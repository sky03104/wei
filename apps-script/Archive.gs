/**
 * Archive.gs — 每季自動把上一季（以前）的 Records 搬到封存分頁
 *
 * 背景：每次操作（首頁、機台詳細頁、報表、匯出對帳表）都會把整張 Records
 * 分頁全部讀進記憶體再篩選——不是只抓畫面顯示的區間，所以效能是跟著
 * 「累計總筆數」變慢，不是跟著「你在看的區間」。筆數多到一個程度
 * （大概幾萬筆以上）就會開始有感地變慢。
 *
 * 這裡的做法：把已經過去、不會再變動的季度資料搬到獨立的封存分頁
 * （例如「封存_2026Q1」），Records 只留「目前這一季」，讀取速度就
 * 只跟「這一季的筆數」有關，不會隨著開店年數一直往上疊加。
 *
 * 封存前累計（carry_in/out/prize/chip_in/chip_out）：首頁 getDashboard()
 * 每台機台的 total 是歷史全部加總，紀錄搬去封存分頁之後這個數字不能
 * 憑空掉下去——封存當下先把要搬走的那批紀錄加總進 Machines 分頁的
 * 這幾欄，之後「累計」＝這幾欄＋目前還留在 Records 裡的量。機台詳細頁
 * 顯示的「累計淨收益」則是本週（見 Service.gs 的 _buildMachineDetail()），
 * 只讀目前這一季的 Records、不會用到這幾欄——跟「本月432/441支數」那幾張
 * 卡片一樣的簡化：跨季度那一週（例如新的一季剛開始沒幾天，週日還在
 * 上一季）如果剛好遇到每月 2 號的封存已經跑過，本週淨收益會少算被搬去
 * 封存分頁那幾天，一年只會發生在季初那一週，先不處理。
 *
 * 觸發方式：setup() 會確保一個「每月 2 號凌晨 3 點」的時間觸發器存在，
 * 呼叫 archiveOldRecords()。這支函式本身天生冪等（只會搬「目前這一季」
 * 以前的資料，沒有東西可搬就安全地什麼都不做），所以固定每月檢查一次
 * 就能保證封存進度不會落後超過一個月，不需要另外判斷「現在是不是剛好
 * 換季」。
 */

/** 'yyyy-MM-dd' → '2026Q3'。 */
function _quarterKey(dateKey) {
  const p = String(dateKey).split('-');
  const y = Number(p[0]);
  const m = Number(p[1]);
  const q = Math.ceil(m / 3);
  return y + 'Q' + q;
}

function _archiveTabName(quarterKey) {
  return '封存_' + quarterKey;
}

/**
 * 幫某一季的封存分頁動態註冊 SCHEMA／HEADER_LABELS／SHEET_TAB_NAMES，
 * 讓 _sheet()／dbInsertMany() 這些既有的存取層函式可以直接把這個
 * 「假分頁名稱」當一般分頁用，不用另外寫一套專門存取封存分頁的程式碼。
 * 欄位結構跟 Records 完全一樣，只是分頁名稱不同。
 */
function _registerArchiveSheet(quarterKey) {
  const key = 'RecordsArchive_' + quarterKey;
  if (!SCHEMA[key]) {
    SCHEMA[key] = SCHEMA.Records.slice();
    HEADER_LABELS[key] = HEADER_LABELS.Records.slice();
    SHEET_TAB_NAMES[key] = _archiveTabName(quarterKey);
  }
  return key;
}

/** 從一批要被搬走的紀錄，算出每台機台要疊加進「封存前累計」的量。 */
function _sumCarryForward(records) {
  const byMachine = {};
  records.forEach(function (r) {
    const mid = String(r.machine_id);
    if (!byMachine[mid]) byMachine[mid] = { in: 0, out: 0, prize: 0, chipIn: 0, chipOut: 0 };
    const amt = toNumber(r.amount);
    if (r.type === RECORD_IN) byMachine[mid].in += amt;
    else if (r.type === RECORD_OUT) byMachine[mid].out += amt;
    else if (r.type === RECORD_PRIZE) byMachine[mid].prize += amt;
    else if (r.type === RECORD_CHIP_IN) byMachine[mid].chipIn += amt;
    else if (r.type === RECORD_CHIP_OUT) byMachine[mid].chipOut += amt;
  });
  return byMachine;
}

