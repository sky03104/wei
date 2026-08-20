/**
 * 娃娃機管理系統 — 後端（自動合併版）
 *
 * 這份檔案是自動產生的，請勿手動編輯。
 * 原始碼分成 6 個檔案維護：apps-script/Db.gs, Auth.gs, Service.gs,
 * Reports.gs, Code.gs, Test.gs —— 需要改動時請改那 6 個檔案，
 * 再執行 `node tools/bundle-gas.js`（或 `npm run bundle`）重新產生這份檔案。
 *
 * 部署方式：把這份檔案的內容整個貼進 GAS 專案唯一的 Code.gs，
 * 詳細步驟見 guide/DEPLOY.md。
 */

// ────────────────────────────────────────────────────────────
// Db.gs
// ────────────────────────────────────────────────────────────
/**
 * Db.gs — 試算表存取層
 *
 * 所有分頁的欄位定義、建表、讀寫、鎖都集中在這裡。
 * 上層（Auth / Service / Reports）不直接碰 SpreadsheetApp。
 */

/** 每個分頁的欄位順序。setup() 會照這個建表頭。 */
const SCHEMA = {
  Users: ['user_id', 'username', 'display_name', 'password_hash', 'salt', 'role', 'status', 'created_at', 'last_login_at'],
  Machines: ['machine_id', 'name', 'location', 'status', 'color', 'sort_order', 'note', 'created_at'],
  Records: ['record_id', 'machine_id', 'type', 'amount', 'prize_id', 'prize_name', 'unit_amount', 'count', 'user_id', 'created_at', 'note', 'voided', 'voided_by', 'voided_at', 'client_token', 'meter_start', 'meter_end'],
  Prizes: ['prize_id', 'machine_id', 'name', 'amount', 'sort_order', 'active'],
  QuickAmounts: ['qa_id', 'machine_id', 'type', 'amount', 'label', 'sort_order'],
  MeterRates: ['rate_id', 'machine_id', 'rate'],
  Permissions: ['user_id', 'machine_id', 'granted_by', 'granted_at'],
  Sessions: ['token', 'user_id', 'created_at', 'expires_at', 'remember'],
  Config: ['key', 'value']
};

/** 這些欄位存 ISO 時間字串，欄位格式必須設成純文字，否則 Sheets 會自作主張轉時區。 */
const TEXT_COLUMNS = ['created_at', 'last_login_at', 'voided_at', 'granted_at', 'expires_at'];

/**
 * 表頭給人看的中文標籤。
 *
 * 只影響試算表第一列顯示的文字，跟 SCHEMA 的英文鍵值是兩件事——
 * 程式碼裡到處都是 r.user_id、dbFind('Users', 'username', ...) 這種寫法，
 * 內部欄位名稱維持英文不變，才不用把整個後端的存取邏輯都改一輪。
 *
 * 每個分頁的陣列長度與順序必須跟 SCHEMA[name] 完全對應，
 * applyHeaderLabels() 會在對不上時直接丟錯，避免兩份手動維護的陣列悄悄不同步。
 */
const HEADER_LABELS = {
  Users: ['帳號編號', '帳號', '顯示名稱', '密碼雜湊', '密碼鹽', '角色', '狀態', '建立時間', '最後登入時間'],
  Machines: ['機台編號', '名稱', '位置', '狀態', '顏色', '排序', '備註', '建立時間'],
  Records: ['紀錄編號', '機台編號', '類型', '金額', '獎型編號', '獎型名稱', '單價', '次數',
    '操作人編號', '建立時間', '備註', '已作廢', '作廢人', '作廢時間', '防重複權杖', '上班表', '下班表'],
  Prizes: ['獎型編號', '機台編號', '名稱', '金額', '排序', '啟用中'],
  QuickAmounts: ['快捷編號', '機台編號', '類型', '金額', '顯示文字', '排序'],
  MeterRates: ['設定編號', '機台編號', '每格金額'],
  Permissions: ['帳號編號', '機台編號', '授權人', '授權時間'],
  Sessions: ['登入權杖', '帳號編號', '建立時間', '到期時間', '記住我'],
  Config: ['設定鍵', '設定值']
};

/**
 * 分頁在試算表下方看到的中文頁籤名稱。
 *
 * 跟 SCHEMA 的鍵值（英文，程式碼內部到處用來當 dbReadAll('Users') 這種參數）
 * 是兩件事——內部一律用英文鍵值查找，只有實際在試算表建立/尋找分頁時
 * 才轉換成這裡的中文頁籤名稱。
 */
const SHEET_TAB_NAMES = {
  Users: '帳號',
  Machines: '機台',
  Records: '紀錄',
  Prizes: '獎型',
  QuickAmounts: '快捷金額',
  MeterRates: '入幣費率',
  Permissions: '台主授權',
  Sessions: '登入狀態',
  Config: '系統設定'
};

/** 單次執行內的分頁快取，避免同一次請求重複讀同一張表。 */
let _sheetCache = {};

function _clearSheetCache() {
  _sheetCache = {};
}

/**
 * 取得試算表。優先用 Script Property SPREADSHEET_ID，
 * 沒設就退回綁定的試算表（方便從試算表選單直接跑 setup）。
 */
function _spreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActive();
  if (active) return active;
  throw new Error('找不到試算表：請在「專案設定 → 指令碼屬性」新增 SPREADSHEET_ID');
}

/**
 * 取得分頁，不存在就依 SCHEMA 建立（含表頭與欄位格式）。
 *
 * 頁籤一律用 SHEET_TAB_NAMES 裡的中文名稱。舊版程式碼是用英文鍵值（例如 'Users'）
 * 直接當頁籤名稱建立的，所以找不到中文頁籤時，會退回去找同名的英文頁籤——
 * 找到的話直接把它改名成中文（setName 不會動到任何資料），
 * 而不是誤判成「還沒建立」而新開一張空的，導致舊資料變成孤兒分頁。
 * 兩邊都找不到才真的是全新分頁。
 */
function _sheet(name) {
  const cols = SCHEMA[name];
  if (!cols) throw new Error('未知的分頁：' + name);
  const tabName = SHEET_TAB_NAMES[name] || name;

  const ss = _spreadsheet();
  let sh = ss.getSheetByName(tabName);
  let isNew = false;
  if (!sh) {
    const legacy = ss.getSheetByName(name);
    if (legacy) {
      legacy.setName(tabName);
      sh = legacy;
    } else {
      sh = ss.insertSheet(tabName);
      isNew = true;
    }
  }
  if (isNew) {
    _writeHeaderRow(sh, name, cols);
    cols.forEach(function (col, i) {
      if (TEXT_COLUMNS.indexOf(col) >= 0) {
        sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      }
    });
  }
  return sh;
}

function _writeHeaderRow(sh, name, cols) {
  const labels = HEADER_LABELS[name];
  if (!labels || labels.length !== cols.length) {
    throw new Error('HEADER_LABELS[' + name + '] 跟 SCHEMA 對不起來，兩邊長度必須一致');
  }
  sh.getRange(1, 1, 1, labels.length).setValues([labels]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/**
 * 把某分頁的表頭（第一列）重新覆寫成中文標籤。
 *
 * 跟 _sheet() 建立新分頁時寫表頭不同，這個是無條件執行的——
 * 用來修正「用改版前的程式碼建立、表頭還是英文」的既有試算表。
 * 只動第一列，不會碰到任何資料列。setup() 會對每個分頁都呼叫一次，
 * 所以只要重新執行一次 setup，既有試算表的表頭就會自動換成中文。
 */
function applyHeaderLabels(name) {
  const cols = SCHEMA[name];
  if (!cols) throw new Error('未知的分頁：' + name);
  const sh = _sheet(name);
  _writeHeaderRow(sh, name, cols);
}

/**
 * 修正入幣改成碼表登錄那次改版留下的欄位錯位。
 *
 * 當時把 meter_start／meter_end 插進 Records 欄位「中間」（count 之後、
 * user_id 之前），而不是加在最後面。試算表的資料是照實體欄位位置存放的，
 * 插在中間會讓改版之前就存在的舊紀錄，從那一欄開始全部被讀到錯的欄位名稱——
 * 操作人被讀成碼表讀數、建立時間被讀成備註，一路錯位到最後一欄。
 * 現在已經把 SCHEMA 改成把這兩欄加在最後面（只增不插），舊紀錄的實體欄位
 * 本來就跟新版排法對得起來，不用動；但改版當下、修正之前那段時間寫入的
 * 紀錄（欄位還是插在中間那種舊排法），需要把它們的欄位實際搬回正確位置。
 *
 * 判斷方式：user_id 一律是 newId('usr') 產生、'usr_' 開頭。
 *   - 第 9 欄本身就是 usr_ 開頭 → 欄位本來就對，不用動。
 *   - 第 9 欄不是、但第 11 欄是 usr_ 開頭 → 改版當下寫入的錯位格式，
 *     把第 9~17 欄搬回：9~15 欄＝原本的 11~17 欄，16~17 欄（碼表讀數）
 *     ＝原本的 9~10 欄。
 *   - 兩邊都不是（整列空白、或無法辨識）→ 保守不動。
 *
 * 天生冪等：搬正確之後再跑一次，這些列的第 9 欄就會是 usr_ 開頭，
 * 直接判定不用動，重複執行不會搬第二次。
 */
function _migrateRecordsMeterColumns() {
  const width = SCHEMA.Records.length;
  const sh = _sheet('Records');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  const range = sh.getRange(2, 1, lastRow - 1, width);
  const values = range.getValues();
  let fixed = 0;

  function looksLikeUserId(v) { return typeof v === 'string' && v.indexOf('usr_') === 0; }

  const out = values.map(function (row) {
    if (looksLikeUserId(row[8])) return row; // 第 9 欄已經是 user_id，格式正確
    if (!looksLikeUserId(row[10])) return row; // 兩邊都不是，無法辨識，不動

    fixed++;
    return [
      row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7],
      row[10], row[11], row[12], row[13], row[14], row[15], row[16],
      row[8], row[9]
    ];
  });

  if (fixed > 0) {
    range.setValues(out);
    delete _sheetCache.Records;
  }
  return fixed;
}

/**
 * 讀出整張分頁，回傳物件陣列。每個物件多一個 _row（實際列號，從 2 起算）。
 * 同一次執行內只會真的讀一次。
 */
function dbReadAll(name) {
  if (_sheetCache[name]) return _sheetCache[name];

  const sh = _sheet(name);
  const lastRow = sh.getLastRow();
  const cols = SCHEMA[name];
  if (lastRow < 2) {
    _sheetCache[name] = [];
    return [];
  }

  const values = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    // 整列皆空的列直接跳過（人工刪資料常留下空列）
    let empty = true;
    for (let c = 0; c < raw.length; c++) {
      if (raw[c] !== '' && raw[c] !== null) { empty = false; break; }
    }
    if (empty) continue;

    const obj = { _row: i + 2 };
    for (let c = 0; c < cols.length; c++) obj[cols[c]] = raw[c];
    rows.push(obj);
  }
  _sheetCache[name] = rows;
  return rows;
}

/** 依欄位值找第一筆（字串比較，避免 id 被當數字）。 */
function dbFind(name, field, value) {
  const rows = dbReadAll(name);
  const target = String(value);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][field]) === target) return rows[i];
  }
  return null;
}

/** 依欄位值找全部。 */
function dbFilter(name, field, value) {
  const target = String(value);
  return dbReadAll(name).filter(function (r) { return String(r[field]) === target; });
}

/** 物件轉成照 SCHEMA 欄位順序排好的陣列。 */
function _toRow(name, obj) {
  return SCHEMA[name].map(function (col) {
    const v = obj[col];
    return (v === undefined || v === null) ? '' : v;
  });
}

/** 新增一列，回傳寫入的物件。 */
function dbInsert(name, obj) {
  return dbInsertMany(name, [obj])[0];
}

/** 一次新增多列（單次 setValues，比逐列 appendRow 快很多也不會撞列）。 */
function dbInsertMany(name, objs) {
  if (!objs.length) return [];
  const sh = _sheet(name);
  const startRow = sh.getLastRow() + 1;
  const rows = objs.map(function (o) { return _toRow(name, o); });
  sh.getRange(startRow, 1, rows.length, SCHEMA[name].length).setValues(rows);
  delete _sheetCache[name];
  return objs;
}

/** 局部更新某一列（只寫有給的欄位）。 */
function dbUpdate(name, rowIndex, patch) {
  const sh = _sheet(name);
  const cols = SCHEMA[name];
  Object.keys(patch).forEach(function (key) {
    const c = cols.indexOf(key);
    if (c < 0) return;
    const v = patch[key];
    sh.getRange(rowIndex, c + 1).setValue((v === undefined || v === null) ? '' : v);
  });
  delete _sheetCache[name];
}

