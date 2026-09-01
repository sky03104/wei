/**
 * 一鍵搬遷：直接從這個 GAS 專案把試算表資料寫進 Supabase，不需要本機
 * Node.js／curl／PowerShell。
 *
 * ── 使用方式 ──────────────────────────────────────────────
 *
 * 1. 把這份檔案整個貼進「娃娃機資料庫版GAS」這個 Apps Script 專案
 *    （左側檔案列表 → 「檔案」旁邊的 + → 指令碼 → 貼進來，檔名隨意，
 *    例如 MigrateToSupabase）。這個專案本來就有 exportAllData()
 *    （在 Archive.gs），這份檔案會直接呼叫它，不用重複寫一次。
 *
 * 2. 左側齒輪圖示「專案設定」→「指令碼屬性」，新增：
 *      SUPABASE_URL              https://gwwuzmspgvpzlstvafov.supabase.co
 *      SUPABASE_SERVICE_ROLE_KEY 你的 service_role key（Supabase 後台
 *                                 Settings → API Keys）
 *      RESET_RECORDS_AND_LEDGER  yes
 *        （這個要清空 records/daily_ledger 重新匯入才需要設成 yes；
 *          不設或設成別的值，行為就是單純 upsert，不會刪除任何東西）
 *
 * 3. 上方選單選這個檔案裡的 migrateToSupabase 函式，按「執行」。
 *    第一次執行 GAS 會跳出授權視窗（因為要對外呼叫 Supabase），照畫面
 *    指示允許即可。
 *
 * 4. 執行完到左側「執行記錄」看結果——帳號的臨時密碼會印在裡面
 *    （格式：帳號 / 合成 email / 臨時密碼 / 角色），截圖存好、發給
 *    對應的人，然後從執行記錄裡把這幾行清掉（執行記錄本身不會外流，
 *    但養成習慣比較好）。
 *
 * ── 設計重點（跟 supabase/migrate-from-sheets.js 對照）──────────
 *
 * - 邏輯、欄位對應、寫入順序都跟 Node 版本一致：帳號→machines→
 *   prizes/quick_amounts/meter_rates→permissions→config→biz_days→
 *   daily_ledger→records（分批 500 筆）。
 * - upsert 一律用 Supabase REST API（PostgREST）的
 *   `Prefer: resolution=merge-duplicates` 達成，等價於 supabase-js
 *   的 `.upsert()`。
 * - 帳號密碼一樣沒辦法直接搬（GAS 的雜湊演算法跟 Supabase Auth 不是
 *   同一套），一樣用合成 email + 隨機臨時密碼，一樣經 Auth Admin API
 *   （這裡改用 REST 端點 `/auth/v1/admin/users`，效果跟 supabase-js
 *   的 `auth.admin.createUser()` 相同）。
 * - RESET_RECORDS_AND_LEDGER=yes 時，寫入前先清空 daily_ledger、
 *   records 兩張表（用 `?seq=gte.0` 當「符合全部列」的篩選條件，
 *   PostgREST 的 DELETE 一定要帶篩選條件，不能無條件砍全表）。
 * - machine_id 對不到任何已匯入機台的紀錄、找不到對應帳號的紀錄／
 *   授權，一律跳過並印警告，不讓整批因為外鍵衝突全部失敗——跟 Node
 *   版本處理方式一致。
 */

