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
 * day=今天、week=本週（週日起）、month=本月（1 號起）、custom=自己給。
 *
 * 這裡的「今天」用 _currentBusinessDate()，不是行事曆日期——沒人按過
 * 「今日營業開始」的話兩者是同一個值，跟以前行為一樣；有進行中的
 * 營業日，週/月的邊界也該照營業日算，不然凌晨一點行事曆日期跳到隔天，
 * 但營業日還沒結束，「本週」卻已經算進下一週就怪了。
 */
function resolveRange(preset, from, to) {
  const today = _currentBusinessDate();

  // 'history'（歷史分頁）跟 'custom' 的日期解析完全一樣，差別只在
  // getReport/exportCsv 會不會去讀封存分頁、要不要擋已封存的區間，
  // 不屬於這裡的事，所以這裡兩個 preset 共用同一段邏輯。
  if (preset === 'custom' || preset === 'history') {
    if (!_isValidKey(from) || !_isValidKey(to)) throw new Error('日期格式不正確');
    if (from > to) throw new Error('起始日期不能晚於結束日期');
    return { from: from, to: to, preset: preset };
  }
  if (preset === 'week') {
    const dow = _keyToUtcDate(today).getUTCDay(); // 0=週日、1=週一…6=週六
    return { from: _addDays(today, -dow), to: today, preset: 'week' };
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
  // 「歷史」分頁明確願意讀封存分頁，其餘 preset 一律只讀目前這一季，
  // 選到已封存的區間要直接報錯，不要默默算出不完整的數字。
  const includeArchive = params.preset === 'history';
  if (!includeArchive) _assertRangeNotArchived(range);
  const rows = _reportRows(scope.ids, range, params, includeArchive);

  const summary = emptySummary();
  const daily = {};
  _eachDay(range.from, range.to).forEach(function (d) { daily[d] = emptySummary(); });

  const prizeStats = {};

  rows.forEach(function (r) {
    _accumulate(summary, r);
    const key = _recordBusinessDate(r);
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
      net: daily[d].net,
      chipIn: daily[d].chipIn,
      chipOut: daily[d].chipOut,
      chipNet: daily[d].chipNet
    };
  });

  const stats = Object.keys(prizeStats).map(function (k) { return prizeStats[k]; });
  stats.sort(function (a, b) { return b.amount - a.amount; });

  const sorted = rows.slice().sort(_byCreatedAtDesc);

  return {
    range: range,
    scope: { machineId: scope.machineId, machineName: scope.machineName, machineCount: scope.ids.length, category: scope.category },
    summary: summary,
    trend: trend,
    prizeStats: stats,
    records: sorted.slice(0, REPORT_RECORD_LIMIT).map(_publicRecord),
    recordCount: rows.length,
    truncated: rows.length > REPORT_RECORD_LIMIT,
    operators: _operatorOptions(scope.ids)
  };
}

/**
 * 報表要看哪些機台：指定單台就驗權限，沒指定就是這個帳號看得到的全部。
 * params.category 有值（'dice'／'electronic'）時，再從「看得到的全部」
 * 裡篩出該分類——目前給首頁「加總」分頁的「骰台查詢」用，合併查詢/匯出
 * 所有骰台但不含電子機台。
 */
function _reportScope(user, params) {
  if (params.machineId) {
    assertMachineAccess(user, params.machineId);
    const m = dbFind('Machines', 'machine_id', params.machineId);
    return {
      ids: [String(params.machineId)],
      machineId: String(params.machineId),
      machineName: m ? m.name : '',
      category: m ? (m.category || 'dice') : ''
    };
  }

  const category = (params.category === MACHINE_CATEGORY_ELECTRONIC || params.category === MACHINE_CATEGORY_DICE)
    ? params.category : '';
  let ids = visibleMachineIds(user);
  let machineName = '';
  if (category) {
    ids = ids.filter(function (id) { return _machineCategory(id) === category; });
    machineName = category === MACHINE_CATEGORY_ELECTRONIC ? '全部電子機台' : '全部骰台';
  }
  return { ids: ids, machineId: '', machineName: machineName, category: category };
}