/** 刪除指定列（由大到小刪，避免列號位移）。 */
function dbDeleteRows(name, rowIndexes) {
  if (!rowIndexes.length) return;
  const sh = _sheet(name);
  rowIndexes.slice().sort(function (a, b) { return b - a; }).forEach(function (r) {
    sh.deleteRow(r);
  });
  delete _sheetCache[name];
}

/** 包住寫入動作，避免兩人同時記帳撞在一起。 */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('系統忙碌中，請稍後再試');
  try {
    _clearSheetCache();
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ── 小工具 ──────────────────────────────────────────────

function newId(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
}

/** 一律用 ISO 字串存時間，跨時區不會有歧義。 */
function nowIso() {
  return new Date().toISOString();
}

function toBool(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.toUpperCase() === 'TRUE';
  return v === 1;
}

function toNumber(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** 讀 Config 分頁的設定值。 */
function configGet(key, fallback) {
  const row = dbFind('Config', 'key', key);
  return row ? row.value : fallback;
}

function configSet(key, value) {
  const row = dbFind('Config', 'key', key);
  if (row) dbUpdate('Config', row._row, { value: value });
  else dbInsert('Config', { key: key, value: value });
}

// ────────────────────────────────────────────────────────────
// Auth.gs
// ────────────────────────────────────────────────────────────
/**
 * Auth.gs — 密碼、Session、角色與機台權限
 *
 * 整套權限的把關點只有這個檔案裡的 requireRole / assertMachineAccess，
 * 其他地方一律透過它們，不要各自判斷角色。
 */

const ROLE_ADMIN = 'admin';
const ROLE_PATROL = 'patrol';
const ROLE_OWNER = 'owner';

const ROLE_LABELS = { admin: '管理員', patrol: '巡邏人員', owner: '台主' };

const SESSION_HOURS_DEFAULT = 12;
const SESSION_DAYS_REMEMBER = 7;

const HASH_ITERATIONS = 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MINUTES = 15;

// ── 密碼 ────────────────────────────────────────────────

/**
 * 全站 pepper。存在 Script Properties，不進 repo、不進試算表。
 * 首次呼叫自動產生，之後固定不變（換掉會讓所有既有密碼失效）。
 */
function _pepper() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('PEPPER');
  if (!p) {
    p = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PEPPER', p);
  }
  return p;
}

function _sha256Hex(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/**
 * salt + pepper 迭代 SHA-256。
 * GAS 沒有 bcrypt，這是在平台限制下能做到的合理強度：
 * 單純撞一組密碼要跑 1000 次雜湊，暴力破解成本高很多。
 */
function hashPassword(password, salt) {
  let h = salt + '|' + _pepper() + '|' + password;
  for (let i = 0; i < HASH_ITERATIONS; i++) h = _sha256Hex(h);
  return h;
}

function newSalt() {
  return Utilities.getUuid().replace(/-/g, '');
}

/** 定時比較，避免用字串比較洩漏前綴資訊。 */
function _safeEquals(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// ── 登入限流 ────────────────────────────────────────────

function _failKey(username) {
  return 'loginfail_' + String(username).toLowerCase();
}

function _assertNotLocked(username) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(_failKey(username)) || 0);
  if (n >= LOGIN_MAX_FAILS) {
    throw new Error('登入失敗次數過多，請於 ' + LOGIN_LOCK_MINUTES + ' 分鐘後再試');
  }
}

function _recordFail(username) {
  const cache = CacheService.getScriptCache();
  const key = _failKey(username);
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), LOGIN_LOCK_MINUTES * 60);
}

function _clearFails(username) {
  CacheService.getScriptCache().remove(_failKey(username));
}

// ── Session ─────────────────────────────────────────────

function _sessionCacheKey(token) {
  return 'sess_' + token;
}

function _createSession(userId, remember) {
  const now = new Date();
  const ms = remember
    ? SESSION_DAYS_REMEMBER * 24 * 60 * 60 * 1000
    : SESSION_HOURS_DEFAULT * 60 * 60 * 1000;
  const expires = new Date(now.getTime() + ms);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');

  dbInsert('Sessions', {
    token: token,
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    remember: !!remember
  });

  CacheService.getScriptCache().put(
    _sessionCacheKey(token),
    JSON.stringify({ user_id: userId, expires_at: expires.toISOString(), remember: !!remember }),
    21600 // Cache 上限 6 小時；過期後自動退回讀試算表
  );

  return { token: token, expiresAt: expires.toISOString() };
}

/**
 * 驗證 token 並回傳使用者。
 *
 * 有效期以試算表的 expires_at 為準（前端動 localStorage 沒有用）。
 * 未勾記住我的 session 會滑動延展，但只在剩不到一半時才真的寫回試算表，
 * 免得每個請求都寫一次。
 */
function validateSession(token) {
  if (!token) throw new AuthError('尚未登入');

  const cache = CacheService.getScriptCache();
  const cacheKey = _sessionCacheKey(token);
  let sess = null;
  let row = null;

  const cached = cache.get(cacheKey);
  if (cached) {
    sess = JSON.parse(cached);
  } else {
    row = dbFind('Sessions', 'token', token);
    if (!row) throw new AuthError('登入已失效，請重新登入');
    sess = { user_id: row.user_id, expires_at: row.expires_at, remember: toBool(row.remember) };
  }

  const now = new Date();
  const expires = new Date(sess.expires_at);
  if (!(expires > now)) {
    cache.remove(cacheKey);
    throw new AuthError('登入已逾時，請重新登入');
  }

  const user = dbFind('Users', 'user_id', sess.user_id);
  if (!user) throw new AuthError('帳號不存在，請重新登入');
  if (String(user.status) !== 'active') throw new AuthError('此帳號已停用');

  if (!sess.remember) {
    const windowMs = SESSION_HOURS_DEFAULT * 60 * 60 * 1000;
    if (expires.getTime() - now.getTime() < windowMs / 2) {
      const next = new Date(now.getTime() + windowMs);
      if (!row) row = dbFind('Sessions', 'token', token);
      if (row) dbUpdate('Sessions', row._row, { expires_at: next.toISOString() });
      sess.expires_at = next.toISOString();
    }
  }

  cache.put(cacheKey, JSON.stringify(sess), 21600);
  return _publicUser(user);
}

function login(username, password, remember) {
  const uname = String(username || '').trim();
  if (!uname || !password) throw new AuthError('請輸入帳號與密碼');

  _assertNotLocked(uname);

  const user = dbReadAll('Users').filter(function (u) {
    return String(u.username).toLowerCase() === uname.toLowerCase();
  })[0];

  // 帳號不存在也要跑一次雜湊，讓回應時間一致，不洩漏帳號是否存在
  const salt = user ? user.salt : 'nonexistent';
  const hash = hashPassword(String(password), String(salt));

  if (!user || !_safeEquals(hash, user.password_hash)) {
    _recordFail(uname);
    throw new AuthError('帳號或密碼錯誤');
  }
  if (String(user.status) !== 'active') {
    throw new AuthError('此帳號已停用，請聯絡管理員');
  }

  _clearFails(uname);
  _cleanupExpiredSessions();

  const sess = _createSession(user.user_id, !!remember);
  dbUpdate('Users', user._row, { last_login_at: nowIso() });

  const publicUser = _publicUser(user);
  return {
    token: sess.token,
    expiresAt: sess.expiresAt,
    remember: !!remember,
    user: publicUser,
    // 登入完一定接著要進首頁，順便把首頁資料一起帶回去，
    // 前端就不用登入成功後再多打一次 dashboard——跟 homeBootstrap 同一個道理，
    // 省下登入當下那一整趟 GAS 來回。
    dashboard: getDashboard(publicUser)
  };
}

function logout(token) {
  const row = dbFind('Sessions', 'token', token);
  if (row) dbDeleteRows('Sessions', [row._row]);
  CacheService.getScriptCache().remove(_sessionCacheKey(token));
  return { ok: true };
}

/** 踢掉某帳號的所有登入狀態（改密碼、停用時用）。 */
function invalidateUserSessions(userId) {
  const rows = dbFilter('Sessions', 'user_id', userId);
  if (!rows.length) return 0;
  const cache = CacheService.getScriptCache();
  rows.forEach(function (r) { cache.remove(_sessionCacheKey(r.token)); });
  dbDeleteRows('Sessions', rows.map(function (r) { return r._row; }));
  return rows.length;
}

function _cleanupExpiredSessions() {
  const now = new Date();
  const stale = dbReadAll('Sessions').filter(function (s) {
    return !(new Date(s.expires_at) > now);
  });
  if (stale.length) dbDeleteRows('Sessions', stale.map(function (s) { return s._row; }));
}

/** 回傳給前端的使用者資料，永遠不含密碼與 salt。 */
function _publicUser(user) {
  return {
    userId: user.user_id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    status: user.status
  };
}

// ── 角色與機台權限 ──────────────────────────────────────

/** 自訂錯誤型別，讓前端能分辨「要重新登入」與一般錯誤。 */
function AuthError(message) {
  const e = new Error(message);
  e.name = 'AuthError';
  return e;
}

function PermissionError(message) {
  const e = new Error(message || '你沒有這項操作的權限');
  e.name = 'PermissionError';
  return e;
}

function isAdmin(user) {
  return user.role === ROLE_ADMIN;
}

function canRecord(user) {
  return user.role === ROLE_ADMIN || user.role === ROLE_PATROL;
}

function requireRole(user, roles) {
  if (roles.indexOf(user.role) < 0) throw PermissionError();
}

/**
 * 這個帳號看得到哪些機台。
 * 管理員與巡邏人員一律全部（新增機台不用補設定）；台主只看授權過的。
 */
function visibleMachineIds(user) {
  const all = dbReadAll('Machines').map(function (m) { return String(m.machine_id); });
  if (user.role === ROLE_ADMIN || user.role === ROLE_PATROL) return all;

  const granted = dbFilter('Permissions', 'user_id', user.userId)
    .map(function (p) { return String(p.machine_id); });
  return all.filter(function (id) { return granted.indexOf(id) >= 0; });
}

/** 台主拿別台的 id 直接打 API，擋在這裡。 */
function assertMachineAccess(user, machineId) {
  if (!machineId) throw new Error('缺少機台編號');
  if (visibleMachineIds(user).indexOf(String(machineId)) < 0) {
    throw PermissionError('你沒有這台機台的權限');
  }
}

// ────────────────────────────────────────────────────────────
// Service.gs
// ────────────────────────────────────────────────────────────
/**
 * Service.gs — 機台、紀錄、開獎、快捷金額、獎型、權限、帳號
 *
 * 這裡假設呼叫端（Code.gs 的路由）已經驗過 token 與角色，
 * 但凡是帶 machineId 的動作仍會再自己擋一次機台權限。
 */

const RECORD_IN = 'in';
const RECORD_OUT = 'out';
const RECORD_PRIZE = 'prize';

const MAX_AMOUNT = 10000000;
const MAX_PRIZE_COUNT = 9999;

// ── 時間 ────────────────────────────────────────────────

function _tz() {
  return Session.getScriptTimeZone() || 'Asia/Taipei';
}

/** ISO 字串 → 當地日期 'yyyy-MM-dd'（報表分組、今日判定都用這個）。 */
function localDateKey(iso) {
  if (!iso) return '';
  const d = (iso instanceof Date) ? iso : new Date(iso);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, _tz(), 'yyyy-MM-dd');
}

function todayKey() {
  return Utilities.formatDate(new Date(), _tz(), 'yyyy-MM-dd');
}

// ── 彙總 ────────────────────────────────────────────────

function emptySummary() {
  return { in: 0, out: 0, prize: 0, net: 0 };
}

function _accumulate(sum, rec) {
  const amt = toNumber(rec.amount);
  if (rec.type === RECORD_IN) sum.in += amt;
  else if (rec.type === RECORD_OUT) sum.out += amt;
  else if (rec.type === RECORD_PRIZE) sum.prize += amt;
  sum.net = sum.in - sum.out - sum.prize;
  return sum;
}

/** 有效紀錄＝沒被作廢的。所有數字都只算這些。 */
function activeRecords() {
  return dbReadAll('Records').filter(function (r) { return !toBool(r.voided); });
}

/**
 * 「最新在前」排序，含毫秒同框時的決勝點。
 *
 * created_at 是 new Date().toISOString()，只有毫秒精度——連續兩個動作
 * （例如同一次請求連續呼叫、或很快點兩下）完全可能落在同一毫秒，字串比較
 * 就分不出先後了。這時候用 _row（試算表列號，dbReadAll 附上的，永遠隨
 * 插入順序遞增）當決勝點：列號大代表比較晚寫入。
 *
 * 不只是排序好不好看的問題——machineDetail 用「最新一筆」的下班表
 * 自動帶入下一次的上班表，兩筆入幣紀錄同一毫秒寫入時，這裡如果分不出
 * 先後，自動帶入就可能帶到錯的（比較舊的）那一筆。
 */
