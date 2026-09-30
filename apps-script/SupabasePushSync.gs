/**
 * SupabasePushSync.gs — 「試算表 → 資料庫」方向的定期安全網。
 *
 * SupabasePush.gs 的即時推送是這個方向的主力：使用者透過 App 操作
 * （入幣/出幣/開分/作廢/開始結單/設定今日數字）的當下就直接推一筆到
 * Supabase。但即時推送刻意設計成「打不通就放棄，不重試」（見
 * SupabasePush.gs 開頭說明），萬一剛好網路不通、Supabase 一時打不通，
 * 那一筆就會漏掉——這支就是補漏用的定期保險網。
 *
 * 例外：機台設定是雙向同步（資料庫版「系統管理」也能改機台），不是單純
 * 用試算表蓋過去，見 _syncMachinesWithSupabase()。
 *
 * ── 跟 MigrateToSupabase.gs 不一樣、也是那支不能拿來定期跑的原因 ──
 *
 * 1. 送出前一定先用 key（record_id／biz_id／ledger_id）去重，同一批
 *    只留最後一筆。真實發生過的事故：BizDays 分頁如果不小心存在重複
 *    列，同一個 biz_id 在同一個 upsert 指令裡出現兩次，Postgres 會直接
 *    整批報錯（21000 "ON CONFLICT DO UPDATE command cannot affect row
 *    a second time"），後面的資料完全不會寫入。
 * 2. 全程包一個 withLock，同一個 GAS 專案裡不會有兩個執行個體同時跑，
 *    不會自己跟自己搶著寫。
 * 3. 純粹 upsert，不做任何 DELETE，不清空任何表——就算跟即時推送同一
 *    瞬間執行，最壞情況只是把同一筆資料多 upsert 一次，結果一樣，不會
 *    互相破壞。
 * 4. Records 的 voided_by／voided_at 會照試算表現在的值原樣帶過去，
 *    不會像 pushRecordsToSupabase()（設計給「剛新增、還沒被作廢過」的
 *    情境用）那樣寫死成 null，避免把已經作廢的紀錄的作廢時間／作廢人
 *    覆蓋回空白。
 *
 * ── 用法 ──────────────────────────────────────────────
 *
 * 只要 setup() 有跑過、且指令碼屬性有設定 SUPABASE_URL／
 * SUPABASE_SERVICE_ROLE_KEY，就會自動裝一個每 15 分鐘跑一次的觸發器
 * （_ensureSupabasePushSyncTrigger()），不用另外手動去「觸發器」頁面設定。
 * 兩個 GAS 專案都裝這個觸發器也沒關係（都是同一份試算表、同一個
 * Supabase，內容一樣，多跑一次只是多打幾次沒必要的 API，不會出錯）。
 */

function pushAllToSupabase() {
  if (_sbPushSuspended) return null; // 自我測試中（見 SupabasePush.gs），不送
  if (!_sbPushEnabled()) {
    Logger.log('尚未設定 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，略過定期安全網。');
    return null;
  }
  return withLock(function () {
    // machines 一定要排第一個：records 有外鍵指到 machine_id，機台如果還沒
    // 存在於 Supabase，records 那批 upsert 會直接被 Postgres 擋下來
    // （真實發生過：23503 外鍵違反，整批 500 筆全部失敗）。機台本身
    // 不像 records/void 有即時推送涵蓋，只有這裡會定期同步（而且是雙向，
    // 見 _syncMachinesWithSupabase()）。
    const summary = {
      machines: _syncMachinesWithSupabase(),
      bizDays: _pushAllBizDaysToSupabase(),
      dailyLedger: _pushAllDailyLedgerToSupabase(),
      records: _pushAllRecordsToSupabase()
    };
    Logger.log('定期安全網推送完成：' + JSON.stringify(summary));
    return summary;
  });
}

