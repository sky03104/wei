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

  // ── 機台分類（骰台／電子）──
  _t(results, '新增機台沒帶 category 時預設是骰台', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '沒填分類台', sortOrder: 30 }).machineId;
    const list = _ok({ action: 'adminListMachines', token: adminTok });
    const found = list.filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(found.category, 'dice', '未指定分類應預設骰台');
    _assertEq(_ok({ action: 'dashboard', token: adminTok }).machines.filter(function (m) { return m.machineId === mid; })[0].category, 'dice', 'dashboard 也應該帶 category');
  });

  const electronicMachine = _ok({
    action: 'adminSaveMachine', token: adminTok, name: '電子測試台', sortOrder: 31, category: 'electronic'
  }).machineId;

  _t(results, '新增機台可指定 category 為 electronic', function () {
    const list = _ok({ action: 'adminListMachines', token: adminTok });
    const found = list.filter(function (m) { return m.machineId === electronicMachine; })[0];
    _assertEq(found.category, 'electronic', '應該存成電子分類');
  });

  _t(results, '電子機台：開分/洗分累加，盈虧＝開分－洗分', function () {
    _ok({ action: 'addRecord', token: adminTok, machineId: electronicMachine, type: 'chip_in', amount: 500, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: electronicMachine, type: 'chip_out', amount: 200, clientToken: newId('ct') });
    const d = _ok({ action: 'machineDetail', token: adminTok, machineId: electronicMachine });
    _assertEq(d.total.chipIn, 500, '開分總額');
    _assertEq(d.total.chipOut, 200, '洗分總額');
    _assertEq(d.total.chipNet, 300, '盈虧＝開分－洗分');
  });

  _t(results, '電子機台不能記錄入幣/出幣/活動', function () {
    _fails({ action: 'addRecord', token: adminTok, machineId: electronicMachine, type: 'in', amount: 100, clientToken: newId('ct') });
    _fails({ action: 'addRecord', token: adminTok, machineId: electronicMachine, type: 'out', amount: 100, clientToken: newId('ct') });
    _fails({ action: 'addMeterRecord', token: adminTok, machineId: electronicMachine, meterStart: 0, meterEnd: 10, clientToken: newId('ct') });
    _fails({
      action: 'addPrizeRecord', token: adminTok, machineId: electronicMachine,
      items: [{ prizeId: bigPrize, count: 1 }], clientToken: newId('ct')
    });
  });

  _t(results, '骰台機台不能記錄開分/洗分', function () {
    _fails({ action: 'addRecord', token: adminTok, machineId: prizeMachine, type: 'chip_in', amount: 100, clientToken: newId('ct') });
    _fails({ action: 'addRecord', token: adminTok, machineId: prizeMachine, type: 'chip_out', amount: 100, clientToken: newId('ct') });
  });

  _t(results, '首頁與機台詳細頁的今日432數量：只算今天、只算獎型名稱為432的次數', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '432測試台', sortOrder: 32 }).machineId;
    const prize432 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '432', amount: 50, sortOrder: 1 }).prizeId;
    const otherPrize = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '其他獎型', amount: 30, sortOrder: 2 }).prizeId;

    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: prize432, count: 3 }, { prizeId: otherPrize, count: 5 }],
      clientToken: newId('ct')
    });

    const detail = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(detail.today432Count, 3, '機台詳細頁今日432數量只算432獎型的次數');

    const dash = _ok({ action: 'dashboard', token: adminTok });
    _assert(dash.today432Count >= 3, '首頁今日432數量至少包含這台剛登錄的 3 次');
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

  _t(results, '營業日：沒人按過開始/結單，行為跟以前一樣照行事曆日期算', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '營業日對照台', sortOrder: 91 }).machineId;
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 10, clientToken: newId('ct') });
    const d = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(d.records[0].businessDate, todayKey(), '沒有進行中的營業日時，紀錄的營業日期應該退回今天的行事曆日期');
    _assertEq(d.today.out, 10, '今日彙總應該照行事曆日期正常算進去');
  });

  _t(results, '營業日：只有管理員跟巡邏人員能按開始/結單，台主不行', function () {
    _fails({ action: 'startBusinessDay', token: ownerTok }, 'PERMISSION');
    _fails({ action: 'endBusinessDay', token: ownerTok }, 'PERMISSION');
  });

  _t(results, '營業日：結單前沒有進行中的營業日，會明確報錯', function () {
    _fails({ action: 'endBusinessDay', token: patrolTok });
  });

  _t(results, '營業日：開始之後，記帳會用開始那天的日期，就算實際寫入時間已經跨過午夜', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '跨夜營業日測試台', sortOrder: 92 }).machineId;

    const started = _ok({ action: 'startBusinessDay', token: patrolTok });
    _assert(started.open, '按下開始之後應該是進行中狀態');
    _assertEq(started.current.businessDate, todayKey(), '開始當下記錄的營業日期應該是今天');

    // 模擬「晚上開始營業、跨過午夜才打烊」：把這個營業日的 business_date
    // 手動改成昨天，代表它其實是昨晚開始的，還沒結束就跨到今天了。
    const bizRow = _openBizDay();
    const yesterday = _addDays(todayKey(), -1);
    dbUpdate('BizDays', bizRow._row, { business_date: yesterday });
    _clearSheetCache();

    _ok({ action: 'addRecord', token: patrolTok, machineId: mid, type: 'out', amount: 20, clientToken: newId('ct') });
    const detail = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(detail.records[0].businessDate, yesterday,
      '就算實際寫入時間是今天，只要營業日還開著，紀錄就該算進營業日開始那一天（昨天）');

    const dash = _ok({ action: 'dashboard', token: adminTok });
    _assertEq(dash.today, yesterday, '首頁的「今天」應該顯示進行中營業日的日期，不是行事曆日期');
    _assert(dash.businessDay.open, '首頁應該回報營業中');
    _assertEq(dash.businessDay.current.businessDate, yesterday, '首頁回報的營業日期應該是昨天');
    const mine = dash.machines.filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(mine.today.out, 20, '這筆紀錄應該被算進「今日」彙總（因為它屬於進行中的營業日）');

    _ok({ action: 'endBusinessDay', token: adminTok });
    const afterEnd = _ok({ action: 'dashboard', token: adminTok });
    _assert(!afterEnd.businessDay.open, '結單後應該顯示沒有進行中的營業日');
    _assertEq(afterEnd.today, todayKey(), '結單後「今天」應該退回行事曆日期');

    // 結單之後再記一筆：沒有進行中的營業日了，退回今天的行事曆日期。
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 5, clientToken: newId('ct') });
    const afterEndDetail = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(afterEndDetail.records[0].businessDate, todayKey(), '結單後新記的帳應該用今天的行事曆日期，不是已經結束的營業日');
  });

  _t(results, '營業日：忘記結單、隔天又按開始，會自動把前一個結掉再開新的', function () {
    const first = _ok({ action: 'startBusinessDay', token: adminTok });
    _assert(first.open, '第一次開始應該成功');
    const firstBizId = _openBizDay().biz_id;

    const second = _ok({ action: 'startBusinessDay', token: patrolTok });
    _assertEq(second.previousAutoClosed, true, '前一個還開著時再按開始，應該回報有自動結掉前一個');

    const firstRow = dbFind('BizDays', 'biz_id', firstBizId);
    _assert(toBool(firstRow.auto_closed), '前一個營業日應該被標記成自動結單');
    _assert(!!firstRow.closed_at, '前一個營業日應該有結束時間');

    const openNow = _openBizDay();
    _assert(openNow.biz_id !== firstBizId, '目前進行中的應該是第二次開的那筆，不是第一筆');

    _ok({ action: 'endBusinessDay', token: adminTok }); // 收尾，不影響後面的測試
  });

  _t(results, '營業日：報表的日/週/月分組也照營業日算，不是行事曆日期', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '報表營業日測試台', sortOrder: 93 }).machineId;

    _ok({ action: 'startBusinessDay', token: adminTok });
    const bizRow = _openBizDay();
    const yesterday = _addDays(todayKey(), -1);
    dbUpdate('BizDays', bizRow._row, { business_date: yesterday });
    _clearSheetCache();

    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 30, clientToken: newId('ct') });

    const report = _ok({ action: 'report', token: adminTok, machineId: mid, preset: 'day' });
    _assertEq(report.range.from, yesterday, '報表「日」區間應該用進行中的營業日期，不是今天的行事曆日期');
    _assertEq(report.summary.out, 30, '報表彙總應該把這筆算進去');

    const csv = _ok({ action: 'exportCsv', token: adminTok, machineId: mid, preset: 'day' });
    _assert(csv.content.indexOf(yesterday) >= 0, 'CSV 的日期欄應該顯示營業日期（昨天），不是行事曆日期');

    _ok({ action: 'endBusinessDay', token: adminTok });
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
    _assert(csv.content.indexOf('活動') > 0, 'CSV 應含活動（原開獎）列');
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