function _byCreatedAtDesc(a, b) {
  const byTime = String(b.created_at).localeCompare(String(a.created_at));
  if (byTime !== 0) return byTime;
  return (b._row || 0) - (a._row || 0);
}

// ── 首頁 ────────────────────────────────────────────────

function getDashboard(user) {
  const ids = visibleMachineIds(user);
  const machines = dbReadAll('Machines').filter(function (m) {
    return ids.indexOf(String(m.machine_id)) >= 0;
  });

  const today = todayKey();
  const totals = {};
  const todays = {};
  ids.forEach(function (id) { totals[id] = emptySummary(); todays[id] = emptySummary(); });

  activeRecords().forEach(function (r) {
    const mid = String(r.machine_id);
    if (!totals[mid]) return;
    _accumulate(totals[mid], r);
    if (localDateKey(r.created_at) === today) _accumulate(todays[mid], r);
  });

  const list = machines.map(function (m) {
    const id = String(m.machine_id);
    return {
      machineId: id,
      name: m.name,
      location: m.location || '',
      status: m.status || 'running',
      color: m.color || '#4F7BE8',
      sortOrder: toNumber(m.sort_order),
      today: todays[id],
      total: totals[id]
    };
  });

  list.sort(function (a, b) {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return String(a.name).localeCompare(String(b.name));
  });

  const grand = emptySummary();
  list.forEach(function (m) {
    grand.in += m.today.in;
    grand.out += m.today.out;
    grand.prize += m.today.prize;
  });
  grand.net = grand.in - grand.out - grand.prize;

  return { machines: list, todayTotal: grand, today: today };
}

/**
 * App 開啟時要驗登入（me）又要拿首頁資料（dashboard），合併成一次呼叫。
 *
 * 跟 adminBootstrap 同一個道理：每支 GAS Web App 呼叫都要付一次 /exec
 * 轉址＋腳本執行的固定成本，這筆成本在網路較慢時感受特別明顯。
 * 開頭這兩支 API 本來就是「驗完登入一定接著要拿首頁資料」，沒有理由
 * 分兩次跑，合併後每次開啟 App 省下一整趟來回。
 */
function homeBootstrap(user) {
  return {
    user: user,
    machineCount: visibleMachineIds(user).length,
    dashboard: getDashboard(user)
  };
}

// ── 機台詳細頁 ──────────────────────────────────────────

function getMachineDetail(user, machineId, recordLimit) {
  assertMachineAccess(user, machineId);
  const m = dbFind('Machines', 'machine_id', machineId);
  if (!m) throw new Error('找不到這台機台');

  const today = todayKey();
  const total = emptySummary();
  const todaySum = emptySummary();
  const mine = [];

  activeRecords().forEach(function (r) {
    if (String(r.machine_id) !== String(machineId)) return;
    _accumulate(total, r);
    if (localDateKey(r.created_at) === today) _accumulate(todaySum, r);
    mine.push(r);
  });

  mine.sort(_byCreatedAtDesc);
  const limit = recordLimit || 50;

  // 上次入幣紀錄的下班表讀數，前端拿來自動帶入這次的上班表——
  // 操作人不用每次憑記憶手打一長串碼表數字，接續前一次就好。
  let lastMeterReading = null;
  for (let i = 0; i < mine.length; i++) {
    if (mine[i].type === RECORD_IN && mine[i].meter_end !== '' && mine[i].meter_end !== undefined) {
      lastMeterReading = toNumber(mine[i].meter_end);
      break;
    }
  }

  return {
    machine: {
      machineId: String(m.machine_id),
      name: m.name,
      location: m.location || '',
      status: m.status || 'running',
      color: m.color || '#4F7BE8',
      note: m.note || ''
    },
    today: todaySum,
    total: total,
    records: mine.slice(0, limit).map(_publicRecord),
    hasMore: mine.length > limit,
    quickAmounts: _resolveQuickAmounts(machineId),
    prizes: _resolvePrizes(machineId),
    meterRate: _resolveMeterRate(machineId),
    lastMeterReading: lastMeterReading
  };
}

function _publicRecord(r) {
  const users = dbReadAll('Users');
  let name = '';
  for (let i = 0; i < users.length; i++) {
    if (String(users[i].user_id) === String(r.user_id)) { name = users[i].display_name || users[i].username; break; }
  }
  return {
    recordId: String(r.record_id),
    machineId: String(r.machine_id),
    type: r.type,
    amount: toNumber(r.amount),
    prizeName: r.prize_name || '',
    unitAmount: r.unit_amount === '' ? null : toNumber(r.unit_amount),
    count: r.count === '' ? null : toNumber(r.count),
    meterStart: r.meter_start === '' || r.meter_start === undefined ? null : toNumber(r.meter_start),
    meterEnd: r.meter_end === '' || r.meter_end === undefined ? null : toNumber(r.meter_end),
    userName: name,
    createdAt: r.created_at,
    note: r.note || ''
  };
}

// ── 記帳（入幣 / 出幣）──────────────────────────────────

function addRecord(user, payload) {
  if (!canRecord(user)) throw PermissionError('你的帳號沒有記帳權限');
  assertMachineAccess(user, payload.machineId);

  const type = payload.type;
  if (type !== RECORD_IN && type !== RECORD_OUT) throw new Error('紀錄類型只能是入幣或出幣');

  const amount = _validAmount(payload.amount);

  return withLock(function () {
    const dup = _findByClientToken(payload.clientToken);
    if (dup.length) return { duplicated: true, records: dup.map(_publicRecord) };

    const rec = {
      record_id: newId('rec'),
      machine_id: String(payload.machineId),
      type: type,
      amount: amount,
      prize_id: '',
      prize_name: '',
      unit_amount: '',
      count: '',
      meter_start: '',
      meter_end: '',
      user_id: user.userId,
      created_at: nowIso(),
      note: String(payload.note || '').substring(0, 200),
      voided: false,
      voided_by: '',
      voided_at: '',
      client_token: String(payload.clientToken || '')
    };
    dbInsert('Records', rec);
    return { duplicated: false, records: [_publicRecord(rec)] };
  });
}

/**
 * 入幣改用碼表讀數計算：金額 = (下班表 − 上班表) × 每格金額。
 * 費率一律從 MeterRates 表查（_resolveMeterRate），前端完全不會、
 * 也不需要傳費率過來——跟開獎金額只信伺服器算出來的、不信前端傳來的
 * 同一個道理。
 */
function addMeterRecord(user, payload) {
  if (!canRecord(user)) throw PermissionError('你的帳號沒有記帳權限');
  assertMachineAccess(user, payload.machineId);

  const meterStart = _validMeterReading(payload.meterStart);
  const meterEnd = _validMeterReading(payload.meterEnd);
  if (meterEnd <= meterStart) throw new Error('下班表必須大於上班表');

  const rate = _resolveMeterRate(payload.machineId).rate;
  const amount = _validAmount((meterEnd - meterStart) * rate);

  return withLock(function () {
    const dup = _findByClientToken(payload.clientToken);
    if (dup.length) return { duplicated: true, records: dup.map(_publicRecord) };

    const rec = {
      record_id: newId('rec'),
      machine_id: String(payload.machineId),
      type: RECORD_IN,
      amount: amount,
      prize_id: '',
      prize_name: '',
      unit_amount: '',
      count: '',
      meter_start: meterStart,
      meter_end: meterEnd,
      user_id: user.userId,
      created_at: nowIso(),
      note: String(payload.note || '').substring(0, 200),
      voided: false,
      voided_by: '',
      voided_at: '',
      client_token: String(payload.clientToken || '')
    };
    dbInsert('Records', rec);
    return { duplicated: false, records: [_publicRecord(rec)] };
  });
}

/** 碼表讀數只接受非負整數（機械式計數器不會有小數，也不會是負的）。 */
function _validMeterReading(raw) {
  const n = Number(raw);
  if (!isFinite(n)) throw new Error('碼表讀數必須是數字');
  if (n < 0) throw new Error('碼表讀數不能是負數');
  if (Math.floor(n) !== n) throw new Error('碼表讀數必須是整數');
  if (n > 99999999) throw new Error('碼表讀數超出上限');
  return n;
}

function _validAmount(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) throw new Error('金額必須是大於 0 的數字');
  if (n > MAX_AMOUNT) throw new Error('金額超出上限');
  return Math.round(n * 100) / 100;
}

function _findByClientToken(token) {
  if (!token) return [];
  return dbFilter('Records', 'client_token', String(token));
}

// ── 開獎 ────────────────────────────────────────────────

/**
 * 一次登錄多個獎型。
 *
 * 前端只送 prizeId 與次數，單價一律由這裡從 Prizes 表查，
 * 前端傳來的金額完全不採信。名稱與單價會快照進紀錄，
 * 之後改價或停用獎型都不會動到歷史帳。
 */
function addPrizeRecord(user, payload) {
  if (!canRecord(user)) throw PermissionError('你的帳號沒有記帳權限');
  assertMachineAccess(user, payload.machineId);

  const items = payload.items || [];
  if (!items.length) throw new Error('請至少輸入一個獎型的次數');

  const available = _resolvePrizes(payload.machineId);
  const byId = {};
  available.forEach(function (p) { byId[p.prizeId] = p; });

  const prepared = [];
  items.forEach(function (item) {
    const count = _validCount(item.count);
    if (count === 0) return;
    const prize = byId[String(item.prizeId)];
    if (!prize) throw new Error('獎型不存在或已停用，請重新整理後再試');
    prepared.push({ prize: prize, count: count });
  });

  if (!prepared.length) throw new Error('請至少輸入一個獎型的次數');

  return withLock(function () {
    const dup = _findByClientToken(payload.clientToken);
    if (dup.length) return { duplicated: true, records: dup.map(_publicRecord) };

    const now = nowIso();
    const note = String(payload.note || '').substring(0, 200);
    const rows = prepared.map(function (p) {
      return {
        record_id: newId('rec'),
        machine_id: String(payload.machineId),
        type: RECORD_PRIZE,
        amount: Math.round(p.prize.amount * p.count * 100) / 100,
        prize_id: p.prize.prizeId,
        prize_name: p.prize.name,
        unit_amount: p.prize.amount,
        count: p.count,
        user_id: user.userId,
        created_at: now,
        note: note,
        voided: false,
        voided_by: '',
        voided_at: '',
        client_token: String(payload.clientToken || '')
      };
    });

    dbInsertMany('Records', rows);
    let sum = 0;
    rows.forEach(function (r) { sum += r.amount; });
    return { duplicated: false, total: sum, records: rows.map(_publicRecord) };
  });
}

function _validCount(raw) {
  const n = Number(raw);
  if (!isFinite(n)) throw new Error('次數必須是數字');
  if (n < 0) throw new Error('次數不能是負數');
  if (Math.floor(n) !== n) throw new Error('次數必須是整數');
  if (n > MAX_PRIZE_COUNT) throw new Error('次數超出上限');
  return n;
}

// ── 作廢 ────────────────────────────────────────────────

function voidRecord(user, recordId) {
  requireRole(user, [ROLE_ADMIN]);
  return withLock(function () {
    const r = dbFind('Records', 'record_id', recordId);
    if (!r) throw new Error('找不到這筆紀錄');
    if (toBool(r.voided)) return { alreadyVoided: true };
    dbUpdate('Records', r._row, {
      voided: true,
      voided_by: user.userId,
      voided_at: nowIso()
    });
    return { alreadyVoided: false };
  });
}

// ── 全局預設 + 單台覆寫 ─────────────────────────────────

/**
 * 快捷金額與獎型共用的解析規則：
 * 該機台有自己的設定就用它，完全沒有才落回全局設定。
 */
function _scopedRows(sheetName, machineId) {
  const rows = dbReadAll(sheetName);
  const own = rows.filter(function (r) { return String(r.machine_id) === String(machineId); });
  if (own.length) return { rows: own, scope: 'machine' };
  return { rows: rows.filter(function (r) { return String(r.machine_id || '') === ''; }), scope: 'global' };
}

function _bySortOrder(a, b) {
  const d = toNumber(a.sort_order) - toNumber(b.sort_order);
  return d !== 0 ? d : toNumber(a.amount) - toNumber(b.amount);
}

function _resolveQuickAmounts(machineId) {
  const res = _scopedRows('QuickAmounts', machineId);
  const sorted = res.rows.slice().sort(_bySortOrder);
  const pick = function (type) {
    return sorted.filter(function (r) { return r.type === type; }).map(function (r) {
      return {
        qaId: String(r.qa_id),
        machineId: String(r.machine_id || ''),
        type: r.type,
        amount: toNumber(r.amount),
        label: r.label || ('$' + toNumber(r.amount)),
        sortOrder: toNumber(r.sort_order)
      };
    });
  };
  return { scope: res.scope, in: pick(RECORD_IN), out: pick(RECORD_OUT) };
}

