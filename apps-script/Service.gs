/**
 * Service.gs — 機台、紀錄、開獎、快捷金額、獎型、權限、帳號
 *
 * 這裡假設呼叫端（Code.gs 的路由）已經驗過 token 與角色，
 * 但凡是帶 machineId 的動作仍會再自己擋一次機台權限。
 */

const RECORD_IN = 'in';
const RECORD_OUT = 'out';
const RECORD_PRIZE = 'prize'; // 前端顯示叫「活動」，內部型別值維持不變（歷史資料、程式邏輯都不用跟著改）
const RECORD_CHIP_IN = 'chip_in';   // 電子機台的「開分」
const RECORD_CHIP_OUT = 'chip_out'; // 電子機台的「洗分」

const MACHINE_CATEGORY_DICE = 'dice';
const MACHINE_CATEGORY_ELECTRONIC = 'electronic';

/** 機台卡片用的像素風圖案款式，對應前端 docs/app.js 的 MACHINE_ICON_MAPS。 */
const MACHINE_ICONS = ['classic', 'round', 'twin', 'tall', 'dice', 'sixdice'];
const DEFAULT_MACHINE_ICON = 'classic';

/** 首頁「今日 OO 數量」卡片專門追蹤的活動名稱，目前先寫死。 */
const TRACKED_PRIZE_NAME = '432';
/** CSV 匯出的「逐日對帳表」另外追蹤的第二個活動名稱次數，目前先寫死。 */
const TRACKED_PRIZE_NAME_2 = '441';

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

// ── 營業日 ──────────────────────────────────────────────
//
// 預設沒人管：「今天」就是行事曆日期（todayKey()），凌晨 0 點自動換日，
// 跟這個功能上線之前完全一樣。只有店家實際按下「今日營業開始」，
// 才會改用手動的營業日邊界——晚上開始、跨過午夜才打烊的營業額，
// 會整批算進「開始那一天」，不會被行事曆日期從中間切開。
//
// 同一時間最多只有一個「進行中」的營業日（closed_at 是空的）。
// 記帳當下呼叫 _currentBusinessDate()：有進行中的營業日就用它的
// business_date，沒有就退回 todayKey()——這個退回路徑保證沒人用過
// 這個功能的店家，行為跟以前一模一樣。

/** 目前進行中的營業日（closed_at 空白），沒有就是 null。 */
function _openBizDay() {
  const rows = dbReadAll('BizDays').filter(function (r) { return !r.closed_at; });
  if (!rows.length) return null;
  // 正常情況下最多一列，防禦性地取最新建立的（列號最大）一列。
  rows.sort(function (a, b) { return (b._row || 0) - (a._row || 0); });
  return rows[0];
}

/** 記帳當下該算進哪一天：有進行中的營業日就用它，沒有就退回行事曆日期。 */
function _currentBusinessDate() {
  const open = _openBizDay();
  return open ? String(open.business_date) : todayKey();
}

/**
 * 「今日」數字要照哪一個營業日 session 的邊界算——優先用「進行中」的那個；
 * 沒有進行中的（已經按過結單）就退回找「今天結束的最後一個」，讓「今日」
 * 數字繼續維持那個 session 重置後的邊界，不會結單那一刻就跳回去跟結單前
 * 的舊帳（忘記結單被自動結掉的上一個 session、或行事曆日期退回路徑記的）
 * 混在一起——要下次又按「今日營業開始」開新的 session，邊界才會再往前挪。
 *
 * 找「今天結束的最後一個」看的是**結束時間**的行事曆日期，不是 business_date——
 * 晚上開始、跨過午夜才打烊的營業日，business_date 存的是「昨天」（開始那天），
 * 用 business_date 對今天的行事曆日期會永遠對不上，結單那一刻反而立刻「失憶」，
 * 剛好是整個跨夜設計最需要它記得的時候。改用結束時間才對得起來：不管這個
 * session 是哪天開始的，只要是今天結的，今天查「今日」就該看得到它。
 *
 * 結單後這個邊界一路維持到「今天」過完（下一個行事曆日到來會自然找不到
 * 符合的 session，退回沒有邊界）或下次又按「今日營業開始」為止——同一天
 * 開始又結束的一般情況，business_date 本來就是今天，退回路徑記的帳一樣
 * 對得起來；跨夜營業日結單後（business_date 是昨天），如果沒開新 session
 * 又繼續用退回路徑記帳，那些新紀錄「今天的行事曆日期」對不上這裡的邊界，
 * 靠 _isTodayRecord() 另外處理（見那支函式的說明），不會被卡住看不到。
 *
 * 今天完全沒按過這個功能、或今天沒有任何相關的營業日紀錄，才會真的回傳
 * null，退回沒有邊界的舊行為，跟這個功能上線前完全一樣。
 */
