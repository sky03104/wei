/**
 * SupabasePushSync.gs — 「試算表 → 資料庫」方向的定期安全網。
 *
 * SupabasePush.gs 的即時推送是這個方向的主力：使用者透過 App 操作
 * （入幣/出幣/開分/作廢/開始結單/設定今日數字）的當下就直接推一筆到
 * Supabase。但即時推送刻意設計成「打不通就放棄，不重試」（見
 * SupabasePush.gs 開頭說明），萬一剛好網路不通、Supabase 一時打不通，
 * 那一筆就會漏掉——這支就是補漏用的定期保險網。
 *
 * 例外：機台、獎型、快捷金額、入幣費率、台主授權這幾種設定是雙向同步
 * （資料庫版也能改），不是單純用試算表蓋過去，見 _syncSettingsWithSupabase()。
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
    // 見 _syncSettingsWithSupabase()，機台是裡面第一張）。
    const summary = {
      settings: _syncSettingsWithSupabase(),
      bizDays: _pushAllBizDaysToSupabase(),
      dailyLedger: _pushAllDailyLedgerToSupabase(),
      records: _pushAllRecordsToSupabase()
    };
    Logger.log('定期安全網推送完成：' + JSON.stringify(summary));
    return summary;
  });
}

/**
 * 設定類資料表的雙向同步：機台、獎型、快捷金額、入幣費率、台主授權。
 *
 * 這幾張表兩個版本都能改（試算表版、資料庫版的「系統管理」／機台頁的設定），
 * 以前卻沒有好好同步：機台是「試算表整張蓋過資料庫」，資料庫版改的最多 15 分鐘
 * 就被蓋回去（真實發生過：2026-09-28 18:04 在資料庫版改了機台，18:08 就被蓋回
 * 舊的）；獎型、快捷金額、入幣費率、台主授權則完全不同步，兩邊各改各的。
 *
 * 現在每張表都跟「上次同步完的樣子」比對，誰有改就以誰為準：
 * - 兩邊一樣：不動。
 * - 只有一邊改了（新增、修改、刪除都算）：照那一邊，另一邊跟著改。
 * - 兩邊都改了同一筆、或第一次同步還沒有「上次的樣子」：以資料庫版為準。
 *   （第一次同步時，兩邊不一樣的地方全部照資料庫版——2026-09-30 查過資料庫的
 *   修改紀錄，這幾種設定最近都是在資料庫版改的；獎型金額、入幣費率兩個版本
 *   實際記帳用的也一模一樣。）
 * - 機台不會被刪（紀錄都掛在機台上）：從試算表刪掉的機台不會加回去，也不會
 *   去刪資料庫那一台。
 * - 台主授權用「帳號」對照兩邊的使用者（試算表是文字編號、資料庫是 uuid）；
 *   帳號只存在其中一邊的，那筆授權不動、也不同步（帳號本身不會同步）。
 *
 * 「上次同步完的樣子」每筆只存一小段指紋（_settingsSyncHash），每張表一個指令碼屬性。
 * 讀不到資料庫那張表就整張略過、下次再比，絕不在不知道資料庫現況時蓋過去或刪掉。
 * 送不成功／寫不成功的那筆記住「下次該怎麼做」，下次再試——不能記成已同步，
 * 否則下次會誤判成「另一邊改了」，反過來把這次的修改蓋掉。
 */
function _syncSettingsWithSupabase() {
  const out = {};
  let ctx = null;
  _settingsSyncSpecs().forEach(function (spec) {
    try {
      if (spec.needsUsers && !ctx) ctx = _settingsSyncUserContext();
      out[spec.id] = _syncSettingsTable(spec, ctx);
    } catch (e) {
      out[spec.id] = 'skipped';
      Logger.log('⚠ ' + spec.label + '這次先不同步（下次再試）：' + (e && e.message));
    }
  });
  return out;
}

