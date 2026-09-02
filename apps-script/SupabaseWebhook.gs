/**
 * SupabaseWebhook.gs — 接收 Supabase 那邊資料異動的 webhook，即時寫回試算表。
 *
 * 跟 SupabasePush.gs（試算表 → 資料庫即時化）相反方向：這支處理
 * 「資料庫 → 試算表」的即時化，取代／補強 supabase/SyncFromSupabase.gs
 * 那個每 5 分鐘跑一次的定期同步——定期同步繼續留著當保險網（webhook
 * 沒送到、Supabase 那邊 pg_net 佇列卡住時的補救），不是拿掉。
 *
 * ── 整體流程 ──────────────────────────────────────────────
 *
 * Supabase 的 records／daily_ledger／biz_days 三張表各自掛一個
 * AFTER INSERT OR UPDATE 的 trigger（SQL 見 supabase/webhook-trigger.sql），
 * 異動當下用 pg_net 打一次 HTTP POST 到這個 GAS 專案的 Web App 網址，
 * body 是 `{type, table, schema, record, old_record}` 這個固定格式。
 *
 * doPost() 收到請求後，先看網址上有沒有 `webhookSecret` 這個查詢字串
 * 參數——有的話走這支檔案的 `_handleSupabaseWebhook()`，不是原本
 * `handleApi()` 那條給前端 App 用的路徑。
 *
 * ── 安全性 ────────────────────────────────────────────────
 *
 * Apps Script 的 doPost(e) **收不到自訂的 HTTP 標頭**（這是 GAS 的限制，
 * 不是我們沒做），沒辦法比照一般 API 用 `Authorization` 標頭驗證，
 * 所以驗證方式改成：Supabase 那邊設定的 webhook 網址裡帶一段隨機字串
 * （`?webhookSecret=...`），這裡比對這個查詢字串參數是不是跟指令碼屬性
 * `SUPABASE_WEBHOOK_SECRET` 存的值一樣，不一樣就直接拒絕、什麼都不做。
 * 這段隨機字串要夠長、夠隨機，外流的話等於任何人都能偽造資料庫異動
 * 事件寫進試算表，務必只在這裡跟 Supabase 的 trigger SQL 裡出現，
 * 不要貼到別的地方。
 *
 * ── 為什麼可以直接整批 upsert，不用像 SyncFromSupabase.gs 那樣分
 *    「新增用 seq 游標」「作廢用 voided_at 游標」兩套 ──────────────
 *
 * 定期同步是「回頭去問資料庫有什麼」，只知道最後結果，沒辦法知道
 * 這個結果是「新增」還是「事後被改過」，所以才需要兩套游標分開處理。
 * Webhook 不一樣：**Supabase 直接把「這一次異動之後的完整那一列」
 * (`record`) 送過來**，不管是新增還是更新（含作廢），統統用同一招
 * 「有就更新、沒有就新增」的 upsert 處理就好，比定期同步單純很多。
 */

function _handleSupabaseWebhook(e) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('SUPABASE_WEBHOOK_SECRET');
  const given = e && e.parameter && e.parameter.webhookSecret;
  if (!expected || given !== expected) {
    return _json({ ok: false, error: '未授權', code: 'FORBIDDEN' });
  }

  let body;
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return _json({ ok: false, error: 'JSON 格式不正確' });
  }

  try {
    withLock(function () {
      _applySupabaseWebhookEvent(body);
    });
    return _json({ ok: true });
  } catch (err) {
    // webhook 失敗不用讓 Supabase 那邊一直重試（pg_net 本身不重試），
    // 只要記下來，缺的那筆之後定期同步（syncFromSupabase）會補上。
    Logger.log('⚠ 處理 Supabase webhook 失敗（' + (body && body.table) + '）：' + (err && err.message) + '——下次定期同步會補上');
    return _json({ ok: false, error: String((err && err.message) || err) });
  }
}

function _applySupabaseWebhookEvent(body) {
  const table = body && body.table;
  const type = body && body.type;
  const row = body && body.record;
  if (!row) return; // DELETE 事件只有 old_record，目前不處理（系統本來就不做硬刪除）

  if (table === 'records') {
    _webhookUpsertRecord(row);
  } else if (table === 'daily_ledger') {
    _webhookUpsertDailyLedger(row);
  } else if (table === 'biz_days') {
    _webhookUpsertBizDay(row);
  } else {
    Logger.log('⚠ webhook 收到不認得的表：' + table + '（type=' + type + '），已忽略');
  }
}