function _relevantBizDayForToday() {
  const open = _openBizDay();
  if (open) return open;

  const today = todayKey();
  const closedToday = dbReadAll('BizDays').filter(function (r) {
    return r.closed_at && localDateKey(r.closed_at) === today;
  });
  if (!closedToday.length) return null;
  closedToday.sort(function (a, b) { return (b._row || 0) - (a._row || 0); });
  return closedToday[0];
}

/**
 * 「今日」數字的重置邊界——按一次「今日營業開始」，所有機台跟加總分頁的
 * 手動帳目都該從那一刻重新歸零算，不能沿用同一個日期裡、這次開始「之前」
 * 記過的帳（不管是忘記結單被自動結掉的上一個 session，還是這個功能上線前
 * 用行事曆日期退回路徑記的）。紀錄本身完全不動，只是這次不把它算進「今日」
 * 而已——歷史查詢跟累計數字看到的還是全部。
 *
 * bizDay 用 _relevantBizDayForToday() 算出來的，可能是進行中的、也可能是
 * 已經結單的——結單後這個邊界還是繼續生效，不會退回單純比對日期。today 是
 * 對應的顯示日期（bizDay.business_date，或沒有相關 session 時的行事曆日期）。
 *
 * 有兩種情況會算進「今日」：
 *   ① 紀錄的日期跟 today 對得上，而且是在這個 session 開始之後記的
 *      （這是主要邏輯，負責「按開始歸零」跟「結單後維持邊界」）。
 *   ② today 其實是「昨天」（跨夜營業日結單後的顯示日期），但這筆紀錄剛好
 *      是「今天的行事曆日期」——這是結單後、沒開新 session 又繼續記的帳，
 *      不管什麼時候記的都算，不然這些新紀錄會因為日期對不上①而被排除在
 *      「今日」之外，跨夜的舊總結反而變成「卡住」新帳看不到的陷阱。
 *      同一天開始又結束的一般情況，today 本來就等於今天的行事曆日期，
 *      跟①是同一組，不會多算兩次。
 */
function _isTodayRecord(r, today, bizDay) {
  const bd = _recordBusinessDate(r);
  if (bd === today) return bizDay ? String(r.created_at) >= String(bizDay.opened_at) : true;
  if (bizDay && String(bizDay.business_date) !== todayKey() && bd === todayKey()) return true;
  return false;
}

/**
 * 某一筆紀錄該算進哪一天。
 *
 * 新紀錄一律在寫入當下就把 business_date 快照進去（跟獎型單價、
 * 碼表讀數同一個道理：算好的結果存下來，之後設定怎麼變都不會動到
 * 歷史帳）。這支是給「讀」的地方用的：舊資料（這個功能上線前寫的）
 * 沒有 business_date 這欄，退回用 created_at 的行事曆日期，這樣舊帳
 * 的日期分類不會因為升級而改變。
 */
function _recordBusinessDate(r) {
  return r.business_date || localDateKey(r.created_at);
}

function _publicBizDay(row) {
  if (!row) return null;
  const users = dbReadAll('Users');
  const nameOf = function (id) {
    if (!id) return '';
    for (let i = 0; i < users.length; i++) {
      if (String(users[i].user_id) === String(id)) return users[i].display_name || users[i].username;
    }
    return '';
  };
  return {
    businessDate: String(row.business_date),
    openedAt: row.opened_at,
    openedByName: nameOf(row.opened_by),
    closedAt: row.closed_at || null,
    closedByName: row.closed_by ? nameOf(row.closed_by) : null,
    autoClosed: toBool(row.auto_closed)
  };
}

/** 首頁顯示用：目前有沒有進行中的營業日、是哪一天開始的。 */
function businessDayStatus(user) {
  const open = _openBizDay();
  return { open: !!open, current: _publicBizDay(open) };
}

/**
 * 按下「今日營業開始」。
 *
 * 如果前一個營業日忘記結單，這裡直接幫忙結掉（記錄 auto_closed，
 * 結束時間就是這次「開始」按下去的當下），不會卡住不讓開新的——
 * 現場人員忘記按結單是常態，擋住比自動處理風險更高。
 */