/**
 * 機台設定（名稱、位置、狀態、顏色、排序、圖案…）的雙向同步。
 *
 * 機台不像 records/biz_days/daily_ledger 有即時推送，只有這裡會同步——沒這段的話，
 * 試算表版新增/改過的機台在資料庫會一直是舊的（甚至完全不存在），造成 records
 * 外鍵失敗、匯出查詢用機台分類篩選時篩到過期資料。
 *
 * 以前這裡是「試算表整張蓋過資料庫」：資料庫版「系統管理」改的機台設定只存在資料庫，
 * 試算表還是舊的，最多 15 分鐘就被這裡用試算表的舊資料蓋回去（真實發生過：
 * 2026-09-28 18:04 在資料庫版改了機台，18:08 就被蓋回舊的）。
 *
 * 現在跟「上次同步完的樣子」比對，誰有改就以誰為準：
 * - 兩邊一樣：不動。
 * - 只有試算表改了（試算表版改的、或直接改試算表）：送到資料庫。
 * - 只有資料庫改了（資料庫版改的）：寫回試算表，試算表版也看得到。
 * - 兩邊都改了、或第一次跑還沒有「上次的樣子」：以試算表為準（跟以前一樣）。
 * - 資料庫版新增、試算表還沒有的機台：加進試算表（不然這台的紀錄同步不回試算表）；
 *   上次同步時還在、後來從試算表刪掉的，不會再加回去。
 *
 * 「上次同步完的樣子」每台只存一小段指紋（_machineSyncHash），放在指令碼屬性。
 * 讀不到資料庫的機台清單就整段略過、下次再比，絕不在不知道資料庫現況時蓋過去。
 * 送不成功／寫不成功的機台保留舊指紋，下次再試——不能記成已同步，否則下次會
 * 誤判成「另一邊改了」，反過來把這次的修改蓋掉。
 */
function _syncMachinesWithSupabase() {
  let dbRows;
  try {
    dbRows = _sbPushFetchMachines();
  } catch (e) {
    Logger.log('⚠ 讀不到資料庫的機台清單，這次先不同步機台（下次再試）：' + (e && e.message));
    return { toDb: 0, toSheet: 0 };
  }
  // 讀試算表現在真正的樣子，不吃跨執行快取（有人直接改試算表時快取還是舊的）
  _invalidateSheetCache('Machines');
  const sheetRows = _dedupeByKey(dbReadAll('Machines'), 'machine_id');
  const base = _machineSyncBaseLoad();
  const plan = _planMachinesSync(sheetRows, dbRows, base);

  const failed = [];
  const toDb = _pushTableInBatch('machines', 'machine_id', plan.toDb, _machinePayload, failed);
  let toSheet = 0;
  plan.toSheet.forEach(function (item) {
    try {
      _writeMachineFromDb(item.sheet, item.db);
      toSheet++;
    } catch (e) {
      failed.push(String(item.db.machine_id));
      Logger.log('⚠ 資料庫的機台設定寫回試算表失敗（' + item.db.machine_id + '，下次再試）：' + (e && e.message));
    }
  });

  const next = plan.nextBase;
  failed.forEach(function (id) {
    if (base && base[id] !== undefined) next[id] = base[id];
    else delete next[id];
  });
  _machineSyncBaseSave(next);
  return { toDb: toDb, toSheet: toSheet };
}

/**
 * 算出這次要怎麼同步（不碰網路、不寫試算表，方便測試）。
 * base：上次同步完每台的指紋（{ machine_id: 指紋 }），第一次跑是 null。
 * 回傳 { toDb: 要送到資料庫的試算表列, toSheet: [{ sheet: 試算表列或 null, db: 資料庫列 }], nextBase }。
 */
function _planMachinesSync(sheetRows, dbRows, base) {
  const sheetById = {};
  sheetRows.forEach(function (r) { if (r.machine_id !== '' && r.machine_id != null) sheetById[String(r.machine_id)] = r; });
  const dbById = {};
  dbRows.forEach(function (r) { if (r.machine_id) dbById[String(r.machine_id)] = r; });

  const plan = { toDb: [], toSheet: [], nextBase: {} };
  Object.keys(sheetById).forEach(function (id) {
    const s = sheetById[id];
    const d = dbById[id];
    const sh = _machineSyncHash(s);
    if (!d) { plan.toDb.push(s); plan.nextBase[id] = sh; return; } // 資料庫還沒有這台
    const dh = _machineSyncHash(d);
    if (sh === dh) { plan.nextBase[id] = sh; return; } // 兩邊一樣
    if (base && base[id] === sh) { // 試算表沒動過、資料庫改了 → 寫回試算表
      plan.toSheet.push({ sheet: s, db: d });
      plan.nextBase[id] = dh;
      return;
    }
    plan.toDb.push(s); // 試算表改了／兩邊都改了／第一次跑 → 以試算表為準
    plan.nextBase[id] = sh;
  });
  Object.keys(dbById).forEach(function (id) {
    if (sheetById[id]) return;
    if (base && base[id] !== undefined) { plan.nextBase[id] = base[id]; return; } // 從試算表刪掉的，不加回去
    plan.toSheet.push({ sheet: null, db: dbById[id] }); // 資料庫版新增的機台
    plan.nextBase[id] = _machineSyncHash(dbById[id]);
  });
  return plan;
}