/** 把算好的「封存前累計」疊加寫回 Machines 分頁對應的機台列。 */
function _applyCarryForward(byMachine) {
  const machines = dbReadAll('Machines');
  Object.keys(byMachine).forEach(function (mid) {
    const m = machines.filter(function (x) { return String(x.machine_id) === mid; })[0];
    if (!m) return; // 機台已經不存在（目前系統沒有刪機台功能，防禦性略過）
    const add = byMachine[mid];
    dbUpdate('Machines', m._row, {
      carry_in: toNumber(m.carry_in) + add.in,
      carry_out: toNumber(m.carry_out) + add.out,
      carry_prize: toNumber(m.carry_prize) + add.prize,
      carry_chip_in: toNumber(m.carry_chip_in) + add.chipIn,
      carry_chip_out: toNumber(m.carry_chip_out) + add.chipOut
    });
  });
}

/**
 * 「累計」用的起始值：從沒被封存過的機台一律是 0（等同 emptySummary()），
 * 封存過的機台會帶入封存時記下來的「封存前累計」，讓機台詳細頁的
 * 「累計淨收益」不會因為舊紀錄搬去封存分頁就憑空掉下去。
 */
function _seedSummary(m) {
  const s = {
    in: toNumber(m.carry_in),
    out: toNumber(m.carry_out),
    prize: toNumber(m.carry_prize),
    chipIn: toNumber(m.carry_chip_in),
    chipOut: toNumber(m.carry_chip_out),
    net: 0,
    chipNet: 0
  };
  s.net = s.in - s.out - s.prize;
  s.chipNet = s.chipIn - s.chipOut;
  return s;
}

/**
 * 把「目前這一季」以前、還留在 Records 的紀錄搬到對應季度的封存分頁。
 *
 * 天生冪等：只挑「業務日期的季度 < 目前這一季」的紀錄，已經搬走的
 * 紀錄不在 Records 裡了，重跑不會重複搬；沒有東西可搬時安全地
 * 什麼都不做。可能一次橫跨好幾個季度（例如超過一季沒執行過），
 * 這裡會依季分桶、各自搬進各自的封存分頁。
 */
function archiveOldRecords() {
  return withLock(function () {
    const currentQ = _quarterKey(_currentBusinessDate());
    const rows = dbReadAll('Records');

    const toArchive = rows.filter(function (r) {
      return _quarterKey(_recordBusinessDate(r)) < currentQ;
    });
    if (!toArchive.length) {
      return { archived: 0, quarters: [] };
    }

    const buckets = {};
    toArchive.forEach(function (r) {
      const q = _quarterKey(_recordBusinessDate(r));
      if (!buckets[q]) buckets[q] = [];
      buckets[q].push(r);
    });

    // 封存前先把每台機台的「封存前累計」補上，這批紀錄從 Records
    // 消失後，machineDetail 的「累計淨收益」才不會憑空掉下去。
    _applyCarryForward(_sumCarryForward(toArchive));

    const quarters = Object.keys(buckets).sort();
    quarters.forEach(function (q) {
      const key = _registerArchiveSheet(q);
      dbInsertMany(key, buckets[q]);
    });

    dbDeleteRows('Records', toArchive.map(function (r) { return r._row; }));

    configSet('last_archived_quarter', quarters[quarters.length - 1]);
    configSet('last_archived_at', nowIso());

    return { archived: toArchive.length, quarters: quarters };
  });
}

/**
 * 確保「每月自動封存檢查」的時間觸發器存在。setup() 會呼叫這支。
 * 用專案既有的觸發器清單判斷「已經裝過了」，重跑 setup() 不會疊加裝出
 * 好幾個一樣的觸發器。回傳這次是不是真的新裝了一個。
 */