function startBusinessDay(user) {
  if (!canRecord(user)) throw PermissionError('你的帳號沒有這個權限');

  return withLock(function () {
    const now = nowIso();
    const open = _openBizDay();
    if (open) {
      dbUpdate('BizDays', open._row, {
        closed_at: now,
        closed_by: user.userId,
        auto_closed: true
      });
    }
    const row = {
      biz_id: newId('biz'),
      business_date: todayKey(),
      opened_at: now,
      opened_by: user.userId,
      closed_at: '',
      closed_by: '',
      auto_closed: false
    };
    dbInsert('BizDays', row);
    return { open: true, current: _publicBizDay(row), previousAutoClosed: !!open };
  });
}

/** 按下「今日營業結單」。沒有進行中的營業日就明確報錯，不要默默沒反應。 */
function endBusinessDay(user) {
  if (!canRecord(user)) throw PermissionError('你的帳號沒有這個權限');

  return withLock(function () {
    const open = _openBizDay();
    if (!open) throw new Error('目前沒有進行中的營業日，請先按「今日營業開始」');
    dbUpdate('BizDays', open._row, {
      closed_at: nowIso(),
      closed_by: user.userId,
      auto_closed: false
    });
    const closed = dbFind('BizDays', 'biz_id', open.biz_id);
    return { open: false, current: _publicBizDay(closed) };
  });
}

/** 機台分類，沒設過（舊資料，欄位是空字串）一律當骰台——這個功能上線前建立的機台全部是骰台。 */
function _machineCategory(machineId) {
  const m = dbFind('Machines', 'machine_id', machineId);
  return (m && m.category) || MACHINE_CATEGORY_DICE;
}

// ── 每日手動帳目（週轉金／運拿／台主給／台主領／還內場／手動活動支出）──
//
// 這些是整間店當天的現金調度，不屬於任何一台機台，每個「營業日 session」
// 只設定一組（像餘額設定，不是像入幣/出幣那樣可以記很多筆）。運拿、
// 台主領本來就是現金流出，操作人直接輸入平常認知的正數金額即可，系統加總
// 時自動幫這兩項套上負號扣除，不用使用者自己記得帶負號（這件事之前讓
// 使用者輸入正數卻被系統加回去，把總結餘算錯了）；週轉金、台主給、還內場
// 則直接加回總結餘。同一個 session 裡重複儲存是覆蓋，不是疊加。
//
// 台主給／台主領可能不只一筆（不只一位台主），各自可以命名，存成 JSON
// 陣列 [{name, amount}, ...]——跟 Records 那種「一直往下加很多筆」不一樣，
// 這裡還是每個 session 存一組（一次覆蓋整份清單），只是清單裡的項目數
// 不再固定是 1 筆。手動活動支出 432／441 是額外的兩個支出欄位，給「自動
// 算出來的 432 活動之外，另外辦的活動」用，跟自動算的 today432Amount 分開
// 各自扣一次，不會互相取代。
//
// 每一列額外存一個 biz_id，snapshot 當時是哪一個營業日 session 存的——
// 跟「今日」紀錄要照 _isTodayRecord() 的開始時間切一樣的道理：按一次
// 「今日營業開始」就是開一個新 session，這些也該跟著歸零重新輸入，
// 不能沿用同一個日期裡「上一個 session」（忘記結單被自動結掉、或這次
// 開始之前）存的舊數字。舊那一列完全不會被刪或改，只是新 session 找
// 不到自己的列時當作沒設定過（都是 0／空清單），資料本身沒有被動過。
//
// given_to_owner／taken_by_owner 兩個舊欄位（單一數字）留著只是為了讀
// 這個功能上線前存的舊資料；新的寫入一律用 *_items 這兩個 JSON 欄位，
// 並且會把舊欄位清空，避免兩邊同時有值造成混淆。

/**
 * 某個營業日的手動帳目原始列，沒設定過就是 null。
 *
 * 只認「相關的營業日 session」（_relevantBizDayForToday()：進行中的，或
 * 今天結束的最後一個）自己存的那一列（biz_id 要對得上）——結單後這個邊界
 * 還是繼續生效，不會跳回去顯示結單前那個舊 session 存的數字。上一個 session
 * 存的舊列即使日期一樣也不算，這樣才會「看起來像歸零」。
 * 今天完全沒按過這個功能（沒有相關 session）才會退回這個功能上線前的
 * 行為，單純比對日期，取最新一列（防禦性地取列號最大的）。
 */