/** 兩邊共用、拿來比對的機台欄位——試算表跟資料庫存法不同的地方（排序 '' 跟 0、'3' 跟 3）統一成同一個樣子。 */
function _machineSyncFields(m) {
  const order = Number(m.sort_order);
  return {
    name: String(m.name == null ? '' : m.name),
    location: String(m.location || ''),
    status: String(m.status || 'running'),
    color: String(m.color || '#4F7BE8'),
    sort_order: isFinite(order) ? order : 0,
    note: String(m.note || ''),
    category: String(m.category || 'dice'),
    icon: String(m.icon || 'classic')
  };
}

/** 機台設定的指紋（FNV-1a 32 位元），只拿來判斷「有沒有變」。建立時間不算：兩邊時間格式不一樣，而且不會改。 */
function _machineSyncHash(m) {
  const f = _machineSyncFields(m);
  const s = JSON.stringify([f.name, f.location, f.status, f.color, f.sort_order, f.note, f.category, f.icon]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** 試算表的一列機台 → 資料庫 machines 的一列。 */
function _machinePayload(m) {
  const p = _machineSyncFields(m);
  p.machine_id = String(m.machine_id);
  p.created_at = m.created_at || new Date().toISOString();
  return p;
}

/** 把資料庫那邊改過／新增的機台設定寫進試算表（sheetRow 是 null 就是新增一列）。 */
function _writeMachineFromDb(sheetRow, d) {
  const f = _machineSyncFields(d);
  if (sheetRow) {
    dbUpdate('Machines', sheetRow._row, f);
    return;
  }
  const created = new Date(d.created_at);
  f.machine_id = String(d.machine_id);
  f.created_at = isNaN(created.getTime()) ? nowIso() : created.toISOString();
  dbInsert('Machines', f);
}

const MACHINE_SYNC_BASE_PROP = 'SB_MACHINE_SYNC_BASE';

function _machineSyncBaseLoad() {
  const raw = PropertiesService.getScriptProperties().getProperty(MACHINE_SYNC_BASE_PROP);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : null;
  } catch (e) {
    return null;
  }
}

function _machineSyncBaseSave(map) {
  try {
    PropertiesService.getScriptProperties().setProperty(MACHINE_SYNC_BASE_PROP, JSON.stringify(map));
  } catch (e) {
    // 存不進去就當作沒同步過：下次兩邊不一樣時以試算表為準（跟以前一樣），不會出錯
    Logger.log('⚠ 記不住這次機台同步完的樣子：' + (e && e.message));
  }
}

function _sbPushFetchMachines() {
  return _sbPushGetJson('/rest/v1/machines?select=machine_id,name,location,status,color,sort_order,note,created_at,category,icon');
}

/** ISO 時間字串是不是在最近 days 天內。 */
function _isRecentIso(iso, days) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return false;
  return (Date.now() - t) <= days * 24 * 60 * 60 * 1000;
}

/**
 * 同一批要 upsert 的資料裡，用 keyField 去重，只留最後一筆——避免試算
 * 表本身如果有重複列，送給 Supabase 的同一個 on_conflict key 在同一個
 * 指令裡出現兩次而整批失敗。發現重複只印警告，不代替使用者決定刪哪
 * 一列（重複列本身是另一個要處理的問題，見 DiagnoseBizDaysDuplicate.gs）。
 */
function _dedupeByKey(rows, keyField) {
  const byKey = {};
  const dupKeys = {};
  rows.forEach(function (r) {
    if (Object.prototype.hasOwnProperty.call(byKey, r[keyField])) dupKeys[r[keyField]] = true;
    byKey[r[keyField]] = r;
  });
  const dupList = Object.keys(dupKeys);
  if (dupList.length) {
    Logger.log('⚠ 試算表本身有重複的 ' + keyField + '：' + dupList.join(', ') + '（這裡會用最後一筆推送，但建議手動去確認、刪掉多的那列）');
  }
  return Object.keys(byKey).map(function (k) { return byKey[k]; });
}

/**
 * 營業日、每日帳目：整張表一次送（一次網路來回），不是一列打一次。
 *
 * 以前是一列打一次網路：營業日 42 列＋每日帳目 35 列＝每 15 分鐘要連 77 次，
 * 一次要跑 1 分多鐘，而且全程握著鎖——這段時間試算表版的記帳、作廢、開始／結單
 * 會等 20 秒後跳「系統忙碌中」；每天加起來超過免費帳號排程每天 90 分鐘的上限；
 * 這兩張表每天各多一列，還會越跑越久。整批送之後幾秒就跑完。
 * 範圍照舊是整張表（不像 records 只送最近 7 天）：這兩張表一天才一列，整批送很快，
 * 保留「任何一列有差異都會被補上」的安全網效果。
 */
function _pushAllBizDaysToSupabase() {
  const rows = _dedupeByKey(dbReadAll('BizDays'), 'biz_id');
  return _pushTableInBatch('biz_days', 'biz_id', rows, _bizDayPayload);
}