function _reportRows(machineIds, range, params, includeArchive) {
  const idSet = {};
  machineIds.forEach(function (id) { idSet[id] = true; });

  const source = includeArchive ? _historyRecords(range) : activeRecords();
  return source.filter(function (r) {
    if (!idSet[String(r.machine_id)]) return false;
    const key = _recordBusinessDate(r);
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

// ── 活動查詢（432/441支數＋開銷）────────────────────────

/**
 * 「活動查詢」：自訂日期範圍內的432/441支數，加上這段期間每天手動填的
 * 開銷加總——給咖哩快速對這段時間辦了幾次活動、花了多少現金開銷用，
 * 不特定看哪一台機台，是這個帳號看得到的全部機台合併算。
 *
 * 432/441支數算法跟 getDashboard() 的今日/本月支數同一套（只認
 * prize_name 剛好是432/441的活動紀錄），只是這裡時間範圍換成自訂區間。
 */
function getActivityQuery(user, params) {
  const range = resolveRange('custom', params.from, params.to);
  _assertRangeNotArchived(range);

  const ids = visibleMachineIds(user);
  const idSet = {};
  ids.forEach(function (id) { idSet[id] = true; });

  let count432 = 0;
  let count441 = 0;
  activeRecords().forEach(function (r) {
    if (r.type !== RECORD_PRIZE) return;
    if (!idSet[String(r.machine_id)]) return;
    const key = _recordBusinessDate(r);
    if (key < range.from || key > range.to) return;
    if (r.prize_name === TRACKED_PRIZE_NAME) count432 += toNumber(r.count);
    else if (r.prize_name === TRACKED_PRIZE_NAME_2) count441 += toNumber(r.count);
  });

  return {
    range: range,
    count432: count432,
    count441: count441,
    manualExpense: _sumManualExpenseInRange(range.from, range.to)
  };
}

/**
 * 逐天取那一天 DailyLedger 最新的一列（同一天可能因為忘記結單又重開之類
 * 的情況存過好幾列，只算最後那列，其餘視為被覆蓋——跟 _dailyLedgerRow()
 * 對「今天」的處理原則一致，只是這裡查的都是已經過去的日子，不用另外
 * 判斷「進行中 session」）加總開銷欄位。
 */
function _sumManualExpenseInRange(from, to) {
  const byDate = {};
  dbReadAll('DailyLedger').forEach(function (row) {
    const d = String(row.business_date);
    if (d < from || d > to) return;
    if (!byDate[d] || toNumber(row._row) > toNumber(byDate[d]._row)) byDate[d] = row;
  });
  return Object.keys(byDate).reduce(function (sum, d) { return sum + toNumber(byDate[d].manual_expense); }, 0);
}

// ── 對帳表匯出（xlsx）───────────────────────────────────

/** 'yyyy-MM-dd' → 「8月9日」，跟現場原本手記的逐日對帳表同一種寫法（不補零）。 */
function _dayKeyToLabel(key) {
  const p = String(key).split('-');
  return Number(p[1]) + '月' + Number(p[2]) + '日';
}

/** _byCreatedAtDesc 的反向版：逐日對帳表要的是當天發生的先後順序（由舊到新）。 */
function _byCreatedAtAsc(a, b) {
  const byTime = String(a.created_at).localeCompare(String(b.created_at));
  if (byTime !== 0) return byTime;
  return (a._row || 0) - (b._row || 0);
}

/**
 * 組出區間的「逐日對帳表」格線資料（不受畫面 500 筆上限影響）：橫向一欄
 * 一天，直向把當天每一筆出幣依發生順序列出來，底下再接出幣/432/441/入幣/
 * 淨額五列小計——現場原本就是這樣手記在紙本試算表上對帳，匯出照抄同一種
 * 版面，不是系統原本「一筆一列」的流水帳格式。純資料，不含任何樣式，
 * 樣式（粗體/底色/紅字）由 exportLedgerXlsx 依這份格線套用。
 */
function _buildLedgerGrid(user, params) {
  const scope = _reportScope(user, params);
  const range = resolveRange(params.preset, params.from, params.to);
  const includeArchive = params.preset === 'history';
  if (!includeArchive) _assertRangeNotArchived(range);
  const rows = _reportRows(scope.ids, range, params, includeArchive);
  const days = _eachDay(range.from, range.to);

  const byDay = {};
  days.forEach(function (d) { byDay[d] = { outs: [], inTotal: 0, count432: 0, count441: 0, amount432: 0, amount441: 0 }; });

  rows.forEach(function (r) {
    const bucket = byDay[_recordBusinessDate(r)];
    if (!bucket) return; // _reportRows 已經照 range 篩過，這裡只是防呆
    if (r.type === RECORD_OUT) {
      bucket.outs.push(r);
    } else if (r.type === RECORD_IN) {
      bucket.inTotal += toNumber(r.amount);
    } else if (r.type === RECORD_PRIZE) {
      if (r.prize_name === TRACKED_PRIZE_NAME) {
        bucket.count432 += toNumber(r.count);
        bucket.amount432 += toNumber(r.amount);
      } else if (r.prize_name === TRACKED_PRIZE_NAME_2) {
        bucket.count441 += toNumber(r.count);
        bucket.amount441 += toNumber(r.amount);
      }
    }
  });

  let maxOuts = 0;
  days.forEach(function (d) {
    byDay[d].outs.sort(_byCreatedAtAsc);
    maxOuts = Math.max(maxOuts, byDay[d].outs.length);
  });

  // 最右邊再加兩欄（標籤＋數字）當整個區間的總計——現場原本手記的紙本
  // 對帳表就是這樣排的，五列小計每一列右邊多兩格看「這幾天總共」多少，
  // 不用自己橫向加總。圖數列（逐筆出幣）不需要總計，兩欄留空。
  const headerRow = ['圖數'].concat(days.map(_dayKeyToLabel)).concat(['', '']);

  const outRows = [];
  for (let i = 0; i < maxOuts; i++) {
    const row = [String(i + 1)];
    days.forEach(function (d) {
      const rec = byDay[d].outs[i];
      row.push(rec ? toNumber(rec.amount) : '');
    });
    row.push('', '');
    outRows.push(row);
  }

  const outTotal = function (d) { return byDay[d].outs.reduce(function (s, r) { return s + toNumber(r.amount); }, 0); };
  const sumDays = function (fn) { return days.reduce(function (s, d) { return s + fn(d); }, 0); };

  const grandOut = sumDays(outTotal);
  const grand432 = sumDays(function (d) { return byDay[d].count432; });
  const grand441 = sumDays(function (d) { return byDay[d].count441; });
  const grandIn = sumDays(function (d) { return byDay[d].inTotal; });
  const grandAmount432 = sumDays(function (d) { return byDay[d].amount432; });
  const grandAmount441 = sumDays(function (d) { return byDay[d].amount441; });
  // +/- ＝ 入幣－出幣－432金額－441金額（432/441 用的是活動實際花費金額，
  // 不是次數）。
  const netOf = function (d) { return byDay[d].inTotal - outTotal(d) - byDay[d].amount432 - byDay[d].amount441; };
  const grandNet = grandIn - grandOut - grandAmount432 - grandAmount441;

  const summaryRows = [
    ['出幣'].concat(days.map(outTotal)).concat(['總出幣', grandOut]),
    ['432'].concat(days.map(function (d) { return byDay[d].count432; })).concat(['432', grand432]),
    ['441'].concat(days.map(function (d) { return byDay[d].count441; })).concat(['441', grand441]),
    ['入幣'].concat(days.map(function (d) { return byDay[d].inTotal; })).concat(['總入幣', grandIn]),
    ['+/-'].concat(days.map(netOf)).concat(['+/-', grandNet])
  ];

  const label = scope.machineName || '全部機台';
  return {
    filenameBase: '娃娃機對帳表_' + label + '_' + range.from + '_' + range.to,
    rowCount: rows.length,
    colCount: headerRow.length,
    headerRow: headerRow,
    outRows: outRows,
    summaryRows: summaryRows
  };
}

/**
 * 把一份 _buildLedgerGrid() 的格線資料寫進一個 sheet 並套樣式：表頭粗體、
 * 出幣逐筆列跟五列小計中間隔一條黑底分隔列、「+/-」列紅字、五列小計
 * 最右邊的標籤欄（總出幣/432/441/總入幣/+/-）粉紅底——排版照現場原本
 * 手記在紙本試算表上的樣子。單一機台匯出跟「骰台查詢」的每一個分頁
 * 都呼叫這支，確保排版永遠一致。
 */
function _writeLedgerSheet(sheet, grid) {
  const numCols = grid.colCount;
  const dividerRow = new Array(numCols).fill('');
  const allRows = [grid.headerRow].concat(grid.outRows, [dividerRow], grid.summaryRows);
  const numRows = allRows.length;
  const dividerRowIndex = 1 + grid.outRows.length + 1;
  const summaryStartRow = dividerRowIndex + 1;
  const SUMMARY_ROW_COUNT = 5; // 出幣/432/441/入幣/+/- 固定五列

  // 表頭列（圖數＋「8月21日」這種日期標籤）跟兩個標籤欄（出幣/432/441/
  // 入幣/+/-、總出幣/432/441/總入幣/+/-）看起來像日期或純數字，Sheets
  // 預設會在寫入當下自動幫忙轉型，「8月21日」會變成日期序號（例如
  // 46255）、「432」會變成數字，顯示就跑掉了。一定要在 setValues() 之前
  // 先把儲存格格式鎖成純文字，Sheets 才不會自動轉型——這個專案已經因為
  // 同一種自動轉型的坑踩過好幾次（Db.gs 的 _fixTextColumnFormatting
  // 就是在修同一類問題，只是那邊是事後補救既有資料，這裡是寫入前預防）。
  sheet.getRange(1, 1, 1, numCols).setNumberFormat('@');
  sheet.getRange(summaryStartRow, 1, SUMMARY_ROW_COUNT, 1).setNumberFormat('@');
  sheet.getRange(summaryStartRow, numCols - 1, SUMMARY_ROW_COUNT, 1).setNumberFormat('@');

  sheet.getRange(1, 1, numRows, numCols).setValues(allRows);
  sheet.getRange(1, 1, 1, numCols).setFontWeight('bold');
  sheet.getRange(1, 1, numRows, numCols).setHorizontalAlignment('center');
  sheet.setFrozenRows(1);

  sheet.getRange(dividerRowIndex, 1, 1, numCols).setBackground('#000000');

  // 五列小計最右邊的標籤欄粉紅底是連續的（同一欄、連續五列），一次
  // setBackground() 就能整批套上，不用一列一列各呼叫一次——「骰台查詢」
  // 一次要開好幾個機台的分頁，每台都省下幾次 API 呼叫，加總起來才有感。
  sheet.getRange(summaryStartRow, numCols - 1, SUMMARY_ROW_COUNT, 1).setBackground('#f8cbcb');

  grid.summaryRows.forEach(function (row, i) {
    if (row[0] === '+/-') sheet.getRange(summaryStartRow + i, 1, 1, numCols).setFontColor('#c00000');
  });

  // 不用 autoResizeColumns：它對中文字的寬度估得偏窄，「總出幣」「總入幣」
  // 「8月21日」這種欄位常常被切字。改成每一欄都給同一個固定的保底寬度，
  // 也比較貼近參考照片那種欄寬整齊劃一的紙本對帳表版面。用
  // setColumnWidths() 一次設完全部欄寬，不要一欄一欄各呼叫一次
  // setColumnWidth()——道理跟上面的粉紅底一樣，都是省 API 呼叫次數。
  sheet.setColumnWidths(1, numCols, 90);
}

/**
 * 機台名稱是自由輸入的文字（adminSaveMachine 只擋長度，沒擋字元），但
 * Google Sheets 的分頁名稱不能包含 [ ] * ? / \ : 這幾個字元，插入或改名
 * 遇到就直接丟錯——本機測試環境的假試算表沒做這個限制，所以這個坑在
 * 本機測試不會現形，只有在真的 GAS 上才會炸開。轉成 .xlsx 之後 Excel
 * 分頁名稱上限是 31 字，所以先砍到 28 字，留空間給下面加的「(2)」這類
 * 撞名後綴，不然砍在後綴中間又變成另一種撞名。
 */
function _sanitizeSheetName(name) {
  const cleaned = String(name || '機台').replace(/[[\]*?/\\:]/g, '-').trim();
  return (cleaned || '機台').substring(0, 28);
}

/** 分頁名稱不能重複（Sheets 會直接報錯拒絕），機台改過名也可能撞名。 */
function _uniqueSheetName(used, name) {
  const base = _sanitizeSheetName(name);
  let candidate = base;
  let n = 2;
  while (used[candidate]) {
    candidate = base + '(' + n + ')';
    n++;
  }
  used[candidate] = true;
  return candidate;
}

/**
 * 「骰台查詢」「電子查詢」這種不指定單台、改指定分類的查詢，匯出時
 * 每一台機台各自開一個分頁，而不是把所有機台的出幣合併成同一張表——
 * 現場對帳是一台一台分開核對，合併在一起反而要自己拆開來看。分頁內容
 * 直接照單一機台匯出的邏輯算（_buildLedgerGrid 帶 machineId），保證跟
 * 「單一機台匯出」長得一模一樣，不是另外寫一套。
 */
function exportLedgerXlsx(user, params) {
  const scope = _reportScope(user, params);
  const isCategoryScope = !params.machineId && scope.category;

  if (!isCategoryScope) {
    const grid = _buildLedgerGrid(user, params);
    const result = _exportLedgerWorkbook(grid.filenameBase, function (ss) {
      const sheet = ss.getSheets()[0] || ss.insertSheet('對帳表');
      _writeLedgerSheet(sheet, grid);
    });
    result.rowCount = grid.rowCount;
    return result;
  }

  if (!scope.ids.length) {
    const categoryLabel = scope.category === MACHINE_CATEGORY_ELECTRONIC ? '電子機台' : '骰台';
    throw new Error('目前沒有看得到的' + categoryLabel + '，無法匯出');
  }

  const machines = dbReadAll('Machines')
    .filter(function (m) { return scope.ids.indexOf(String(m.machine_id)) >= 0; })
    .sort(function (a, b) {
      if (toNumber(a.sort_order) !== toNumber(b.sort_order)) return toNumber(a.sort_order) - toNumber(b.sort_order);
      return String(a.name).localeCompare(String(b.name));
    });

  const range = resolveRange(params.preset, params.from, params.to);
  const filenameBase = '娃娃機對帳表_' + scope.machineName + '_' + range.from + '_' + range.to;

  let totalRowCount = 0;
  const result = _exportLedgerWorkbook(filenameBase, function (ss) {
    const usedNames = {};
    machines.forEach(function (m, i) {
      const grid = _buildLedgerGrid(user, Object.assign({}, params, { machineId: String(m.machine_id) }));
      totalRowCount += grid.rowCount;
      const sheetName = _uniqueSheetName(usedNames, m.name);
      const sheet = i === 0 ? (ss.getSheets()[0] || ss.insertSheet(sheetName)) : ss.insertSheet(sheetName);
      if (i === 0) sheet.setName(sheetName);
      _writeLedgerSheet(sheet, grid);
    });
  });
  result.rowCount = totalRowCount;
  return result;
}

/**
 * 「骰台查詢」（全部骰台／全部電子機台）頁的「📷 匯出截圖」用——
 * 跟 exportLedgerXlsx 分頁內容共用同一份 _buildLedgerGrid() 格線資料，
 * 差別是不用建立暫時的 Google 試算表再轉存 xlsx（那一趟很慢），直接把
 * 每台機台的格線資料整批回傳給前端，讓前端照 exportLedgerImage() 那套
 * canvas 手繪畫法自己畫成一張一張截圖，不用多裝套件、離線也能用。
 * 只支援「分類查詢」（不指定單一機台）——單一機台頁本來就只有一台，
 * 直接用「📷 匯出明細截圖」那顆鈕就好，不需要這支。
 */
function exportLedgerGrids(user, params) {
  const scope = _reportScope(user, params);
  if (params.machineId || !scope.category) throw new Error('這個功能只支援「全部骰台」／「全部電子機台」這種分類查詢');
  if (!scope.ids.length) {
    const categoryLabel = scope.category === MACHINE_CATEGORY_ELECTRONIC ? '電子機台' : '骰台';
    throw new Error('目前沒有看得到的' + categoryLabel + '，無法匯出');
  }

  const machines = dbReadAll('Machines')
    .filter(function (m) { return scope.ids.indexOf(String(m.machine_id)) >= 0; })
    .sort(function (a, b) {
      if (toNumber(a.sort_order) !== toNumber(b.sort_order)) return toNumber(a.sort_order) - toNumber(b.sort_order);
      return String(a.name).localeCompare(String(b.name));
    });

  const range = resolveRange(params.preset, params.from, params.to);

  const grids = machines.map(function (m) {
    const grid = _buildLedgerGrid(user, Object.assign({}, params, { machineId: String(m.machine_id) }));
    return {
      machineId: String(m.machine_id),
      machineName: m.name,
      headerRow: grid.headerRow,
      outRows: grid.outRows,
      summaryRows: grid.summaryRows,
      colCount: grid.colCount,
      rowCount: grid.rowCount
    };
  });

  return { range: range, machines: grids };
}

/**
 * 建一份暫時的 Google 試算表、交給 fillFn 把內容跟分頁寫好，
 * 再用 UrlFetchApp 打 Google 內建的匯出網址轉成 .xlsx bytes 回傳，
 * 最後把暫時試算表丟進垃圾桶（不留在雲端硬碟裡）。
 */
function _exportLedgerWorkbook(filenameBase, fillFn) {
  const ss = SpreadsheetApp.create(filenameBase);
  const id = ss.getId();
  try {
    fillFn(ss);

    // 一定要在打匯出網址之前 flush：剛套用的樣式（底色／字色／欄寬）是
    // 透過 Sheets service 排入佇列的操作，沒有 flush 過就直接打匯出網址，
    // Google 後端有時候還沒把這些操作真的寫進試算表，匯出抓到的會是
    // 半套版本——這是已知的 GAS 陷阱。
    SpreadsheetApp.flush();

    const url = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx';
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    const base64 = Utilities.base64Encode(resp.getBlob().getBytes());

    return { filename: filenameBase + '.xlsx', base64: base64 };
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}