function _dailyLedgerRow(businessDate) {
  const rows = dbFilter('DailyLedger', 'business_date', businessDate);
  if (!rows.length) return null;
  const relevant = _relevantBizDayForToday();
  if (relevant) {
    const mine = rows.filter(function (r) { return String(r.biz_id || '') === String(relevant.biz_id); });
    return mine.length ? mine[0] : null;
  }
  rows.sort(function (a, b) { return (b._row || 0) - (a._row || 0); });
  return rows[0];
}

/** 解析台主給／台主領明細的 JSON 陣列，格式不對或空白一律當沒有資料。 */
function _parseLedgerItems(json) {
  if (!json) return [];
  let arr;
  try {
    arr = JSON.parse(json);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(function (it) {
    return { name: String((it && it.name) || '').trim(), amount: toNumber(it && it.amount) };
  }).filter(function (it) { return it.amount !== 0; });
}

/**
 * 新欄位（*_items）沒有資料時，退回舊欄位（單一數字）給一個預設名稱，
 * 讓這個功能上線前就存在的舊資料還看得到——只是顯示用，不會把舊欄位
 * 寫回新格式，下次使用者自己重新儲存才會真的搬過去。
 */
function _ledgerItemsOrLegacy(itemsJson, legacyAmount, legacyName) {
  const items = _parseLedgerItems(itemsJson);
  if (items.length) return items;
  const amt = toNumber(legacyAmount);
  return amt ? [{ name: legacyName, amount: amt }] : [];
}

function _sumLedgerItems(items) {
  return items.reduce(function (s, it) { return s + toNumber(it.amount); }, 0);
}

/** 轉成前端要的形狀，沒設定過的營業日各項都當 0／空清單，不是回傳 null 讓前端自己判斷。 */
function _publicDailyLedger(row) {
  const givenToOwnerItems = row ? _ledgerItemsOrLegacy(row.given_to_owner_items, row.given_to_owner, '台主給') : [];
  const takenByOwnerItems = row ? _ledgerItemsOrLegacy(row.taken_by_owner_items, row.taken_by_owner, '台主領') : [];
  return {
    turnover: row ? toNumber(row.turnover) : 0,
    transport: row ? toNumber(row.transport) : 0,
    givenToOwnerItems: givenToOwnerItems,
    givenToOwner: _sumLedgerItems(givenToOwnerItems),
    takenByOwnerItems: takenByOwnerItems,
    takenByOwner: _sumLedgerItems(takenByOwnerItems),
    returnedToHouse: row ? toNumber(row.returned_to_house) : 0,
    manual432: row ? toNumber(row.manual_432) : 0,
    manual441: row ? toNumber(row.manual_441) : 0,
    manualExpense: row ? toNumber(row.manual_expense) : 0,
    updatedAt: row ? row.updated_at : ''
  };
}

/** 跟 _validAmount 不同：允許輸入負數（用於偶爾需要沖正的修正），只限制數字的大小。 */
function _validSignedAmount(raw) {
  const n = Number(raw);
  if (!isFinite(n)) throw new Error('金額必須是數字');
  if (Math.abs(n) > MAX_AMOUNT) throw new Error('金額超出上限');
  return Math.round(n * 100) / 100;
}

/** 運拿／台主領／手動活動支出這幾項一律是現金流出，輸入平常認知的正數金額就好，加總時系統自動扣除。 */
function _validOutflowAmount(raw) {
  const n = Number(raw || 0);
  if (!isFinite(n)) throw new Error('金額必須是數字');
  if (n < 0) throw new Error('這項請輸入正數金額，系統會自動從總結餘扣除');
  if (n > MAX_AMOUNT) throw new Error('金額超出上限');
  return Math.round(n * 100) / 100;
}

const MAX_LEDGER_ITEMS = 30;

/**
 * 整理台主給／台主領的清單：每筆驗證金額（用 validateAmount，兩邊規則不同——
 * 台主給可正可負，台主領一律正數自動扣除）、名稱沒填就用預設名稱頂著、
 * 金額是 0（含沒填）的那幾筆直接丟掉，不用留著佔位子。
 */
function _sanitizeLedgerItems(raw, validateAmount, defaultName) {
  if (!raw) return [];
  if (!Array.isArray(raw)) throw new Error('清單格式不正確');
  if (raw.length > MAX_LEDGER_ITEMS) throw new Error('筆數超出上限');
  const items = [];
  raw.forEach(function (it) {
    const amount = validateAmount(it && it.amount);
    if (!amount) return;
    const name = String((it && it.name) || '').trim().slice(0, 30);
    items.push({ name: name || defaultName, amount: amount });
  });
  return items;
}

/** 設定今天（目前營業日）的週轉金／運拿／台主給／台主領／還內場／手動活動支出。 */
function saveDailyLedger(user, payload) {
  if (!canRecord(user)) throw PermissionError('你的帳號沒有這個權限');

  const turnover = _validSignedAmount(payload.turnover);
  const transport = _validOutflowAmount(payload.transport);
  const givenToOwnerItems = _sanitizeLedgerItems(payload.givenToOwnerItems, _validSignedAmount, '台主給');
  const takenByOwnerItems = _sanitizeLedgerItems(payload.takenByOwnerItems, _validOutflowAmount, '台主領');
  const returnedToHouse = _validSignedAmount(payload.returnedToHouse);
  const manual432 = _validOutflowAmount(payload.manual432);
  const manual441 = _validOutflowAmount(payload.manual441);
  const manualExpense = _validOutflowAmount(payload.manualExpense);

  return withLock(function () {
    // 用跟 getDashboard() 讀取時同一套邊界（_relevantBizDayForToday()），
    // 不是 _currentBusinessDate()——後者結單後會退回今天的行事曆日期，
    // 兩邊算的「今天」對不起來的話，這裡存的那一列跟畫面讀的那一列會是
    // 不同的 business_date／biz_id，變成存了卻讀不到、顯示 0。
    const relevant = _relevantBizDayForToday();
    const businessDate = relevant ? String(relevant.business_date) : todayKey();
    const existing = _dailyLedgerRow(businessDate);
    const patch = {
      turnover: turnover,
      transport: transport,
      // 舊的單一數字欄位清空——新的寫入一律走 *_items，兩邊同時有值會
      // 讓 _ledgerItemsOrLegacy() 的退回邏輯搞不清楚該信哪一個。
      given_to_owner: '',
      taken_by_owner: '',
      given_to_owner_items: JSON.stringify(givenToOwnerItems),
      taken_by_owner_items: JSON.stringify(takenByOwnerItems),
      returned_to_house: returnedToHouse,
      manual_432: manual432,
      manual_441: manual441,
      manual_expense: manualExpense,
      updated_by: user.userId,
      updated_at: nowIso()
    };
    if (existing) {
      dbUpdate('DailyLedger', existing._row, patch);
    } else {
      dbInsert('DailyLedger', Object.assign({
        ledger_id: newId('ldg'),
        business_date: businessDate,
        biz_id: relevant ? relevant.biz_id : ''
      }, patch));
    }
    return _publicDailyLedger(_dailyLedgerRow(businessDate));
  });
}

// ── 彙總 ────────────────────────────────────────────────

/**
 * 骰台（in/out/prize）跟電子（chip_in/chip_out）兩種機台的欄位都放在
 * 同一個 summary 物件裡，骰台紀錄不會動到 chipIn/chipOut，電子紀錄
 * 也不會動到 in/out/prize——兩種機台混在同一批紀錄裡累加也不會互相污染，
 * 首頁「加總」分頁要同時看兩種淨額時不用分開兩套彙總邏輯。
 */
function emptySummary() {
  return { in: 0, out: 0, prize: 0, net: 0, chipIn: 0, chipOut: 0, chipNet: 0 };
}

function _accumulate(sum, rec) {
  const amt = toNumber(rec.amount);
  if (rec.type === RECORD_IN) sum.in += amt;
  else if (rec.type === RECORD_OUT) sum.out += amt;
  else if (rec.type === RECORD_PRIZE) sum.prize += amt;
  else if (rec.type === RECORD_CHIP_IN) sum.chipIn += amt;
  else if (rec.type === RECORD_CHIP_OUT) sum.chipOut += amt;
  sum.net = sum.in - sum.out - sum.prize;
  sum.chipNet = sum.chipIn - sum.chipOut;
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

  const machineById = {};
  machines.forEach(function (m) { machineById[String(m.machine_id)] = m; });

  const openBiz = _relevantBizDayForToday();
  const today = openBiz ? String(openBiz.business_date) : todayKey();
  const totals = {};
  const todays = {};
  // totals 是「累計」（全部歷史加總），要從封存前累計開始疊；
  // todays 只看今天，跟封存無關，一律從 0 開始。
  ids.forEach(function (id) { totals[id] = _seedSummary(machineById[id] || {}); todays[id] = emptySummary(); });

  let today432Count = 0;
  let today432Amount = 0;
  let today441Count = 0;
  let todayOutCount = 0;
  // 本月432/441支數——「本月」照營業日期算（跟報表頁 month 這個 preset
  // 同一套邏輯：從這個月1號算到今天），不是行事曆月份，才會跟「今日」
  // 的算法一致，晚上跨過月初的營業額不會被切開。
  const thisMonth = today.substring(0, 7);
  let month432Count = 0;
  let month441Count = 0;
  activeRecords().forEach(function (r) {
    const mid = String(r.machine_id);
    if (!totals[mid]) return;
    _accumulate(totals[mid], r);
    const isToday = _isTodayRecord(r, today, openBiz);
    if (isToday) {
      _accumulate(todays[mid], r);
      if (r.type === RECORD_PRIZE && r.prize_name === TRACKED_PRIZE_NAME) {
        today432Count += toNumber(r.count);
        today432Amount += toNumber(r.amount);
      } else if (r.type === RECORD_PRIZE && r.prize_name === TRACKED_PRIZE_NAME_2) {
        today441Count += toNumber(r.count);
      } else if (r.type === RECORD_OUT) {
        todayOutCount += 1;
      }
    }
    if (r.type === RECORD_PRIZE && _recordBusinessDate(r).substring(0, 7) === thisMonth) {
      if (r.prize_name === TRACKED_PRIZE_NAME) month432Count += toNumber(r.count);
      else if (r.prize_name === TRACKED_PRIZE_NAME_2) month441Count += toNumber(r.count);
    }
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
      category: m.category || MACHINE_CATEGORY_DICE,
      icon: m.icon || DEFAULT_MACHINE_ICON,
      today: todays[id],
      total: totals[id]
    };
  });

  list.sort(function (a, b) {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return String(a.name).localeCompare(String(b.name));
  });

  // 骰台跟電子機台的今日淨額分開算——首頁「加總」分頁要同時顯示
  // 骰台淨收益、電子淨收益、兩者相加的總淨收益三張卡片。
  const diceTotal = emptySummary();
  const electronicTotal = emptySummary();
  list.forEach(function (m) {
    const target = m.category === MACHINE_CATEGORY_ELECTRONIC ? electronicTotal : diceTotal;
    target.in += m.today.in;
    target.out += m.today.out;
    target.prize += m.today.prize;
    target.chipIn += m.today.chipIn;
    target.chipOut += m.today.chipOut;
  });
  diceTotal.net = diceTotal.in - diceTotal.out - diceTotal.prize;
  electronicTotal.chipNet = electronicTotal.chipIn - electronicTotal.chipOut;

  const grand = emptySummary();
  grand.in = diceTotal.in;
  grand.out = diceTotal.out;
  grand.prize = diceTotal.prize;
  grand.net = diceTotal.net;
  grand.chipIn = electronicTotal.chipIn;
  grand.chipOut = electronicTotal.chipOut;
  grand.chipNet = electronicTotal.chipNet;

  const ledger = _publicDailyLedger(_dailyLedgerRow(today));

  // 「加總」分頁的現金結餘：今日入幣 − 出幣 − 手動活動支出432/441（另外辦
  // 活動時的現金支出）− 開銷（每天手動填的現金支出）＋電子淨贏 ＋週轉金/
  // 台主給/台主領/還內場這幾個每天手動輸入的數字。系統自動算出來的
  // 432活動金額（today432Amount，即「活動出獎」）故意不扣在這裡——給出去
  // 的是獎品不是現金，不會讓收銀機裡的錢變少，只影響機台自己的「淨收益」
  // （diceTotal.net 那條算式），不是這裡的現金對帳。運拿（transport）這個
  // 欄位已經用不到，故意不扣——DailyLedger 分頁還留著這一欄只是為了讀
  // 舊資料，新存的值不會再影響這裡。台主領、手動活動支出、開銷存的是
  // 使用者輸入的正數現金流出金額，這裡要扣掉；週轉金、台主給、還內場是
  // 加回去。台主給／台主領現在可能有好幾筆，這裡用的是 _publicDailyLedger()
  // 已經加總好的 givenToOwner／takenByOwner。
  const ledgerTotal = diceTotal.in - diceTotal.out - ledger.manual432 - ledger.manual441 - ledger.manualExpense
    + ledger.turnover + ledger.givenToOwner
    + electronicTotal.chipNet - ledger.takenByOwner + ledger.returnedToHouse;

  return {
    machines: list,
    todayTotal: grand,
    diceTotal: diceTotal,
    electronicTotal: electronicTotal,
    today432Count: today432Count,
    today432Amount: today432Amount,
    today441Count: today441Count,
    todayOutCount: todayOutCount,
    month432Count: month432Count,
    month441Count: month441Count,
    ledger: ledger,
    ledgerTotal: Math.round(ledgerTotal * 100) / 100,
    today: today,
    businessDay: businessDayStatus(user)
  };
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

/**
 * 單一機台的詳細頁資料——getMachineDetail（單台）跟 getAllMachineDetails
 * （一次算全部，見下方）共用同一份組裝邏輯，差別只在呼叫端怎麼把這台的
 * 紀錄篩出來，避免兩邊各寫一份、改一邊忘了改另一邊。
 */
function _buildMachineDetail(m, records, recordLimit, openBiz) {
  const today = openBiz ? String(openBiz.business_date) : todayKey();
  // 「累計」要從封存前累計開始疊，不然舊紀錄搬去封存分頁之後這個數字會憑空掉下去。
  const total = _seedSummary(m);
  const todaySum = emptySummary();
  let today432Count = 0;

  records.forEach(function (r) {
    _accumulate(total, r);
    const isToday = _isTodayRecord(r, today, openBiz);
    if (isToday) {
      _accumulate(todaySum, r);
      if (r.type === RECORD_PRIZE && r.prize_name === TRACKED_PRIZE_NAME) {
        today432Count += toNumber(r.count);
      }
    }
  });

  const mine = records.slice().sort(_byCreatedAtDesc);
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

  const machineId = String(m.machine_id);
  return {
    machine: {
      machineId: machineId,
      name: m.name,
      location: m.location || '',
      status: m.status || 'running',
      color: m.color || '#4F7BE8',
      note: m.note || '',
      category: m.category || MACHINE_CATEGORY_DICE,
      icon: m.icon || DEFAULT_MACHINE_ICON
    },
    today: todaySum,
    today432Count: today432Count,
    total: total,
    records: mine.slice(0, limit).map(_publicRecord),
    hasMore: mine.length > limit,
    quickAmounts: _resolveQuickAmounts(machineId),
    prizes: _resolvePrizes(machineId),
    meterRate: _resolveMeterRate(machineId),
    lastMeterReading: lastMeterReading
  };
}

function getMachineDetail(user, machineId, recordLimit) {
  assertMachineAccess(user, machineId);
  const m = dbFind('Machines', 'machine_id', machineId);
  if (!m) throw new Error('找不到這台機台');

  const mine = activeRecords().filter(function (r) { return String(r.machine_id) === String(machineId); });
  return _buildMachineDetail(m, mine, recordLimit, _relevantBizDayForToday());
}

/**
 * 一次算出使用者看得到的每一台機台的完整詳細頁資料（跟 getMachineDetail
 * 同一個形狀，用 machineId 當 key），登入後前端只要打這一支就能讓
 * 「切機台秒切」的背景預取從原本 N 台各打一次 machineDetail（N 次網路
 * 來回、每次都重新讀一次整張 Records）縮成一次網路來回、一次 Records
 * 讀取——dbReadAll 在同一次執行內本來就會快取，真正貴的是「跨執行」
 * 那 N 趟 Sheets API 讀取，這裡直接省掉。
 */
function getAllMachineDetails(user, recordLimit) {
  const ids = visibleMachineIds(user);
  const machines = dbReadAll('Machines').filter(function (m) {
    return ids.indexOf(String(m.machine_id)) >= 0;
  });

  const byMachine = {};
  ids.forEach(function (id) { byMachine[id] = []; });
  activeRecords().forEach(function (r) {
    const mid = String(r.machine_id);
    if (byMachine[mid]) byMachine[mid].push(r);
  });

  const openBiz = _relevantBizDayForToday();
  const result = {};
  machines.forEach(function (m) {
    const id = String(m.machine_id);
    result[id] = _buildMachineDetail(m, byMachine[id] || [], recordLimit, openBiz);
  });
  return result;
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
    businessDate: _recordBusinessDate(r),
    note: r.note || ''
  };
}

