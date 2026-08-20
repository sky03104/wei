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
