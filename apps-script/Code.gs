/**
 * Code.gs — Web App 進入點、API 路由、初始化、自我測試
 *
 * 這支 GAS 只回 JSON，不輸出任何 HTML。
 * 前端是 GitHub Pages 上的 PWA，透過 form-urlencoded POST 打進來
 * （form-urlencoded 屬於 CORS simple request，不會觸發 preflight）。
 */

const API_VERSION = '1.0.0';

/** action → 允許的角色。沒列在這裡的 action 一律拒絕。 */
const ACTION_ROLES = {
  ping: 'public',
  login: 'public',

  me: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  homeBootstrap: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  logout: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  dashboard: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  machineDetail: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  allMachineDetails: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  report: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  exportLedgerXlsx: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  exportLedgerGrids: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  activityQuery: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listQuickAmounts: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listPrizes: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listMeterRate: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],

  addRecord: [ROLE_ADMIN, ROLE_PATROL],
  addPrizeRecord: [ROLE_ADMIN, ROLE_PATROL],
  addMeterRecord: [ROLE_ADMIN, ROLE_PATROL],
  startBusinessDay: [ROLE_ADMIN, ROLE_PATROL],
  endBusinessDay: [ROLE_ADMIN, ROLE_PATROL],
  saveDailyLedger: [ROLE_ADMIN, ROLE_PATROL],

  voidRecord: [ROLE_ADMIN],
  saveQuickAmount: [ROLE_ADMIN],
  deleteQuickAmount: [ROLE_ADMIN],
  savePrize: [ROLE_ADMIN],
  deletePrize: [ROLE_ADMIN],
  saveMeterRate: [ROLE_ADMIN],
  forkScope: [ROLE_ADMIN],
  resetScope: [ROLE_ADMIN],

  adminListUsers: [ROLE_ADMIN],
  adminSaveUser: [ROLE_ADMIN],
  adminResetPassword: [ROLE_ADMIN],
  adminListPrizes: [ROLE_ADMIN],
  adminListMachines: [ROLE_ADMIN],
  adminSaveMachine: [ROLE_ADMIN],
  adminListPermissions: [ROLE_ADMIN],
  adminSetPermission: [ROLE_ADMIN],
  adminBootstrap: [ROLE_ADMIN],

  // 只給 Phase 4 資料遷移用（見 supabase/migrate-from-sheets.js），
  // 遷移完成、確認新系統穩定後可以整段拿掉。
  exportAllData: [ROLE_ADMIN]
};

// ── HTTP 進入點 ─────────────────────────────────────────

function doPost(e) {
  let payload = {};
  try {
    const raw = (e && e.parameter && e.parameter.payload) ? e.parameter.payload : '{}';
    payload = JSON.parse(raw);
  } catch (err) {
    return _json({ ok: false, error: '請求格式錯誤', code: 'BAD_REQUEST' });
  }
  return _json(handleApi(payload));
}

