/**
 * 定時同步（方向二）：把 Supabase 資料庫端新增/更新的資料寫回 Google 試算表。
 *
 * 跟 MigrateToSupabase.gs（方向一：試算表 → 資料庫）搭配，兩支都設成時間
 * 觸發器每 5 分鐘跑一次，就是完整的雙向同步。這份檔案會用到
 * MigrateToSupabase.gs 裡已經定義的 _sbFetch／_sbTrimSlash／_sbNum 等小工具，
 * 兩份檔案要貼在同一個 Apps Script 專案裡（沿用一樣的
 * SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY 指令碼屬性）。
 *
 * ── 設計重點 ──────────────────────────────────────────────
 *
 * - **records（記帳紀錄）：增量同步**。資料量大且持續成長，用資料庫的
 *   `seq`（bigserial，插入順序，永遠遞增）當游標，每次只抓
 *   `seq > 上次同步到的位置` 的新資料，存進指令碼屬性
 *   `SYNC_RECORDS_LAST_SEQ`。因為抓到的一定是試算表裡还沒有的新紀錄，
 *   直接整批 insert（不用先查有沒有已存在，快很多）。
 *   **已知限制**：資料庫端事後把一筆舊紀錄「作廢」（void），因為那是
 *   對已存在列的 UPDATE，`seq` 不會變，這支目前抓不到、不會同步作廢
 *   狀態回試算表。這個動作比較少見，先不處理；如果之後真的需要，
 *   可以另外寫一支專門同步作廢狀態的（用 voided_at 當游標）。
 * - **biz_days（營業日）／daily_ledger（每日帳目）：全量比對**。這兩張
 *   資料量小（一天頂多新增/更新個位數筆），而且「結單」「重新儲存
 *   今日數字」都是對已存在列的 UPDATE，用 seq 游標會漏掉這些更新——
 *   所以乾脆每次都整張表重新比對（有就更新、沒有就新增），資料量小，
 *   即使每 5 分鐘全量跑一次也不會有效能問題。
 * - **user_id 對照**：資料庫用 uuid，試算表用原本的文字 user_id，透過
 *   兩邊都有的 username 建對照表（Supabase profiles.username ↔ 試算表
 *   Users.username）。對不到的（理論上不該發生，除非帳號沒同步過）
 *   會留空並在執行記錄印警告。
 * - machines／prizes／quick_amounts／meter_rates／permissions／config
 *   這些設定類的表**不在這支的範圍內**——目前設計是只有管理員用資料庫版
 *   記帳，機台/獎型等設定維持在試算表端管理、由 MigrateToSupabase.gs
 *   單向帶去資料庫。如果之後也需要在資料庫端改這些設定並同步回試算表，
 *   要另外擴充。
 */

function syncFromSupabase() {
  const props = PropertiesService.getScriptProperties();
  const SUPABASE_URL = _sbTrimSlash(props.getProperty('SUPABASE_URL'));
  const SERVICE_ROLE_KEY = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('請先在「指令碼屬性」設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY。');
  }

  const uidMap = _sbBuildReverseUserIdMap(SUPABASE_URL, SERVICE_ROLE_KEY);

  _syncBizDaysFromSupabase(SUPABASE_URL, SERVICE_ROLE_KEY, uidMap);
  _syncDailyLedgerFromSupabase(SUPABASE_URL, SERVICE_ROLE_KEY, uidMap);
  _syncRecordsFromSupabase(SUPABASE_URL, SERVICE_ROLE_KEY, uidMap, props);

  Logger.log('\n🎉 資料庫 → 試算表 同步完成。');
}

// ── 使用者 id 對照（Supabase uuid ↔ 試算表 user_id） ──────────

function _sbBuildReverseUserIdMap(SUPABASE_URL, KEY) {
  const sheetUsers = dbReadAll('Users');
  const usernameToSheetId = {};
  sheetUsers.forEach(function (u) { usernameToSheetId[u.username] = u.user_id; });

  const profiles = _sbFetch(SUPABASE_URL, KEY, 'GET', '/rest/v1/profiles?select=id,username', undefined) || [];
  const map = {};
  profiles.forEach(function (p) {
    const sid = usernameToSheetId[p.username];
    if (sid) map[p.id] = sid;
    else Logger.log('⚠ Supabase 帳號 ' + p.username + ' 在試算表 Users 找不到對應帳號，涉及這個帳號的紀錄 user_id 會留空');
  });
  return map;
}

function _sbMapUser(uidMap, supabaseUuid) {
  if (!supabaseUuid) return '';
  return uidMap[supabaseUuid] || '';
}

// ── upsert 進試算表分頁（有就更新、沒有就新增） ──────────────