function _ensureArchiveTrigger() {
  const already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'archiveOldRecords';
  });
  if (already) return false;
  ScriptApp.newTrigger('archiveOldRecords')
    .timeBased()
    .onMonthDay(2)
    .atHour(3)
    .create();
  return true;
}

/**
 * 報表／匯出對帳表 選到的區間如果早於「已封存」的季度，直接明確報錯，
 * 不要默默算出不完整的數字——那些資料還在試算表裡，只是搬去了封存
 * 分頁，系統目前不會跨分頁合併查詢，使用者要自己去對應的封存分頁看。
 */
function _assertRangeNotArchived(range) {
  const lastArchived = configGet('last_archived_quarter', '');
  if (!lastArchived) return; // 還沒封存過，不用管
  if (_quarterKey(range.from) > lastArchived) return;
  throw new Error(
    '查詢區間包含已封存的舊資料（' + lastArchived + ' 以前，含）。'
    + '系統只查得到封存之後的資料，更早的部分請到試算表「' + _archiveTabName(_quarterKey(range.from)) + '」等封存分頁查看。'
  );
}

// ── 歷史查詢（報表頁「歷史」分頁專用）──────────────────
//
// 平常的報表／匯出對帳表 刻意只讀 Records（見上面的 _assertRangeNotArchived），
// 這樣才能保持「只讀目前這一季」的效能優勢。但使用者偶爾就是需要回頭看
// 更久以前的資料，所以另外開一條路：「歷史」分頁明確願意多付一點效能
// 代價，把 Records 加上所有涵蓋到查詢區間的封存分頁一起讀出來、合併查詢。
//
// 封存分頁是動態新增的（每季一張，例如「封存_2026Q1」），不維護一份
// 寫死的清單——直接掃試算表目前實際存在的分頁名稱，季度會隨著繼續
// 開店、繼續封存自動增加，不用改程式碼。