/**
 * Supabase uuid → 試算表文字 user_id，跟 SupabasePush.gs 的
 * _sbPushUserId() 方向相反（那支是查「這個試算表帳號在 Supabase 是誰」，
 * 這支是查「Supabase 這個 uuid 在試算表是誰」），但都是靠 username 對照，
 * 同樣用 CacheService 快取 1 小時。
 */
function _webhookUserId(supabaseUuid) {
  if (!supabaseUuid) return '';
  const cache = CacheService.getScriptCache();
  const cacheKey = 'sbWebhookUidMap';
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
    if (!Array.isArray(profiles)) throw new Error('profiles 回應格式不是陣列：' + text);
    profiles.forEach(function (p) {
      const sid = usernameToSheetId[p.username];
      if (sid) map[p.id] = sid;
    });
    try { cache.put(cacheKey, JSON.stringify(map), 3600); } catch (e) { /* 快取放不下就算了 */ }
  }
  return map[supabaseUuid] || '';
}

/** 有就更新、沒有就新增，回傳 'inserted' 或 'updated'。 */
function _sheetUpsertRow(sheetName, keyField, obj) {
  const existing = dbFind(sheetName, keyField, obj[keyField]);
  if (existing) {
    dbUpdate(sheetName, existing._row, obj);
    return 'updated';
  }
  dbInsert(sheetName, obj);
  return 'inserted';
}

function _webhookUpsertRecord(r) {
  const validMachine = !!dbFind('Machines', 'machine_id', r.machine_id);
  if (!validMachine) {
    Logger.log('⚠ webhook records：machine_id=' + r.machine_id + ' 在試算表找不到，已跳過（' + r.record_id + '）');
    return;
  }
  const result = _sheetUpsertRow('Records', 'record_id', {
    record_id: r.record_id,
    machine_id: r.machine_id,
    type: r.type,
    amount: r.amount,
    prize_id: r.prize_id || '',
    prize_name: r.prize_name || '',
    unit_amount: (r.unit_amount === null || r.unit_amount === undefined) ? '' : r.unit_amount,
    count: (r.count === null || r.count === undefined) ? '' : r.count,
    user_id: _webhookUserId(r.user_id),
    created_at: r.created_at,
    note: r.note || '',
    voided: !!r.voided,
    voided_by: _webhookUserId(r.voided_by),
    voided_at: r.voided_at || '',
    client_token: r.client_token || '',
    meter_start: (r.meter_start === null || r.meter_start === undefined) ? '' : r.meter_start,
    meter_end: (r.meter_end === null || r.meter_end === undefined) ? '' : r.meter_end,
    business_date: r.business_date
  });
  Logger.log('✓ webhook records：' + result + '（' + r.record_id + '）');
}

function _webhookUpsertDailyLedger(l) {
  const result = _sheetUpsertRow('DailyLedger', 'ledger_id', {
    ledger_id: l.ledger_id,
    business_date: l.business_date,
    turnover: l.turnover,
    transport: l.transport,
    given_to_owner: 0,
    taken_by_owner: 0,
    given_to_owner_items: JSON.stringify(l.given_to_owner_items || []),
    taken_by_owner_items: JSON.stringify(l.taken_by_owner_items || []),
    returned_to_house: l.returned_to_house,
    updated_by: _webhookUserId(l.updated_by),
    updated_at: l.updated_at,
    biz_id: l.biz_id || '',
    manual_432: l.manual_432,
    manual_441: l.manual_441,
    manual_expense: l.manual_expense
  });
  Logger.log('✓ webhook daily_ledger：' + result + '（' + l.ledger_id + '）');
}

function _webhookUpsertBizDay(b) {
  const result = _sheetUpsertRow('BizDays', 'biz_id', {
    biz_id: b.biz_id,
    business_date: b.business_date,
    opened_at: b.opened_at,
    opened_by: _webhookUserId(b.opened_by),
    closed_at: b.closed_at || '',
    closed_by: _webhookUserId(b.closed_by),
    auto_closed: !!b.auto_closed
  });
  Logger.log('✓ webhook biz_days：' + result + '（' + b.biz_id + '）');
}
