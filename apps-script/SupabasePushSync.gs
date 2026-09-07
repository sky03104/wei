/**
 * SupabasePushSync.gs — 「試算表 → 資料庫」方向的定期安全網。
 *
 * SupabasePush.gs 的即時推送是這個方向的主力：使用者透過 App 操作
 * （入幣/出幣/開分/作廢/開始結單/設定今日數字）的當下就直接推一筆到
 * Supabase。但即時推送刻意設計成「打不通就放棄，不重試」（見
 * SupabasePush.gs 開頭說明），萬一剛好網路不通、Supabase 一時打不通，
 * 那一筆就會漏掉——這支就是補漏用的定期保險網。
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
  if (!_sbPushEnabled()) {
    Logger.log('尚未設定 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，略過定期安全網。');
    return null;
  }
  return withLock(function () {
    // machines 一定要排第一個：records 有外鍵指到 machine_id，機台如果還沒
    // 存在於 Supabase，records 那批 upsert 會直接被 Postgres 擋下來
    // （真實發生過：23503 外鍵違反，整批 500 筆全部失敗）。機台本身
    // 不像 records/void 有即時推送涵蓋，只有這裡會定期把它們同步過去。
    const summary = {
      machines: _pushAllMachinesToSupabase(),
      bizDays: _pushAllBizDaysToSupabase(),
      dailyLedger: _pushAllDailyLedgerToSupabase(),
      records: _pushAllRecordsToSupabase()
    };
    Logger.log('定期安全網推送完成：' + JSON.stringify(summary));
    return summary;
  });
}

/** 機台不像 records/biz_days/daily_ledger 有即時推送，只有這支定期安全網會同步——沒這段的話，新增/改過的機台在 Supabase 會一直是舊的（甚至完全不存在），造成 records 外鍵失敗、匯出查詢用機台分類篩選時篩到過期資料。 */
function _pushAllMachinesToSupabase() {
  const rows = _dedupeByKey(dbReadAll('Machines'), 'machine_id');
  try {
    const payload = rows.map(function (m) {
      return {
        machine_id: m.machine_id, name: m.name, location: m.location || '', status: m.status || 'running',
        color: m.color || '#4F7BE8', sort_order: m.sort_order === '' ? 0 : m.sort_order, note: m.note || '',
        created_at: m.created_at || new Date().toISOString(), category: m.category || 'dice', icon: m.icon || 'classic'
      };
    });
    _sbPushUpsert('machines', payload, 'machine_id');
    return payload.length;
  } catch (e) {
    Logger.log('⚠ 定期安全網推送失敗（machines）：' + (e && e.message));
    return 0;
  }
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

function _pushAllBizDaysToSupabase() {
  const rows = _dedupeByKey(dbReadAll('BizDays'), 'biz_id');
  rows.forEach(function (row) { pushBizDayToSupabase(row); });
  return rows.length;
}

function _pushAllDailyLedgerToSupabase() {
  const rows = _dedupeByKey(dbReadAll('DailyLedger'), 'ledger_id');
  rows.forEach(function (row) { pushDailyLedgerToSupabase(row); });
  return rows.length;
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
  if (!_sbPushEnabled()) return false;
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