/** 掃試算表目前實際存在的封存分頁，回傳季度清單（由舊到新排序）。 */
function _listArchiveQuarters() {
  const re = /^封存_(\d{4}Q[1-4])$/;
  return _spreadsheet().getSheets()
    .map(function (sh) {
      const m = re.exec(sh.getName());
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .sort();
}

/**
 * 「歷史」查詢用的紀錄來源：目前這一季（Records）＋所有跟查詢區間
 * 有重疊、目前實際存在的封存分頁，合併成一份紀錄陣列。
 */
function _historyRecords(range) {
  const fromQ = _quarterKey(range.from);
  const toQ = _quarterKey(range.to);
  const quarters = _listArchiveQuarters().filter(function (q) { return q >= fromQ && q <= toQ; });

  let all = activeRecords();
  quarters.forEach(function (q) {
    const key = _registerArchiveSheet(q);
    all = all.concat(dbReadAll(key).filter(function (r) { return !toBool(r.voided); }));
  });
  return all;
}

// ── Phase 4 資料遷移：一次匯出全部資料 ─────────────────────
//
// 只給 supabase/migrate-from-sheets.js 用。遷移完成、確認 Postgres
// 版本穩定運作一段時間後，這個 action 跟這一段程式碼可以整個拿掉。

/**
 * 遷移用的完整紀錄清單：目前這一季（Records）＋全部封存分頁，
 * 不像 _historyRecords() 那樣篩掉已作廢的——遷移要把作廢紀錄也一起
 * 搬過去，保留完整的稽核軌跡（Postgres 版本一樣有 voided 欄位）。
 */
function _allRecordsForExport() {
  let all = dbReadAll('Records');
  _listArchiveQuarters().forEach(function (q) {
    const key = _registerArchiveSheet(q);
    all = all.concat(dbReadAll(key));
  });
  return all;
}

/**
 * 匯出全部資料給 Phase 4 遷移腳本用，一次打包成一份 JSON。
 *
 * 刻意轉成跟系統其他 API 回應一致的 camelCase 欄位名稱（不是直接把
 * dbReadAll() 讀到的原始 snake_case 欄位吐出去）——supabase/
 * migrate-from-sheets.js 就是照這個形狀寫的，兩邊要對得上。
 *
 * Users 刻意不帶 password_hash／salt——GAS 用的雜湊演算法沒辦法直接
 * 匯入 Supabase Auth，帳號密碼在遷移計畫裡本來就是「請使用者到新系統
 * 重設一次」，不需要（也不應該）把舊雜湊值搬過去。
 * Machines 不帶 carry_* 那幾欄——那是配合季度封存機制的「封存前累計」，
 * Postgres 版本因為不需要季度封存，這幾欄的值沒有意義（合併後的
 * records 表本身就能算出完整歷史），遷移腳本看到的機台餘額一律用
 * 合併後的 records 現場算。
 */
function exportAllData(user) {
  requireRole(user, [ROLE_ADMIN]);
  return {
    exportedAt: nowIso(),
    apiVersion: API_VERSION,
    users: dbReadAll('Users').map(function (r) {
      return {
        userId: r.user_id, username: r.username, displayName: r.display_name || r.username,
        role: r.role, status: r.status, createdAt: r.created_at, lastLoginAt: r.last_login_at || ''
      };
    }),
    machines: dbReadAll('Machines').map(function (r) {
      return {
        machineId: r.machine_id, name: r.name, location: r.location || '', status: r.status || 'running',
        color: r.color || '#4F7BE8', sortOrder: r.sort_order, note: r.note || '', createdAt: r.created_at,
        category: r.category || MACHINE_CATEGORY_DICE, icon: r.icon || DEFAULT_MACHINE_ICON
      };
    }),
    prizes: dbReadAll('Prizes').map(function (r) {
      return { prizeId: r.prize_id, machineId: r.machine_id || '', name: r.name, amount: r.amount, sortOrder: r.sort_order, active: r.active };
    }),
    quickAmounts: dbReadAll('QuickAmounts').map(function (r) {
      return { qaId: r.qa_id, machineId: r.machine_id || '', type: r.type, amount: r.amount, label: r.label || '', sortOrder: r.sort_order };
    }),
    meterRates: dbReadAll('MeterRates').map(function (r) {
      return { rateId: r.rate_id, machineId: r.machine_id || '', rate: r.rate };
    }),
    permissions: dbReadAll('Permissions').map(function (r) {
      return { userId: r.user_id, machineId: r.machine_id, grantedBy: r.granted_by || '', grantedAt: r.granted_at };
    }),
    config: dbReadAll('Config').map(function (r) {
      return { key: r.key, value: r.value || '' };
    }),
    bizDays: dbReadAll('BizDays').map(function (r) {
      return {
        bizId: r.biz_id, businessDate: r.business_date, openedAt: r.opened_at, openedBy: r.opened_by || '',
        closedAt: r.closed_at || '', closedBy: r.closed_by || '', autoClosed: r.auto_closed
      };
    }),
    dailyLedger: dbReadAll('DailyLedger').map(function (r) {
      return {
        ledgerId: r.ledger_id, businessDate: r.business_date, turnover: r.turnover, transport: r.transport,
        givenToOwner: r.given_to_owner, takenByOwner: r.taken_by_owner, returnedToHouse: r.returned_to_house,
        updatedBy: r.updated_by || '', updatedAt: r.updated_at, bizId: r.biz_id || '',
        manual432: r.manual_432, manual441: r.manual_441,
        givenToOwnerItems: r.given_to_owner_items || '[]', takenByOwnerItems: r.taken_by_owner_items || '[]',
        manualExpense: r.manual_expense
      };
    }),
    records: _allRecordsForExport().map(function (r) {
      return {
        recordId: r.record_id, machineId: r.machine_id, type: r.type, amount: r.amount,
        prizeId: r.prize_id || '', prizeName: r.prize_name || '', unitAmount: r.unit_amount, count: r.count,
        userId: r.user_id, createdAt: r.created_at, note: r.note || '', voided: r.voided,
        voidedBy: r.voided_by || '', voidedAt: r.voided_at || '', clientToken: r.client_token || '',
        meterStart: r.meter_start, meterEnd: r.meter_end, businessDate: r.business_date
      };
    })
  };
}
