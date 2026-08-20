/**
 * Db.gs — 試算表存取層
 *
 * 所有分頁的欄位定義、建表、讀寫、鎖都集中在這裡。
 * 上層（Auth / Service / Reports）不直接碰 SpreadsheetApp。
 */

/** 每個分頁的欄位順序。setup() 會照這個建表頭。 */
const SCHEMA = {
  Users: ['user_id', 'username', 'display_name', 'password_hash', 'salt', 'role', 'status', 'created_at', 'last_login_at'],
  Machines: ['machine_id', 'name', 'location', 'status', 'color', 'sort_order', 'note', 'created_at'],
  Records: ['record_id', 'machine_id', 'type', 'amount', 'prize_id', 'prize_name', 'unit_amount', 'count', 'user_id', 'created_at', 'note', 'voided', 'voided_by', 'voided_at', 'client_token', 'meter_start', 'meter_end', 'business_date'],
  Prizes: ['prize_id', 'machine_id', 'name', 'amount', 'sort_order', 'active'],
  QuickAmounts: ['qa_id', 'machine_id', 'type', 'amount', 'label', 'sort_order'],
  MeterRates: ['rate_id', 'machine_id', 'rate'],
  Permissions: ['user_id', 'machine_id', 'granted_by', 'granted_at'],
  Sessions: ['token', 'user_id', 'created_at', 'expires_at', 'remember'],
  Config: ['key', 'value'],
  BizDays: ['biz_id', 'business_date', 'opened_at', 'opened_by', 'closed_at', 'closed_by', 'auto_closed']
};

/**
 * 這些欄位存 ISO 時間字串或 yyyy-MM-dd 日期字串，欄位格式必須設成純文字，
 * 否則 Sheets 會自作主張轉成日期／時間型別（改天再讀出來就變成 Date 物件，
 * 不是原本存的字串，字串排序、比對全部跟著壞掉——這正是入幣改版那次
 * 欄位錯位之外，另一種「忘記鎖格式」會踩到的坑，這裡把 business_date
 * 也一併鎖住，不要重蹈覆轍）。
 */
const TEXT_COLUMNS = ['created_at', 'last_login_at', 'voided_at', 'granted_at', 'expires_at', 'business_date', 'opened_at', 'closed_at'];

/**
 * 表頭給人看的中文標籤。
 *
 * 只影響試算表第一列顯示的文字，跟 SCHEMA 的英文鍵值是兩件事——
 * 程式碼裡到處都是 r.user_id、dbFind('Users', 'username', ...) 這種寫法，
 * 內部欄位名稱維持英文不變，才不用把整個後端的存取邏輯都改一輪。
 *
 * 每個分頁的陣列長度與順序必須跟 SCHEMA[name] 完全對應，
 * applyHeaderLabels() 會在對不上時直接丟錯，避免兩份手動維護的陣列悄悄不同步。
 */
const HEADER_LABELS = {
  Users: ['帳號編號', '帳號', '顯示名稱', '密碼雜湊', '密碼鹽', '角色', '狀態', '建立時間', '最後登入時間'],
  Machines: ['機台編號', '名稱', '位置', '狀態', '顏色', '排序', '備註', '建立時間'],
  Records: ['紀錄編號', '機台編號', '類型', '金額', '獎型編號', '獎型名稱', '單價', '次數',
    '操作人編號', '建立時間', '備註', '已作廢', '作廢人', '作廢時間', '防重複權杖', '上班表', '下班表', '營業日期'],
  Prizes: ['獎型編號', '機台編號', '名稱', '金額', '排序', '啟用中'],
  QuickAmounts: ['快捷編號', '機台編號', '類型', '金額', '顯示文字', '排序'],
  MeterRates: ['設定編號', '機台編號', '每格金額'],
  Permissions: ['帳號編號', '機台編號', '授權人', '授權時間'],
  Sessions: ['登入權杖', '帳號編號', '建立時間', '到期時間', '記住我'],
  Config: ['設定鍵', '設定值'],
  BizDays: ['營業日編號', '營業日期', '開始時間', '開始人', '結束時間', '結束人', '自動結單']
};

/**
 * 分頁在試算表下方看到的中文頁籤名稱。
 *
 * 跟 SCHEMA 的鍵值（英文，程式碼內部到處用來當 dbReadAll('Users') 這種參數）
 * 是兩件事——內部一律用英文鍵值查找，只有實際在試算表建立/尋找分頁時
 * 才轉換成這裡的中文頁籤名稱。
 */
const SHEET_TAB_NAMES = {
  Users: '帳號',
  Machines: '機台',
  Records: '紀錄',
  Prizes: '獎型',
  QuickAmounts: '快捷金額',
  MeterRates: '入幣費率',
  Permissions: '台主授權',
  Sessions: '登入狀態',
  Config: '系統設定',
  BizDays: '營業日'
};