function _sheetUpsert(sheetName, keyField, obj) {
  const existing = dbFind(sheetName, keyField, obj[keyField]);
  if (existing) {
    dbUpdate(sheetName, existing._row, obj);
    return 'updated';
  }
  dbInsert(sheetName, obj);
  return 'inserted';
}

// ── 營業日：全量比對 ──────────────────────────────────────

function _syncBizDaysFromSupabase(SUPABASE_URL, KEY, uidMap) {
  const rows = _sbFetch(SUPABASE_URL, KEY, 'GET', '/rest/v1/biz_days?select=*&order=seq.asc', undefined) || [];
  let inserted = 0, updated = 0;
  rows.forEach(function (b) {
    const result = _sheetUpsert('BizDays', 'biz_id', {
      biz_id: b.biz_id,
      business_date: b.business_date,
      opened_at: b.opened_at,
      opened_by: _sbMapUser(uidMap, b.opened_by),
      closed_at: b.closed_at || '',
      closed_by: _sbMapUser(uidMap, b.closed_by),
      auto_closed: !!b.auto_closed
    });
    if (result === 'inserted') inserted++; else updated++;
  });
  Logger.log('✓ biz_days：新增 ' + inserted + ' 筆、更新 ' + updated + ' 筆');
}

// ── 每日手動帳目：全量比對 ──────────────────────────────────

function _syncDailyLedgerFromSupabase(SUPABASE_URL, KEY, uidMap) {
  const rows = _sbFetch(SUPABASE_URL, KEY, 'GET', '/rest/v1/daily_ledger?select=*&order=seq.asc', undefined) || [];
  let inserted = 0, updated = 0;
  rows.forEach(function (l) {
    const result = _sheetUpsert('DailyLedger', 'ledger_id', {
      ledger_id: l.ledger_id,
      business_date: l.business_date,
      turnover: l.turnover,
      transport: l.transport,
      given_to_owner: l.given_to_owner,
      taken_by_owner: l.taken_by_owner,
      returned_to_house: l.returned_to_house,
      updated_by: _sbMapUser(uidMap, l.updated_by),
      updated_at: l.updated_at,
      biz_id: l.biz_id || '',
      manual_432: l.manual_432,
      manual_441: l.manual_441,
      given_to_owner_items: JSON.stringify(l.given_to_owner_items || []),
      taken_by_owner_items: JSON.stringify(l.taken_by_owner_items || []),
      manual_expense: l.manual_expense
    });
    if (result === 'inserted') inserted++; else updated++;
  });
  Logger.log('✓ daily_ledger：新增 ' + inserted + ' 筆、更新 ' + updated + ' 筆');
}

// ── 記帳紀錄：用 seq 游標增量抓新增的 ──────────────────────

function _syncRecordsFromSupabase(SUPABASE_URL, KEY, uidMap, props) {
  const CURSOR_KEY = 'SYNC_RECORDS_LAST_SEQ';
  let cursor = Number(props.getProperty(CURSOR_KEY) || '0');
  const BATCH = 500;
  let totalNew = 0;

  for (;;) {
    const rows = _sbFetch(SUPABASE_URL, KEY, 'GET',
      '/rest/v1/records?select=*&seq=gt.' + cursor + '&order=seq.asc&limit=' + BATCH, undefined) || [];
    if (!rows.length) break;

    const sheetRows = rows.map(function (r) {
      return {
        record_id: r.record_id,
        machine_id: r.machine_id,
        type: r.type,
        amount: r.amount,
        prize_id: r.prize_id || '',
        prize_name: r.prize_name || '',
        unit_amount: (r.unit_amount === null || r.unit_amount === undefined) ? '' : r.unit_amount,
        count: (r.count === null || r.count === undefined) ? '' : r.count,
        user_id: _sbMapUser(uidMap, r.user_id),
        created_at: r.created_at,
        note: r.note || '',
        voided: !!r.voided,
        voided_by: _sbMapUser(uidMap, r.voided_by),
        voided_at: r.voided_at || '',
        client_token: r.client_token || '',
        meter_start: (r.meter_start === null || r.meter_start === undefined) ? '' : r.meter_start,
        meter_end: (r.meter_end === null || r.meter_end === undefined) ? '' : r.meter_end,
        business_date: r.business_date
      };
    });

    dbInsertMany('Records', sheetRows);
    cursor = rows[rows.length - 1].seq;
    props.setProperty(CURSOR_KEY, String(cursor)); // 每批寫完就存游標，中途失敗不會重複寫入已成功的批次
    totalNew += rows.length;

    if (rows.length < BATCH) break;
  }

  Logger.log('✓ records：新增 ' + totalNew + ' 筆（游標目前在 seq=' + cursor + '）');
}