function migrateToSupabase() {
  const props = PropertiesService.getScriptProperties();
  const SUPABASE_URL = _sbTrimSlash(props.getProperty('SUPABASE_URL'));
  const SERVICE_ROLE_KEY = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  const RESET = props.getProperty('RESET_RECORDS_AND_LEDGER') === 'yes';
  const EMAIL_DOMAIN = props.getProperty('MIGRATION_EMAIL_DOMAIN') || 'migrated.local';
  const RECORDS_BATCH_SIZE = 500;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('請先在「指令碼屬性」設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY。');
  }

  const raw = exportAllData({ role: ROLE_ADMIN });
  Logger.log('匯出時間：' + raw.exportedAt);
  Logger.log('帳號 ' + raw.users.length + '、機台 ' + raw.machines.length + '、紀錄 ' + raw.records.length + ' 筆');

  if (RESET) {
    Logger.log('⚠ RESET_RECORDS_AND_LEDGER=yes，先清空 daily_ledger 與 records 兩張表再重新匯入。');
    _sbWipe(SUPABASE_URL, SERVICE_ROLE_KEY, 'daily_ledger');
    _sbWipe(SUPABASE_URL, SERVICE_ROLE_KEY, 'records');
  }

  // 1) 帳號 → Supabase Auth + profiles，順便建立 舊 user_id → 新 uuid 對照表
  const userIdMap = {};
  const credentialLines = [];
  raw.users.forEach(function (u) {
    userIdMap[u.userId] = _sbUpsertUser(SUPABASE_URL, SERVICE_ROLE_KEY, EMAIL_DOMAIN, u, credentialLines);
  });
  if (credentialLines.length) {
    Logger.log('\n⚠ 已產生 ' + credentialLines.length + ' 組臨時密碼（帳號 / email / 臨時密碼 / 角色）：\n' +
      credentialLines.join('\n') +
      '\n請個別發給對應的人，並提醒他們登入後立刻改密碼，看完把這幾行從執行記錄清掉。\n');
  }

  // 2) 機台
  _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'machines', raw.machines.map(function (m) {
    return {
      machine_id: m.machineId, name: m.name, location: m.location || '', status: m.status || 'running',
      color: m.color || '#4F7BE8', sort_order: _sbNum(m.sortOrder, 0), note: m.note || '',
      created_at: m.createdAt || new Date().toISOString(), category: m.category || 'dice', icon: m.icon || 'classic'
    };
  }), 'machine_id');

  // 3) 全局預設/單台覆寫設定
  _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'prizes', raw.prizes.map(function (p) {
    return { prize_id: p.prizeId, machine_id: p.machineId || '', name: p.name, amount: _sbNum(p.amount, 0), sort_order: _sbNum(p.sortOrder, 0), active: !!p.active };
  }), 'prize_id');

  _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'quick_amounts', raw.quickAmounts.map(function (q) {
    return { qa_id: q.qaId, machine_id: q.machineId || '', type: q.type, amount: _sbNum(q.amount, 0), label: q.label || '', sort_order: _sbNum(q.sortOrder, 0) };
  }), 'qa_id');

  _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'meter_rates', raw.meterRates.map(function (r) {
    return { rate_id: r.rateId, machine_id: r.machineId || '', rate: _sbNum(r.rate, 100) };
  }), 'rate_id');

  // 4) 台主授權
  const permissionRows = [];
  raw.permissions.forEach(function (p) {
    const uid = userIdMap[p.userId];
    if (!uid) { Logger.log('⚠ 授權紀錄找不到對應帳號（user_id=' + p.userId + '），跳過'); return; }
    permissionRows.push({
      user_id: uid, machine_id: p.machineId,
      granted_by: p.grantedBy ? (userIdMap[p.grantedBy] || null) : null,
      granted_at: p.grantedAt || new Date().toISOString()
    });
  });
  _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'permissions', permissionRows, 'user_id,machine_id');

  // 5) 系統設定
  _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'config', raw.config.map(function (c) {
    return { key: c.key, value: c.value || '' };
  }), 'key');

  // 6) 營業日
  _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'biz_days', raw.bizDays.map(function (b) {
    return {
      biz_id: b.bizId, business_date: b.businessDate, opened_at: b.openedAt,
      opened_by: b.openedBy ? (userIdMap[b.openedBy] || null) : null,
      closed_at: b.closedAt || null, closed_by: b.closedBy ? (userIdMap[b.closedBy] || null) : null,
      auto_closed: !!b.autoClosed
    };
  }), 'biz_id');

  // 7) 每日手動帳目
  _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'daily_ledger', raw.dailyLedger.map(function (l) {
    return {
      ledger_id: l.ledgerId, business_date: l.businessDate, turnover: _sbNum(l.turnover, 0),
      transport: _sbNum(l.transport, 0), given_to_owner: _sbNum(l.givenToOwner, 0), taken_by_owner: _sbNum(l.takenByOwner, 0),
      returned_to_house: _sbNum(l.returnedToHouse, 0), updated_by: l.updatedBy ? (userIdMap[l.updatedBy] || null) : null,
      updated_at: l.updatedAt || new Date().toISOString(), biz_id: l.bizId || null,
      manual_432: _sbNum(l.manual432, 0), manual_441: _sbNum(l.manual441, 0),
      given_to_owner_items: _sbParseJson(l.givenToOwnerItems), taken_by_owner_items: _sbParseJson(l.takenByOwnerItems),
      manual_expense: _sbNum(l.manualExpense, 0)
    };
  }), 'ledger_id');

  // 8) 紀錄（分批寫入，最後做；machine_id/user_id 對不到的先濾掉，避免整批因外鍵失敗）
  const validMachineIds = {};
  raw.machines.forEach(function (m) { validMachineIds[m.machineId] = true; });
  const recordRows = [];
  let skippedUser = 0, skippedMachine = 0;
  raw.records.forEach(function (r) {
    const uid = userIdMap[r.userId];
    if (!uid) { skippedUser++; return; }
    if (!validMachineIds[r.machineId]) { skippedMachine++; return; }
    recordRows.push({
      record_id: r.recordId, machine_id: r.machineId, type: r.type, amount: _sbNum(r.amount, 0),
      prize_id: r.prizeId || null, prize_name: r.prizeName || '', unit_amount: _sbNumOrNull(r.unitAmount), count: _sbNumOrNull(r.count),
      user_id: uid, created_at: r.createdAt, note: r.note || '', voided: !!r.voided,
      voided_by: r.voidedBy ? (userIdMap[r.voidedBy] || null) : null, voided_at: r.voidedAt || null,
      client_token: r.clientToken || null, meter_start: _sbNumOrNull(r.meterStart), meter_end: _sbNumOrNull(r.meterEnd),
      business_date: r.businessDate
    });
  });
  if (skippedUser) Logger.log('⚠ ' + skippedUser + ' 筆紀錄找不到對應帳號，已跳過');
  if (skippedMachine) Logger.log('⚠ ' + skippedMachine + ' 筆紀錄的 machine_id 對不到任何一台已匯入機台，已跳過');

  for (let i = 0; i < recordRows.length; i += RECORDS_BATCH_SIZE) {
    const batch = recordRows.slice(i, i + RECORDS_BATCH_SIZE);
    _sbUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, 'records', batch, 'record_id', 'records（第 ' + (i / RECORDS_BATCH_SIZE + 1) + ' 批）');
  }

  Logger.log('\n🎉 遷移完成。建議接著在 Supabase SQL Editor 跑一次 supabase/verify-migration.sql 核對筆數。');
}

