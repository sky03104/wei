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

/** 報表要看哪些機台：指定單台就驗權限，沒指定就是這個帳號看得到的全部。 */
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
  return { ids: visibleMachineIds(user), machineId: '', machineName: '', category: '' };
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
  days.forEach(function (d) { byDay[d] = { outs: [], inTotal: 0, count432: 0, count441: 0 }; });

  rows.forEach(function (r) {
    const bucket = byDay[_recordBusinessDate(r)];
    if (!bucket) return; // _reportRows 已經照 range 篩過，這裡只是防呆
    if (r.type === RECORD_OUT) {
      bucket.outs.push(r);
    } else if (r.type === RECORD_IN) {
      bucket.inTotal += toNumber(r.amount);
    } else if (r.type === RECORD_PRIZE) {
      if (r.prize_name === TRACKED_PRIZE_NAME) bucket.count432 += toNumber(r.count);
      else if (r.prize_name === TRACKED_PRIZE_NAME_2) bucket.count441 += toNumber(r.count);
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
  const grandNet = grandIn - grandOut;

  const summaryRows = [
    ['出幣'].concat(days.map(outTotal)).concat(['總出幣', grandOut]),
    ['432'].concat(days.map(function (d) { return byDay[d].count432; })).concat(['432', grand432]),
    ['441'].concat(days.map(function (d) { return byDay[d].count441; })).concat(['441', grand441]),
    ['入幣'].concat(days.map(function (d) { return byDay[d].inTotal; })).concat(['總入幣', grandIn]),
    ['+/-'].concat(days.map(function (d) { return byDay[d].inTotal - outTotal(d); })).concat(['+/-', grandNet])
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
 * 把 _buildLedgerGrid() 的格線資料做成一份有格式的 .xlsx：表頭粗體、
 * 出幣逐筆列跟五列小計中間隔一條黑底分隔列、「+/-」列紅字、五列小計
 * 最右邊的標籤欄（總出幣/432/441/總入幣/+/-）粉紅底——排版照現場原本
 * 手記在紙本試算表上的樣子。做法是先建一份暫時的 Google 試算表套版，
 * 再用 UrlFetchApp 打 Google 內建的匯出網址轉成 .xlsx bytes，最後把暫時
 * 試算表丟進垃圾桶（不留在雲端硬碟裡）。
 */
function exportLedgerXlsx(user, params) {
  const grid = _buildLedgerGrid(user, params);
  const numCols = grid.colCount;
  const dividerRow = new Array(numCols).fill('');
  const allRows = [grid.headerRow].concat(grid.outRows, [dividerRow], grid.summaryRows);
  const numRows = allRows.length;
  const dividerRowIndex = 1 + grid.outRows.length + 1;
  const summaryStartRow = dividerRowIndex + 1;
  const SUMMARY_ROW_COUNT = 5; // 出幣/432/441/入幣/+/- 固定五列

  const ss = SpreadsheetApp.create(grid.filenameBase);
  const id = ss.getId();
  try {
    const sheet = ss.getSheets()[0] || ss.insertSheet('對帳表');

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
    sheet.setFrozenRows(1);

    sheet.getRange(dividerRowIndex, 1, 1, numCols).setBackground('#000000');

    grid.summaryRows.forEach(function (row, i) {
      const sheetRow = summaryStartRow + i;
      if (row[0] === '+/-') sheet.getRange(sheetRow, 1, 1, numCols).setFontColor('#c00000');
      sheet.getRange(sheetRow, numCols - 1, 1, 1).setBackground('#f8cbcb');
    });

    sheet.autoResizeColumns(1, numCols);
    // autoResizeColumns 對中文字的寬度估得偏窄，容易把「總出幣」「總入幣」
    // 這種三個字的標籤切掉，兩個標籤欄額外給一個保底寬度蓋過去。
    sheet.setColumnWidth(1, 90);
    sheet.setColumnWidth(numCols - 1, 90);

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

    return {
      filename: grid.filenameBase + '.xlsx',
      base64: base64,
      rowCount: grid.rowCount
    };
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}
