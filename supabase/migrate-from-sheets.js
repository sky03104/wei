#!/usr/bin/env node
/**
 * Phase 4：把 Google Sheets 裡的現有資料搬進 Postgres（Supabase）。
 *
 * 這支腳本要在「能同時連到 Google 跟 Supabase」的環境跑（你自己的電腦），
 * 不是在 Claude 的 sandbox 裡跑——sandbox 的網路政策只放行走代理的少數
 * 網域，連不到任意的 Supabase 專案。
 *
 * ── 使用方式 ──────────────────────────────────────────────
 *
 * 1. 先把這個分支的 apps-script/dist/Code.gs（含新加的 exportAllData
 *    action）暫時貼進你 GAS 專案的編輯器、存檔、部署一個新版本
 *    （不用建新的部署網址，用現有的 /exec 網址就好，只是內容換一下）。
 *    這個 action 只有管理員能打，遷移完成後可以把 GAS 換回 main 分支
 *    的版本（exportAllData 不影響任何現有功能，留著也不會壞事，但
 *    確認遷移穩定後建議拿掉，减少一個攻擊面）。
 *
 * 2. 用管理員帳號登入拿到 token，打一次 exportAllData，把回傳的 JSON
 *    存成本機檔案（預設檔名 data-export.json，放在這個腳本旁邊）：
 *
 *      curl -s -X POST 'https://你的GAS部署網址/exec' \
 *        --data-urlencode 'action=exportAllData' \
 *        --data-urlencode 'token=你的登入token' \
 *        | node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(0)).data))" \
 *        > supabase/data-export.json
 *
 *    （GAS 回應包一層 {ok:true, data:{...}}，上面那段 node -e 是把
 *    data 那層拆出來單獨存檔；也可以自己用瀏覽器/Postman 打完，
 *    手動把 data 那層另存成 data-export.json。）
 *
 * 3. 安裝依賴、設定環境變數、執行：
 *
 *      npm install @supabase/supabase-js
 *      export SUPABASE_URL='https://xxxx.supabase.co'
 *      export SUPABASE_SERVICE_ROLE_KEY='拿 Settings > API Keys 裡的 service_role key'
 *      node supabase/migrate-from-sheets.js
 *
 *    SERVICE_ROLE_KEY 是最高權限的 key，只能在這種一次性、本機執行的
 *    腳本用，絕對不能放進前端程式碼或提交進 git。
 *
 * ── 設計重點 ──────────────────────────────────────────────
 *
 * - **冪等**：所有寫入都用 upsert（衝突就跳過或覆蓋），腳本中途失敗
 *   重跑一次是安全的，不會產生重複資料。
 * - **帳號密碼沒辦法遷移**：GAS 版本的雜湊演算法（PBKDF2 變形）跟
 *   Supabase Auth 用的不是同一套，沒辦法直接搬密碼過去。這支腳本會
 *   幫每個帳號建立一組隨機臨時密碼、寫進本機的
 *   migration-credentials.txt（.gitignore 已排除，不會進 git），
 *   遷移完成後要嘛請每個人用臨時密碼登入後自己改密碼，要嘛在 Supabase
 *   Auth 後台個別觸發「忘記密碼」重發驗證信。
 * - **email 是合成的**：Supabase Auth 一定要 email，舊系統是純帳號制
 *   （沒有 email 欄位）。這裡用 `${username}@${MIGRATION_EMAIL_DOMAIN}`
 *   當合成 email，只是拿來滿足 Supabase Auth 的必填欄位，不會真的
 *   寄信到那個地址——之後要接「username 登入」（policies.sql 底部
 *   註解掉的 resolve_username_email() 草稿）也是靠這個合成 email
 *   規則對應回去。
 * - **不搬 carry_* 欄位**：那是配合 Sheets 季度封存機制的「封存前累計」，
 *   Postgres 版本因為不需要季度封存，records 表本身合併了全部歷史，
 *   不需要這個欄位，也不會匯出（見 apps-script/Archive.gs 的
 *   exportAllData() 註解）。
 * - **Records 分批寫入**：資料量可能上萬筆，一次 insert 太大會超過
 *   PostgREST 的請求大小限制，這裡固定每批 500 筆。
 *
 * ── 重新整批同步（清掉資料庫裡的測試資料）──────────────────
 *
 * 平常這支腳本是 upsert（只新增/覆蓋，不會刪除資料庫裡多出來的資料）。
 * 如果資料庫端在 Phase 5 雙軌測試時，透過 App 介面按出了一堆測試用的
 * 記帳紀錄／每日帳目，這些不會被 upsert 自動清掉——這時候想要「資料庫
 * = 試算表的乾淨鏡像」，把環境變數 `RESET_RECORDS_AND_LEDGER` 設成
 * `yes` 再執行：
 *
 *   export RESET_RECORDS_AND_LEDGER=yes
 *   node supabase/migrate-from-sheets.js
 *
 * 這會在寫入前先清空 `daily_ledger` 跟 `records` 兩張表（帳號、機台、
 * 獎型、快捷金額、費率、授權、系統設定、營業日都不動，只清這兩張），
 * 再照原本的流程從匯出檔案重新寫入一份乾淨的。務必先確認
 * `data-export.json` 是「剛剛才從試算表重新匯出」的最新版本，不然會
 * 拿舊資料把資料庫洗回去。
 *
 * 沒有設這個環境變數的話行為完全不變（純 upsert，不會刪除任何東西）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPORT_FILE = process.env.SHEETS_EXPORT_FILE || path.join(__dirname, 'data-export.json');
const EMAIL_DOMAIN = process.env.MIGRATION_EMAIL_DOMAIN || 'migrated.local';
const CREDENTIALS_FILE = path.join(__dirname, 'migration-credentials.txt');
const RECORDS_BATCH_SIZE = 500;
const RESET_RECORDS_AND_LEDGER = process.env.RESET_RECORDS_AND_LEDGER === 'yes';

function fail(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  fail('請先設定環境變數 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY（見檔案開頭的使用說明）。');
}
if (!fs.existsSync(EXPORT_FILE)) {
  fail('找不到匯出檔案：' + EXPORT_FILE + '\n請先用管理員帳號打 exportAllData action，把回傳的 data 存成這個檔案（見檔案開頭的使用說明）。');
}

let createClient;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch (e) {
  fail('缺少 @supabase/supabase-js，先跑：npm install @supabase/supabase-js');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ── 小工具：把 Sheets 匯出的值轉成 Postgres 欄位該有的型別 ──────

/** 空字串／undefined → null（Postgres 的 nullable 欄位、外鍵欄位常用）。*/
function nullIfEmpty(v) {
  return v === '' || v === undefined || v === null ? null : v;
}