// ── 小工具 ────────────────────────────────────────────────

function _sbTrimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function _sbNum(v, fallback) {
  if (v === '' || v === undefined || v === null) return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function _sbNumOrNull(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function _sbParseJson(v) {
  if (v === '' || v === undefined || v === null) return [];
  if (typeof v !== 'string') return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function _sbFetch(SUPABASE_URL, KEY, method, path, payload, extraHeaders) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
  const options = { method: method, headers: headers, muteHttpExceptions: true };
  if (payload !== undefined) options.payload = JSON.stringify(payload);
  const resp = UrlFetchApp.fetch(SUPABASE_URL + path, options);
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code >= 300) throw new Error('Supabase 請求失敗 (' + code + ') ' + method + ' ' + path + '：' + text);
  return text ? JSON.parse(text) : null;
}

function _sbUpsert(SUPABASE_URL, KEY, table, rows, onConflict, label) {
  if (!rows.length) { Logger.log('· ' + (label || table) + '：0 筆，跳過'); return; }
  const path = '/rest/v1/' + table + '?on_conflict=' + encodeURIComponent(onConflict);
  _sbFetch(SUPABASE_URL, KEY, 'POST', path, rows, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  Logger.log('✓ ' + (label || table) + '：' + rows.length + ' 筆');
}

/** seq 是 bigserial（永遠 >= 1），?seq=gte.0 當「符合全部列」的篩選條件——
 * PostgREST 的 DELETE 一定要帶篩選條件，不能無條件砍全表。*/
function _sbWipe(SUPABASE_URL, KEY, table) {
  _sbFetch(SUPABASE_URL, KEY, 'DELETE', '/rest/v1/' + table + '?seq=gte.0', undefined, { Prefer: 'return=minimal' });
  Logger.log('🗑 已清空 ' + table);
}

function _sbUpsertUser(SUPABASE_URL, KEY, EMAIL_DOMAIN, u, credentialLines) {
  const existing = _sbFetch(SUPABASE_URL, KEY, 'GET', '/rest/v1/profiles?username=eq.' + encodeURIComponent(u.username) + '&select=id', undefined);
  if (existing && existing.length) {
    Logger.log('· 帳號 ' + u.username + '：已存在，跳過建立（沿用既有 id）');
    return existing[0].id;
  }

  const email = u.username.toLowerCase() + '@' + EMAIL_DOMAIN;
  const tempPassword = Utilities.getUuid().replace(/-/g, '');

  const created = _sbFetch(SUPABASE_URL, KEY, 'POST', '/auth/v1/admin/users', {
    email: email, password: tempPassword, email_confirm: true,
    user_metadata: { username: u.username, migrated_from: 'gas-sheets' }
  });
  const newId = created && (created.id || (created.user && created.user.id));
  if (!newId) throw new Error('建立 Auth 帳號失敗（' + u.username + '）：' + JSON.stringify(created));

  credentialLines.push(u.username + '\t' + email + '\t' + tempPassword + '\t' + u.role);

  _sbFetch(SUPABASE_URL, KEY, 'POST', '/rest/v1/profiles?on_conflict=id', [{
    id: newId, username: u.username, display_name: u.displayName || u.username,
    role: u.role, status: u.status || 'active', created_at: u.createdAt || new Date().toISOString(),
    last_login_at: u.lastLoginAt || null
  }], { Prefer: 'resolution=merge-duplicates,return=minimal' });

  Logger.log('✓ 帳號 ' + u.username + '：建立完成');
  return newId;
}
