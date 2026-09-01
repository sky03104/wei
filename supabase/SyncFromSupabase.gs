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
 * - **records（記帳紀錄）：增量同步，但一定先比對過現有 record_id 才插入**。
 *   資料量大且持續成長，用資料庫的 `seq`（bigserial，插入順序，永遠
 *   遞增）當游標，每次只抓 `seq > 上次同步到的位置` 的資料，存進指令碼
 *   屬性 `SYNC_RECORDS_LAST_SEQ`。
 *
 *   **重要教訓（早期版本在這裡出過真的的 bug，見 CleanupDuplicateRecords.gs）**：
 *   「Supabase 裡 seq 比較新」不等於「試算表裡沒有這筆」——例如一筆紀錄
 *   本來就是從試算表搬過去 Supabase 的舊資料，它在 Supabase 那張表是
 *   第一次出現，一樣會分配到一個新的 seq。早期版本看到 seq 新就直接
 *   insert，把這種「其實試算表早就有」的紀錄又插入了一次，試算表
 *   Records 分頁因此出現大量重複列。現在改成：每次先讀一次試算表現有
 *   的 record_id 集合，只有真的不存在的才會被 insert，就算游標判斷
 *   失準（例如觸發器被重跑、cursor 被重置），也不會再插入重複列。
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

// ── 整表 upsert（有就更新、沒有就新增）──────────────────────
//
// 只在一開始呼叫一次 dbReadAll（讀整張表、建 key→_row 對照表），迴圈裡
// 只用這份記憶體裡的對照表判斷，不會再對同一張表重複呼叫 dbFind——
// 早期版本迴圈裡每列各自呼叫 dbFind（＝dbReadAll），而每次 dbUpdate／
// dbInsert 都會讓快取失效，變成「查一列、整張表重讀一次」疊加起來，
// 資料筆數雖然不多也會拖得很慢，實測甚至跑到撞 GAS 6 分鐘執行上限被
// 強制中斷。新增的部分最後用一次 dbInsertMany 整批寫入，不用逐列插入。

function _fullTableUpsert(sheetName, keyField, objs) {
  const existing = dbReadAll(sheetName);
  const byKey = {};
  existing.forEach(function (r) { byKey[r[keyField]] = r; });

  const toInsert = [];
  let updated = 0, unchanged = 0;
  objs.forEach(function (obj) {
    const row = byKey[obj[keyField]];
    if (!row) { toInsert.push(obj); return; }
    // 大部分列是已經同步過、內容沒變的歷史資料，真的有欄位不同才寫入，
    // 不用每次全量比對都把每一列重寫一遍。
    const changed = Object.keys(obj).some(function (k) { return String(row[k]) !== String(obj[k]); });
    if (changed) {
      dbUpdate(sheetName, row._row, obj);
      updated++;
    } else {
      unchanged++;
    }
  });
  if (toInsert.length) dbInsertMany(sheetName, toInsert);
  return { inserted: toInsert.length, updated: updated, unchanged: unchanged };
}

// ── 營業日：全量比對 ──────────────────────────────────────

function _syncBizDaysFromSupabase(SUPABASE_URL, KEY, uidMap) {
  const rows = _sbFetch(SUPABASE_URL, KEY, 'GET', '/rest/v1/biz_days?select=*&order=seq.asc', undefined) || [];
  const objs = rows.map(function (b) {
    return {
      biz_id: b.biz_id,
      business_date: b.business_date,
      opened_at: b.opened_at,
      opened_by: _sbMapUser(uidMap, b.opened_by),
      closed_at: b.closed_at || '',
      closed_by: _sbMapUser(uidMap, b.closed_by),
      auto_closed: !!b.auto_closed
    };
  });
  const result = _fullTableUpsert('BizDays', 'biz_id', objs);
  Logger.log('✓ biz_days：新增 ' + result.inserted + ' 筆、更新 ' + result.updated + ' 筆、內容沒變跳過 ' + result.unchanged + ' 筆');
}

// ── 每日手動帳目：全量比對 ──────────────────────────────────

function _syncDailyLedgerFromSupabase(SUPABASE_URL, KEY, uidMap) {
  const rows = _sbFetch(SUPABASE_URL, KEY, 'GET', '/rest/v1/daily_ledger?select=*&order=seq.asc', undefined) || [];
  const objs = rows.map(function (l) {
    return {
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
    };
  });
  const result = _fullTableUpsert('DailyLedger', 'ledger_id', objs);
  Logger.log('✓ daily_ledger：新增 ' + result.inserted + ' 筆、更新 ' + result.updated + ' 筆、內容沒變跳過 ' + result.unchanged + ' 筆');
}

// ── 記帳紀錄：用 seq 游標增量抓新增的 ──────────────────────

function _syncRecordsFromSupabase(SUPABASE_URL, KEY, uidMap, props) {
  const CURSOR_KEY = 'SYNC_RECORDS_LAST_SEQ';
  let cursor = Number(props.getProperty(CURSOR_KEY) || '0');
  const BATCH = 500;
  let totalNew = 0, totalSkippedExisting = 0;

  // 試算表現有的 record_id 集合，只讀一次（dbReadAll 本身有快取）——
  // 用這個當「保險」，不管游標算得準不準，都不會插入試算表已經有的紀錄。
  const existingIds = {};
  dbReadAll('Records').forEach(function (r) { existingIds[r.record_id] = true; });

  for (;;) {
    const rows = _sbFetch(SUPABASE_URL, KEY, 'GET',
      '/rest/v1/records?select=*&seq=gt.' + cursor + '&order=seq.asc&limit=' + BATCH, undefined) || [];
    if (!rows.length) break;

    const sheetRows = [];
    rows.forEach(function (r) {
      if (existingIds[r.record_id]) { totalSkippedExisting++; return; }
      existingIds[r.record_id] = true;
      sheetRows.push({
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
      });
    });

    if (sheetRows.length) dbInsertMany('Records', sheetRows);
    cursor = rows[rows.length - 1].seq;
    props.setProperty(CURSOR_KEY, String(cursor)); // 每批寫完就存游標，中途失敗不會重複處理已成功的批次
    totalNew += sheetRows.length;

    if (rows.length < BATCH) break;
  }

  Logger.log('✓ records：新增 ' + totalNew + ' 筆、跳過已存在 ' + totalSkippedExisting + ' 筆（游標目前在 seq=' + cursor + '）');
}