/** 同步一張設定表：讀兩邊 → 算出要怎麼做 → 做 → 記下同步完的樣子。 */
function _syncSettingsTable(spec, ctx) {
  const dbRows = _sbPushGetJson('/rest/v1/' + spec.table + '?select=' + spec.select);
  // 讀試算表現在真正的樣子，不吃跨執行快取（有人直接改試算表時快取還是舊的）
  _invalidateSheetCache(spec.sheet);
  const sheetRows = dbReadAll(spec.sheet);
  // 防呆：一邊整張空掉、另一邊還有好幾筆，不像正常的刪除，比較像資料庫被清空或
  // SPREADSHEET_ID 指錯試算表（真的發生過）——雙向同步會把另一邊也全部刪掉，這次先不動
  const sheetCount = sheetRows.filter(function (r) { return spec.sheetKey(r, ctx); }).length;
  const dbCount = dbRows.filter(function (r) { return spec.dbKey(r, ctx); }).length;
  if ((sheetCount === 0 && dbCount >= 3) || (dbCount === 0 && sheetCount >= 3)) {
    Logger.log('⚠ ' + spec.label + '有一邊整張是空的（試算表 ' + sheetCount + ' 筆、資料庫 ' + dbCount +
      ' 筆），不像正常的修改，這次先不同步；請確認試算表跟資料庫的設定是不是正確');
    return 'skipped (one side empty)';
  }
  const base = _settingsSyncBaseLoad(spec.id);
  const plan = _planSettingsSync(spec, sheetRows, dbRows, base, ctx);
  const failed = [];
  const fail = function (item, what, e) {
    failed.push(item);
    Logger.log('⚠ ' + spec.label + '同步失敗（' + what + ' ' + item.key + '，下次再試）：' + (e && e.message));
  };
  const done = { toDb: 0, dbDeleted: 0, toSheet: 0, sheetDeleted: 0 };

  // 1) 送到資料庫：整批一次，被擋下才一筆一筆送，正常的照樣送得到
  if (plan.toDb.length) {
    const payloads = plan.toDb.map(function (x) { return spec.toDb(x.sheet, ctx); });
    try {
      _sbPushUpsert(spec.table, payloads, spec.conflict);
      done.toDb = payloads.length;
    } catch (e) {
      Logger.log('⚠ ' + spec.label + '整批送出失敗，改成一筆一筆送：' + (e && e.message));
      plan.toDb.forEach(function (x, i) {
        try {
          _sbPushUpsert(spec.table, [payloads[i]], spec.conflict);
          done.toDb++;
        } catch (e2) { fail(x, '送出', e2); }
      });
    }
  }
  // 2) 資料庫那邊跟著刪（一天頂多幾筆，一筆一筆刪就好）
  plan.dbDelete.forEach(function (x) {
    try {
      _sbPushDelete(spec.table, spec.dbFilter(x.db));
      done.dbDeleted++;
    } catch (e) { fail(x, '刪除', e); }
  });
  // 3) 寫回試算表：先改、再加（加在最後面，不會讓前面的列號跑掉）、最後才刪
  plan.sheetUpdate.forEach(function (x) {
    try {
      const patch = spec.fields(x.db, ctx);
      x.rows.forEach(function (r) { dbUpdate(spec.sheet, r._row, patch); });
      done.toSheet++;
    } catch (e) { fail(x, '寫回試算表', e); }
  });
  if (plan.sheetInsert.length) {
    try {
      dbInsertMany(spec.sheet, plan.sheetInsert.map(function (x) { return spec.toSheet(x.db, ctx); }));
      done.toSheet += plan.sheetInsert.length;
    } catch (e) { plan.sheetInsert.forEach(function (x) { fail(x, '加進試算表', e); }); }
  }
  if (plan.sheetDelete.length) {
    try {
      const rowIndexes = [];
      plan.sheetDelete.forEach(function (x) { x.rows.forEach(function (r) { rowIndexes.push(r._row); }); });
      dbDeleteRows(spec.sheet, rowIndexes);
      done.sheetDeleted = plan.sheetDelete.length;
    } catch (e) { plan.sheetDelete.forEach(function (x) { fail(x, '從試算表刪除', e); }); }
  }

  const next = plan.nextBase;
  failed.forEach(function (x) {
    if (x.onFail === undefined) delete next[x.key];
    else next[x.key] = x.onFail;
  });
  _settingsSyncBaseSave(spec.id, next);
  return done;
}

