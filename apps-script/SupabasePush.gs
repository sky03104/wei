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

function _sbPushEnabled() {
  const props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('SUPABASE_URL') && props.getProperty('SUPABASE_SERVICE_ROLE_KEY'));
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

/**
 * 試算表 user_id（文字）→ Supabase profiles.id（uuid），靠兩邊都有的
 * username 對照。查一次 Supabase 的 profiles 表要花一次網路來回，快取
 * 1 小時，避免每一次記帳都多打一次 API 拖慢使用者的操作。
 */
function _sbPushUserId(sheetUserId) {
  if (!sheetUserId) return null;
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
    const profiles = JSON.parse(resp.getContentText() || '[]');
    profiles.forEach(function (p) {
      const sid = usernameToSheetId[p.username];
      if (sid) map[sid] = p.id;
    });
    try { cache.put(cacheKey, JSON.stringify(map), 3600); } catch (e) { /* 快取放不下就算了，這次還是能正常查完 */ }
  }
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

/** 每日手動帳目（設定今日數字）。 */
function pushDailyLedgerToSupabase(row) {
  if (!_sbPushEnabled() || !row) return;
  try {
    _sbPushUpsert('daily_ledger', [{
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
    }], 'ledger_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（daily_ledger）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}

/** 今日營業開始／結單。 */
function pushBizDayToSupabase(row) {
  if (!_sbPushEnabled() || !row) return;
  try {
    _sbPushUpsert('biz_days', [{
      biz_id: row.biz_id,
      business_date: row.business_date,
      opened_at: row.opened_at,
      opened_by: _sbPushUserId(row.opened_by),
      closed_at: row.closed_at || null,
      closed_by: _sbPushUserId(row.closed_by),
      auto_closed: !!row.auto_closed
    }], 'biz_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（biz_days）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}