/** 直接用瀏覽器開 /exec 時給個確認畫面，順便當健康檢查。 */
function doGet() {
  return _json({ ok: true, data: { service: '娃娃機管理系統 API', version: API_VERSION, hint: '這是 API 端點，請從前端網站使用' } });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 路由本體。抽出來是為了讓 runSelfTest 能直接呼叫，測到跟線上同一條路徑。 */
function handleApi(payload) {
  const action = String(payload.action || '');
  const allowed = ACTION_ROLES[action];

  try {
    _clearSheetCache();

    if (!allowed) throw new Error('不支援的操作：' + action);

    if (allowed === 'public') {
      return { ok: true, data: _dispatchPublic(action, payload) };
    }

    const user = validateSession(payload.token);
    requireRole(user, allowed);
    return { ok: true, data: _dispatch(action, payload, user) };

  } catch (err) {
    const name = err && err.name;
    return {
      ok: false,
      error: (err && err.message) ? err.message : '發生未預期的錯誤',
      code: name === 'AuthError' ? 'AUTH' : (name === 'PermissionError' ? 'PERMISSION' : 'ERROR')
    };
  }
}

function _dispatchPublic(action, p) {
  if (action === 'ping') return { version: API_VERSION, time: nowIso() };
  if (action === 'login') return login(p.username, p.password, p.remember);
  throw new Error('不支援的操作：' + action);
}

function _dispatch(action, p, user) {
  switch (action) {
    case 'me':
      return { user: user, machineCount: visibleMachineIds(user).length };
    case 'logout':
      return logout(p.token);

    case 'dashboard':
      return getDashboard(user);
    case 'homeBootstrap':
      return homeBootstrap(user);
    case 'machineDetail':
      return getMachineDetail(user, p.machineId, p.recordLimit);
    case 'allMachineDetails':
      return getAllMachineDetails(user, p.recordLimit);
    case 'report':
      return getReport(user, p);
    case 'exportLedgerXlsx':
      return exportLedgerXlsx(user, p);
    case 'exportLedgerGrids':
      return exportLedgerGrids(user, p);
    case 'activityQuery':
      return getActivityQuery(user, p);
    case 'listQuickAmounts':
      return listQuickAmounts(user, p.machineId);
    case 'listPrizes':
      return listPrizes(user, p.machineId);
    case 'listMeterRate':
      return listMeterRate(user, p.machineId);

    case 'addRecord':
      return addRecord(user, p);
    case 'addPrizeRecord':
      return addPrizeRecord(user, p);
    case 'addMeterRecord':
      return addMeterRecord(user, p);
    case 'startBusinessDay':
      return startBusinessDay(user);
    case 'endBusinessDay':
      return endBusinessDay(user);
    case 'saveDailyLedger':
      return saveDailyLedger(user, p);
    case 'voidRecord':
      return voidRecord(user, p.recordId);

    case 'saveQuickAmount':
      return saveQuickAmount(user, p);
    case 'deleteQuickAmount':
      return deleteQuickAmount(user, p.qaId);
    case 'savePrize':
      return savePrize(user, p);
    case 'deletePrize':
      return deletePrize(user, p.prizeId);
    case 'saveMeterRate':
      return saveMeterRate(user, p);
    case 'forkScope':
      return forkScopeToMachine(user, p.sheet, p.machineId);
    case 'resetScope':
      return resetScopeToGlobal(user, p.sheet, p.machineId);

    case 'adminListUsers':
      return adminListUsers(user);
    case 'adminSaveUser':
      return adminSaveUser(user, p);
    case 'adminResetPassword':
      return adminResetPassword(user, p);
    case 'adminListPrizes':
      return adminListPrizes(user);
    case 'adminListMachines':
      return adminListMachines(user);
    case 'adminSaveMachine':
      return adminSaveMachine(user, p);
    case 'adminListPermissions':
      return adminListPermissions(user);
    case 'adminSetPermission':
      return adminSetPermission(user, p);
    case 'adminBootstrap':
      return adminBootstrap(user);
    case 'exportAllData':
      return exportAllData(user);

    default:
      throw new Error('不支援的操作：' + action);
  }
}

// ── 初始化 ──────────────────────────────────────────────

/**
 * 第一次部署時在 GAS 編輯器手動執行這一支。
 * 會建好所有分頁、產生 pepper、開一個管理員帳號、放幾組預設快捷金額與獎型。
 * 重複執行是安全的：已存在的東西不會被覆蓋。
 */
function setup() {
  const out = [];

  Object.keys(SCHEMA).forEach(function (name) {
    dbReadAll(name); // 觸發建表
    applyHeaderLabels(name); // 表頭一律覆寫成中文，既有分頁也會被修正，不影響資料列
    out.push('分頁 ' + name + ' 就緒');
  });

  const fixedRecords = _migrateRecordsMeterColumns();
  if (fixedRecords > 0) {
    out.push('已修正 ' + fixedRecords + ' 筆紀錄的欄位錯位（入幣改版當時造成的問題，資料已搬回正確位置，沒有遺失任何資料）');
  }

  const fixedTextCells = _fixTextColumnFormatting();
  if (fixedTextCells > 0) {
    out.push('已修正 ' + fixedTextCells + ' 個被 Sheets 自動轉成日期型別的儲存格（例如舊分頁後來才加的 business_date 欄位），改回純文字並鎖住格式，數值本身沒有變過');
  }

  _pepper();
  out.push('PEPPER 就緒');

  const triggerInstalled = _ensureArchiveTrigger();
  out.push(triggerInstalled
    ? '已設定每月自動封存檢查（每月 2 號凌晨 3 點，會把上一季以前還留在「紀錄」分頁的資料搬去封存分頁）'
    : '每月自動封存檢查已經設定過，略過');

  const props = PropertiesService.getScriptProperties();
  const admins = dbReadAll('Users').filter(function (u) { return String(u.role) === ROLE_ADMIN; });
  // 忘記密碼的救援流程：使用者在試算表把某個 admin 列的 password_hash/salt 清空後重跑 setup，
  // 這裡要能認出「有 admin 但密碼是空的」，不能只看「完全沒有 admin」。
  const brokenAdmin = admins.find(function (u) { return !u.password_hash || !u.salt; });

  if (!admins.length || brokenAdmin) {
    const username = brokenAdmin ? brokenAdmin.username : (props.getProperty('INITIAL_ADMIN_USERNAME') || 'admin');
    let password = props.getProperty('INITIAL_ADMIN_PASSWORD');
    let generated = false;
    if (!password) {
      password = Utilities.getUuid().replace(/-/g, '').substring(0, 12);
      generated = true;
    }
    const salt = newSalt();
    const passwordHash = hashPassword(password, salt);

    if (brokenAdmin) {
      dbUpdate('Users', brokenAdmin._row, { password_hash: passwordHash, salt: salt });
      invalidateUserSessions(brokenAdmin.user_id);
    } else {
      dbInsert('Users', {
        user_id: newId('usr'),
        username: username,
        display_name: '系統管理員',
        password_hash: passwordHash,
        salt: salt,
        role: ROLE_ADMIN,
        status: 'active',
        created_at: nowIso(),
        last_login_at: ''
      });
    }
    out.push('');
    out.push(brokenAdmin ? '=== 管理員密碼已重設 ===' : '=== 管理員帳號已建立 ===');
    out.push('帳號：' + username);
    out.push('密碼：' + password + (generated ? '（系統隨機產生，請立刻登入後改掉）' : ''));
    out.push('========================');
    props.deleteProperty('INITIAL_ADMIN_PASSWORD');
  } else {
    out.push('已有管理員帳號，略過建立');
  }

  if (!dbReadAll('QuickAmounts').length) {
    // 入幣改用碼表讀數計算，不再需要快捷金額按鈕，只保留出幣的預設值。
    const seed = [];
    [10, 50, 100].forEach(function (a, i) {
      seed.push({ qa_id: newId('qa'), machine_id: '', type: RECORD_OUT, amount: a, label: '$' + a, sort_order: i + 1 });
    });
    dbInsertMany('QuickAmounts', seed);
    out.push('已建立預設快捷金額（全局，僅出幣）');
  }

  if (!dbReadAll('Prizes').length) {
    dbInsertMany('Prizes', [
      { prize_id: newId('prz'), machine_id: '', name: '大娃', amount: 150, sort_order: 1, active: true },
      { prize_id: newId('prz'), machine_id: '', name: '中娃', amount: 80, sort_order: 2, active: true },
      { prize_id: newId('prz'), machine_id: '', name: '小娃', amount: 40, sort_order: 3, active: true }
    ]);
    out.push('已建立預設獎型（全局）');
  }

  if (!dbReadAll('MeterRates').length) {
    dbInsert('MeterRates', { rate_id: newId('mr'), machine_id: '', rate: 100 });
    out.push('已建立預設碼表費率（全局，每格 $100）');
  }

  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * 手動執行：正式上線前，把測試期間累積的交易資料清空，機台本身的設定不動。
 *
 * 只能在 GAS 編輯器裡手動執行——刻意不透過 App 任何按鈕或 API action 觸發，
 * 避免有人在手機上不小心點到，把資料清掉。**這是不可逆的動作，執行前
 * 建議先把整份試算表複製一份備份。**
 *
 * 會清空：
 *   - Records（入幣／出幣／活動／開分／洗分紀錄）
 *   - DailyLedger（每日手動帳目：週轉金／運拿／台主給／台主領／432／441）
 *   - BizDays（今日營業開始／結單的歷史）
 *   - 機台上的「封存前累計」欄位（carry_in／carry_out／carry_prize／
 *     carry_chip_in／carry_chip_out）歸零——這幾個數字是封存機制銜接用的
 *     累計基準，Records 清空後這幾個數字也該跟著歸零，不然機台的「累計」
 *     淨收益會對不起來（還留著測試期間的假數字）
 *
 * 不會動：Machines 本身（名稱、位置、顏色、分類、圖案、狀態、排序）、
 * Prizes／QuickAmounts／MeterRates（機台的按鈕設定）、Users／Permissions
 * （帳號與授權）、Config、封存分頁（如果已經有封存過的舊資料，這支不會去
 * 動它——那是「已經封存」的歷史，跟這裡要清的「測試期間交易資料」是兩回事）。
 */
function clearTestData() {
  return withLock(function () {
    const out = [];

    const recordRows = dbReadAll('Records').map(function (r) { return r._row; });
    dbDeleteRows('Records', recordRows);
    out.push('已清空「紀錄」分頁：' + recordRows.length + ' 筆');

    const ledgerRows = dbReadAll('DailyLedger').map(function (r) { return r._row; });
    dbDeleteRows('DailyLedger', ledgerRows);
    out.push('已清空「每日手動帳目」分頁：' + ledgerRows.length + ' 筆');

    const bizRows = dbReadAll('BizDays').map(function (r) { return r._row; });
    dbDeleteRows('BizDays', bizRows);
    out.push('已清空「營業日」分頁：' + bizRows.length + ' 筆');

    const machines = dbReadAll('Machines');
    machines.forEach(function (m) {
      dbUpdate('Machines', m._row, {
        carry_in: 0, carry_out: 0, carry_prize: 0, carry_chip_in: 0, carry_chip_out: 0
      });
    });
    out.push('已把 ' + machines.length + ' 台機台的「封存前累計」欄位歸零');

    out.push('');
    out.push('機台本身（名稱／位置／顏色／分類／圖案／排序）、快捷金額、獎型、入幣費率、帳號與授權都沒有被動過。');

    const msg = out.join('\n');
    Logger.log(msg);
    return msg;
  });
}

/**
 * 手動執行：只用來讓「匯出對帳表 Excel」需要的新權限（建立/刪除暫存試算表、
 * 對外發出 HTTP 請求）第一次跳出 Google 授權畫面。
 *
 * 部署成 Web App 之後，App 端按「匯出 Excel」是背景呼叫，沒有互動介面可以
 * 顯示授權視窗，第一次遇到還沒授權過的權限只會直接失敗，不會跳出「允許」
 * 畫面——授權畫面只有在編輯器裡手動執行函式時才會出現。這支函式故意只做
 * 最少的事（建一份空試算表、打一次匯出網址、刪掉），跑幾秒鐘就結束，
 * 不用像 runSelfTest 那樣跑完整套測試（在真正的試算表上跑 90 幾項測試，
 * 常常會超過 Apps Script 6 分鐘的執行上限，反而還沒跑到會用到這個權限的
 * 測試就先逾時了）。
 *
 * 用法：編輯器上方函式下拉選單選這支 → 執行 → 跳出畫面就照著「進階」→
 * 「前往（不安全）」→「允許」點下去。跑完看執行紀錄確認印出「授權沒問題」，
 * 之後 App 上的「匯出 Excel」就能正常用了。
 */
function authorizeExportXlsx() {
  const ss = SpreadsheetApp.create('授權測試_可刪除');
  const id = ss.getId();
  try {
    const url = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx';
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code !== 200) {
      throw new Error('匯出網址回傳 HTTP ' + code + '，預期 200。');
    }
    Logger.log('授權沒問題，「匯出 Excel」現在可以正常用了。');
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}