/**
 * 算出這張表這次要怎麼同步（不碰網路、不寫試算表，方便測試）。
 * base：上次同步完每筆的指紋（{ key: 指紋 }），這張表第一次同步是 null。
 * 每個動作都帶 onFail：做失敗時這筆要記成什麼指紋，下次才會再做同一件事。
 */
function _planSettingsSync(spec, sheetRows, dbRows, base, ctx) {
  const keys = [];
  const sheetByKey = {};
  sheetRows.forEach(function (r) {
    const k = spec.sheetKey(r, ctx);
    if (!k) return;
    if (!sheetByKey[k]) { sheetByKey[k] = { row: r, rows: [] }; keys.push(k); }
    sheetByKey[k].rows.push(r); // 試算表有重複列時全部一起改／刪，比對用第一列（跟 dbFind 一樣）
  });
  const dbByKey = {};
  dbRows.forEach(function (r) {
    const k = spec.dbKey(r, ctx);
    if (!k) return;
    if (!sheetByKey[k] && !dbByKey[k]) keys.push(k);
    dbByKey[k] = r;
  });

  const first = !base;
  const plan = { toDb: [], dbDelete: [], sheetUpdate: [], sheetInsert: [], sheetDelete: [], nextBase: {} };
  keys.forEach(function (k) {
    const s = sheetByKey[k];
    const d = dbByKey[k];
    const b = base ? base[k] : undefined;
    const sh = s ? _settingsSyncHash(spec.fields(s.row, ctx)) : undefined;
    const dh = d ? _settingsSyncHash(spec.fields(d, ctx)) : undefined;

    if (s && d) {
      if (sh === dh) { plan.nextBase[k] = sh; return; } // 兩邊一樣
      if (b !== undefined && b === dh) { // 只有試算表改了 → 送到資料庫
        plan.toDb.push({ key: k, sheet: s.row, onFail: b });
        plan.nextBase[k] = sh;
        return;
      }
      // 只有資料庫改了／兩邊都改了／第一次同步 → 以資料庫為準
      plan.sheetUpdate.push({ key: k, rows: s.rows, db: d, onFail: b });
      plan.nextBase[k] = dh;
      return;
    }

    if (s) { // 只有試算表有
      if (!spec.canDelete || (!first && b === undefined)) { // 試算表新增的（機台一律當新增）→ 送到資料庫
        plan.toDb.push({ key: k, sheet: s.row, onFail: undefined });
        plan.nextBase[k] = sh;
        return;
      }
      // 資料庫那邊刪掉了（或第一次同步、以資料庫為準）→ 試算表也刪
      plan.sheetDelete.push({ key: k, rows: s.rows, onFail: sh });
      return;
    }

    // 只有資料庫有
    if (b === undefined) { // 資料庫版新增的（或第一次同步、以資料庫為準）→ 加進試算表
      plan.sheetInsert.push({ key: k, db: d, onFail: undefined });
      plan.nextBase[k] = dh;
      return;
    }
    // 上次還在、後來從試算表刪掉了
    if (!spec.canDelete) { plan.nextBase[k] = b; return; } // 機台：不加回去，也不刪資料庫
    if (dh === b) { // 資料庫沒動過 → 資料庫也刪
      plan.dbDelete.push({ key: k, db: d, onFail: b });
      return;
    }
    plan.sheetInsert.push({ key: k, db: d, onFail: b }); // 資料庫版後來又改過 → 以資料庫為準，加回試算表
    plan.nextBase[k] = dh;
  });
  return plan;
}