/** 數字欄位：空字串／undefined → null，其餘轉成 Number。*/
function toNumOrNull(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 布林欄位：Sheets 存的可能是 true/false（boolean）或 'TRUE'/'FALSE'（字串）。*/
function toBool(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

/**
 * given_to_owner_items／taken_by_owner_items：GAS 那邊用 TEXT_COLUMNS
 * 鎖成純文字存 JSON.stringify 過的字串，這裡要 parse 回物件才能塞進
 * Postgres 的 jsonb 欄位。
 */
function parseJsonColumn(v) {
  if (v === '' || v === undefined || v === null) return [];
  if (typeof v !== 'string') return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function upsert(table, rows, onConflict, label) {
  if (!rows.length) {
    console.log('· ' + (label || table) + '：0 筆，跳過');
    return;
  }
  const { error } = await supabase.from(table).upsert(rows, { onConflict });
  if (error) fail((label || table) + ' 寫入失敗：' + error.message);
  console.log('✓ ' + (label || table) + '：' + rows.length + ' 筆');
}

/** seq 是 bigserial（永遠 >= 1），用 gte 0 當「符合全部列」的條件——
 * Supabase JS 的 delete() 一定要帶篩選條件，不能無條件砍全表。*/
async function wipeTable(table, label) {
  const { error, count } = await supabase.from(table).delete({ count: 'exact' }).gte('seq', 0);
  if (error) fail('清空 ' + (label || table) + ' 失敗：' + error.message);
  console.log('🗑 已清空 ' + (label || table) + '（刪除 ' + (count == null ? '?' : count) + ' 筆）');
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  const raw = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
  ['users', 'machines', 'records'].forEach(function (k) {
    if (!Array.isArray(raw[k])) fail('匯出檔案格式不對，缺少 "' + k + '" 陣列。是不是存錯層了（要存 GAS 回應的 data 那層，不是整包回應）？');
  });

  console.log('匯出時間：' + (raw.exportedAt || '未知'));
  console.log('帳號 ' + raw.users.length + '、機台 ' + raw.machines.length + '、紀錄 ' + raw.records.length + ' 筆\n');

  if (RESET_RECORDS_AND_LEDGER) {
    console.log('⚠ RESET_RECORDS_AND_LEDGER=yes，先清空 daily_ledger 與 records 兩張表再重新匯入。\n');
    // daily_ledger 有 biz_id 參照 biz_days，但沒有東西反過來參照
    // daily_ledger／records，兩張互不依賴，清空順序不影響正確性。
    await wipeTable('daily_ledger');
    await wipeTable('records');
    console.log('');
  }

  // 1) 帳號 → Supabase Auth + profiles，順便建立 舊 user_id → 新 uuid 對照表
  const userIdMap = {}; // old user_id (text) -> new uuid
  const credentialLines = [];

  for (const u of raw.users) {
    const { data: existing } = await supabase.from('profiles').select('id').eq('username', u.username).maybeSingle();
    if (existing) {
      userIdMap[u.userId] = existing.id;
      console.log('· 帳號 ' + u.username + '：已存在，跳過建立（沿用既有 id）');
      continue;
    }

    const email = u.username.toLowerCase() + '@' + EMAIL_DOMAIN;
    const tempPassword = crypto.randomBytes(9).toString('base64url');

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { username: u.username, migrated_from: 'gas-sheets' }
    });
    if (createErr) fail('建立 Auth 帳號失敗（' + u.username + '）：' + createErr.message);

    const newId = created.user.id;
    userIdMap[u.userId] = newId;
    credentialLines.push(u.username + '\t' + email + '\t' + tempPassword + '\t' + u.role);

    const { error: profileErr } = await supabase.from('profiles').upsert({
      id: newId,
      username: u.username,
      display_name: u.displayName || u.username,
      role: u.role,
      status: u.status || 'active',
      created_at: u.createdAt || new Date().toISOString(),
      last_login_at: nullIfEmpty(u.lastLoginAt)
    }, { onConflict: 'id' });
    if (profileErr) fail('寫入 profiles 失敗（' + u.username + '）：' + profileErr.message);

    console.log('✓ 帳號 ' + u.username + '：建立完成');
  }

  if (credentialLines.length) {
    const header = 'username\temail（合成，僅供登入用不會真的收信）\t臨時密碼\trole\n' +
      '# 這個檔案含明文密碼，只在這台電腦保留、發完密碼給對應的人之後請刪除，不要提交進 git。\n';
    fs.writeFileSync(CREDENTIALS_FILE, header + credentialLines.join('\n') + '\n');
    console.log('\n⚠ 已產生 ' + credentialLines.length + ' 組臨時密碼，存在：' + CREDENTIALS_FILE);
    console.log('  請個別發給對應的人，並提醒他們登入後立刻改密碼。\n');
  }

  // 2) 機台（不搬 carry_* 欄位，見檔案開頭說明）
  await upsert('machines', raw.machines.map(function (m) {
    return {
      machine_id: m.machineId,
      name: m.name,
      location: m.location || '',
      status: m.status || 'running',
      color: m.color || '#4F7BE8',
      sort_order: toNumOrNull(m.sortOrder) || 0,
      note: m.note || '',
      created_at: m.createdAt || new Date().toISOString(),
      category: m.category || 'dice',
      icon: m.icon || 'classic'
    };
  }), 'machine_id');

  // 3) 全局預設/單台覆寫設定
  await upsert('prizes', raw.prizes.map(function (p) {
    return {
      prize_id: p.prizeId,
      machine_id: p.machineId || '',
      name: p.name,
      amount: toNumOrNull(p.amount) || 0,
      sort_order: toNumOrNull(p.sortOrder) || 0,
      active: toBool(p.active)
    };
  }), 'prize_id');

  await upsert('quick_amounts', raw.quickAmounts.map(function (q) {
    return {
      qa_id: q.qaId,
      machine_id: q.machineId || '',
      type: q.type,
      amount: toNumOrNull(q.amount) || 0,
      label: q.label || '',
      sort_order: toNumOrNull(q.sortOrder) || 0
    };
  }), 'qa_id');

  await upsert('meter_rates', raw.meterRates.map(function (r) {
    return {
      rate_id: r.rateId,
      machine_id: r.machineId || '',
      rate: toNumOrNull(r.rate) || 100
    };
  }), 'rate_id');

  // 4) 台主授權（user_id/granted_by 要透過 userIdMap 轉成新 uuid）
  const permissionRows = [];
  for (const p of raw.permissions) {
    const uid = userIdMap[p.userId];
    if (!uid) { console.log('⚠ 授權紀錄找不到對應帳號（user_id=' + p.userId + '），跳過'); continue; }
    permissionRows.push({
      user_id: uid,
      machine_id: p.machineId,
      granted_by: p.grantedBy ? (userIdMap[p.grantedBy] || null) : null,
      granted_at: p.grantedAt || new Date().toISOString()
    });
  }
  await upsert('permissions', permissionRows, 'user_id,machine_id');

  // 5) 系統設定
  await upsert('config', raw.config.map(function (c) {
    return { key: c.key, value: c.value || '' };
  }), 'key');

  // 6) 營業日
  const bizDayRows = raw.bizDays.map(function (b) {
    return {
      biz_id: b.bizId,
      business_date: b.businessDate,
      opened_at: b.openedAt,
      opened_by: b.openedBy ? (userIdMap[b.openedBy] || null) : null,
      closed_at: nullIfEmpty(b.closedAt),
      closed_by: b.closedBy ? (userIdMap[b.closedBy] || null) : null,
      auto_closed: toBool(b.autoClosed)
    };
  });
  await upsert('biz_days', bizDayRows, 'biz_id');

  // 7) 每日手動帳目（given_to_owner_items/taken_by_owner_items 要 parse 回 jsonb）
  const ledgerRows = raw.dailyLedger.map(function (l) {
    return {
      ledger_id: l.ledgerId,
      business_date: l.businessDate,
      turnover: toNumOrNull(l.turnover) || 0,
      transport: toNumOrNull(l.transport) || 0,
      given_to_owner: toNumOrNull(l.givenToOwner) || 0,
      taken_by_owner: toNumOrNull(l.takenByOwner) || 0,
      returned_to_house: toNumOrNull(l.returnedToHouse) || 0,
      updated_by: l.updatedBy ? (userIdMap[l.updatedBy] || null) : null,
      updated_at: l.updatedAt || new Date().toISOString(),
      biz_id: nullIfEmpty(l.bizId),
      manual_432: toNumOrNull(l.manual432) || 0,
      manual_441: toNumOrNull(l.manual441) || 0,
      given_to_owner_items: parseJsonColumn(l.givenToOwnerItems),
      taken_by_owner_items: parseJsonColumn(l.takenByOwnerItems),
      manual_expense: toNumOrNull(l.manualExpense) || 0
    };
  });
  await upsert('daily_ledger', ledgerRows, 'ledger_id');

  // 8) 紀錄（分批寫入，最後做）
  const validMachineIds = new Set(raw.machines.map(function (m) { return m.machineId; }));
  const recordRows = [];
  let skippedRecords = 0;
  let skippedOrphanMachine = 0;
  for (const r of raw.records) {
    const uid = userIdMap[r.userId];
    if (!uid) { skippedRecords++; continue; }
    // records.machine_id 有外鍵限制（references machines），Sheets 裡偶爾會有
    // 指向「現在已經不存在的機台」的舊紀錄（機台被用不常見方式改過 ID、或
    // 很久以前的測試資料）——upsert 是整批送出的，一筆對不上外鍵會讓整批
    // 500 筆全部失敗，所以要先在這裡濾掉，不要等資料庫報錯才發現。
    if (!validMachineIds.has(r.machineId)) { skippedOrphanMachine++; continue; }
    recordRows.push({
      record_id: r.recordId,
      machine_id: r.machineId,
      type: r.type,
      amount: toNumOrNull(r.amount) || 0,
      prize_id: nullIfEmpty(r.prizeId),
      prize_name: r.prizeName || '',
      unit_amount: toNumOrNull(r.unitAmount),
      count: toNumOrNull(r.count),
      user_id: uid,
      created_at: r.createdAt,
      note: r.note || '',
      voided: toBool(r.voided),
      voided_by: r.voidedBy ? (userIdMap[r.voidedBy] || null) : null,
      voided_at: nullIfEmpty(r.voidedAt),
      client_token: nullIfEmpty(r.clientToken),
      meter_start: toNumOrNull(r.meterStart),
      meter_end: toNumOrNull(r.meterEnd),
      business_date: r.businessDate
    });
  }
  if (skippedRecords) console.log('⚠ ' + skippedRecords + ' 筆紀錄找不到對應帳號，已跳過（原始資料保留在 Sheets，之後可以手動補）');
  if (skippedOrphanMachine) console.log('⚠ ' + skippedOrphanMachine + ' 筆紀錄的 machine_id 對不到任何一台已匯入的機台，已跳過（原始資料保留在 Sheets，之後可以手動確認）');

  for (let i = 0; i < recordRows.length; i += RECORDS_BATCH_SIZE) {
    const batch = recordRows.slice(i, i + RECORDS_BATCH_SIZE);
    await upsert('records', batch, 'record_id', 'records（第 ' + (i / RECORDS_BATCH_SIZE + 1) + ' 批）');
  }

  console.log('\n🎉 遷移完成。建議接著跑一次 verify-migration.sql（見 supabase/README 或 MIGRATION_PLAN.md）核對筆數與金額。');
}

main().catch(function (e) {
  fail(e.stack || String(e));
});