/** 單次執行內的分頁快取，避免同一次請求重複讀同一張表。 */
let _sheetCache = {};

function _clearSheetCache() {
  _sheetCache = {};
}

/**
 * 取得試算表。優先用 Script Property SPREADSHEET_ID，
 * 沒設就退回綁定的試算表（方便從試算表選單直接跑 setup）。
 */
function _spreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActive();
  if (active) return active;
  throw new Error('找不到試算表：請在「專案設定 → 指令碼屬性」新增 SPREADSHEET_ID');
}

/**
 * 取得分頁，不存在就依 SCHEMA 建立（含表頭與欄位格式）。
 *
 * 頁籤一律用 SHEET_TAB_NAMES 裡的中文名稱。舊版程式碼是用英文鍵值（例如 'Users'）
 * 直接當頁籤名稱建立的，所以找不到中文頁籤時，會退回去找同名的英文頁籤——
 * 找到的話直接把它改名成中文（setName 不會動到任何資料），
 * 而不是誤判成「還沒建立」而新開一張空的，導致舊資料變成孤兒分頁。
 * 兩邊都找不到才真的是全新分頁。
 */
function _sheet(name) {
  const cols = SCHEMA[name];
  if (!cols) throw new Error('未知的分頁：' + name);
  const tabName = SHEET_TAB_NAMES[name] || name;

  const ss = _spreadsheet();
  let sh = ss.getSheetByName(tabName);
  let isNew = false;
  if (!sh) {
    const legacy = ss.getSheetByName(name);
    if (legacy) {
      legacy.setName(tabName);
      sh = legacy;
    } else {
      sh = ss.insertSheet(tabName);
      isNew = true;
    }
  }
  if (isNew) {
    _writeHeaderRow(sh, name, cols);
    cols.forEach(function (col, i) {
      if (TEXT_COLUMNS.indexOf(col) >= 0) {
        sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      }
    });
  }
  return sh;
}

function _writeHeaderRow(sh, name, cols) {
  const labels = HEADER_LABELS[name];
  if (!labels || labels.length !== cols.length) {
    throw new Error('HEADER_LABELS[' + name + '] 跟 SCHEMA 對不起來，兩邊長度必須一致');
  }
  sh.getRange(1, 1, 1, labels.length).setValues([labels]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/**
 * 把某分頁的表頭（第一列）重新覆寫成中文標籤。
 *
 * 跟 _sheet() 建立新分頁時寫表頭不同，這個是無條件執行的——
 * 用來修正「用改版前的程式碼建立、表頭還是英文」的既有試算表。
 * 只動第一列，不會碰到任何資料列。setup() 會對每個分頁都呼叫一次，
 * 所以只要重新執行一次 setup，既有試算表的表頭就會自動換成中文。
 */
function applyHeaderLabels(name) {
  const cols = SCHEMA[name];
  if (!cols) throw new Error('未知的分頁：' + name);
  const sh = _sheet(name);
  _writeHeaderRow(sh, name, cols);
}

/**
 * 修正入幣改成碼表登錄那次改版留下的欄位錯位。
 *
 * 當時把 meter_start／meter_end 插進 Records 欄位「中間」（count 之後、
 * user_id 之前），而不是加在最後面。試算表的資料是照實體欄位位置存放的，
 * 插在中間會讓改版之前就存在的舊紀錄，從那一欄開始全部被讀到錯的欄位名稱——
 * 操作人被讀成碼表讀數、建立時間被讀成備註，一路錯位到最後一欄。
 * 現在已經把 SCHEMA 改成把這兩欄加在最後面（只增不插），舊紀錄的實體欄位
 * 本來就跟新版排法對得起來，不用動；但改版當下、修正之前那段時間寫入的
 * 紀錄（欄位還是插在中間那種舊排法），需要把它們的欄位實際搬回正確位置。
 *
 * 判斷方式：user_id 一律是 newId('usr') 產生、'usr_' 開頭。
 *   - 第 9 欄本身就是 usr_ 開頭 → 欄位本來就對，不用動。
 *   - 第 9 欄不是、但第 11 欄是 usr_ 開頭 → 改版當下寫入的錯位格式，
 *     把第 9~17 欄搬回：9~15 欄＝原本的 11~17 欄，16~17 欄（碼表讀數）
 *     ＝原本的 9~10 欄。
 *   - 兩邊都不是（整列空白、或無法辨識）→ 保守不動。
 *
 * 天生冪等：搬正確之後再跑一次，這些列的第 9 欄就會是 usr_ 開頭，
 * 直接判定不用動，重複執行不會搬第二次。
 */
function _migrateRecordsMeterColumns() {
  const width = SCHEMA.Records.length;
  const sh = _sheet('Records');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  const range = sh.getRange(2, 1, lastRow - 1, width);
  const values = range.getValues();
  let fixed = 0;

  function looksLikeUserId(v) { return typeof v === 'string' && v.indexOf('usr_') === 0; }

  const out = values.map(function (row) {
    if (looksLikeUserId(row[8])) return row; // 第 9 欄已經是 user_id，格式正確
    if (!looksLikeUserId(row[10])) return row; // 兩邊都不是，無法辨識，不動

    fixed++;
    return [
      row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7],
      row[10], row[11], row[12], row[13], row[14], row[15], row[16],
      row[8], row[9]
    ];
  });

  if (fixed > 0) {
    range.setValues(out);
    delete _sheetCache.Records;
  }
  return fixed;
}

/**
 * 讀出整張分頁，回傳物件陣列。每個物件多一個 _row（實際列號，從 2 起算）。
 * 同一次執行內只會真的讀一次。
 */
function dbReadAll(name) {
  if (_sheetCache[name]) return _sheetCache[name];

  const sh = _sheet(name);
  const lastRow = sh.getLastRow();
  const cols = SCHEMA[name];
  if (lastRow < 2) {
    _sheetCache[name] = [];
    return [];
  }

  const values = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    // 整列皆空的列直接跳過（人工刪資料常留下空列）
    let empty = true;
    for (let c = 0; c < raw.length; c++) {
      if (raw[c] !== '' && raw[c] !== null) { empty = false; break; }
    }
    if (empty) continue;

    const obj = { _row: i + 2 };
    for (let c = 0; c < cols.length; c++) obj[cols[c]] = raw[c];
    rows.push(obj);
  }
  _sheetCache[name] = rows;
  return rows;
}