/** 設定的指紋（FNV-1a 32 位元），只拿來判斷「有沒有變」，不用加密等級。 */
function _settingsSyncHash(fields) {
  const s = JSON.stringify(fields);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** 數字欄位：試算表跟資料庫存法不同（'' 跟 0、'3' 跟 3、'12500.00' 跟 12500）統一成數字；空白用預設值。 */
function _syncNum(v, dflt) {
  if (v === '' || v === null || v === undefined) return dflt;
  const n = Number(v);
  return isFinite(n) ? n : dflt;
}

function _syncStr(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function _syncIso(v) {
  const t = new Date(v);
  return (v && !isNaN(t.getTime())) ? t.toISOString() : nowIso();
}

/** 機台兩邊共用、拿來比對的欄位（建立時間不算：兩邊時間格式不一樣，而且不會改）。 */
function _machineSyncFields(m) {
  return {
    name: _syncStr(m.name),
    location: _syncStr(m.location),
    status: _syncStr(m.status) || 'running',
    color: _syncStr(m.color) || '#4F7BE8',
    sort_order: _syncNum(m.sort_order, 0),
    note: _syncStr(m.note),
    category: _syncStr(m.category) || 'dice',
    icon: _syncStr(m.icon) || 'classic'
  };
}

/**
 * 每張設定表的同步方式。fields() 的欄位名稱就是試算表的欄位名稱（寫回試算表直接用），
 * key 是兩邊共用、用來配對的編號。用函式包起來回傳，不在載入時就建好（各檔案載入順序不影響）。
 */
function _settingsSyncSpecs() {
  const byId = function (field) {
    return function (r) { return _syncStr(r[field]); };
  };
  const withId = function (fields, field) {
    return function (r) {
      const o = fields(r);
      o[field] = String(r[field]);
      return o;
    };
  };
  const eqFilter = function (field) {
    return function (d) { return field + '=eq.' + encodeURIComponent(d[field]); };
  };

  const prizeFields = function (r) {
    return { machine_id: _syncStr(r.machine_id), name: _syncStr(r.name), amount: _syncNum(r.amount, 0), sort_order: _syncNum(r.sort_order, 0), active: toBool(r.active) };
  };
  const quickAmountFields = function (r) {
    return { machine_id: _syncStr(r.machine_id), type: _syncStr(r.type), amount: _syncNum(r.amount, 0), label: _syncStr(r.label), sort_order: _syncNum(r.sort_order, 0) };
  };
  const meterRateFields = function (r) {
    return { machine_id: _syncStr(r.machine_id), rate: _syncNum(r.rate, 100) };
  };

  return [
    {
      id: 'machines', label: '機台', sheet: 'Machines', table: 'machines', conflict: 'machine_id', canDelete: false,
      select: 'machine_id,name,location,status,color,sort_order,note,created_at,category,icon',
      sheetKey: byId('machine_id'), dbKey: byId('machine_id'), fields: _machineSyncFields,
      toDb: function (s) {
        const p = withId(_machineSyncFields, 'machine_id')(s);
        p.created_at = _syncIso(s.created_at);
        return p;
      },
      toSheet: function (d) {
        const f = withId(_machineSyncFields, 'machine_id')(d);
        f.created_at = _syncIso(d.created_at);
        return f;
      }
    },
    {
      id: 'prizes', label: '獎型', sheet: 'Prizes', table: 'prizes', conflict: 'prize_id', canDelete: true,
      select: 'prize_id,machine_id,name,amount,sort_order,active',
      sheetKey: byId('prize_id'), dbKey: byId('prize_id'), fields: prizeFields,
      toDb: withId(prizeFields, 'prize_id'), toSheet: withId(prizeFields, 'prize_id'), dbFilter: eqFilter('prize_id')
    },
    {
      id: 'quick_amounts', label: '快捷金額', sheet: 'QuickAmounts', table: 'quick_amounts', conflict: 'qa_id', canDelete: true,
      select: 'qa_id,machine_id,type,amount,label,sort_order',
      sheetKey: byId('qa_id'), dbKey: byId('qa_id'), fields: quickAmountFields,
      toDb: withId(quickAmountFields, 'qa_id'), toSheet: withId(quickAmountFields, 'qa_id'), dbFilter: eqFilter('qa_id')
    },
    {
      id: 'meter_rates', label: '入幣費率', sheet: 'MeterRates', table: 'meter_rates', conflict: 'rate_id', canDelete: true,
      select: 'rate_id,machine_id,rate',
      sheetKey: byId('rate_id'), dbKey: byId('rate_id'), fields: meterRateFields,
      toDb: withId(meterRateFields, 'rate_id'), toSheet: withId(meterRateFields, 'rate_id'), dbFilter: eqFilter('rate_id')
    },
    {
      // 授權只有「有／沒有」，沒有內容可改：指紋固定，只會新增或刪除
      id: 'permissions', label: '台主授權', sheet: 'Permissions', table: 'permissions', conflict: 'user_id,machine_id',
      canDelete: true, needsUsers: true, select: 'user_id,machine_id,granted_by,granted_at',
      sheetKey: function (r, ctx) {
        const name = ctx.sheetIdToName[_syncStr(r.user_id)];
        return (name && ctx.dbNameToId[name] && r.machine_id) ? name + '|' + r.machine_id : '';
      },
      dbKey: function (r, ctx) {
        const name = ctx.dbIdToName[_syncStr(r.user_id)];
        return (name && ctx.sheetNameToId[name] && r.machine_id) ? name + '|' + r.machine_id : '';
      },
      fields: function () { return {}; },
      toDb: function (s, ctx) {
        const by = ctx.sheetIdToName[_syncStr(s.granted_by)];
        return {
          user_id: ctx.dbNameToId[ctx.sheetIdToName[_syncStr(s.user_id)]],
          machine_id: String(s.machine_id),
          granted_by: (by && ctx.dbNameToId[by]) || null,
          granted_at: _syncIso(s.granted_at)
        };
      },
      toSheet: function (d, ctx) {
        const by = ctx.dbIdToName[_syncStr(d.granted_by)];
        return {
          user_id: ctx.sheetNameToId[ctx.dbIdToName[_syncStr(d.user_id)]],
          machine_id: String(d.machine_id),
          granted_by: (by && ctx.sheetNameToId[by]) || '',
          granted_at: _syncIso(d.granted_at)
        };
      },
      dbFilter: function (d) {
        return 'user_id=eq.' + encodeURIComponent(d.user_id) + '&machine_id=eq.' + encodeURIComponent(d.machine_id);
      }
    }
  ];
}

/** 兩邊帳號的對照（靠 username）：台主授權要把試算表的文字編號跟資料庫的 uuid 對起來。 */
function _settingsSyncUserContext() {
  const ctx = { sheetIdToName: {}, sheetNameToId: {}, dbIdToName: {}, dbNameToId: {} };
  dbReadAll('Users').forEach(function (u) {
    if (!u.user_id || !u.username) return;
    ctx.sheetIdToName[String(u.user_id)] = String(u.username);
    ctx.sheetNameToId[String(u.username)] = String(u.user_id);
  });
  _sbPushGetJson('/rest/v1/profiles?select=id,username').forEach(function (p) {
    if (!p.id || !p.username) return;
    ctx.dbIdToName[String(p.id)] = String(p.username);
    ctx.dbNameToId[String(p.username)] = String(p.id);
  });
  return ctx;
}

function _settingsSyncBaseKey(id) {
  return 'SB_SYNC_BASE_' + id;
}

function _settingsSyncBaseLoad(id) {
  const raw = PropertiesService.getScriptProperties().getProperty(_settingsSyncBaseKey(id));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : null;
  } catch (e) {
    return null;
  }
}

function _settingsSyncBaseSave(id, map) {
  try {
    PropertiesService.getScriptProperties().setProperty(_settingsSyncBaseKey(id), JSON.stringify(map));
  } catch (e) {
    // 存不進去的話下次會當成第一次同步（以資料庫為準），不會出錯，但試算表這段時間改的可能被蓋掉
    Logger.log('⚠ 記不住這次同步完的樣子（' + id + '）：' + (e && e.message));
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
 * 讓其他正常的列照樣送得到，不會因為一列壞掉整張表都補不上。回傳實際送成功的列數。
 */
function _pushTableInBatch(table, keyField, rows, toPayload) {
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
        return _sbOmitMissingPeople({
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
        }, ['voided_by']);
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
