/**
 * SupabasePush.gs — 試算表寫入的當下，順便即時推一份到 Supabase。
 *
 * 跟 supabase/migrate-from-sheets.js／supabase/MigrateToSupabase.gs 那套
 * 「定期整批 upsert」搭配，不是取代：這裡處理「剛剛寫的這一筆」，
 * 讓「試算表 → 資料庫」這個方向從「最多等 5 分鐘」變成「幾乎即時」；
 * 定期整批同步繼續留著當保險網——這裡推送失敗（網路問題、Supabase
 * 剛好打不通）不會讓使用者發現，缺的那一筆會在下一次定期同步時自然
 * 補上，不需要在這裡做重試。
 *
 * ── 最重要的設計原則 ──────────────────────────────────────
 *
 * **絕對不能因為 Supabase 打不通，就讓試算表本身的寫入跟著失敗或變慢
 * 到使用者有感。** 這裡每一支對外函式都自己包 try/catch，出錯只印一行
 * 警告到執行記錄，不會往外拋——呼叫端（Service.gs 的 addRecord 等）
 * 完全不用理會這裡有沒有成功。
 *
 * ── 什麼時候真的會推送 ──────────────────────────────────
 *
 * 只有指令碼屬性同時設定了 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY
 * 才會真的打 API；main 正式站台目前沒有設這兩個屬性，這裡所有呼叫都會
 * 靜靜跳過（_sbPushEnabled() 回傳 false），不影響任何現有行為——這也是
 * 為什麼可以放心把這些呼叫直接加進 Service.gs：沒設定這兩個屬性的環境
 * 完全不受影響。
 */

/**
 * 自我測試（Test.gs 的 runSelfTest）期間設成 true：測試會真的「營業開始、記帳、設定今日數字」，
 * 這些動作平常都會即時同步到資料庫——正式專案有設定資料庫連線資訊時，測試資料就會被送進
 * 正式資料庫（測試的營業日會讓資料庫版以為今天又開了一次營業）。測試期間一律不送。
 * 用執行期變數、不是指令碼屬性：測試跑到一半被砍斷，下一次執行自然恢復，不會一直卡在暫停。
 */
let _sbPushSuspended = false;

/** 指令碼屬性有沒有設定資料庫連線資訊（要不要裝定期安全網的觸發器看這個）。 */
function _sbPushConfigured() {
  const props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('SUPABASE_URL') && props.getProperty('SUPABASE_SERVICE_ROLE_KEY'));
}

/** 現在要不要真的送到資料庫：有設定連線資訊，而且不是在跑自我測試。 */
function _sbPushEnabled() {
  return !_sbPushSuspended && _sbPushConfigured();
}

function _sbPushConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: String(props.getProperty('SUPABASE_URL') || '').replace(/\/+$/, ''),
    key: props.getProperty('SUPABASE_SERVICE_ROLE_KEY')
  };
}

function _sbPushFetch(method, path, payload, extraHeaders) {
  const cfg = _sbPushConfig();
  const headers = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
  if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
  const options = { method: method, headers: headers, muteHttpExceptions: true };
  if (payload !== undefined) options.payload = JSON.stringify(payload);
  const resp = UrlFetchApp.fetch(cfg.url + path, options);
  const code = resp.getResponseCode();
  if (code >= 300) throw new Error('(' + code + ') ' + method + ' ' + path + '：' + resp.getContentText());
}

/** GET 一張表（PostgREST 查詢），回傳陣列；連不上、格式不對一律丟錯，讓呼叫端決定要不要略過。 */
function _sbPushGetJson(path) {
  const cfg = _sbPushConfig();
  const headers = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
  const resp = UrlFetchApp.fetch(cfg.url + path, { method: 'GET', headers: headers, muteHttpExceptions: true });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code >= 300) throw new Error('(' + code + ') GET ' + path + '：' + text);
  const data = JSON.parse(text || '[]');
  if (!Array.isArray(data)) throw new Error('GET ' + path + ' 回應格式不是陣列：' + text);
  return data;
}

/** 刪掉符合條件的列（filter 例如 'qa_id=eq.qa_xxx'；PostgREST 規定 DELETE 一定要帶條件，不會整張刪掉）。 */
function _sbPushDelete(table, filter) {
  _sbPushFetch('DELETE', '/rest/v1/' + table + '?' + filter, undefined, { Prefer: 'return=minimal' });
}

/**
 * 試算表 user_id（文字）→ Supabase profiles.id（uuid），靠兩邊都有的
 * username 對照。查一次 Supabase 的 profiles 表要花一次網路來回，快取
 * 1 小時，避免每一次記帳都多打一次 API 拖慢使用者的操作。
 *
 * 同一次執行裡還會再記在 _sbPushUidMapMemo：定期安全網一次要處理幾百筆紀錄，
 * 以前每一筆都去讀一次 CacheService，幾百次累積起來要花好幾秒到十幾秒。
 * 每次執行都是全新的全域變數，不會拿到上一次執行留下的舊對照表。
 */
let _sbPushUidMapMemo = null;