function _resolvePrizes(machineId) {
  const res = _scopedRows('Prizes', machineId);
  return res.rows
    .filter(function (r) { return toBool(r.active); })
    .sort(_bySortOrder)
    .map(function (r) {
      return {
        prizeId: String(r.prize_id),
        machineId: String(r.machine_id || ''),
        name: r.name,
        amount: toNumber(r.amount),
        sortOrder: toNumber(r.sort_order),
        scope: res.scope
      };
    });
}

function listQuickAmounts(user, machineId) {
  assertMachineAccess(user, machineId);
  return _resolveQuickAmounts(machineId);
}

function listPrizes(user, machineId) {
  assertMachineAccess(user, machineId);
  return { scope: _scopedRows('Prizes', machineId).scope, prizes: _resolvePrizes(machineId) };
}

/**
 * 入幣用的碼表費率（每格代表多少錢）。跟快捷金額／獎型同一套
 * 「全局預設 + 單台可覆寫」規則，只是這裡的設定只有一個數字，不是一份清單。
 * 找不到任何列（理論上 setup() 一定會建好全局那一列）時退回 100 保底。
 */
function _resolveMeterRate(machineId) {
  const res = _scopedRows('MeterRates', machineId);
  const row = res.rows[0];
  return { scope: res.scope, rate: row ? toNumber(row.rate) : 100 };
}

function listMeterRate(user, machineId) {
  assertMachineAccess(user, machineId);
  return _resolveMeterRate(machineId);
}

/**
 * 設定碼表費率。跟快捷金額/獎型不同的是這裡永遠只有一列（單一數字，
 * 不是清單），所以不需要先「複製全局成單台」再編輯——直接依 machineId
 * 找出這個範圍現有的列就更新，沒有就新增一列，一步到位。
 * machineId 空字串＝改全局預設；有值＝改（或建立）該機台的專屬費率。
 * 「改回沿用全局」則沿用既有的 resetScope action（見 Code.gs）。
 */
function saveMeterRate(user, payload) {
  requireRole(user, [ROLE_ADMIN]);
  const scopeMachine = String(payload.machineId || '');
  if (scopeMachine) assertMachineAccess(user, scopeMachine);
  const rate = _validAmount(payload.rate);

  return withLock(function () {
    const existing = dbReadAll('MeterRates').filter(function (r) {
      return String(r.machine_id || '') === scopeMachine;
    });
    if (existing.length) {
      dbUpdate('MeterRates', existing[0]._row, { rate: rate });
      return { rateId: String(existing[0].rate_id), rate: rate };
    }
    const row = { rate_id: newId('mr'), machine_id: scopeMachine, rate: rate };
    dbInsert('MeterRates', row);
    return { rateId: row.rate_id, rate: rate };
  });
}

function saveQuickAmount(user, payload) {
  requireRole(user, [ROLE_ADMIN]);
  const scopeMachine = String(payload.machineId || '');
  if (scopeMachine) assertMachineAccess(user, scopeMachine);

  const type = payload.type;
  if (type !== RECORD_IN && type !== RECORD_OUT) throw new Error('快捷鍵類型只能是入幣或出幣');
  const amount = _validAmount(payload.amount);

  return withLock(function () {
    if (payload.qaId) {
      const row = dbFind('QuickAmounts', 'qa_id', payload.qaId);
      if (!row) throw new Error('找不到這個快捷鍵');
      dbUpdate('QuickAmounts', row._row, {
        amount: amount,
        label: String(payload.label || '').substring(0, 20),
        sort_order: toNumber(payload.sortOrder)
      });
      return { qaId: String(payload.qaId) };
    }
    const qa = {
      qa_id: newId('qa'),
      machine_id: scopeMachine,
      type: type,
      amount: amount,
      label: String(payload.label || '').substring(0, 20),
      sort_order: toNumber(payload.sortOrder)
    };
    dbInsert('QuickAmounts', qa);
    return { qaId: qa.qa_id };
  });
}

function deleteQuickAmount(user, qaId) {
  requireRole(user, [ROLE_ADMIN]);
  return withLock(function () {
    const row = dbFind('QuickAmounts', 'qa_id', qaId);
    if (!row) throw new Error('找不到這個快捷鍵');
    dbDeleteRows('QuickAmounts', [row._row]);
    return { ok: true };
  });
}

/** 把全局設定複製一份成這台機台的專屬設定，之後改這台不影響其他台。 */
/** 每張可覆寫設定表新增一列時，主鍵欄位名稱與 id 前綴。 */
const SCOPED_ID_FIELD = {
  QuickAmounts: { field: 'qa_id', prefix: 'qa' },
  Prizes: { field: 'prize_id', prefix: 'prz' },
  MeterRates: { field: 'rate_id', prefix: 'mr' }
};

function forkScopeToMachine(user, sheetName, machineId) {
  requireRole(user, [ROLE_ADMIN]);
  assertMachineAccess(user, machineId);
  const idField = SCOPED_ID_FIELD[sheetName];
  if (!idField) throw new Error('不支援的設定類型');

  return withLock(function () {
    const own = dbReadAll(sheetName).filter(function (r) { return String(r.machine_id) === String(machineId); });
    if (own.length) return { scope: 'machine', created: 0 };

    const globals = dbReadAll(sheetName).filter(function (r) { return String(r.machine_id || '') === ''; });
    // 全局本身是空的就沒東西可複製——不要靜默回報「已複製成單台」，
    // 那樣 created:0 卻宣稱 scope:'machine' 會誤導呼叫端。
    if (!globals.length) throw new Error('全局設定是空的，沒有東西可以複製');
    const copies = globals.map(function (r) {
      const copy = {};
      SCHEMA[sheetName].forEach(function (col) { copy[col] = r[col]; });
      copy[idField.field] = newId(idField.prefix);
      copy.machine_id = String(machineId);
      return copy;
    });
    dbInsertMany(sheetName, copies);
    return { scope: 'machine', created: copies.length };
  });
}

/**
 * 刪掉這台的專屬設定，回頭沿用全局。
 * MeterRates 也走這條：「改成本台自訂」用 forkScope 複製一份全局費率過來，
 * 這裡負責反過來的「改回沿用全局」。
 */
function resetScopeToGlobal(user, sheetName, machineId) {
  requireRole(user, [ROLE_ADMIN]);
  assertMachineAccess(user, machineId);
  if (!SCOPED_ID_FIELD[sheetName]) throw new Error('不支援的設定類型');

  return withLock(function () {
    const own = dbReadAll(sheetName).filter(function (r) { return String(r.machine_id) === String(machineId); });
    dbDeleteRows(sheetName, own.map(function (r) { return r._row; }));
    return { scope: 'global', removed: own.length };
  });
}

// ── 獎型（管理員）───────────────────────────────────────

function savePrize(user, payload) {
  requireRole(user, [ROLE_ADMIN]);
  const scopeMachine = String(payload.machineId || '');
  if (scopeMachine) assertMachineAccess(user, scopeMachine);

  const name = String(payload.name || '').trim();
  if (!name) throw new Error('請輸入獎型名稱');
  if (name.length > 30) throw new Error('獎型名稱請在 30 字以內');
  const amount = _validAmount(payload.amount);

  return withLock(function () {
    if (payload.prizeId) {
      const row = dbFind('Prizes', 'prize_id', payload.prizeId);
      if (!row) throw new Error('找不到這個獎型');
      dbUpdate('Prizes', row._row, {
        name: name,
        amount: amount,
        sort_order: toNumber(payload.sortOrder),
        active: payload.active === undefined ? toBool(row.active) : !!payload.active
      });
      return { prizeId: String(payload.prizeId) };
    }
    const prize = {
      prize_id: newId('prz'),
      machine_id: scopeMachine,
      name: name,
      amount: amount,
      sort_order: toNumber(payload.sortOrder),
      active: true
    };
    dbInsert('Prizes', prize);
    return { prizeId: prize.prize_id };
  });
}

/**
 * 刪除獎型＝停用。
 * 真的刪列會讓報表對不回歷史紀錄，所以只把 active 設成 false，
 * 開獎面板就不再出現它，但舊帳仍算得出來。
 */
function deletePrize(user, prizeId) {
  requireRole(user, [ROLE_ADMIN]);
  return withLock(function () {
    const row = dbFind('Prizes', 'prize_id', prizeId);
    if (!row) throw new Error('找不到這個獎型');
    dbUpdate('Prizes', row._row, { active: false });
    return { ok: true };
  });
}

/**
 * 管理員的獎型清單。
 * 回傳全局獎型本身（不是解析後的結果），另外附上哪些機台設了專屬獎型，
 * 讓管理員一眼看出「改全局會不會影響到某幾台」。
 */
function adminListPrizes(user) {
  requireRole(user, [ROLE_ADMIN]);
  const all = dbReadAll('Prizes');

  const global = all
    .filter(function (r) { return String(r.machine_id || '') === '' && toBool(r.active); })
    .sort(_bySortOrder)
    .map(function (r) {
      return {
        prizeId: String(r.prize_id),
        name: r.name,
        amount: toNumber(r.amount),
        sortOrder: toNumber(r.sort_order)
      };
    });

  const overrideCounts = {};
  all.forEach(function (r) {
    const mid = String(r.machine_id || '');
    if (!mid || !toBool(r.active)) return;
    overrideCounts[mid] = (overrideCounts[mid] || 0) + 1;
  });

  const machineNames = {};
  dbReadAll('Machines').forEach(function (m) { machineNames[String(m.machine_id)] = m.name; });

  const overrides = Object.keys(overrideCounts).map(function (mid) {
    return { machineId: mid, name: machineNames[mid] || mid, count: overrideCounts[mid] };
  });

  return { global: global, overrides: overrides };
}

// ── 機台（管理員）───────────────────────────────────────

function adminListMachines(user) {
  requireRole(user, [ROLE_ADMIN]);
  return dbReadAll('Machines')
    .sort(function (a, b) { return toNumber(a.sort_order) - toNumber(b.sort_order); })
    .map(function (m) {
      return {
        machineId: String(m.machine_id),
        name: m.name,
        location: m.location || '',
        status: m.status || 'running',
        color: m.color || '#4F7BE8',
        sortOrder: toNumber(m.sort_order),
        note: m.note || ''
      };
    });
}

function adminSaveMachine(user, payload) {
  requireRole(user, [ROLE_ADMIN]);
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('請輸入機台名稱');
  if (name.length > 30) throw new Error('機台名稱請在 30 字以內');

  const status = payload.status || 'running';
  if (['running', 'maintenance', 'offline'].indexOf(status) < 0) throw new Error('機台狀態不正確');

  let color = String(payload.color || '#4F7BE8');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = '#4F7BE8';

  return withLock(function () {
    if (payload.machineId) {
      const row = dbFind('Machines', 'machine_id', payload.machineId);
      if (!row) throw new Error('找不到這台機台');
      dbUpdate('Machines', row._row, {
        name: name,
        location: String(payload.location || '').substring(0, 50),
        status: status,
        color: color,
        sort_order: toNumber(payload.sortOrder),
        note: String(payload.note || '').substring(0, 200)
      });
      return { machineId: String(payload.machineId) };
    }
    const m = {
      machine_id: newId('mch'),
      name: name,
      location: String(payload.location || '').substring(0, 50),
      status: status,
      color: color,
      sort_order: toNumber(payload.sortOrder),
      note: String(payload.note || '').substring(0, 200),
      created_at: nowIso()
    };
    dbInsert('Machines', m);
    return { machineId: m.machine_id };
  });
}

// ── 帳號（管理員）───────────────────────────────────────

function adminListUsers(user) {
  requireRole(user, [ROLE_ADMIN]);
  return dbReadAll('Users').map(function (u) {
    const pub = _publicUser(u);
    pub.lastLoginAt = u.last_login_at || '';
    pub.createdAt = u.created_at || '';
    return pub;
  });
}

