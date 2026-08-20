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
  report: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  exportCsv: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listQuickAmounts: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listPrizes: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listMeterRate: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],

  addRecord: [ROLE_ADMIN, ROLE_PATROL],
  addPrizeRecord: [ROLE_ADMIN, ROLE_PATROL],
  addMeterRecord: [ROLE_ADMIN, ROLE_PATROL],
  startBusinessDay: [ROLE_ADMIN, ROLE_PATROL],
  endBusinessDay: [ROLE_ADMIN, ROLE_PATROL],

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
  adminBootstrap: [ROLE_ADMIN]
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
    case 'report':
      return getReport(user, p);
    case 'exportCsv':
      return exportCsv(user, p);
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

  _pepper();
  out.push('PEPPER 就緒');

  const props = PropertiesService.getScriptProperties();
  const admins = dbReadAll('Users').filter(function (u) { return String(u.role) === ROLE_ADMIN; });

  if (!admins.length) {
    const username = props.getProperty('INITIAL_ADMIN_USERNAME') || 'admin';
    let password = props.getProperty('INITIAL_ADMIN_PASSWORD');
    let generated = false;
    if (!password) {
      password = Utilities.getUuid().replace(/-/g, '').substring(0, 12);
      generated = true;
    }
    const salt = newSalt();
    dbInsert('Users', {
      user_id: newId('usr'),
      username: username,
      display_name: '系統管理員',
      password_hash: hashPassword(password, salt),
      salt: salt,
      role: ROLE_ADMIN,
      status: 'active',
      created_at: nowIso(),
      last_login_at: ''
    });
    out.push('');
    out.push('=== 管理員帳號已建立 ===');
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