function _sbPushUserId(sheetUserId) {
  if (!sheetUserId) return null;
  if (_sbPushUidMapMemo) return _sbPushUidMapMemo[sheetUserId] || null;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'sbPushUidMap';
  let map = null;
  try {
    const cached = cache.get(cacheKey);
    if (cached) map = JSON.parse(cached);
  } catch (e) { map = null; }

  if (!map) {
    map = {};
    const usernameToSheetId = {};
    dbReadAll('Users').forEach(function (u) { usernameToSheetId[u.username] = u.user_id; });
    const cfg = _sbPushConfig();
    const headers = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
    const resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/profiles?select=id,username', { method: 'GET', headers: headers, muteHttpExceptions: true });
    const code = resp.getResponseCode();
    const text = resp.getContentText();
    if (code >= 300) throw new Error('查詢 profiles 失敗 (' + code + ')：' + text);
    let profiles;
    try { profiles = JSON.parse(text || '[]'); } catch (e) { throw new Error('profiles 回應不是合法 JSON：' + text); }
    if (!Array.isArray(profiles)) throw new Error('profiles 回應格式不是陣列（' + typeof profiles + '）：' + text);
    profiles.forEach(function (p) {
      const sid = usernameToSheetId[p.username];
      if (sid) map[sid] = p.id;
    });
    try { cache.put(cacheKey, JSON.stringify(map), 3600); } catch (e) { /* 快取放不下就算了，這次還是能正常查完 */ }
  }
  _sbPushUidMapMemo = map;
  return map[sheetUserId] || null;
}

function _sbPushUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  _sbPushFetch('POST', '/rest/v1/' + table + '?on_conflict=' + encodeURIComponent(onConflict), rows,
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

/** 入幣／出幣／碼表入幣／開獎：一次可能好幾筆（開獎一次登錄多個獎型）。 */
function pushRecordsToSupabase(recs) {
  if (!_sbPushEnabled() || !recs || !recs.length) return;
  try {
    const rows = recs.map(function (r) {
      const uid = _sbPushUserId(r.user_id);
      if (!uid) throw new Error('user_id=' + r.user_id + ' 在 Supabase 找不到對應帳號');
      return {
        record_id: r.record_id, machine_id: r.machine_id, type: r.type, amount: r.amount,
        prize_id: r.prize_id || null, prize_name: r.prize_name || '',
        unit_amount: r.unit_amount === '' ? null : r.unit_amount,
        count: r.count === '' ? null : r.count,
        user_id: uid, created_at: r.created_at, note: r.note || '',
        voided: !!r.voided, voided_by: null, voided_at: null,
        client_token: r.client_token || null,
        meter_start: r.meter_start === '' ? null : r.meter_start,
        meter_end: r.meter_end === '' ? null : r.meter_end,
        business_date: r.business_date
      };
    });
    _sbPushUpsert('records', rows, 'record_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（records）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}

/** 作廢一筆紀錄。 */
function pushVoidToSupabase(rec) {
  if (!_sbPushEnabled() || !rec) return;
  try {
    _sbPushUpsert('records', [{
      record_id: rec.record_id,
      voided: true,
      voided_by: _sbPushUserId(rec.voided_by),
      voided_at: rec.voided_at
    }], 'record_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（voidRecord）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}

/** DailyLedger 的一列 → 資料庫 daily_ledger 的一列（即時推送跟定期安全網共用，兩邊送的內容一定一樣）。 */
function _dailyLedgerPayload(row) {
  return {
    ledger_id: row.ledger_id,
    business_date: row.business_date,
    turnover: toNumber(row.turnover),
    transport: toNumber(row.transport),
    given_to_owner: 0,
    taken_by_owner: 0,
    given_to_owner_items: _parseLedgerItems(row.given_to_owner_items),
    taken_by_owner_items: _parseLedgerItems(row.taken_by_owner_items),
    returned_to_house: toNumber(row.returned_to_house),
    updated_by: _sbPushUserId(row.updated_by),
    updated_at: row.updated_at,
    biz_id: row.biz_id || null,
    manual_432: toNumber(row.manual_432),
    manual_441: toNumber(row.manual_441),
    manual_expense: toNumber(row.manual_expense)
  };
}

/** 每日手動帳目（設定今日數字）。 */
function pushDailyLedgerToSupabase(row) {
  if (!_sbPushEnabled() || !row) return;
  try {
    _sbPushUpsert('daily_ledger', [_dailyLedgerPayload(row)], 'ledger_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（daily_ledger）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}

/** BizDays 的一列 → 資料庫 biz_days 的一列（即時推送跟定期安全網共用，兩邊送的內容一定一樣）。 */
function _bizDayPayload(row) {
  return {
    biz_id: row.biz_id,
    business_date: row.business_date,
    opened_at: row.opened_at,
    opened_by: _sbPushUserId(row.opened_by),
    closed_at: row.closed_at || null,
    closed_by: _sbPushUserId(row.closed_by),
    auto_closed: !!row.auto_closed
  };
}

/** 今日營業開始／結單。 */
function pushBizDayToSupabase(row) {
  if (!_sbPushEnabled() || !row) return;
  try {
    _sbPushUpsert('biz_days', [_bizDayPayload(row)], 'biz_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（biz_days）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}