/** 依欄位值找第一筆（字串比較，避免 id 被當數字）。 */
function dbFind(name, field, value) {
  const rows = dbReadAll(name);
  const target = String(value);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][field]) === target) return rows[i];
  }
  return null;
}

/** 依欄位值找全部。 */
function dbFilter(name, field, value) {
  const target = String(value);
  return dbReadAll(name).filter(function (r) { return String(r[field]) === target; });
}

/** 物件轉成照 SCHEMA 欄位順序排好的陣列。 */
function _toRow(name, obj) {
  return SCHEMA[name].map(function (col) {
    const v = obj[col];
    return (v === undefined || v === null) ? '' : v;
  });
}

/** 新增一列，回傳寫入的物件。 */
function dbInsert(name, obj) {
  return dbInsertMany(name, [obj])[0];
}

/** 一次新增多列（單次 setValues，比逐列 appendRow 快很多也不會撞列）。 */
function dbInsertMany(name, objs) {
  if (!objs.length) return [];
  const sh = _sheet(name);
  const startRow = sh.getLastRow() + 1;
  const rows = objs.map(function (o) { return _toRow(name, o); });
  sh.getRange(startRow, 1, rows.length, SCHEMA[name].length).setValues(rows);
  delete _sheetCache[name];
  return objs;
}

/** 局部更新某一列（只寫有給的欄位）。 */
function dbUpdate(name, rowIndex, patch) {
  const sh = _sheet(name);
  const cols = SCHEMA[name];
  Object.keys(patch).forEach(function (key) {
    const c = cols.indexOf(key);
    if (c < 0) return;
    const v = patch[key];
    sh.getRange(rowIndex, c + 1).setValue((v === undefined || v === null) ? '' : v);
  });
  delete _sheetCache[name];
}

/** 刪除指定列（由大到小刪，避免列號位移）。 */
function dbDeleteRows(name, rowIndexes) {
  if (!rowIndexes.length) return;
  const sh = _sheet(name);
  rowIndexes.slice().sort(function (a, b) { return b - a; }).forEach(function (r) {
    sh.deleteRow(r);
  });
  delete _sheetCache[name];
}

/** 包住寫入動作，避免兩人同時記帳撞在一起。 */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('系統忙碌中，請稍後再試');
  try {
    _clearSheetCache();
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ── 小工具 ──────────────────────────────────────────────

function newId(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
}

/** 一律用 ISO 字串存時間，跨時區不會有歧義。 */
function nowIso() {
  return new Date().toISOString();
}

function toBool(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.toUpperCase() === 'TRUE';
  return v === 1;
}

function toNumber(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** 讀 Config 分頁的設定值。 */
function configGet(key, fallback) {
  const row = dbFind('Config', 'key', key);
  return row ? row.value : fallback;
}

function configSet(key, value) {
  const row = dbFind('Config', 'key', key);
  if (row) dbUpdate('Config', row._row, { value: value });
  else dbInsert('Config', { key: key, value: value });
}
