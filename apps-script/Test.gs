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
  const temp = SpreadsheetApp.create('【自我測試】娃娃機管理系統 ' + nowIso());
  const results = [];

  // 切到暫時試算表用的是執行期變數（_spreadsheetOverride），不是
  // Script Property——就算這次執行跑到一半被 Apps Script 6 分鐘執行
  // 上限砍斷，也不會讓正式站台的 SPREADSHEET_ID 卡在這份暫時試算表上。
  // 詳見 Db.gs 的 _spreadsheetOverride 註解。
  _spreadsheetOverride = temp;
  try {
    _clearSheetCache();
    _selfTestBody(results);
  } catch (err) {
    results.push({ ok: false, name: '測試流程本身中斷', err: err.message });
  } finally {
    _spreadsheetOverride = null;
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
    _fails({ action: 'exportLedgerXlsx', token: ownerTok, machineId: machineB, preset: 'day' }, 'PERMISSION');
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

  _t(results, 'allMachineDetails 一次回傳的每台機台內容，要跟各自打一次 machineDetail 完全一致；台主只拿得到自己看得到的機台', function () {
    [adminTok, patrolTok].forEach(function (tok) {
      const all = _ok({ action: 'allMachineDetails', token: tok });
      [machineA, machineB].forEach(function (mid) {
        const single = _ok({ action: 'machineDetail', token: tok, machineId: mid });
        _assert(all[mid], 'allMachineDetails 應該包含機台 ' + mid);
        _assertEq(JSON.stringify(all[mid]), JSON.stringify(single), 'allMachineDetails[' + mid + '] 應該跟單獨打 machineDetail 一致');
      });
    });

    const ownerAll = _ok({ action: 'allMachineDetails', token: ownerTok });
    _assert(ownerAll[machineA], '台主應該拿得到自己被授權的機台A');
    _assert(!ownerAll[machineB], '台主不該拿到沒被授權的機台B');
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

  _t(results, 'addRecord／addMeterRecord 回傳要直接附上最新的機台詳細頁資料，前端才不用送出後再多打一次 machineDetail', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '送出即回詳細頁測試台', sortOrder: 10.5 }).machineId;

    const outRes = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 30, clientToken: newId('ct') });
    _assert(!!outRes.detail, 'addRecord 的回應應該要附帶 detail');
    _assertEq(outRes.detail.total.out, 30, 'addRecord 附帶的 detail 要反映剛寫入的這一筆');
    _assertEq(JSON.stringify(outRes.detail), JSON.stringify(_ok({ action: 'machineDetail', token: adminTok, machineId: mid })),
      'addRecord 附帶的 detail 應該跟另外呼叫一次 machineDetail 拿到的結果一模一樣');

    const meterRes = _ok({ action: 'addMeterRecord', token: adminTok, machineId: mid, meterStart: 0, meterEnd: 5, clientToken: newId('ct') });
    _assert(!!meterRes.detail, 'addMeterRecord 的回應應該要附帶 detail');
    _assertEq(meterRes.detail.total.in, 500, 'addMeterRecord 附帶的 detail 要反映剛寫入的這一筆（費率100×5格）');
    _assertEq(JSON.stringify(meterRes.detail), JSON.stringify(_ok({ action: 'machineDetail', token: adminTok, machineId: mid })),
      'addMeterRecord 附帶的 detail 應該跟另外呼叫一次 machineDetail 拿到的結果一模一樣');

    // 重複送出（clientToken 撞到）也要附帶 detail，前端不管有沒有重複都會直接拿它用。
    const dupCt = newId('ct');
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 5, clientToken: dupCt });
    const dupRes = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 5, clientToken: dupCt });
    _assert(dupRes.duplicated, '這筆應該被判定為重複');
    _assert(!!dupRes.detail, '就算是重複，也要附帶 detail，前端不用另外判斷');
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

  // ── 機台圖案（icon）：不像分類，隨時可以改，也不需要新增時就決定 ──
  _t(results, '機台圖案：沒指定時預設是 classic，dashboard／machineDetail／adminListMachines 都要帶到', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '沒填圖案台', sortOrder: 32 }).machineId;

    const listed = _ok({ action: 'adminListMachines', token: adminTok }).filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(listed.icon, 'classic', 'adminListMachines 未指定圖案應預設 classic');

    const dashMachine = _ok({ action: 'dashboard', token: adminTok }).machines.filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(dashMachine.icon, 'classic', 'dashboard 也應該預設 classic');

    const detail = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(detail.machine.icon, 'classic', 'machineDetail 也應該預設 classic');
  });

  _t(results, '機台圖案：可以指定成 round/twin/tall/dice，之後編輯（不像分類）隨時能再改', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '圖案測試台', sortOrder: 33, icon: 'round' }).machineId;
    let found = _ok({ action: 'adminListMachines', token: adminTok }).filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(found.icon, 'round', '新增時指定的圖案應該存起來');

    _ok({
      action: 'adminSaveMachine', token: adminTok, machineId: mid,
      name: found.name, location: found.location, status: found.status, color: found.color, sortOrder: found.sortOrder,
      icon: 'twin'
    });
    found = _ok({ action: 'adminListMachines', token: adminTok }).filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(found.icon, 'twin', '編輯時應該可以把圖案換成別款，不像分類會被鎖住');

    _ok({
      action: 'adminSaveMachine', token: adminTok, machineId: mid,
      name: found.name, location: found.location, status: found.status, color: found.color, sortOrder: found.sortOrder,
      icon: 'dice'
    });
    found = _ok({ action: 'adminListMachines', token: adminTok }).filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(found.icon, 'dice', '新增的夾骰子款也要能選');

    _ok({
      action: 'adminSaveMachine', token: adminTok, machineId: mid,
      name: found.name, location: found.location, status: found.status, color: found.color, sortOrder: found.sortOrder,
      icon: 'sixdice'
    });
    found = _ok({ action: 'adminListMachines', token: adminTok }).filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(found.icon, 'sixdice', '單顆六點骰款也要能選');
  });

  _t(results, '機台圖案：給不認得的鍵值會落回 classic，不會整個請求失敗', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '亂填圖案台', sortOrder: 34, icon: '<script>' }).machineId;
    const found = _ok({ action: 'adminListMachines', token: adminTok }).filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(found.icon, 'classic', '不在白名單裡的圖案鍵值應該落回預設值 classic');
  });

  _t(results, '電子機台：開分/洗分累加，盈虧＝開分－洗分（今日與累計都要對）', function () {
    _ok({ action: 'addRecord', token: adminTok, machineId: electronicMachine, type: 'chip_in', amount: 500, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: electronicMachine, type: 'chip_out', amount: 200, clientToken: newId('ct') });
    const d = _ok({ action: 'machineDetail', token: adminTok, machineId: electronicMachine });
    _assertEq(d.total.chipIn, 500, '累計開分總額');
    _assertEq(d.total.chipOut, 200, '累計洗分總額');
    _assertEq(d.total.chipNet, 300, '累計盈虧＝開分－洗分');
    // 前端「盈虧金額」卡片實際讀的是 today 這個桶，不是 total——
    // 只驗 total 沒驗到 today 曾經是一個測試盲點，這裡兩個都要驗。
    _assertEq(d.today.chipIn, 500, '今日開分總額');
    _assertEq(d.today.chipOut, 200, '今日洗分總額');
    _assertEq(d.today.chipNet, 300, '今日盈虧＝開分－洗分');

    const dash = _ok({ action: 'dashboard', token: adminTok });
    const mine = dash.machines.filter(function (m) { return m.machineId === electronicMachine; })[0];
    _assertEq(mine.today.chipIn, 500, '首頁機台卡片的今日開分也要對');
    _assertEq(mine.today.chipOut, 200, '首頁機台卡片的今日洗分也要對');
    _assert(dash.electronicTotal.chipIn >= 500, '電子分頁籤的今日開分加總至少要包含這台剛記的');
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
    // 結單後「今天」不會立刻退回行事曆日期——這個跨夜營業日是今天結的，
    // 「今日」該繼續顯示它的日期（昨天），不然剛結束的那個晚上的總結
    // 會憑空消失，見 _relevantBizDayForToday()。
    _assertEq(afterEnd.today, yesterday, '結單後「今天」應該還是顯示這個跨夜營業日的日期，不會立刻退回行事曆日期');

    // 結單之後再記一筆：沒有進行中的營業日了，這筆新紀錄退回今天的行事曆日期
    // （寫入邏輯 _currentBusinessDate() 不受「今日顯示邊界」影響，兩者是分開的）。
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

    const grid = _buildLedgerGrid(validateSession(adminTok), { machineId: mid, preset: 'day' });
    _assert(grid.headerRow.indexOf(_dayKeyToLabel(yesterday)) >= 0, '對帳表的欄位應該顯示營業日期（昨天），不是行事曆日期');

    _ok({ action: 'endBusinessDay', token: adminTok });
  });

  // ── 每日手動帳目（週轉金／運拿／台主給／台主領／還內場）──

  _t(results, '每日手動帳目：沒設定過的營業日，各項都是 0／空清單', function () {
    const dash = _ok({ action: 'dashboard', token: adminTok });
    _assertEq(dash.ledger.turnover, 0, '週轉金預設 0');
    _assertEq(dash.ledger.transport, 0, '運拿預設 0');
    _assertEq(dash.ledger.givenToOwner, 0, '台主給預設 0');
    _assertEq(dash.ledger.givenToOwnerItems.length, 0, '台主給明細預設空清單');
    _assertEq(dash.ledger.takenByOwner, 0, '台主領預設 0');
    _assertEq(dash.ledger.takenByOwnerItems.length, 0, '台主領明細預設空清單');
    _assertEq(dash.ledger.returnedToHouse, 0, '還內場預設 0');
    _assertEq(dash.ledger.manual432, 0, '手動活動支出432預設 0');
    _assertEq(dash.ledger.manual441, 0, '手動活動支出441預設 0');
  });

  _t(results, '每日手動帳目：只有管理員跟巡邏人員能設定，台主不行', function () {
    _fails({
      action: 'saveDailyLedger', token: ownerTok,
      turnover: 1, transport: 1, givenToOwnerItems: [{ name: '老王', amount: 1 }],
      takenByOwnerItems: [{ name: '老王', amount: 1 }], returnedToHouse: 1
    }, 'PERMISSION');
  });

  _t(results, '每日手動帳目：運拿／台主領／手動活動支出輸入負數會被擋（這幾項一律當正數的現金流出，系統自動扣除）', function () {
    _fails({ action: 'saveDailyLedger', token: patrolTok, turnover: 0, transport: -1, returnedToHouse: 0 });
    _fails({
      action: 'saveDailyLedger', token: patrolTok, turnover: 0, transport: 0,
      takenByOwnerItems: [{ name: '老王', amount: -1 }], returnedToHouse: 0
    });
    _fails({ action: 'saveDailyLedger', token: patrolTok, turnover: 0, transport: 0, returnedToHouse: 0, manual432: -1 });
    _fails({ action: 'saveDailyLedger', token: patrolTok, turnover: 0, transport: 0, returnedToHouse: 0, manual441: -1 });
  });

  _t(results, '每日手動帳目：台主給／台主領可以存好幾筆、各自命名，輸入正數金額儲存後 dashboard 會反映最新值', function () {
    const saved = _ok({
      action: 'saveDailyLedger', token: patrolTok,
      turnover: 416000, transport: 250000,
      givenToOwnerItems: [{ name: '老王', amount: 40000 }, { name: '老李', amount: 20200 }],
      takenByOwnerItems: [{ name: '老王', amount: 172600 }],
      returnedToHouse: 13000, manual432: 3000, manual441: 2000
    });
    _assertEq(saved.transport, 250000, '應該原封不動存正數，不做正負號轉換');
    _assertEq(saved.givenToOwner, 60200, '台主給應該是這幾筆的總和（40000+20200）');
    _assertEq(saved.givenToOwnerItems.length, 2, '台主給應該存了 2 筆，各自的名字要留著');
    _assert(saved.givenToOwnerItems.some(function (it) { return it.name === '老王' && it.amount === 40000; }), '應該找得到「老王 40000」這一筆');
    _assert(saved.givenToOwnerItems.some(function (it) { return it.name === '老李' && it.amount === 20200; }), '應該找得到「老李 20200」這一筆');

    const dash = _ok({ action: 'dashboard', token: adminTok });
    _assertEq(dash.ledger.turnover, 416000, '週轉金應該是剛存的值');
    _assertEq(dash.ledger.transport, 250000, '運拿應該是剛存的正數');
    _assertEq(dash.ledger.givenToOwner, 60200, '台主給應該是剛存的總和');
    _assertEq(dash.ledger.takenByOwner, 172600, '台主領應該是剛存的正數');
    _assertEq(dash.ledger.takenByOwnerItems[0].name, '老王', '台主領明細的名字應該存下來');
    _assertEq(dash.ledger.returnedToHouse, 13000, '還內場應該是剛存的值');
    _assertEq(dash.ledger.manual432, 3000, '手動活動支出432應該是剛存的值');
    _assertEq(dash.ledger.manual441, 2000, '手動活動支出441應該是剛存的值');
  });

  _t(results, '每日手動帳目：台主給／台主領沒填名字會用預設名稱，金額是 0 或沒填的那幾筆直接不存', function () {
    const saved = _ok({
      action: 'saveDailyLedger', token: adminTok, turnover: 0, transport: 0, returnedToHouse: 0,
      givenToOwnerItems: [{ name: '', amount: 500 }, { name: '有名字但沒填金額', amount: '' }, { name: '', amount: 0 }],
      takenByOwnerItems: []
    });
    _assertEq(saved.givenToOwnerItems.length, 1, '金額是 0 或空白的那幾筆應該直接被濾掉，只留下真的有金額的那筆');
    _assertEq(saved.givenToOwnerItems[0].name, '台主給', '名字沒填的話應該用預設名稱「台主給」頂著');
    _assertEq(saved.givenToOwnerItems[0].amount, 500, '有填的那筆金額要對');
  });

  _t(results, '每日手動帳目：手動活動支出432/441 沒填當 0，同一個營業日重複儲存是覆蓋，不是疊加', function () {
    const saved = _ok({ action: 'saveDailyLedger', token: adminTok, turnover: 1000, transport: 0, returnedToHouse: 0 });
    _assertEq(saved.manual432, 0, '手動活動支出432沒填應該存成 0');
    _assertEq(saved.manual441, 0, '手動活動支出441沒填應該存成 0');
    const dash = _ok({ action: 'dashboard', token: adminTok });
    _assertEq(dash.ledger.turnover, 1000, '第二次儲存應該覆蓋掉第一次的值，不是疊加成 417000');
    _assertEq(dash.ledger.givenToOwner, 0, '這次沒帶台主給，應該覆蓋成空清單，不是留著上次的兩筆');
  });

  _t(results, '今日432獎金額：只算獎型名稱剛好是432的活動金額，其他獎型不算', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '每日帳目測試台', sortOrder: 94 }).machineId;
    const prize432 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '432', amount: 70, sortOrder: 1 }).prizeId;
    const otherPrize = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '其他', amount: 20, sortOrder: 2 }).prizeId;

    const before = _ok({ action: 'dashboard', token: adminTok }).today432Amount;
    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: prize432, count: 2 }, { prizeId: otherPrize, count: 3 }],
      clientToken: newId('ct')
    });
    const after = _ok({ action: 'dashboard', token: adminTok }).today432Amount;
    _assertEq(after - before, 140, '今日432獎金額應該只增加 432 獎型的部分（70×2＝140），其他獎型不算進去');
  });

  _t(results, '今日441數量：只算獎型名稱剛好是441的次數，不算金額，其他獎型不算', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '441數量測試台', sortOrder: 94 }).machineId;
    const prize441 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '441', amount: 50, sortOrder: 1 }).prizeId;
    const otherPrize = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '其他', amount: 20, sortOrder: 2 }).prizeId;

    const before = _ok({ action: 'dashboard', token: adminTok }).today441Count;
    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: prize441, count: 3 }, { prizeId: otherPrize, count: 5 }],
      clientToken: newId('ct')
    });
    const after = _ok({ action: 'dashboard', token: adminTok }).today441Count;
    _assertEq(after - before, 3, '今日441數量應該只增加 441 獎型的次數（3），不算其他獎型，也不算金額');
  });

  _t(results, '本月432/441支數：算的是這個月（照營業日期，1號到今天）的次數加總，不是只算今天；上個月的紀錄不算進去', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '本月支數測試台', sortOrder: 93 }).machineId;
    const prize432 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '432', amount: 10, sortOrder: 1 }).prizeId;
    const prize441 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '441', amount: 10, sortOrder: 2 }).prizeId;

    const before = _ok({ action: 'dashboard', token: adminTok });

    // 今天登記一筆，應該算進本月。
    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: prize432, count: 2 }, { prizeId: prize441, count: 4 }],
      clientToken: newId('ct')
    });

    // 再登記一筆，改記到「上個月」，確認不會被算進本月——用 40 天前保證
    // 換到不同月份，不用管今天是幾號。
    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: prize432, count: 9 }, { prizeId: prize441, count: 9 }],
      clientToken: newId('ct')
    });
    const lastMonthDate = _addDays(todayKey(), -40);
    dbReadAll('Records')
      .filter(function (r) { return r.machine_id === mid && toNumber(r.count) === 9; })
      .forEach(function (r) { dbUpdate('Records', r._row, { business_date: lastMonthDate }); });
    _clearSheetCache();

    const after = _ok({ action: 'dashboard', token: adminTok });
    _assertEq(after.month432Count - before.month432Count, 2, '本月432支數只該算今天那筆的 2，上個月那筆 9 不該算進來');
    _assertEq(after.month441Count - before.month441Count, 4, '本月441支數只該算今天那筆的 4，上個月那筆 9 不該算進來');
  });

  _t(results, '活動查詢：自訂日期範圍內的432/441支數＋每天開銷加總，只算範圍內的、範圍外的日期不算', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '活動查詢測試台', sortOrder: 92 }).machineId;
    const prize432 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '432', amount: 10, sortOrder: 1 }).prizeId;
    const prize441 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '441', amount: 10, sortOrder: 2 }).prizeId;

    // 用兩個不同的歷史日期來測邊界，這樣才能對精確的數字，不用再用
    // before/after 相減。刻意只往回抓幾天（不是幾十天）——抓太遠可能跨到
    // 上一季，之後跑到的封存測試（archiveOldRecords）會把這幾筆也順手
    // 掃進去，反而弄亂那個測試自己對「封存到哪一季」的期待值。
    const inDate = _addDays(todayKey(), -2);
    const outDate = _addDays(todayKey(), -5); // 範圍外，確認不會被算進來

    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: prize432, count: 5 }, { prizeId: prize441, count: 7 }],
      clientToken: newId('ct')
    });
    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: prize432, count: 99 }, { prizeId: prize441, count: 99 }],
      clientToken: newId('ct')
    });
    dbReadAll('Records').filter(function (r) { return r.machine_id === mid && toNumber(r.count) === 5; })
      .forEach(function (r) { dbUpdate('Records', r._row, { business_date: inDate }); });
    dbReadAll('Records').filter(function (r) { return r.machine_id === mid && toNumber(r.count) === 7; })
      .forEach(function (r) { dbUpdate('Records', r._row, { business_date: inDate }); });
    dbReadAll('Records').filter(function (r) { return r.machine_id === mid && toNumber(r.count) === 99; })
      .forEach(function (r) { dbUpdate('Records', r._row, { business_date: outDate }); });
    _clearSheetCache();

    // 直接塞一列 DailyLedger 到 inDate，模擬那天存過的開銷；outDate 完全
    // 不存，確認開銷加總不會誤把它算成 0 以外的東西、也不會漏算。
    dbInsert('DailyLedger', {
      ledger_id: newId('ldg'), business_date: inDate,
      turnover: 0, transport: 0, given_to_owner: 0, taken_by_owner: 0, returned_to_house: 0,
      updated_by: '', updated_at: nowIso(), biz_id: '',
      manual_432: 0, manual_441: 0, given_to_owner_items: '', taken_by_owner_items: '',
      manual_expense: 888
    });
    _clearSheetCache();

    const inRange = _ok({ action: 'activityQuery', token: adminTok, from: inDate, to: inDate });
    _assertEq(inRange.count432, 5, '活動查詢只該算範圍內那天的432支數，outDate 那筆 99 不該算進來');
    _assertEq(inRange.count441, 7, '活動查詢只該算範圍內那天的441支數，outDate 那筆 99 不該算進來');
    _assertEq(inRange.manualExpense, 888, '活動查詢的開銷應該是那天存的 888');

    const boundedRange = _ok({ action: 'activityQuery', token: adminTok, from: outDate, to: inDate });
    _assertEq(boundedRange.count432, 5 + 99, '拉長區間把 outDate 也包進來後，432支數應該是兩天加總');
    _assertEq(boundedRange.count441, 7 + 99, '拉長區間把 outDate 也包進來後，441支數應該是兩天加總');
  });

  _t(results, '加總分頁的總結餘＝入幣－出幣－手動活動支出432/441＋週轉金＋台主給＋電子淨贏－台主領＋還內場（自動算的432活動金額跟運拿都不算現金支出，不扣）', function () {
    const diceMid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '結餘算式骰台', sortOrder: 95 }).machineId;
    const elecMid = _ok({
      action: 'adminSaveMachine', token: adminTok, name: '結餘算式電子', sortOrder: 96, category: 'electronic'
    }).machineId;

    _ok({ action: 'addRecord', token: adminTok, machineId: diceMid, type: 'in', amount: 300, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: diceMid, type: 'out', amount: 50, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: elecMid, type: 'chip_in', amount: 400, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: elecMid, type: 'chip_out', amount: 100, clientToken: newId('ct') });

    _ok({
      action: 'saveDailyLedger', token: adminTok,
      turnover: 10, transport: 0,
      givenToOwnerItems: [{ name: '老王', amount: 18 }, { name: '老李', amount: 12 }],
      takenByOwnerItems: [{ name: '老王', amount: 40 }],
      returnedToHouse: 5, manual432: 7, manual441: 3
    });

    const before = _ok({ action: 'dashboard', token: adminTok });
    _assertEq(before.ledger.givenToOwner, 30, '台主給應該是「老王 18」＋「老李 12」的總和');
    const expected = before.diceTotal.in - before.diceTotal.out
      - before.ledger.manual432 - before.ledger.manual441
      + before.ledger.turnover + before.ledger.givenToOwner
      + before.electronicTotal.chipNet - before.ledger.takenByOwner + before.ledger.returnedToHouse;
    _assertEq(before.ledgerTotal, Math.round(expected * 100) / 100, '總結餘應該等於台主領／手動活動支出扣除、其餘加總後的結果');

    // 骰台記一筆真的活動獎品開獎，today432Amount 因此變成非 0——但這筆是
    // 給獎品不是給現金，加總的總結餘不應該因此改變，只有機台自己的
    // 「淨收益」會反映這筆成本。
    const prizeId = _ok({ action: 'savePrize', token: adminTok, machineId: diceMid, name: '432', amount: 15, sortOrder: 1 }).prizeId;
    _ok({ action: 'addPrizeRecord', token: adminTok, machineId: diceMid, items: [{ prizeId: prizeId, count: 2 }], clientToken: newId('ct') });
    const after = _ok({ action: 'dashboard', token: adminTok });
    _assert(after.today432Amount > 0, '這筆開獎應該讓 today432Amount 變成非 0，測試前提才成立');
    _assertEq(after.ledgerTotal, before.ledgerTotal, '登記432活動獎品不該讓現金結餘的總結餘變動——給的是獎品不是現金');

    // 運拿這個欄位「用不到了」——畫面已經拿掉這一列，公式也不該再扣，
    // 就算資料庫裡還存著舊值（歷史相容），也不能偷偷影響今天的總結餘。
    // 除了 transport 其餘欄位照抄第一次存的值，才能單獨看出 transport 有沒有影響。
    _ok({
      action: 'saveDailyLedger', token: adminTok,
      turnover: 10, transport: 99999,
      givenToOwnerItems: [{ name: '老王', amount: 18 }, { name: '老李', amount: 12 }],
      takenByOwnerItems: [{ name: '老王', amount: 40 }],
      returnedToHouse: 5, manual432: 7, manual441: 3
    });
    const afterTransport = _ok({ action: 'dashboard', token: adminTok });
    _assertEq(afterTransport.ledgerTotal, before.ledgerTotal, '運拿欄位不管存多少都不該影響總結餘——這一列已經不用了');
  });

  _t(results, '按下「今日營業開始」：所有機台的今日數字跟加總分頁的手動帳目都歸零，但紀錄跟累計都沒被動過', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '按開始歸零測試台', sortOrder: 98 }).machineId;

    // 目前沒有進行中的營業日（前面測試都有結單收尾）：用行事曆日期退回路徑記一筆，
    // 模擬「使用者今天已經先記了一些帳，晚點才想到要按開始」的情境。
    const beforeRec = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 70, clientToken: newId('ct') });
    _ok({
      action: 'saveDailyLedger', token: adminTok,
      turnover: 999, transport: 0, givenToOwner: 0, takenByOwner: 0, returnedToHouse: 0
    });
    const before = _ok({ action: 'dashboard', token: adminTok });
    const beforeMine = before.machines.filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(beforeMine.today.out, 70, '按開始之前，這筆退回行事曆日期記的帳應該正常算進今日');
    _assertEq(before.ledger.turnover, 999, '按開始之前，剛存的週轉金應該正常顯示');

    // 測試環境跑得很快，這筆紀錄跟接下來開始的營業日有可能落在同一毫秒，
    // 時間字串就分不出先後（真實情境不會這麼巧，使用者按鈕不可能按這麼快）。
    // 手動把「重置前」那筆紀錄的時間往回撥 5 秒，確定它一定算在開始之前——
    // 不動接下來要記的「開始時間」跟「重置後」那筆，兩者都用真實的當下時間，
    // 順序自然成立，不用賭測試執行速度。
    const beforeRow = dbFind('Records', 'record_id', beforeRec.records[0].recordId);
    dbUpdate('Records', beforeRow._row, { created_at: new Date(Date.now() - 5000).toISOString() });
    _clearSheetCache();

    _ok({ action: 'startBusinessDay', token: adminTok });
    const afterStart = _ok({ action: 'dashboard', token: adminTok });
    const afterStartMine = afterStart.machines.filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(afterStartMine.today.out, 0, '按下開始之後，這次開始之前記的帳不該再算進今日（就算日期一樣）');
    _assertEq(afterStart.ledger.turnover, 0, '按下開始之後，加總分頁的週轉金等五項手動帳目應該歸零');

    const detail = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(detail.total.out, 70, '累計（全部歷史）不受這次開始影響，剛剛那 70 還在累計裡');
    _assertEq(detail.records.length, 1, '紀錄本身完全沒被刪除或作廢');
    _assertEq(detail.today.out, 0, '機台詳細頁的「今日」也要跟首頁一致，歸零');

    // 這次開始之後才記的新帳，應該正常算進今日；舊的那筆（重置前）跟新存的
    // 週轉金各自獨立，不會互相覆蓋（資料完全沒被動過，只是不再被算進「今日」）。
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 15, clientToken: newId('ct') });
    _ok({
      action: 'saveDailyLedger', token: adminTok,
      turnover: 88, transport: 0, givenToOwner: 0, takenByOwner: 0, returnedToHouse: 0
    });
    const afterNew = _ok({ action: 'dashboard', token: adminTok });
    const afterNewMine = afterNew.machines.filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(afterNewMine.today.out, 15, '這次開始之後才記的帳，應該正常算進今日');
    _assertEq(afterNew.ledger.turnover, 88, '這次開始之後新存的週轉金，應該正常顯示，不會被舊值覆蓋或疊加');

    // 存的時候用的是「相關營業日 session」的日期，不一定剛好是 todayKey()
    // 這個字串（例如同一個測試流程裡前面剛好還有別的營業日 session 是用
    // 模擬跨夜留下的「昨天」）——這裡不比對存進哪個日期桶，只確認兩筆
    // 分別留著、都還查得到，這才是這項測試真正要驗的事。
    const ledgerRows = dbReadAll('DailyLedger');
    _assert(ledgerRows.some(function (r) { return toNumber(r.turnover) === 999; }),
      '按開始之前存的那筆週轉金 999，應該還完整留在試算表裡，沒有被刪除或覆蓋');
    _assert(ledgerRows.some(function (r) { return toNumber(r.turnover) === 88; }),
      '按開始之後存的那筆週轉金 88，應該是獨立新增的一列，不是覆蓋掉舊的那筆');

    // 按「今日營業結單」之後，「今日」數字不該立刻跳回去跟結單前的舊帳
    // （那筆 70）混在一起——結單後的「今日」邊界要繼續維持這個 session
    // 剛剛歸零之後的樣子，一直到下次又按「今日營業開始」才會再往前挪。
    _ok({ action: 'endBusinessDay', token: adminTok });
    const afterEndSameSession = _ok({ action: 'dashboard', token: adminTok });
    const afterEndMine = afterEndSameSession.machines.filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(afterEndMine.today.out, 15, '結單後「今日出幣」應該還是這個 session 的 15，不會跳回去加上結單前的 70（變成 85）');
    _assertEq(afterEndSameSession.ledger.turnover, 88, '結單後加總分頁的週轉金應該還是這個 session 存的 88，不會退回結單前那筆 999');

    const afterEndDetail = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(afterEndDetail.today.out, 15, '機台詳細頁結單後的「今日出幣」也要跟首頁一致，維持 15');
  });

  _t(results, '跨夜營業日結單後：「今日」要繼續看得到那個晚上的總結，不會因為過了午夜就消失', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '跨夜結單測試台', sortOrder: 100 }).machineId;

    _ok({ action: 'startBusinessDay', token: adminTok });
    // 模擬「晚上開始營業、跨過午夜才打烊」：把這個營業日的 business_date
    // 手動改成昨天，代表它其實是昨晚開始的，還沒結束就跨到今天了。
    const bizRow = _openBizDay();
    const yesterday = _addDays(todayKey(), -1);
    dbUpdate('BizDays', bizRow._row, { business_date: yesterday });
    _clearSheetCache();

    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 40, clientToken: newId('ct') });

    // 結單（結束時間是「今天」，business_date 是「昨天」）。
    _ok({ action: 'endBusinessDay', token: adminTok });

    const afterEnd = _ok({ action: 'dashboard', token: adminTok });
    _assertEq(afterEnd.today, yesterday,
      '結單後「今日」應該還是顯示那個跨夜營業日的日期（昨天），不是今天的行事曆日期——' +
      '不然剛結束的那個晚上的總結會憑空消失');
    const mineAfterEnd = afterEnd.machines.filter(function (m) { return m.machineId === mid; })[0];
    _assertEq(mineAfterEnd.today.out, 40, '結單後應該還看得到剛剛那個跨夜營業日記的 40，不會因為過了午夜就變 0');

    const detailAfterEnd = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(detailAfterEnd.today.out, 40, '機台詳細頁也要一致，結單後跨夜營業日的 40 還在「今日」裡');
  });

  // ── 修正「舊分頁後來才加的欄位被 Sheets 自動轉成日期型別」──
  //
  // Records 分頁從系統一開始就存在，business_date 是後來才加進 schema 的新欄位，
  // 從沒機會在「_sheet() 建立新分頁」那個時間點被鎖成純文字格式。實際 Google 試算表
  // 遇到這種情況，會把看起來像日期的字串自動解析成真正的日期序列值，讀出來變成
  // JS Date 物件，不是原本存的字串——今日彙總、營業日比對這些拿 business_date 做
  // 字串比對的地方就會全部對不起來，卻不會噴任何錯誤，只是默默算出 0。
  // 這裡的測試沙盒不會真的重現 Sheets 那個自動轉型別的行為，所以用手動塞一個
  // Date 物件進儲存格的方式，模擬「已經被轉壞」的狀態，驗證修復程序真的能把它救回來。

  _t(results, '修正舊分頁後來才加的欄位被 Sheets 自動轉成日期型別：business_date 修回文字，今日彙總恢復正常', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '日期型別修復測試台', sortOrder: 97 }).machineId;
    const res = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 100, clientToken: newId('ct') });
    const recordId = res.records[0].recordId;

    const before1 = dbFind('Records', 'record_id', recordId);
    const sh = _spreadsheet().getSheetByName(SHEET_TAB_NAMES.Records);
    const col = SCHEMA.Records.indexOf('business_date') + 1;
    sh.getRange(before1._row, col).setValue(new Date(before1.business_date + 'T00:00:00Z'));
    _clearSheetCache();

    const corrupted = dbFind('Records', 'record_id', recordId);
    _assert(corrupted.business_date instanceof Date, '模擬應該要讓這格變成 Date 物件（測試前置條件）');

    const before = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(before.today.in, 0, '損壞狀態下，今日彙總應該抓不到這筆（重現使用者回報的症狀）');

    const fixedCells = _fixTextColumnFormatting();
    _assert(fixedCells > 0, '應該回報修正了至少一個儲存格');
    _clearSheetCache();

    const repaired = dbFind('Records', 'record_id', recordId);
    _assertEq(typeof repaired.business_date, 'string', '修好之後應該是字串，不是 Date 物件');
    _assertEq(repaired.business_date, todayKey(), '修好之後日期值應該還原正確，沒有跑掉');

    const after = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(after.today.in, 100, '修好之後，今日彙總應該正確抓到這筆');
  });

  _t(results, '重新執行 setup 會自動修正被誤存成日期型別的儲存格，且不會誤傷正常的文字資料', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: 'setup日期修復測試台', sortOrder: 98 }).machineId;
    const res = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 50, clientToken: newId('ct') });
    const recordId = res.records[0].recordId;

    const row = dbFind('Records', 'record_id', recordId);
    const sh = _spreadsheet().getSheetByName(SHEET_TAB_NAMES.Records);
    const col = SCHEMA.Records.indexOf('business_date') + 1;
    sh.getRange(row._row, col).setValue(new Date(row.business_date + 'T00:00:00Z'));
    _clearSheetCache();

    setup();
    _clearSheetCache();

    const repaired = dbFind('Records', 'record_id', recordId);
    _assertEq(typeof repaired.business_date, 'string', 'setup 之後應該是字串');
    _assertEq(repaired.business_date, todayKey(), '修好之後日期值應該還原正確，沒有跑掉');
    const detail = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(detail.today.out, 50, 'setup 修好之後今日彙總應該正確');

    // 再跑一次 setup 應該不會誤傷已經是正常文字的資料（天生冪等）。
    setup();
    _clearSheetCache();
    const stillOk = dbFind('Records', 'record_id', recordId);
    _assertEq(stillOk.business_date, todayKey(), '重複執行 setup 不該誤傷已經是文字的正常資料');
  });

  _t(results, '修正獎型名稱剛好是純數字被 Sheets 自動轉成數字型別：prize_name 修回文字，今日432數量恢復正常', function () {
    // 這是使用者實際回報的真實根因：獎型直接取名叫「432」，這個名字整串是
    // 數字，沒鎖文字格式的欄位會被 Sheets 自動轉成數字 432（不是字串 "432"），
    // 跟程式裡的字串常數 TRACKED_PRIZE_NAME 做 === 比對就永遠對不起來，
    // 「今日432數量」卡片因此永遠是 0，即使紀錄本身都寫對了。
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '獎型數字修復測試台', sortOrder: 99 }).machineId;
    const prize432 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '432', amount: 70, sortOrder: 1 }).prizeId;
    const res = _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: prize432, count: 2 }], clientToken: newId('ct')
    });
    const recordId = res.records[0].recordId;

    const row = dbFind('Records', 'record_id', recordId);
    const sh = _spreadsheet().getSheetByName(SHEET_TAB_NAMES.Records);
    const col = SCHEMA.Records.indexOf('prize_name') + 1;
    sh.getRange(row._row, col).setValue(Number(row.prize_name));
    _clearSheetCache();

    const corrupted = dbFind('Records', 'record_id', recordId);
    _assertEq(typeof corrupted.prize_name, 'number', '模擬應該要讓這格變成數字型別（測試前置條件）');

    const before = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(before.today432Count, 0, '損壞狀態下，今日432數量應該抓不到這筆（重現使用者回報的症狀）');

    const fixedCells = _fixTextColumnFormatting();
    _assert(fixedCells > 0, '應該回報修正了至少一個儲存格');
    _clearSheetCache();

    const repaired = dbFind('Records', 'record_id', recordId);
    _assertEq(typeof repaired.prize_name, 'string', '修好之後應該是字串，不是數字');
    _assertEq(repaired.prize_name, '432', '修好之後名稱應該還原成 "432"');

    const after = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(after.today432Count, 2, '修好之後，今日432數量應該正確抓到這筆');
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

  _t(results, '報表：電子機台的 scope.category 會標成 electronic，淨收益改用 chipIn/chipOut 算', function () {
    const rep = _ok({ action: 'report', token: adminTok, machineId: electronicMachine, preset: 'day' });
    _assertEq(rep.scope.category, 'electronic', '電子機台的報表 scope 應該標出分類');
    _assertEq(rep.summary.in, 0, '電子機台不會有入幣紀錄，骰台欄位應該是 0');
    _assertEq(rep.summary.net, 0, '電子機台用骰台算式的淨收益必然是 0（沒有 in/out/prize 紀錄）');
    _assertEq(rep.summary.chipIn, 500, '電子機台的報表彙總要看得到開分總額');
    _assertEq(rep.summary.chipOut, 200, '電子機台的報表彙總要看得到洗分總額');
    _assertEq(rep.summary.chipNet, 300, '電子機台真正的淨收益要用 chipIn－chipOut 算');
    _assert(rep.trend.length >= 1, '電子機台的趨勢陣列也該有資料');
    _assertEq(rep.trend[0].chipNet, 300, '趨勢陣列的每一天也要帶 chipNet，不然圖表畫不出電子機台的走勢');

    const dice = _ok({ action: 'report', token: adminTok, machineId: prizeMachine, preset: 'day' });
    _assertEq(dice.scope.category, 'dice', '骰台的報表 scope.category 應該是 dice');
  });

  _t(results, '自訂區間：起始晚於結束會被擋', function () {
    _fails({ action: 'report', token: adminTok, preset: 'custom', from: '2026-05-10', to: '2026-05-01' });
    _fails({ action: 'report', token: adminTok, preset: 'custom', from: 'bad', to: '2026-05-01' });
  });

  _t(results, '對帳表：逐日對帳表格線——出幣逐筆列出、432/441 計次、入幣與淨額都對得起來', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '對帳表測試台', sortOrder: 97 }).machineId;
    const p432 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '432', amount: 10, sortOrder: 1 }).prizeId;
    const p441 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '441', amount: 10, sortOrder: 2 }).prizeId;

    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 100, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 200, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 50, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 500, clientToken: newId('ct') });
    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: p432, count: 2 }, { prizeId: p441, count: 1 }],
      clientToken: newId('ct')
    });

    const grid = _buildLedgerGrid(validateSession(adminTok), { machineId: mid, preset: 'day' });
    _assertEq(grid.headerRow.join(','), '圖數,' + _dayKeyToLabel(todayKey()) + ',,', '表頭第一列應該是「圖數」＋今天的日期標籤，最後兩欄（總計欄）留空');
    _assertEq(grid.outRows[0].join(','), '1,100,,', '第 1 筆出幣應該依發生順序排在第一列，圖數列的總計欄留空');
    _assertEq(grid.outRows[1].join(','), '2,200,,', '第 2 筆出幣應該排在第二列');
    _assertEq(grid.outRows[2].join(','), '3,50,,', '第 3 筆出幣應該排在第三列');
    _assertEq(grid.summaryRows[0].join(','), '出幣,350,總出幣,350', '出幣小計應該是三筆加總 100+200+50，最右邊總計欄（只有一天）應該一樣是 350');
    _assertEq(grid.summaryRows[1].join(','), '432,2,432,2', '432 應該是計次（送出時 count=2），不是金額；總計欄也一樣');
    _assertEq(grid.summaryRows[2].join(','), '441,1,441,1', '441 應該是計次（送出時 count=1），不是金額；總計欄也一樣');
    _assertEq(grid.summaryRows[3].join(','), '入幣,500,總入幣,500', '入幣是當天總額，不逐筆列出；總計欄也一樣');
    _assertEq(grid.summaryRows[4].join(','), '+/-,120,+/-,120', '淨額＝入幣 500－出幣 350－432金額(2×10=20)－441金額(1×10=10)＝120；總計欄也一樣');

    const xlsx = _ok({ action: 'exportLedgerXlsx', token: adminTok, machineId: mid, preset: 'day' });
    _assert(xlsx.filename.indexOf('.xlsx') > 0, '檔名應以 .xlsx 結尾');
    _assert(xlsx.base64 && xlsx.base64.length > 0, '應該回傳非空的 base64 內容');
    _assertEq(xlsx.rowCount, 6, 'rowCount 應該是這個區間的原始紀錄筆數：3 出幣+1 入幣+開獎批次各獎型各寫一列（432、441 共 2 列）');
  });

  _t(results, '對帳表：+/- 要扣 432 跟 441 的活動金額（次數×單價），不是只扣次數', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '對帳表淨額測試台', sortOrder: 96 }).machineId;
    const p432 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '432', amount: 15, sortOrder: 1 }).prizeId;
    const p441 = _ok({ action: 'savePrize', token: adminTok, machineId: mid, name: '441', amount: 25, sortOrder: 2 }).prizeId;

    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 100, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 1000, clientToken: newId('ct') });
    _ok({
      action: 'addPrizeRecord', token: adminTok, machineId: mid,
      items: [{ prizeId: p432, count: 3 }, { prizeId: p441, count: 2 }],
      clientToken: newId('ct')
    });

    const grid = _buildLedgerGrid(validateSession(adminTok), { machineId: mid, preset: 'day' });
    // 432金額＝3×15＝45、441金額＝2×25＝50；+/-＝入幣1000－出幣100－45－50＝805
    _assertEq(grid.summaryRows[4].join(','), '+/-,805,+/-,805', '432跟441用的單價不一樣，如果算金額時兩者對調了這裡就會算錯');
  });

  _t(results, '對帳表：區間跨好幾天時，每天各自一欄，沒有出幣的那天出幣欄留空、小計是 0，最右邊兩欄是整個區間的總計', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '對帳表多日測試台', sortOrder: 98 }).machineId;
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 30, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 20, clientToken: newId('ct') });

    const grid = _buildLedgerGrid(validateSession(adminTok), {
      machineId: mid, preset: 'custom', from: _addDays(todayKey(), -2), to: todayKey()
    });
    _assertEq(grid.headerRow.join(','), '圖數,' + [_addDays(todayKey(), -2), _addDays(todayKey(), -1), todayKey()].map(_dayKeyToLabel).join(',') + ',,',
      '三天區間應該有三欄，由舊到新排列，最後兩欄（總計欄）留空');
    _assertEq(grid.outRows[0].join(','), '1,,,30,,', '前兩天沒有出幣紀錄，那兩欄該留空，只有今天有資料，圖數列的總計欄留空');
    _assertEq(grid.summaryRows[0].join(','), '出幣,0,0,30,總出幣,30', '出幣小計：沒紀錄的兩天是 0，今天是 30，總計欄＝三天加總 30');
    _assertEq(grid.summaryRows[4].join(','), '+/-,0,0,-10,+/-,-10', '淨額最後一欄總計＝三天入幣 20－出幣 30＝-10');
  });

  _t(results, '骰台查詢匯出：不指定機台改指定分類時，各骰台各自算好的小計要加總成整體 rowCount，電子機台不算進去', function () {
    const diceX = _ok({ action: 'adminSaveMachine', token: adminTok, name: '骰台查詢測試X', sortOrder: 95 }).machineId;
    const diceY = _ok({ action: 'adminSaveMachine', token: adminTok, name: '骰台查詢測試Y', sortOrder: 94 }).machineId;
    const elecZ = _ok({ action: 'adminSaveMachine', token: adminTok, name: '骰台查詢測試Z（電子）', category: 'electronic', sortOrder: 93 }).machineId;

    _ok({ action: 'addRecord', token: adminTok, machineId: diceX, type: 'out', amount: 60, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: diceY, type: 'out', amount: 25, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: diceY, type: 'out', amount: 15, clientToken: newId('ct') });
    _ok({ action: 'addRecord', token: adminTok, machineId: elecZ, type: 'chip_in', amount: 500, clientToken: newId('ct') });

    // 用只被授權這三台的台主查詢，才不會被整個測試套件跑下來累積的
    // 其他骰台（admin 看得到全部）污染 rowCount 的比對基準。
    const scopedOwner = _mkUser('t_owner_dice_query', ROLE_OWNER, 'ownerDice123');
    _clearSheetCache();
    const scopedTok = _token('t_owner_dice_query', 'ownerDice123');
    [diceX, diceY, elecZ].forEach(function (mid) {
      _ok({ action: 'adminSetPermission', token: adminTok, userId: scopedOwner.user_id, machineId: mid, granted: true });
    });

    const xGrid = _buildLedgerGrid(validateSession(scopedTok), { machineId: diceX, preset: 'day' });
    const yGrid = _buildLedgerGrid(validateSession(scopedTok), { machineId: diceY, preset: 'day' });

    const xlsx = _ok({ action: 'exportLedgerXlsx', token: scopedTok, category: 'dice', preset: 'day' });
    _assert(xlsx.filename.indexOf('全部骰台') >= 0, '檔名應該標示「全部骰台」，跟單一機台的檔名區分開來：' + xlsx.filename);
    _assertEq(xlsx.rowCount, xGrid.rowCount + yGrid.rowCount,
      '骰台查詢的 rowCount 應該等於各骰台分頁各自的 rowCount 加總（電子機台不算）');
  });

  _t(results, '骰台查詢匯出：機台名稱含 Sheets 分頁名不准用的字元（/ \\ : * ? [ ]）不會匯出失敗', function () {
    // 機台名稱只擋長度沒擋字元（adminSaveMachine），但這些字元當分頁名稱
    // 在真的 Google Sheets 上會直接報錯——本機假試算表不會擋，這裡改成
    // 直接測 _sanitizeSheetName，不靠假試算表的（不存在的）字元檢查。
    _assertEq(_sanitizeSheetName('1/2號機'), '1-2號機', '斜線要換掉');
    _assertEq(_sanitizeSheetName('A:B機台'), 'A-B機台', '冒號要換掉');
    _assertEq(_sanitizeSheetName('[維修]機台*?'), '-維修-機台--', '中括號跟星號問號都要換掉');
    _assert(_sanitizeSheetName('x'.repeat(50)).length <= 28, '要砍到 28 字以內，留空間給撞名後綴');

    const diceP = _ok({ action: 'adminSaveMachine', token: adminTok, name: '1/2號機', sortOrder: 90 }).machineId;
    _ok({ action: 'addRecord', token: adminTok, machineId: diceP, type: 'out', amount: 10, clientToken: newId('ct') });
    const scopedOwner2 = _mkUser('t_owner_slash_name', ROLE_OWNER, 'ownerSlash123');
    _clearSheetCache();
    const scopedTok2 = _token('t_owner_slash_name', 'ownerSlash123');
    _ok({ action: 'adminSetPermission', token: adminTok, userId: scopedOwner2.user_id, machineId: diceP, granted: true });

    const xlsx2 = _ok({ action: 'exportLedgerXlsx', token: scopedTok2, category: 'dice', preset: 'day' });
    _assert(xlsx2.rowCount >= 1, '含特殊字元機台名稱的骰台查詢應該照樣匯出成功');
  });

  _t(results, '骰台查詢匯出：台主只被授權電子機台時，查骰台分類會直接報錯，不是靜默生出空白活頁簿', function () {
    // 系統裡其實「有」骰台（machineA），但這個台主沒被授權——證明報錯是
    // 權限篩掉了看得到的骰台清單，不是系統裡根本沒有骰台機台。
    const elecOnly = _ok({ action: 'adminSaveMachine', token: adminTok, name: '骰台查詢權限測試（電子）', category: 'electronic', sortOrder: 91 }).machineId;
    const elecOnlyOwner = _mkUser('t_owner_elec_only', ROLE_OWNER, 'ownerElec123');
    _clearSheetCache();
    const elecOnlyTok = _token('t_owner_elec_only', 'ownerElec123');
    _ok({ action: 'adminSetPermission', token: adminTok, userId: elecOnlyOwner.user_id, machineId: elecOnly, granted: true });

    _fails({ action: 'exportLedgerXlsx', token: elecOnlyTok, category: 'dice', preset: 'day' });
  });

  // ── 按季自動封存舊資料 ──
  _t(results, '_quarterKey：日期換算季度正確', function () {
    _assertEq(_quarterKey('2026-01-15'), '2026Q1', '1月屬於Q1');
    _assertEq(_quarterKey('2026-03-31'), '2026Q1', '3月底還是Q1');
    _assertEq(_quarterKey('2026-04-01'), '2026Q2', '4月開始是Q2');
    _assertEq(_quarterKey('2026-08-21'), '2026Q3', '8月屬於Q3');
    _assertEq(_quarterKey('2026-12-31'), '2026Q4', '12月屬於Q4');
  });

  _t(results, '封存：把上一季以前的紀錄搬到封存分頁，且不影響今天的紀錄', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '封存測試台', sortOrder: 96 }).machineId;
    const oldDate = _addDays(todayKey(), -200); // 200 天前，保證是更早的季度

    const oldIn = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 1000, clientToken: newId('ct') }).records[0];
    const oldOut = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 300, clientToken: newId('ct') }).records[0];
    [oldIn, oldOut].forEach(function (rec) {
      const row = dbFind('Records', 'record_id', rec.recordId);
      dbUpdate('Records', row._row, { business_date: oldDate });
    });
    _clearSheetCache();

    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 50, clientToken: newId('ct') });

    const before = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(before.total.in, 1050, '封存前：累計入幣應該包含舊紀錄跟今天的紀錄');
    _assertEq(before.total.out, 300, '封存前：累計出幣應該包含舊紀錄');
    _assertEq(before.records.length, 3, '封存前：明細應該看得到全部 3 筆');

    const oldQ = _quarterKey(oldDate);
    const result = archiveOldRecords();
    _assert(result.archived >= 2, '至少應該封存剛剛那兩筆舊紀錄，實際 ' + result.archived);
    _assert(result.quarters.indexOf(oldQ) >= 0, '回傳的季度清單應該包含 ' + oldQ);

    const after = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(after.total.in, 1050, '封存後：累計入幣要靠封存前累計補回來，不能掉回 50');
    _assertEq(after.total.out, 300, '封存後：累計出幣一樣要對');
    _assertEq(after.records.length, 1, '封存後：明細應該只剩今天那 1 筆，舊的已經搬走');
    _assertEq(after.today.in, 50, '今日彙總不該被封存動到');

    const archiveKey = 'RecordsArchive_' + oldQ;
    const archived = dbReadAll(archiveKey).filter(function (r) { return String(r.machine_id) === mid; });
    _assertEq(archived.length, 2, '封存分頁應該存有剛剛那兩筆舊紀錄');
    _assertEq(configGet('last_archived_quarter', ''), oldQ, 'Config 應該記下最後封存到哪一季');

    const again = archiveOldRecords();
    _assertEq(again.archived, 0, '天生冪等：再跑一次不該重複封存');
  });

  _t(results, '封存：每月自動檢查的觸發器，setup() 只會裝一次，不會重複裝', function () {
    const before = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'archiveOldRecords'; }).length;
    const first = _ensureArchiveTrigger();
    const second = _ensureArchiveTrigger();
    _assert(before === 0 ? first === true : true, '沒裝過的話第一次呼叫應該回傳 true（真的裝了）');
    _assertEq(second, false, '已經裝過了，第二次呼叫應該回傳 false');
    const after = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'archiveOldRecords'; }).length;
    _assertEq(after, 1, '不管呼叫幾次，觸發器都只該有 1 個');

    const msg = setup();
    _assert(msg.indexOf('每月自動封存檢查已經設定過，略過') >= 0, 'setup() 訊息應該說明觸發器已經裝過，不是又裝一個');
  });

  _t(results, '封存：報表／匯出對帳表 選到已封存的舊區間會明確報錯，選現在這一季不受影響', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '封存區間測試台', sortOrder: 95 }).machineId;
    const oldDate = _addDays(todayKey(), -300);
    const rec = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 10, clientToken: newId('ct') }).records[0];
    dbUpdate('Records', dbFind('Records', 'record_id', rec.recordId)._row, { business_date: oldDate });
    _clearSheetCache();
    archiveOldRecords();

    _fails({ action: 'report', token: adminTok, machineId: mid, preset: 'custom', from: oldDate, to: oldDate });
    _fails({ action: 'exportLedgerXlsx', token: adminTok, machineId: mid, preset: 'custom', from: oldDate, to: oldDate });

    // 選現在這一季（今天）不該被誤擋
    const rep = _ok({ action: 'report', token: adminTok, machineId: mid, preset: 'day' });
    _assert(rep, '查詢今天的報表不該被封存區間擋下來');
    const xlsx = _ok({ action: 'exportLedgerXlsx', token: adminTok, machineId: mid, preset: 'day' });
    _assert(xlsx, '匯出今天的對帳表不該被封存區間擋下來');
  });

  _t(results, '歷史：preset=history 會自動合併封存分頁跟目前這一季的資料，其他 preset 仍然維持擋已封存區間', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '歷史查詢測試台', sortOrder: 94 }).machineId;
    const oldDate = _addDays(todayKey(), -300);

    const oldRec = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 700, clientToken: newId('ct') }).records[0];
    dbUpdate('Records', dbFind('Records', 'record_id', oldRec.recordId)._row, { business_date: oldDate });
    _clearSheetCache();
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 200, clientToken: newId('ct') });

    const oldQ = _quarterKey(oldDate);
    archiveOldRecords();
    _assert(_listArchiveQuarters().indexOf(oldQ) >= 0, '_listArchiveQuarters 應該掃得到剛剛封存的季度');

    // preset=custom 選到封存區間還是要被擋（跟前一項測試邏輯一致，這裡換一台機台驗證不衝突）。
    _fails({ action: 'report', token: adminTok, machineId: mid, preset: 'custom', from: oldDate, to: todayKey() });

    // preset=history 選同一段區間，應該自動把封存分頁跟目前這一季合併，兩筆都算得到。
    const histRep = _ok({ action: 'report', token: adminTok, machineId: mid, preset: 'history', from: oldDate, to: todayKey() });
    _assertEq(histRep.summary.out, 900, '歷史報表應該把封存分頁的 700 跟目前這一季的 200 加起來');
    _assertEq(histRep.recordCount, 2, '歷史報表應該看得到兩筆紀錄');

    const histGrid = _buildLedgerGrid(validateSession(adminTok), { machineId: mid, preset: 'history', from: oldDate, to: todayKey() });
    const outRow = histGrid.summaryRows.find(function (row) { return row[0] === '出幣'; });
    _assertEq(outRow[outRow.length - 1], 900, '歷史匯出的對帳表出幣列最右邊的總計欄應該是 700+200=900');
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

  // 一樣放最後：這裡會弄壞 t_admin 的密碼欄位並讓 setup() 重新產生，
  // adminTok 之後就失效了，後面不能再有測試依賴它。
  _t(results, '忘記密碼救援：手動清空管理員密碼欄位後重跑 setup 會認出來並重新產生，不是誤判成「已有管理員」而跳過', function () {
    const admin = dbReadAll('Users').find(function (u) { return u.username === 't_admin'; });
    _assert(admin, '應該找得到 t_admin');

    // 模擬 DEPLOY.md 記載的救援流程：使用者到試算表手動清空 password_hash/salt
    dbUpdate('Users', admin._row, { password_hash: '', salt: '' });
    _clearSheetCache();

    const beforeAdminCount = dbReadAll('Users').filter(function (u) { return String(u.role) === ROLE_ADMIN; }).length;
    const msg = setup();
    _clearSheetCache();

    _assert(msg.indexOf('管理員密碼已重設') >= 0, 'setup() 訊息應該說明是重設密碼，不是新建帳號');
    const afterAdmins = dbReadAll('Users').filter(function (u) { return String(u.role) === ROLE_ADMIN; });
    _assertEq(afterAdmins.length, beforeAdminCount, '不該多建一個管理員帳號，應該是修正原本那一筆');

    const fixed = dbFind('Users', 'user_id', admin.user_id);
    _assert(fixed.password_hash && fixed.salt, '密碼欄位應該被重新填上，不再是空的');

    // 舊 session 應該跟著真正的「重設密碼」行為一樣立刻失效
    _fails({ action: 'me', token: adminTok }, 'AUTH');
  });

  // 真的放最後：clearTestData() 會清空全部 Records／DailyLedger／BizDays，
  // 後面不能再有任何測試依賴這些分頁還留著資料。
  _t(results, 'clearTestData()：清空紀錄／每日手動帳目／營業日，機台本身跟其他設定不動，封存前累計欄位歸零', function () {
    const beforeMachines = dbReadAll('Machines');
    _assert(beforeMachines.length > 0, '清空前應該已經有機台資料（前面的測試建了很多台）');
    _assert(dbReadAll('Records').length > 0, '清空前 Records 應該已經有很多筆測試資料');
    _assert(dbReadAll('BizDays').length > 0, '清空前 BizDays 應該已經有測試留下的營業日紀錄');
    const prizesCount = dbReadAll('Prizes').length;
    const quickAmountsCount = dbReadAll('QuickAmounts').length;
    const meterRatesCount = dbReadAll('MeterRates').length;
    const usersCount = dbReadAll('Users').length;

    // 模擬「測試期間曾經觸發過封存」：手動塞一個非零的封存前累計金額。
    const sampleMachine = beforeMachines[0];
    dbUpdate('Machines', sampleMachine._row, { carry_in: 12345, carry_out: 6789 });
    _clearSheetCache();

    const msg = clearTestData();
    _clearSheetCache();

    _assertEq(dbReadAll('Records').length, 0, 'Records 應該被清空');
    _assertEq(dbReadAll('DailyLedger').length, 0, 'DailyLedger 應該被清空');
    _assertEq(dbReadAll('BizDays').length, 0, 'BizDays 應該被清空');

    const afterMachines = dbReadAll('Machines');
    _assertEq(afterMachines.length, beforeMachines.length, '機台本身的筆數不該變，不會被清掉');
    const sameMachine = dbFind('Machines', 'machine_id', sampleMachine.machine_id);
    _assertEq(sameMachine.name, sampleMachine.name, '機台名稱應該原封不動');
    _assertEq(toNumber(sameMachine.carry_in), 0, '封存前累計入幣應該被歸零');
    _assertEq(toNumber(sameMachine.carry_out), 0, '封存前累計出幣應該被歸零');

    _assertEq(dbReadAll('Prizes').length, prizesCount, '獎型設定不該被清掉');
    _assertEq(dbReadAll('QuickAmounts').length, quickAmountsCount, '快捷金額設定不該被清掉');
    _assertEq(dbReadAll('MeterRates').length, meterRatesCount, '入幣費率設定不該被清掉');
    _assertEq(dbReadAll('Users').length, usersCount, '帳號不該被清掉');

    _assert(msg.indexOf('紀錄') >= 0 && msg.indexOf('每日手動帳目') >= 0 && msg.indexOf('營業日') >= 0,
      '訊息應該說明清空了哪些分頁');
  });
}