function adminSaveUser(user, payload) {
  requireRole(user, [ROLE_ADMIN]);
  const role = payload.role;
  if ([ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER].indexOf(role) < 0) throw new Error('角色不正確');
  const status = payload.status || 'active';
  if (['active', 'disabled'].indexOf(status) < 0) throw new Error('帳號狀態不正確');

  return withLock(function () {
    if (payload.userId) {
      const row = dbFind('Users', 'user_id', payload.userId);
      if (!row) throw new Error('找不到這個帳號');

      // 不能把最後一個可用的管理員降級或停用，否則沒人進得了系統管理頁
      const losingAdmin = (String(row.role) === ROLE_ADMIN) && (role !== ROLE_ADMIN || status !== 'active');
      if (losingAdmin && _activeAdminCount(row.user_id) === 0) {
        throw new Error('至少要保留一個啟用中的管理員帳號');
      }

      dbUpdate('Users', row._row, {
        display_name: String(payload.displayName || row.display_name || '').substring(0, 30),
        role: role,
        status: status
      });

      // 降級或停用後，原本的登入狀態不該還留著舊權限
      if (String(row.role) !== role || String(row.status) !== status) {
        invalidateUserSessions(row.user_id);
      }
      return { userId: String(payload.userId) };
    }

    const username = String(payload.username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) {
      throw new Error('帳號只能用英數字與 _ . -，長度 3~20');
    }
    const exists = dbReadAll('Users').some(function (u) {
      return String(u.username).toLowerCase() === username.toLowerCase();
    });
    if (exists) throw new Error('這個帳號已經存在');

    const password = String(payload.password || '');
    _assertPasswordStrength(password);

    const salt = newSalt();
    const u = {
      user_id: newId('usr'),
      username: username,
      display_name: String(payload.displayName || username).substring(0, 30),
      password_hash: hashPassword(password, salt),
      salt: salt,
      role: role,
      status: status,
      created_at: nowIso(),
      last_login_at: ''
    };
    dbInsert('Users', u);
    return { userId: u.user_id };
  });
}

/** 除了 excludeUserId 以外，還有幾個啟用中的管理員。 */
function _activeAdminCount(excludeUserId) {
  return dbReadAll('Users').filter(function (u) {
    return String(u.role) === ROLE_ADMIN
      && String(u.status) === 'active'
      && String(u.user_id) !== String(excludeUserId);
  }).length;
}

function _assertPasswordStrength(password) {
  if (password.length < 6) throw new Error('密碼至少 6 個字');
  if (password.length > 64) throw new Error('密碼請在 64 字以內');
}

/**
 * 重設密碼。全系統只有這條路能改密碼，而且只有管理員走得通。
 * 改完立刻踢掉該帳號所有裝置的登入狀態。
 */
function adminResetPassword(user, payload) {
  requireRole(user, [ROLE_ADMIN]);
  const password = String(payload.password || '');
  _assertPasswordStrength(password);

  return withLock(function () {
    const row = dbFind('Users', 'user_id', payload.userId);
    if (!row) throw new Error('找不到這個帳號');
    const salt = newSalt();
    dbUpdate('Users', row._row, {
      salt: salt,
      password_hash: hashPassword(password, salt)
    });
    const kicked = invalidateUserSessions(row.user_id);
    return { userId: String(payload.userId), sessionsCleared: kicked };
  });
}

// ── 台主授權（管理員）───────────────────────────────────

function adminListPermissions(user) {
  requireRole(user, [ROLE_ADMIN]);
  const owners = dbReadAll('Users')
    .filter(function (u) { return String(u.role) === ROLE_OWNER; })
    .map(function (u) {
      return { userId: String(u.user_id), username: u.username, displayName: u.display_name || u.username, status: u.status };
    });

  const grants = {};
  owners.forEach(function (o) { grants[o.userId] = []; });
  dbReadAll('Permissions').forEach(function (p) {
    const uid = String(p.user_id);
    if (grants[uid]) grants[uid].push(String(p.machine_id));
  });

  return { owners: owners, machines: adminListMachines(user), grants: grants };
}

function adminSetPermission(user, payload) {
  requireRole(user, [ROLE_ADMIN]);
  assertMachineAccess(user, payload.machineId);

  return withLock(function () {
    const target = dbFind('Users', 'user_id', payload.userId);
    if (!target) throw new Error('找不到這個帳號');
    if (String(target.role) !== ROLE_OWNER) {
      throw new Error('只有台主需要逐台授權，管理員與巡邏人員本來就看得到全部機台');
    }

    const existing = dbReadAll('Permissions').filter(function (p) {
      return String(p.user_id) === String(payload.userId) && String(p.machine_id) === String(payload.machineId);
    });

    if (payload.granted) {
      if (!existing.length) {
        dbInsert('Permissions', {
          user_id: String(payload.userId),
          machine_id: String(payload.machineId),
          granted_by: user.userId,
          granted_at: nowIso()
        });
      }
    } else if (existing.length) {
      dbDeleteRows('Permissions', existing.map(function (p) { return p._row; }));
    }

    return { userId: String(payload.userId), machineId: String(payload.machineId), granted: !!payload.granted };
  });
}

/**
 * 系統管理頁一次進頁面／切分頁需要的四組資料，合併成一次呼叫。
 *
 * adminListUsers / adminListMachines / adminListPrizes / adminListPermissions
 * 各自獨立存在主要是給自我測試分開驗證用；前端一次要全部資料時改叫這支，
 * 省掉分開打 4 次 API 各自要付的固定成本（GAS 執行 + 每次 /exec 的一次轉址）。
 */
function adminBootstrap(user) {
  requireRole(user, [ROLE_ADMIN]);
  return {
    users: adminListUsers(user),
    machines: adminListMachines(user),
    prizes: adminListPrizes(user),
    perms: adminListPermissions(user)
  };
}

// ────────────────────────────────────────────────────────────
// Reports.gs
// ────────────────────────────────────────────────────────────
/**
 * Reports.gs — 報表彙總、趨勢、獎型統計、CSV
 *
 * 區間一律用當地日期字串 'yyyy-MM-dd' 表示與比較，
 * 不做時區換算，避免跨日的帳算到隔天去。
 */

const REPORT_RECORD_LIMIT = 500;

// ── 日期工具（純字串運算，不受伺服器時區影響）──────────

function _keyToUtcDate(key) {
  const p = String(key).split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}

function _utcDateToKey(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

function _addDays(key, n) {
  const d = _keyToUtcDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return _utcDateToKey(d);
}

function _isValidKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(key || ''));
}

/**
 * 把 preset 換算成 from / to。
 * day=今天、week=本週（週一起）、month=本月（1 號起）、custom=自己給。
 */
function resolveRange(preset, from, to) {
  const today = todayKey();

  if (preset === 'custom') {
    if (!_isValidKey(from) || !_isValidKey(to)) throw new Error('日期格式不正確');
    if (from > to) throw new Error('起始日期不能晚於結束日期');
    return { from: from, to: to, preset: 'custom' };
  }
  if (preset === 'week') {
    const dow = _keyToUtcDate(today).getUTCDay(); // 0=週日
    const backToMonday = (dow + 6) % 7;
    return { from: _addDays(today, -backToMonday), to: today, preset: 'week' };
  }
  if (preset === 'month') {
    return { from: today.substring(0, 8) + '01', to: today, preset: 'month' };
  }
  return { from: today, to: today, preset: 'day' };
}

function _eachDay(from, to) {
  const days = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 400) {
    days.push(cur);
    cur = _addDays(cur, 1);
    guard++;
  }
  return days;
}

// ── 報表 ────────────────────────────────────────────────

/**
 * params: { machineId?, preset, from?, to?, type?, userId? }
 * machineId 留空＝這個帳號看得到的所有機台合併。
 */
function getReport(user, params) {
  const scope = _reportScope(user, params);
  const range = resolveRange(params.preset, params.from, params.to);
  const rows = _reportRows(scope.ids, range, params);

  const summary = emptySummary();
  const daily = {};
  _eachDay(range.from, range.to).forEach(function (d) { daily[d] = emptySummary(); });

  const prizeStats = {};

  rows.forEach(function (r) {
    _accumulate(summary, r);
    const key = localDateKey(r.created_at);
    if (daily[key]) _accumulate(daily[key], r);

    if (r.type === RECORD_PRIZE) {
      const name = String(r.prize_name || '(未命名獎型)');
      if (!prizeStats[name]) prizeStats[name] = { name: name, count: 0, amount: 0 };
      prizeStats[name].count += toNumber(r.count);
      prizeStats[name].amount += toNumber(r.amount);
    }
  });

  const trend = _eachDay(range.from, range.to).map(function (d) {
    return {
      date: d,
      in: daily[d].in,
      out: daily[d].out,
      prize: daily[d].prize,
      net: daily[d].net
    };
  });

  const stats = Object.keys(prizeStats).map(function (k) { return prizeStats[k]; });
  stats.sort(function (a, b) { return b.amount - a.amount; });

  const sorted = rows.slice().sort(_byCreatedAtDesc);

  return {
    range: range,
    scope: { machineId: scope.machineId, machineName: scope.machineName, machineCount: scope.ids.length },
    summary: summary,
    trend: trend,
    prizeStats: stats,
    records: sorted.slice(0, REPORT_RECORD_LIMIT).map(_publicRecord),
    recordCount: rows.length,
    truncated: rows.length > REPORT_RECORD_LIMIT,
    operators: _operatorOptions(scope.ids)
  };
}

/** 報表要看哪些機台：指定單台就驗權限，沒指定就是這個帳號看得到的全部。 */
function _reportScope(user, params) {
  if (params.machineId) {
    assertMachineAccess(user, params.machineId);
    const m = dbFind('Machines', 'machine_id', params.machineId);
    return {
      ids: [String(params.machineId)],
      machineId: String(params.machineId),
      machineName: m ? m.name : ''
    };
  }
  return { ids: visibleMachineIds(user), machineId: '', machineName: '' };
}

function _reportRows(machineIds, range, params) {
  const idSet = {};
  machineIds.forEach(function (id) { idSet[id] = true; });

  return activeRecords().filter(function (r) {
    if (!idSet[String(r.machine_id)]) return false;
    const key = localDateKey(r.created_at);
    if (key < range.from || key > range.to) return false;
    if (params.type && r.type !== params.type) return false;
    if (params.userId && String(r.user_id) !== String(params.userId)) return false;
    return true;
  });
}

/** 篩選用的「操作人」下拉選項，只列這些機台實際出現過的人。 */
function _operatorOptions(machineIds) {
  const idSet = {};
  machineIds.forEach(function (id) { idSet[id] = true; });

  const seen = {};
  activeRecords().forEach(function (r) {
    if (idSet[String(r.machine_id)]) seen[String(r.user_id)] = true;
  });

  return dbReadAll('Users')
    .filter(function (u) { return seen[String(u.user_id)]; })
    .map(function (u) { return { userId: String(u.user_id), name: u.display_name || u.username }; });
}

// ── CSV ─────────────────────────────────────────────────

function _csvCell(v) {
  const s = (v === undefined || v === null) ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const TYPE_LABELS = { in: '入幣', out: '出幣', prize: '開獎' };

/**
 * 匯出整個區間的紀錄（不受畫面 500 筆上限影響）。
 * BOM 由前端加，這裡只回純 CSV 內容。
 */
function exportCsv(user, params) {
  const scope = _reportScope(user, params);
  const range = resolveRange(params.preset, params.from, params.to);
  const rows = _reportRows(scope.ids, range, params);

  const machineNames = {};
  dbReadAll('Machines').forEach(function (m) { machineNames[String(m.machine_id)] = m.name; });
  const userNames = {};
  dbReadAll('Users').forEach(function (u) { userNames[String(u.user_id)] = u.display_name || u.username; });

  const lines = [];
  lines.push(['日期', '時間', '機台', '類型', '金額', '獎型', '單價', '次數', '上班表', '下班表', '操作人', '備註'].join(','));

  rows.sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
  rows.forEach(function (r) {
    const d = new Date(r.created_at);
    lines.push([
      _csvCell(localDateKey(r.created_at)),
      _csvCell(isNaN(d.getTime()) ? '' : Utilities.formatDate(d, _tz(), 'HH:mm:ss')),
      _csvCell(machineNames[String(r.machine_id)] || r.machine_id),
      _csvCell(TYPE_LABELS[r.type] || r.type),
      _csvCell(toNumber(r.amount)),
      _csvCell(r.prize_name || ''),
      _csvCell(r.unit_amount === '' ? '' : toNumber(r.unit_amount)),
      _csvCell(r.count === '' ? '' : toNumber(r.count)),
      _csvCell(r.meter_start === '' ? '' : toNumber(r.meter_start)),
      _csvCell(r.meter_end === '' ? '' : toNumber(r.meter_end)),
      _csvCell(userNames[String(r.user_id)] || ''),
      _csvCell(r.note || '')
    ].join(','));
  });

  const summary = emptySummary();
  rows.forEach(function (r) { _accumulate(summary, r); });
  lines.push('');
  lines.push(['合計', '', '', '入幣', summary.in, '出幣', summary.out, '開獎', summary.prize, '', '', ''].map(_csvCell).join(','));
  lines.push(['', '', '', '淨收益', summary.net, '', '', '', '', '', '', ''].map(_csvCell).join(','));

  const label = scope.machineName || '全部機台';
  return {
    filename: '娃娃機報表_' + label + '_' + range.from + '_' + range.to + '.csv',
    content: lines.join('\r\n'),
    rowCount: rows.length
  };
}

// ────────────────────────────────────────────────────────────
// Code.gs
// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
// Test.gs
// ────────────────────────────────────────────────────────────
/**
 * Test.gs — 自我測試（選擇性貼上）
 *
 * 在 GAS 編輯器選 runSelfTest 執行即可。
 * 會另外開一份暫時的試算表跑完全部測試，跑完自動丟進垃圾桶，
 * 完全不會碰到你的正式資料。
 *
 * 測試一律透過 handleApi() 走完整路徑（驗 token → 驗角色 → 驗機台權限），
 * 確保測到的就是線上實際會執行的那條路。
 */

function runSelfTest() {
  const props = PropertiesService.getScriptProperties();
  const original = props.getProperty('SPREADSHEET_ID');
  const temp = SpreadsheetApp.create('【自我測試】娃娃機管理系統 ' + nowIso());
  const results = [];

  try {
    props.setProperty('SPREADSHEET_ID', temp.getId());
    _clearSheetCache();
    _selfTestBody(results);
  } catch (err) {
    results.push({ ok: false, name: '測試流程本身中斷', err: err.message });
  } finally {
    if (original) props.setProperty('SPREADSHEET_ID', original);
    else props.deleteProperty('SPREADSHEET_ID');
    _clearSheetCache();
    try { DriveApp.getFileById(temp.getId()).setTrashed(true); } catch (e) { /* 清不掉就算了 */ }
  }

  const failed = results.filter(function (r) { return !r.ok; });
  const lines = results.map(function (r) {
    return (r.ok ? '  ✅ ' : '  ❌ ') + r.name + (r.ok ? '' : ' → ' + r.err);
  });
  lines.unshift('自我測試結果：' + (results.length - failed.length) + ' / ' + results.length + ' 通過');
  if (failed.length) lines.push('', '⚠️ 有 ' + failed.length + ' 項未通過，請先修正再部署。');
  else lines.push('', '🎉 全部通過。');

  const report = lines.join('\n');
  Logger.log(report);
  return report;
}

// ── 斷言工具 ────────────────────────────────────────────

function _t(results, name, fn) {
  try {
    fn();
    results.push({ ok: true, name: name });
  } catch (err) {
    results.push({ ok: false, name: name, err: err.message });
  }
}

function _assert(cond, msg) {
  if (!cond) throw new Error(msg || '斷言失敗');
}

function _assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '值不符') + '：預期 ' + expected + '，實際 ' + actual);
  }
}