// ── 記帳（入幣 / 出幣）──────────────────────────────────

function addRecord(user, payload) {
  if (!canRecord(user)) throw PermissionError('你的帳號沒有記帳權限');
  assertMachineAccess(user, payload.machineId);

  const type = payload.type;
  const isDiceType = (type === RECORD_IN || type === RECORD_OUT);
  const isChipType = (type === RECORD_CHIP_IN || type === RECORD_CHIP_OUT);
  if (!isDiceType && !isChipType) throw new Error('紀錄類型不正確');

  const category = _machineCategory(payload.machineId);
  if (category === MACHINE_CATEGORY_ELECTRONIC && !isChipType) {
    throw new Error('電子機台只能記錄開分或洗分');
  }
  if (category !== MACHINE_CATEGORY_ELECTRONIC && !isDiceType) {
    throw new Error('骰台機台不能記錄開分或洗分');
  }

  const amount = _validAmount(payload.amount);

  const result = withLock(function () {
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
      client_token: String(payload.clientToken || ''),
      business_date: _currentBusinessDate()
    };
    dbInsert('Records', rec);
    return { duplicated: false, records: [_publicRecord(rec)] };
  });
  // 前端送出入幣/出幣後一定緊接著重新整理機台詳細頁，沒理由分兩趟網路
  // 來回各付一次 GAS 的 /exec 轉址成本——直接把最新的詳細頁資料一起
  // 回傳，跟 homeBootstrap／getAllMachineDetails 同一個道理。放在鎖外面
  // 算（純讀取，不用佔著鎖），且這筆剛寫入的紀錄在同一次執行內立刻可讀
  // （dbInsert 已經把 Records 的快取清掉）。
  result.detail = getMachineDetail(user, payload.machineId);
  return result;
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
  if (_machineCategory(payload.machineId) === MACHINE_CATEGORY_ELECTRONIC) {
    throw new Error('電子機台不能用碼表入幣，請用開分/洗分');
  }

  const meterStart = _validMeterReading(payload.meterStart);
  const meterEnd = _validMeterReading(payload.meterEnd);
  if (meterEnd <= meterStart) throw new Error('下班表必須大於上班表');

  const rate = _resolveMeterRate(payload.machineId).rate;
  const amount = _validAmount((meterEnd - meterStart) * rate);

  const result = withLock(function () {
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
      client_token: String(payload.clientToken || ''),
      business_date: _currentBusinessDate()
    };
    dbInsert('Records', rec);
    return { duplicated: false, records: [_publicRecord(rec)] };
  });
  // 跟 addRecord 同一個道理：直接把最新的機台詳細頁資料一起回傳，
  // 省掉前端緊接著再打一次 machineDetail 的來回。
  result.detail = getMachineDetail(user, payload.machineId);
  return result;
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
  if (_machineCategory(payload.machineId) === MACHINE_CATEGORY_ELECTRONIC) {
    throw new Error('電子機台沒有活動登錄');
  }

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
    const businessDate = _currentBusinessDate();
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
        client_token: String(payload.clientToken || ''),
        business_date: businessDate
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
        note: m.note || '',
        category: m.category || MACHINE_CATEGORY_DICE,
        icon: m.icon || DEFAULT_MACHINE_ICON
      };
    });
}

