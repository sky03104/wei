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
