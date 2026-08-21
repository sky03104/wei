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

// ── CSV ─────────────────────────────────────────────────

function _csvCell(v) {
  const s = (v === undefined || v === null) ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

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
 * 匯出區間的「逐日對帳表」（不受畫面 500 筆上限影響）：橫向一欄一天，
 * 直向把當天每一筆出幣依發生順序列出來，底下再接出幣/432/441/入幣/
 * 淨額五列小計——現場原本就是這樣手記在紙本試算表上對帳，匯出照抄
 * 同一種版面，不是系統原本「一筆一列」的流水帳格式。
 * BOM 由前端加，這裡只回純 CSV 內容。
 */
function exportCsv(user, params) {
  const scope = _reportScope(user, params);
  const range = resolveRange(params.preset, params.from, params.to);
  const rows = _reportRows(scope.ids, range, params);
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

  const lines = [];
  lines.push(['圖數'].concat(days.map(_dayKeyToLabel)).map(_csvCell).join(','));

  for (let i = 0; i < maxOuts; i++) {
    const row = [String(i + 1)];
    days.forEach(function (d) {
      const rec = byDay[d].outs[i];
      row.push(rec ? toNumber(rec.amount) : '');
    });
    lines.push(row.map(_csvCell).join(','));
  }

  const outTotal = function (d) { return byDay[d].outs.reduce(function (s, r) { return s + toNumber(r.amount); }, 0); };
  lines.push(['出幣'].concat(days.map(outTotal)).map(_csvCell).join(','));
  lines.push(['432'].concat(days.map(function (d) { return byDay[d].count432; })).map(_csvCell).join(','));
  lines.push(['441'].concat(days.map(function (d) { return byDay[d].count441; })).map(_csvCell).join(','));
  lines.push(['入幣'].concat(days.map(function (d) { return byDay[d].inTotal; })).map(_csvCell).join(','));
  lines.push(['+/-'].concat(days.map(function (d) { return byDay[d].inTotal - outTotal(d); })).map(_csvCell).join(','));

  const label = scope.machineName || '全部機台';
  return {
    filename: '娃娃機對帳表_' + label + '_' + range.from + '_' + range.to + '.csv',
    content: lines.join('\r\n'),
    rowCount: rows.length
  };
}
