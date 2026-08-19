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

  mine.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  const limit = recordLimit || 50;

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
    prizes: _resolvePrizes(machineId)
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
function forkScopeToMachine(user, sheetName, machineId) {
  requireRole(user, [ROLE_ADMIN]);
  assertMachineAccess(user, machineId);
  if (sheetName !== 'QuickAmounts' && sheetName !== 'Prizes') throw new Error('不支援的設定類型');

  return withLock(function () {
    const own = dbReadAll(sheetName).filter(function (r) { return String(r.machine_id) === String(machineId); });
    if (own.length) return { scope: 'machine', created: 0 };

    const globals = dbReadAll(sheetName).filter(function (r) { return String(r.machine_id || '') === ''; });
    const copies = globals.map(function (r) {
      const copy = {};
      SCHEMA[sheetName].forEach(function (col) { copy[col] = r[col]; });
      copy[sheetName === 'Prizes' ? 'prize_id' : 'qa_id'] = newId(sheetName === 'Prizes' ? 'prz' : 'qa');
      copy.machine_id = String(machineId);
      return copy;
    });
    dbInsertMany(sheetName, copies);
    return { scope: 'machine', created: copies.length };
  });
}

/** 刪掉這台的專屬設定，回頭沿用全局。 */
function resetScopeToGlobal(user, sheetName, machineId) {
  requireRole(user, [ROLE_ADMIN]);
  assertMachineAccess(user, machineId);
  if (sheetName !== 'QuickAmounts' && sheetName !== 'Prizes') throw new Error('不支援的設定類型');

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