/** 呼叫 API 並要求成功，回傳 data。 */
function _ok(payload) {
  const res = handleApi(payload);
  if (!res.ok) throw new Error('預期成功但失敗了：' + res.error);
  return res.data;
}

/** 呼叫 API 並要求失敗，可指定錯誤代碼。 */
function _fails(payload, expectCode) {
  const res = handleApi(payload);
  if (res.ok) throw new Error('預期被拒絕，但竟然成功了');
  if (expectCode && res.code !== expectCode) {
    throw new Error('錯誤代碼不符：預期 ' + expectCode + '，實際 ' + res.code + '（' + res.error + '）');
  }
  return res;
}

function _mkUser(username, role, password) {
  const salt = newSalt();
  const u = {
    user_id: newId('usr'),
    username: username,
    display_name: username,
    password_hash: hashPassword(password, salt),
    salt: salt,
    role: role,
    status: 'active',
    created_at: nowIso(),
    last_login_at: ''
  };
  dbInsert('Users', u);
  return u;
}

function _token(username, password, remember) {
  CacheService.getScriptCache().remove(_failKey(username));
  return _ok({ action: 'login', username: username, password: password, remember: !!remember }).token;
}

// ── 測試本體 ────────────────────────────────────────────

function _selfTestBody(results) {
  // ── 佈置：3 個帳號、2 台機台，台主只授權機台 A ──
  Object.keys(SCHEMA).forEach(function (n) { dbReadAll(n); });

  _t(results, '新建立的分頁頁籤與表頭都是中文', function () {
    const ss = _spreadsheet();
    Object.keys(SCHEMA).forEach(function (name) {
      const sh = ss.getSheetByName(SHEET_TAB_NAMES[name]);
      _assert(sh, name + ' 分頁應該用中文頁籤名稱「' + SHEET_TAB_NAMES[name] + '」建立');
      const header = sh.getRange(1, 1, 1, SCHEMA[name].length).getValues()[0];
      _assertEq(JSON.stringify(header), JSON.stringify(HEADER_LABELS[name]), name + ' 分頁的表頭應該是中文');
    });
  });

  _t(results, '舊版英文頁籤名稱會被改名成中文，資料原封不動', function () {
    const ss = _spreadsheet();
    delete _sheetCache.Machines;
    const before = dbReadAll('Machines'); // 目前已經是中文頁籤「機台」
    const beforeCount = before.length;

    // 模擬「用改版前的程式碼建立的舊試算表」：頁籤名稱改回英文鍵值
    ss.getSheetByName(SHEET_TAB_NAMES.Machines).setName('Machines');
    delete _sheetCache.Machines;

    const rows = dbReadAll('Machines'); // 觸發 _sheet() 的英文頁籤 fallback，應該原地改名，不是新開一張
    _assertEq(rows.length, beforeCount, '改名後資料筆數應該不變');
    _assert(!!ss.getSheetByName(SHEET_TAB_NAMES.Machines), '應該能用中文頁籤名稱重新找到這張分頁');
    _assert(!ss.getSheetByName('Machines'), '改名後不該再有英文頁籤殘留');
  });

  // 手動塞這一列，模擬真實環境跑過 setup() 之後的狀態——這裡故意不直接呼叫
  // 真正的 setup()，因為它在「目前沒有啟用中管理員」時會自動建一個，
  // 會干擾後面依賴「當下只有一個管理員」的測試（見檔案最後方的說明）。
  dbInsert('MeterRates', { rate_id: newId('mr'), machine_id: '', rate: 100 });

  const admin = _mkUser('t_admin', ROLE_ADMIN, 'admin123');
  const patrol = _mkUser('t_patrol', ROLE_PATROL, 'patrol123');
  const owner = _mkUser('t_owner', ROLE_OWNER, 'owner123');
  _clearSheetCache();

  const adminTok = _token('t_admin', 'admin123');
  const machineA = _ok({ action: 'adminSaveMachine', token: adminTok, name: '機台A', sortOrder: 1 }).machineId;
  const machineB = _ok({ action: 'adminSaveMachine', token: adminTok, name: '機台B', sortOrder: 2 }).machineId;

  _ok({ action: 'adminSetPermission', token: adminTok, userId: owner.user_id, machineId: machineA, granted: true });

  const patrolTok = _token('t_patrol', 'patrol123');
  const ownerTok = _token('t_owner', 'owner123');

  // ── 登入與 Session ──
  _t(results, '正確密碼可登入', function () {
    _assert(_token('t_admin', 'admin123'), '沒拿到 token');
  });

  _t(results, '登入回應會一併帶回首頁資料，不用另外再打一次 dashboard', function () {
    CacheService.getScriptCache().remove(_failKey('t_admin'));
    const res = _ok({ action: 'login', username: 't_admin', password: 'admin123' });
    _assert(res.dashboard, '登入回應應該要有 dashboard 欄位');
    const dashboard = _ok({ action: 'dashboard', token: res.token });
    _assertEq(res.dashboard.machines.length, dashboard.machines.length, '登入帶回的 dashboard 應該跟分開打的一致');
  });

  _t(results, '錯誤密碼被拒', function () {
    _fails({ action: 'login', username: 't_admin', password: 'wrong' });
    CacheService.getScriptCache().remove(_failKey('t_admin'));
  });

  _t(results, '亂編的 token 被拒', function () {
    _fails({ action: 'dashboard', token: 'not-a-real-token' }, 'AUTH');
  });

  _t(results, '沒帶 token 被拒', function () {
    _fails({ action: 'dashboard' }, 'AUTH');
  });

  _t(results, '連續失敗 5 次後被鎖 15 分鐘', function () {
    const u = _mkUser('t_lockme', ROLE_OWNER, 'lock123');
    _clearSheetCache();
    CacheService.getScriptCache().remove(_failKey('t_lockme'));
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) {
      _fails({ action: 'login', username: 't_lockme', password: 'nope' });
    }
    const res = _fails({ action: 'login', username: 't_lockme', password: 'lock123' });
    _assert(res.error.indexOf('次數過多') >= 0, '應該是被鎖的訊息，實際：' + res.error);
    CacheService.getScriptCache().remove(_failKey('t_lockme'));
    _assert(u.user_id, '');
  });

  _t(results, '不勾記住我：有效期約 12 小時', function () {
    const tok = _token('t_patrol', 'patrol123', false);
    const sess = dbFind('Sessions', 'token', tok);
    const hours = (new Date(sess.expires_at).getTime() - Date.now()) / 3600000;
    _assert(hours > 11.5 && hours < 12.5, '有效期應接近 12 小時，實際 ' + hours.toFixed(2) + ' 小時');
    _assertEq(toBool(sess.remember), false, 'remember 旗標');
  });

  _t(results, '勾記住我：有效期約 7 天', function () {
    const tok = _token('t_patrol', 'patrol123', true);
    const sess = dbFind('Sessions', 'token', tok);
    const days = (new Date(sess.expires_at).getTime() - Date.now()) / 86400000;
    _assert(days > 6.9 && days < 7.1, '有效期應接近 7 天，實際 ' + days.toFixed(2) + ' 天');
    _assertEq(toBool(sess.remember), true, 'remember 旗標');
  });

  _t(results, '到期的 token 立刻失效', function () {
    const tok = _token('t_owner', 'owner123', true);
    const sess = dbFind('Sessions', 'token', tok);
    dbUpdate('Sessions', sess._row, { expires_at: new Date(Date.now() - 1000).toISOString() });
    CacheService.getScriptCache().remove(_sessionCacheKey(tok));
    _fails({ action: 'dashboard', token: tok }, 'AUTH');
  });

  // ── 帳號與密碼 ──
  _t(results, '管理員改密碼後，舊 token 全部失效', function () {
    const victim = _mkUser('t_victim', ROLE_OWNER, 'old123456');
    _clearSheetCache();
    const vTok = _token('t_victim', 'old123456', true);
    _ok({ action: 'me', token: vTok });

    _ok({ action: 'adminResetPassword', token: adminTok, userId: victim.user_id, password: 'new123456' });

    _fails({ action: 'me', token: vTok }, 'AUTH');
    _fails({ action: 'login', username: 't_victim', password: 'old123456' });
    CacheService.getScriptCache().remove(_failKey('t_victim'));
    _assert(_token('t_victim', 'new123456'), '新密碼應該可以登入');
  });

  _t(results, '一般帳號無法改密碼（沒有自助路徑）', function () {
    _fails({ action: 'adminResetPassword', token: patrolTok, userId: patrol.user_id, password: 'hack123456' }, 'PERMISSION');
    _fails({ action: 'adminResetPassword', token: ownerTok, userId: owner.user_id, password: 'hack123456' }, 'PERMISSION');
    _fails({ action: 'adminSaveUser', token: patrolTok, userId: patrol.user_id, role: ROLE_ADMIN, status: 'active' }, 'PERMISSION');
  });

  _t(results, '不能把最後一個管理員降級', function () {
    _fails({ action: 'adminSaveUser', token: adminTok, userId: admin.user_id, role: ROLE_PATROL, status: 'active' });
  });

  _t(results, '密碼太短會被擋', function () {
    _fails({ action: 'adminResetPassword', token: adminTok, userId: owner.user_id, password: '123' });
  });

  // ── 角色可見範圍 ──
  _t(results, '管理員與巡邏人員看得到全部機台', function () {
    _assertEq(_ok({ action: 'dashboard', token: adminTok }).machines.length, 2, '管理員可見機台數');
    _assertEq(_ok({ action: 'dashboard', token: patrolTok }).machines.length, 2, '巡邏人員可見機台數');
  });

  _t(results, '台主只看得到被授權的機台', function () {
    const d = _ok({ action: 'dashboard', token: ownerTok });
    _assertEq(d.machines.length, 1, '台主可見機台數');
    _assertEq(d.machines[0].machineId, machineA, '台主看到的應該是機台A');
  });

  _t(results, '台主拿別台 id 直接打 API 會被擋', function () {
    _fails({ action: 'machineDetail', token: ownerTok, machineId: machineB }, 'PERMISSION');
    _fails({ action: 'report', token: ownerTok, machineId: machineB, preset: 'day' }, 'PERMISSION');
    _fails({ action: 'exportCsv', token: ownerTok, machineId: machineB, preset: 'day' }, 'PERMISSION');
  });

  _t(results, '新增機台後管理員與巡邏人員立刻看得到，台主看不到', function () {
    _ok({ action: 'adminSaveMachine', token: adminTok, name: '機台C', sortOrder: 3 });
    _assertEq(_ok({ action: 'dashboard', token: adminTok }).machines.length, 3, '管理員');
    _assertEq(_ok({ action: 'dashboard', token: patrolTok }).machines.length, 3, '巡邏人員');
    _assertEq(_ok({ action: 'dashboard', token: ownerTok }).machines.length, 1, '台主');
  });

  // ── 記帳權限 ──
  _t(results, '巡邏人員可以記帳', function () {
    _ok({ action: 'addRecord', token: patrolTok, machineId: machineA, type: 'in', amount: 100, clientToken: newId('ct') });
  });

  _t(results, '台主不能記帳（連自己的機台也不行）', function () {
    _fails({ action: 'addRecord', token: ownerTok, machineId: machineA, type: 'in', amount: 100, clientToken: newId('ct') }, 'PERMISSION');
    _fails({ action: 'addPrizeRecord', token: ownerTok, machineId: machineA, items: [], clientToken: newId('ct') }, 'PERMISSION');
  });

  _t(results, '巡邏人員不能碰管理功能', function () {
    _fails({ action: 'savePrize', token: patrolTok, name: '偷加的獎', amount: 1 }, 'PERMISSION');
    _fails({ action: 'saveQuickAmount', token: patrolTok, type: 'in', amount: 1 }, 'PERMISSION');
    _fails({ action: 'adminListUsers', token: patrolTok }, 'PERMISSION');
    _fails({ action: 'adminSetPermission', token: patrolTok, userId: owner.user_id, machineId: machineA, granted: true }, 'PERMISSION');
  });

  _t(results, 'adminBootstrap 合併回傳的內容跟分開打 4 支 API 一致，且僅限管理員', function () {
    _fails({ action: 'adminBootstrap', token: patrolTok }, 'PERMISSION');
    _fails({ action: 'adminBootstrap', token: ownerTok }, 'PERMISSION');

    const combined = _ok({ action: 'adminBootstrap', token: adminTok });
    const users = _ok({ action: 'adminListUsers', token: adminTok });
    const machines = _ok({ action: 'adminListMachines', token: adminTok });
    const prizes = _ok({ action: 'adminListPrizes', token: adminTok });
    const perms = _ok({ action: 'adminListPermissions', token: adminTok });

    _assertEq(combined.users.length, users.length, 'users 筆數應一致');
    _assertEq(combined.machines.length, machines.length, 'machines 筆數應一致');
    _assertEq(combined.prizes.global.length, prizes.global.length, 'prizes.global 筆數應一致');
    _assertEq(combined.perms.owners.length, perms.owners.length, 'perms.owners 筆數應一致');
  });

  _t(results, 'homeBootstrap 合併回傳的內容跟分開打 me + dashboard 一致，三種角色都能用', function () {
    [adminTok, patrolTok, ownerTok].forEach(function (tok) {
      const combined = _ok({ action: 'homeBootstrap', token: tok });
      const me = _ok({ action: 'me', token: tok });
      const dashboard = _ok({ action: 'dashboard', token: tok });

      _assertEq(combined.user.userId, me.user.userId, 'user 應該跟 me 回傳的一致');
      _assertEq(combined.machineCount, me.machineCount, 'machineCount 應該跟 me 回傳的一致');
      _assertEq(combined.dashboard.machines.length, dashboard.machines.length, 'dashboard.machines 筆數應一致');
      _assertEq(JSON.stringify(combined.dashboard.todayTotal), JSON.stringify(dashboard.todayTotal), 'dashboard.todayTotal 應一致');
    });
  });

  // ── 收益計算 ──
  _t(results, '入幣 100、出幣 30 → 淨收益 70；作廢出幣後 → 100', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '計算測試台', sortOrder: 9 }).machineId;
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 100, clientToken: newId('ct') });
    const outRec = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 30, clientToken: newId('ct') });

    let d = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(d.total.net, 70, '作廢前淨收益');

    _ok({ action: 'voidRecord', token: adminTok, recordId: outRec.records[0].recordId });
    d = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(d.total.net, 100, '作廢後淨收益');
    _assertEq(d.total.out, 0, '作廢後出幣總額');
  });

  _t(results, '同一個 clientToken 送兩次只會寫入一筆', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '冪等測試台', sortOrder: 10 }).machineId;
    const ct = newId('ct');
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 50, clientToken: ct });
    const second = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 50, clientToken: ct });
    _assertEq(second.duplicated, true, '第二次應被判定為重複');
    _assertEq(_ok({ action: 'machineDetail', token: adminTok, machineId: mid }).total.in, 50, '總入幣');
  });

  // ── 開獎 ──
  const prizeMachine = _ok({ action: 'adminSaveMachine', token: adminTok, name: '開獎測試台', sortOrder: 11 }).machineId;
  const bigPrize = _ok({ action: 'savePrize', token: adminTok, name: '大娃', amount: 150, sortOrder: 1 }).prizeId;
  const smallPrize = _ok({ action: 'savePrize', token: adminTok, name: '小娃', amount: 40, sortOrder: 2 }).prizeId;

  _t(results, '開獎：大娃×1 + 小娃×2 → 寫 2 列、成本 230', function () {
    const res = _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: prizeMachine,
      items: [{ prizeId: bigPrize, count: 1 }, { prizeId: smallPrize, count: 2 }],
      clientToken: newId('ct')
    });
    _assertEq(res.records.length, 2, '應寫入 2 列');
    _assertEq(res.total, 230, '開獎總成本');
  });

  _t(results, '開獎算成本：淨收益 = 入 − 出 − 開獎', function () {
    _ok({ action: 'addRecord', token: adminTok, machineId: prizeMachine, type: 'in', amount: 1000, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: prizeMachine, type: 'out', amount: 100, clientToken: newId('ct') });
    const d = _ok({ action: 'machineDetail', token: adminTok, machineId: prizeMachine });
    _assertEq(d.total.prize, 230, '開獎總額');
    _assertEq(d.total.net, 1000 - 100 - 230, '淨收益');
  });

  _t(results, '前端傳來的金額一律不採信', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '偽造測試台', sortOrder: 12 }).machineId;
    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: bigPrize, count: 1, amount: 1, unitAmount: 1 }],
      amount: 1, clientToken: newId('ct')
    });
    _assertEq(_ok({ action: 'machineDetail', token: adminTok, machineId: mid }).total.prize, 150, '應以 Prizes 表的單價計算');
  });

  _t(results, '不合法的次數會被擋（負數／小數／超大值）', function () {
    [-1, 1.5, MAX_PRIZE_COUNT + 1].forEach(function (bad) {
      _fails({
        action: 'addPrizeRecord', token: adminTok, machineId: prizeMachine,
        items: [{ prizeId: bigPrize, count: bad }], clientToken: newId('ct')
      });
    });
  });

  _t(results, '次數全為 0 會被擋（避免送出空白單）', function () {
    _fails({
      action: 'addPrizeRecord', token: adminTok, machineId: prizeMachine,
      items: [{ prizeId: bigPrize, count: 0 }], clientToken: newId('ct')
    });
  });

  _t(results, '改價與停用獎型都不會動到歷史帳', function () {
    _ok({ action: 'savePrize', token: adminTok, prizeId: bigPrize, name: '超大娃', amount: 200, sortOrder: 1 });
    const d = _ok({ action: 'machineDetail', token: adminTok, machineId: prizeMachine });
    _assertEq(d.total.prize, 230, '改價後歷史開獎總額不該變');

    const old = d.records.filter(function (r) { return r.prizeName === '大娃'; });
    _assert(old.length > 0, '舊紀錄應保留原本的獎型名稱快照');
    _assertEq(old[0].unitAmount, 150, '舊紀錄的單價快照');

    _ok({ action: 'deletePrize', token: adminTok, prizeId: bigPrize });
    const listed = _ok({ action: 'listPrizes', token: adminTok, machineId: prizeMachine }).prizes;
    _assertEq(listed.filter(function (p) { return p.prizeId === bigPrize; }).length, 0, '停用後不該再出現在開獎面板');
    _assertEq(_ok({ action: 'machineDetail', token: adminTok, machineId: prizeMachine }).total.prize, 230, '停用後歷史帳仍算得出來');
  });

  // ── 入幣（碼表計算）──
  const meterMachine = _ok({ action: 'adminSaveMachine', token: adminTok, name: '碼表測試台', sortOrder: 15 }).machineId;

  _t(results, '入幣：(下班表－上班表)×費率，預設費率 100', function () {
    const res = _ok({
      action: 'addMeterRecord', token: adminTok, machineId: meterMachine,
      meterStart: 1000, meterEnd: 1050, clientToken: newId('ct')
    });
    _assertEq(res.records.length, 1, '應該只寫入一筆');
    _assertEq(res.records[0].amount, 5000, '(1050-1000)×100 應該是 5000');
    _assertEq(res.records[0].meterStart, 1000, '應保留上班表讀數');
    _assertEq(res.records[0].meterEnd, 1050, '應保留下班表讀數');
    _assertEq(res.records[0].type, 'in', '應該算成入幣');
  });

  _t(results, '入幣：金額與費率一律由後端算，前端塞假資料沒有用', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '碼表偽造測試台', sortOrder: 16 }).machineId;
    const res = _ok({
      action: 'addMeterRecord', token: adminTok, machineId: mid,
      meterStart: 0, meterEnd: 10, amount: 1, rate: 1, clientToken: newId('ct')
    });
    _assertEq(res.records[0].amount, 1000, '應該用伺服器的費率 100 計算，不理會前端傳來的 amount/rate');
  });

  _t(results, '入幣：下班表必須大於上班表', function () {
    _fails({ action: 'addMeterRecord', token: adminTok, machineId: meterMachine, meterStart: 500, meterEnd: 500, clientToken: newId('ct') });
    _fails({ action: 'addMeterRecord', token: adminTok, machineId: meterMachine, meterStart: 500, meterEnd: 400, clientToken: newId('ct') });
  });

  _t(results, '入幣：碼表讀數必須是非負整數', function () {
    [-1, 1.5].forEach(function (bad) {
      _fails({ action: 'addMeterRecord', token: adminTok, machineId: meterMachine, meterStart: bad, meterEnd: 999999, clientToken: newId('ct') });
    });
  });

  _t(results, '入幣：台主不能記帳，巡邏人員可以', function () {
    _fails({ action: 'addMeterRecord', token: ownerTok, machineId: machineA, meterStart: 0, meterEnd: 10, clientToken: newId('ct') }, 'PERMISSION');
    _ok({ action: 'addMeterRecord', token: patrolTok, machineId: meterMachine, meterStart: 1050, meterEnd: 1060, clientToken: newId('ct') });
  });

  _t(results, '入幣：同一個 clientToken 送兩次只會寫入一筆', function () {
    const ct = newId('ct');
    _ok({ action: 'addMeterRecord', token: adminTok, machineId: meterMachine, meterStart: 2000, meterEnd: 2010, clientToken: ct });
    const second = _ok({ action: 'addMeterRecord', token: adminTok, machineId: meterMachine, meterStart: 2000, meterEnd: 2010, clientToken: ct });
    _assertEq(second.duplicated, true, '第二次應被判定為重複');
  });

  _t(results, '入幣：detail 頁會帶出上次的下班表，給前端自動帶入下一次的上班表', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '碼表接續測試台', sortOrder: 17 }).machineId;
    let d = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(d.lastMeterReading, null, '從沒記過帳的機台應該是 null');

    _ok({ action: 'addMeterRecord', token: adminTok, machineId: mid, meterStart: 100, meterEnd: 200, clientToken: newId('ct') });
    d = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(d.lastMeterReading, 200, '應該是最新一筆的下班表讀數');

    _ok({ action: 'addMeterRecord', token: adminTok, machineId: mid, meterStart: 200, meterEnd: 350, clientToken: newId('ct') });
    d = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(d.lastMeterReading, 350, '再記一筆後應該更新成最新的下班表讀數');
  });

  _t(results, '修正入幣改版當時欄位錯位：舊紀錄與錯位紀錄都能救回，且天生冪等', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '欄位錯位測試台', sortOrder: 90 }).machineId;
    const sh = _spreadsheet().getSheetByName(SHEET_TAB_NAMES.Records);
    const startRow = sh.getLastRow() + 1;

    // 模擬「改版前」的舊格式：15 個實體欄位，沒有 meter_start/meter_end，
    // user_id 好端端在第 9 欄、created_at 在第 10 欄、voided 在第 12 欄。
    const oldFormatRow = [
      'rec_legacy001', mid, 'out', 500, '', '', '', '',
      admin.user_id, '2026-01-01T00:00:00.000Z', '備註A', false, '', '', 'ct_legacy001'
    ];

    // 模擬「改版當下、還沒修好之前」寫入的錯位格式：meter_start/meter_end
    // 插在第 9、10 欄，後面的 user_id/created_at/... 全部往後推兩欄。
    const brokenFormatRow = [
      'rec_broken001', mid, 'in', 8000, '', '', '', '',
      1000, 1080, admin.user_id, '2026-01-02T00:00:00.000Z', '', false, '', '', 'ct_broken001'
    ];

    sh.getRange(startRow, 1, 1, oldFormatRow.length).setValues([oldFormatRow]);
    sh.getRange(startRow + 1, 1, 1, brokenFormatRow.length).setValues([brokenFormatRow]);
    delete _sheetCache.Records;

    const fixedCount = _migrateRecordsMeterColumns();
    _assert(fixedCount >= 1, '應該至少修好剛剛塞的那筆錯位紀錄');
    delete _sheetCache.Records;

    const legacy = dbFind('Records', 'record_id', 'rec_legacy001');
    _assertEq(legacy.user_id, admin.user_id, '舊格式紀錄的操作人本來就對，不該被migration動到');
    _assertEq(legacy.created_at, '2026-01-01T00:00:00.000Z', '舊格式紀錄的建立時間本來就對');
    _assertEq(legacy.meter_start, '', '舊格式紀錄本來就沒有碼表資料，應該是空的');
    _assertEq(legacy.meter_end, '', '舊格式紀錄本來就沒有碼表資料，應該是空的');

    const broken = dbFind('Records', 'record_id', 'rec_broken001');
    _assertEq(broken.user_id, admin.user_id, '錯位紀錄的操作人應該被搬回正確位置');
    _assertEq(broken.created_at, '2026-01-02T00:00:00.000Z', '錯位紀錄的建立時間應該被搬回正確位置');
    _assertEq(toNumber(broken.meter_start), 1000, '錯位紀錄的上班表讀數應該被搬到最後面的正確欄位');
    _assertEq(toNumber(broken.meter_end), 1080, '錯位紀錄的下班表讀數應該被搬到最後面的正確欄位');
    _assertEq(toBool(broken.voided), false, '錯位紀錄的作廢狀態應該被搬回正確位置');
    _assertEq(broken.client_token, 'ct_broken001', '錯位紀錄的防重複權杖應該被搬回正確位置');

    const secondRun = _migrateRecordsMeterColumns();
    _assertEq(secondRun, 0, '修好之後再跑一次應該天生冪等，不會再搬動任何一筆');
  });

  _t(results, '入幣費率：全局預設 + 單台覆寫，改回沿用全局；費率變動不影響歷史紀錄', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '費率覆寫測試台', sortOrder: 18 }).machineId;

    let rate = _ok({ action: 'listMeterRate', token: adminTok, machineId: mid });
    _assertEq(rate.scope, 'global', '一開始應沿用全局');
    _assertEq(rate.rate, 100, '全局預設費率應該是 100');

    const before = _ok({
      action: 'addMeterRecord', token: adminTok, machineId: mid,
      meterStart: 0, meterEnd: 10, clientToken: newId('ct')
    });
    _assertEq(before.records[0].amount, 1000, '用全局費率 100 算出來應該是 1000');

    _ok({ action: 'saveMeterRate', token: adminTok, machineId: mid, rate: 300 });
    rate = _ok({ action: 'listMeterRate', token: adminTok, machineId: mid });
    _assertEq(rate.scope, 'machine', '設定過後應該切成 machine');
    _assertEq(rate.rate, 300, '應該是剛設定的單台費率');

    const other = _ok({ action: 'adminSaveMachine', token: adminTok, name: '費率不受影響測試台', sortOrder: 19 }).machineId;
    _assertEq(_ok({ action: 'listMeterRate', token: adminTok, machineId: other }).rate, 100, '改單台費率不該影響其他機台');

    const historicalCheck = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    const oldRecord = historicalCheck.records.filter(function (r) { return r.recordId === before.records[0].recordId; })[0];
    _assertEq(oldRecord.amount, 1000, '改費率不該動到已經記好的舊帳');

    const after = _ok({
      action: 'addMeterRecord', token: adminTok, machineId: mid,
      meterStart: 10, meterEnd: 20, clientToken: newId('ct')
    });
    _assertEq(after.records[0].amount, 3000, '改費率後的新紀錄要用新費率 300 算');

    _ok({ action: 'resetScope', token: adminTok, sheet: 'MeterRates', machineId: mid });
    rate = _ok({ action: 'listMeterRate', token: adminTok, machineId: mid });
    _assertEq(rate.scope, 'global', '清掉單台費率後應該落回全局');
    _assertEq(rate.rate, 100, '落回全局後應該是全局的 100');
  });

  _t(results, '入幣費率：只有管理員能設定', function () {
    _fails({ action: 'saveMeterRate', token: patrolTok, machineId: '', rate: 999 }, 'PERMISSION');
    _fails({ action: 'saveMeterRate', token: ownerTok, machineId: '', rate: 999 }, 'PERMISSION');
  });

  // ── 全局預設 + 單台覆寫 ──
  _t(results, '快捷金額：單台設定覆寫全局，刪掉後落回全局', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '覆寫測試台', sortOrder: 13 }).machineId;
    _ok({ action: 'saveQuickAmount', token: adminTok, machineId: '', type: 'in', amount: 100, label: '$100', sortOrder: 1 });

    let qa = _ok({ action: 'listQuickAmounts', token: adminTok, machineId: mid });
    _assertEq(qa.scope, 'global', '一開始應沿用全局');

    _ok({ action: 'saveQuickAmount', token: adminTok, machineId: mid, type: 'in', amount: 777, label: '$777', sortOrder: 1 });
    qa = _ok({ action: 'listQuickAmounts', token: adminTok, machineId: mid });
    _assertEq(qa.scope, 'machine', '有單台設定後應切成 machine');
    _assertEq(qa.in.length, 1, '單台設定應完全取代全局');
    _assertEq(qa.in[0].amount, 777, '單台金額');

    _ok({ action: 'resetScope', token: adminTok, sheet: 'QuickAmounts', machineId: mid });
    qa = _ok({ action: 'listQuickAmounts', token: adminTok, machineId: mid });
    _assertEq(qa.scope, 'global', '清掉單台設定後應落回全局');
  });

  _t(results, '獎型：複製全局成單台後，改單台不影響其他機台', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '獎型覆寫台', sortOrder: 14 }).machineId;
    const before = _ok({ action: 'listPrizes', token: adminTok, machineId: mid });
    _assertEq(before.scope, 'global', '一開始沿用全局');

    _ok({ action: 'forkScope', token: adminTok, sheet: 'Prizes', machineId: mid });
    const after = _ok({ action: 'listPrizes', token: adminTok, machineId: mid });
    _assertEq(after.scope, 'machine', '複製後應切成 machine');
    _assertEq(after.prizes.length, before.prizes.length, '複製後獎型數量應相同');
    _assert(after.prizes[0].prizeId !== before.prizes[0].prizeId, '複製出來的應該是新的獎型 id');
  });

  _t(results, '入幣費率：forkScope 也支援 MeterRates（先複製全局值再各自調整）', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '費率 fork 測試台', sortOrder: 20 }).machineId;
    const before = _ok({ action: 'listMeterRate', token: adminTok, machineId: mid });
    _assertEq(before.scope, 'global', '一開始沿用全局');
    _assertEq(before.rate, 100, '全局費率是 100');

    _ok({ action: 'forkScope', token: adminTok, sheet: 'MeterRates', machineId: mid });
    const after = _ok({ action: 'listMeterRate', token: adminTok, machineId: mid });
    _assertEq(after.scope, 'machine', '複製後應切成 machine');
    _assertEq(after.rate, 100, '複製當下應該還是跟全局一樣的值，之後才各自調整');

    _ok({ action: 'saveMeterRate', token: adminTok, machineId: mid, rate: 250 });
    const untouched = _ok({ action: 'adminSaveMachine', token: adminTok, name: '費率 fork 對照台', sortOrder: 21 }).machineId;
    _assertEq(_ok({ action: 'listMeterRate', token: adminTok, machineId: untouched }).rate, 100, '調整這台之後不該動到全局（另一台仍是全局的 100）');
  });

  // ── 報表 ──
  _t(results, '報表：日/週/月的加總與趨勢長度正確', function () {
    const day = _ok({ action: 'report', token: adminTok, machineId: prizeMachine, preset: 'day' });
    _assertEq(day.trend.length, 1, '日報表趨勢應只有 1 天');
    _assertEq(day.summary.net, 1000 - 100 - 230, '日報表淨收益');

    const week = _ok({ action: 'report', token: adminTok, machineId: prizeMachine, preset: 'week' });
    _assert(week.trend.length >= 1 && week.trend.length <= 7, '週報表趨勢長度應在 1~7 天，實際 ' + week.trend.length);

    const month = _ok({ action: 'report', token: adminTok, machineId: prizeMachine, preset: 'month' });
    _assert(month.trend.length >= 1 && month.trend.length <= 31, '月報表趨勢長度應在 1~31 天');
    _assertEq(month.summary.net, day.summary.net, '本月與今日的資料應一致（測試資料都在今天）');
  });

  _t(results, '報表：獎型統計次數與金額對得起來', function () {
    const rep = _ok({ action: 'report', token: adminTok, machineId: prizeMachine, preset: 'day' });
    let count = 0;
    let amount = 0;
    rep.prizeStats.forEach(function (s) { count += s.count; amount += s.amount; });
    _assertEq(count, 3, '獎型總次數（大娃1 + 小娃2）');
    _assertEq(amount, 230, '獎型總金額');
  });

  _t(results, '報表：不指定機台時只涵蓋自己看得到的機台', function () {
    const rep = _ok({ action: 'report', token: ownerTok, preset: 'month' });
    _assertEq(rep.scope.machineCount, 1, '台主的報表只該涵蓋 1 台');
  });

  _t(results, '自訂區間：起始晚於結束會被擋', function () {
    _fails({ action: 'report', token: adminTok, preset: 'custom', from: '2026-05-10', to: '2026-05-01' });
    _fails({ action: 'report', token: adminTok, preset: 'custom', from: 'bad', to: '2026-05-01' });
  });

  _t(results, 'CSV：含表頭、逐筆資料與合計', function () {
    const csv = _ok({ action: 'exportCsv', token: adminTok, machineId: prizeMachine, preset: 'day' });
    _assert(csv.content.indexOf('日期,時間,機台,類型,金額') === 0, 'CSV 應以表頭開始');
    _assert(csv.content.indexOf('開獎') > 0, 'CSV 應含開獎列');
    _assert(csv.content.indexOf('淨收益') > 0, 'CSV 應含淨收益合計');
    _assert(csv.filename.indexOf('.csv') > 0, '檔名應以 .csv 結尾');
  });

  // ── 雜項 ──
  _t(results, '不支援的 action 會被拒絕', function () {
    _fails({ action: 'dropAllTables', token: adminTok });
  });

  _t(results, '登出後 token 立刻失效', function () {
    const tok = _token('t_admin', 'admin123');
    _ok({ action: 'me', token: tok });
    _ok({ action: 'logout', token: tok });
    _fails({ action: 'me', token: tok }, 'AUTH');
  });

  _t(results, '回傳的使用者資料不含密碼與 salt', function () {
    const me = _ok({ action: 'me', token: adminTok });
    _assert(me.user.password_hash === undefined, '不該回傳 password_hash');
    _assert(me.user.salt === undefined, '不該回傳 salt');
    const users = _ok({ action: 'adminListUsers', token: adminTok });
    users.forEach(function (u) {
      _assert(u.password_hash === undefined && u.salt === undefined, '帳號清單不該含密碼欄位');
    });
  });

  // 放在最後：這裡會呼叫真正的 setup()，它在「目前沒有啟用中的管理員」時
  // 會自動新增一個，可能干擾前面依賴「剛好只有 t_admin 一個管理員」的測試
  // （例如「不能把最後一個管理員降級」）。此時 t_admin 一直是啟用中的管理員，
  // setup() 不會再造一個，所以放最後執行是安全的。
  _t(results, '重新執行 setup 會把舊表頭修正成中文，且不動既有資料', function () {
    const ss = _spreadsheet();
    const usersSheet = ss.getSheetByName(SHEET_TAB_NAMES.Users);

    _clearSheetCache();
    const before = dbReadAll('Users');
    const beforeCount = before.length;
    const sample = before[0];

    // 模擬「用改版前的程式碼建立的舊試算表」：表頭被改回英文
    usersSheet.getRange(1, 1, 1, SCHEMA.Users.length).setValues([SCHEMA.Users]);
    _clearSheetCache();

    setup();
    _clearSheetCache();

    const header = usersSheet.getRange(1, 1, 1, SCHEMA.Users.length).getValues()[0];
    _assertEq(JSON.stringify(header), JSON.stringify(HEADER_LABELS.Users), '重跑 setup 後表頭應變回中文');

    const after = dbReadAll('Users');
    _assertEq(after.length, beforeCount, '不該新增或刪除既有的資料列');
    const stillThere = after.some(function (u) { return u.user_id === sample.user_id && u.username === sample.username; });
    _assert(stillThere, '既有的帳號資料應該原封不動還在');
  });
}