/**
 * 機台分類（骰台／電子）只在「新增機台」當下決定，走哪顆新增按鈕就是哪個分類，
 * 之後編輯不能再改——換分類代表這台機台過去的紀錄類型（in/out/prize 或
 * chip_in/chip_out）全部對不上新分類，貿然允許改分類等於讓歷史帳目失真。
 * 所以這裡只有新增分支會寫 category，更新分支完全不動這一欄。
 */
function adminSaveMachine(user, payload) {
  requireRole(user, [ROLE_ADMIN]);
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('請輸入機台名稱');
  if (name.length > 30) throw new Error('機台名稱請在 30 字以內');

  const status = payload.status || 'running';
  if (['running', 'maintenance', 'offline'].indexOf(status) < 0) throw new Error('機台狀態不正確');

  let color = String(payload.color || '#4F7BE8');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = '#4F7BE8';

  // 圖案跟顏色一樣，隨時可以改，不像分類牽動歷史紀錄的型別。
  const icon = MACHINE_ICONS.indexOf(payload.icon) >= 0 ? payload.icon : DEFAULT_MACHINE_ICON;

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
        note: String(payload.note || '').substring(0, 200),
        icon: icon
      });
      return { machineId: String(payload.machineId) };
    }
    const category = payload.category === MACHINE_CATEGORY_ELECTRONIC ? MACHINE_CATEGORY_ELECTRONIC : MACHINE_CATEGORY_DICE;
    const m = {
      machine_id: newId('mch'),
      name: name,
      location: String(payload.location || '').substring(0, 50),
      status: status,
      color: color,
      sort_order: toNumber(payload.sortOrder),
      note: String(payload.note || '').substring(0, 200),
      created_at: nowIso(),
      category: category,
      icon: icon
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