function _pushAllDailyLedgerToSupabase() {
  const rows = _dedupeByKey(dbReadAll('DailyLedger'), 'ledger_id');
  return _pushTableInBatch('daily_ledger', 'ledger_id', rows, _dailyLedgerPayload);
}

/**
 * 整批一次 upsert；整批被資料庫擋下時（例如其中一列資料有問題），才退回一列一列送，
 * 讓其他正常的列照樣送得到，不會因為一列壞掉整張表都補不上。回傳實際送成功的列數；
 * 有給 failedKeys（陣列）的話，送不成功的那幾列的 key 會放進去。
 */
function _pushTableInBatch(table, keyField, rows, toPayload, failedKeys) {
  if (!rows.length) return 0;
  try {
    _sbPushUpsert(table, rows.map(toPayload), keyField);
    return rows.length;
  } catch (e) {
    Logger.log('⚠ 定期安全網整批推送失敗（' + table + '），改成一列一列送：' + (e && e.message));
  }
  let ok = 0;
  rows.forEach(function (row) {
    try {
      _sbPushUpsert(table, [toPayload(row)], keyField);
      ok++;
    } catch (e) {
      if (failedKeys) failedKeys.push(String(row[keyField]));
      Logger.log('⚠ 定期安全網推送失敗（' + table + ' ' + row[keyField] + '，下次再試）：' + (e && e.message));
    }
  });
  return ok;
}

/**
 * 跟 pushRecordsToSupabase() 分開寫：那支是給「剛新增」的情境用，
 * voided_by/voided_at 寫死 null；這裡要原樣帶已作廢紀錄的作廢資訊。
 *
 * 只送「最近 RECENT_DAYS 天內新增或作廢」的紀錄，不是每次都把全部歷史
 * 紀錄重推一次——這支是安全網，只需要補「即時推送剛好失敗」的那幾筆，
 * 那必然是最近才發生的事，很久以前的紀錄早就同步過了，沒必要每 15
 * 分鐘重新整批送一次。真實發生過的事故：不限制範圍時，1000+ 筆全部
 * 重送直接跑到超過 GAS 6 分鐘執行上限被強制中止，而且全程握著鎖，
 * 期間所有需要搶鎖的操作（開始/結單/入幣/作廢…）都會卡住。
 */
function _pushAllRecordsToSupabase() {
  const RECENT_DAYS = 7;
  const rows = _dedupeByKey(dbReadAll('Records'), 'record_id')
    .filter(function (r) { return _isRecentIso(r.created_at, RECENT_DAYS) || _isRecentIso(r.voided_at, RECENT_DAYS); });
  const BATCH = 200;
  let pushed = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    try {
      const payload = chunk.map(function (r) {
        const uid = _sbPushUserId(r.user_id);
        if (!uid) throw new Error('user_id=' + r.user_id + ' 在 Supabase 找不到對應帳號');
        return {
          record_id: r.record_id, machine_id: r.machine_id, type: r.type, amount: r.amount,
          prize_id: r.prize_id || null, prize_name: r.prize_name || '',
          unit_amount: r.unit_amount === '' ? null : r.unit_amount,
          count: r.count === '' ? null : r.count,
          user_id: uid, created_at: r.created_at, note: r.note || '',
          voided: !!r.voided,
          voided_by: r.voided_by ? _sbPushUserId(r.voided_by) : null,
          voided_at: r.voided_at || null,
          client_token: r.client_token || null,
          meter_start: r.meter_start === '' ? null : r.meter_start,
          meter_end: r.meter_end === '' ? null : r.meter_end,
          business_date: r.business_date
        };
      });
      _sbPushUpsert('records', payload, 'record_id');
      pushed += payload.length;
    } catch (e) {
      Logger.log('⚠ 定期安全網推送失敗（records 第 ' + i + '～' + (i + chunk.length) + ' 筆，下次再試）：' + (e && e.message));
    }
  }
  return pushed;
}

/**
 * 確保「試算表→資料庫定期安全網」的時間觸發器存在。setup() 會呼叫這支。
 * 用專案既有的觸發器清單判斷「已經裝過了」，重跑 setup() 不會疊加裝出
 * 好幾個一樣的觸發器。只有指令碼屬性有設定 Supabase 連線資訊才會裝，
 * 沒設定的環境（例如還沒接 Supabase 的測試專案）不受影響。
 */
function _ensureSupabasePushSyncTrigger() {
  if (!_sbPushConfigured()) return false;
  const already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'pushAllToSupabase';
  });
  if (already) return false;
  ScriptApp.newTrigger('pushAllToSupabase')
    .timeBased()
    .everyMinutes(15)
    .create();
  return true;
}
