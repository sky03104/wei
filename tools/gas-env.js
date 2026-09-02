/**
 * tools/gas-env.js — Apps Script 執行環境的記憶體模擬器
 *
 * Apps Script 說到底就是 JS，缺的只是 Google 那些全域物件。
 * 這裡用記憶體版本把它們補起來（試算表、指令碼屬性、快取、雜湊、時區…），
 * 讓 apps-script/*.gs 能直接在 Node 上跑。
 *
 * 兩個地方用到它：
 *   tools/local-test.js  跑後端自我測試
 *   tools/dev-server.js  當本機後端，讓前端能真的連上去測
 *
 * 這不能取代在 GAS 上實跑（配額、權限、真實試算表行為仍需驗證），
 * 但能在幾秒內抓出絕大多數迴歸。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// ── 試算表 ──────────────────────────────────────────────

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        row.push(this.sheet._get(this.row + r, this.col + c));
      }
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    // 真正的 Google Sheets 對 setValues() 的欄數/列數會嚴格驗證，對不上就直接丟錯——
    // 這裡故意複製這個行為，不是放寬。之前這裡沒驗證，_migrateRecordsMeterColumns()
    // 重組陣列時漏掉最後一欄的 bug 在本機測試完全沒現形，直到在真正的 GAS 上才炸開。
    if (values.length !== this.numRows) {
      throw new Error('The number of rows in the data does not match the number of rows in the range. The data has ' + values.length + ' but the range has ' + this.numRows + '.');
    }
    for (let r = 0; r < values.length; r++) {
      if (values[r].length !== this.numCols) {
        throw new Error('The number of columns in the data does not match the number of columns in the range. The data has ' + values[r].length + ' but the range has ' + this.numCols + '.');
      }
      for (let c = 0; c < values[r].length; c++) {
        this.sheet._set(this.row + r, this.col + c, values[r][c]);
      }
    }
    return this;
  }
  setValue(v) {
    this.sheet._set(this.row, this.col, v);
    return this;
  }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setHorizontalAlignment() { return this; }
}

class FakeSheet {
  constructor(name, ss) {
    this.name = name;
    this.ss = ss;
    this.data = []; // data[row-1][col-1]
  }
  getName() { return this.name; }
  setName(newName) {
    if (this.ss) {
      this.ss.sheets.delete(this.name);
      this.ss.sheets.set(newName, this);
    }
    this.name = newName;
    return this;
  }
  _get(row, col) {
    const r = this.data[row - 1];
    if (!r) return '';
    const v = r[col - 1];
    return v === undefined ? '' : v;
  }
  _set(row, col, value) {
    while (this.data.length < row) this.data.push([]);
    const r = this.data[row - 1];
    while (r.length < col) r.push('');
    r[col - 1] = value === undefined || value === null ? '' : value;
  }
  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
  }
  getLastRow() {
    for (let r = this.data.length; r >= 1; r--) {
      const row = this.data[r - 1] || [];
      if (row.some((v) => v !== '' && v !== undefined && v !== null)) return r;
    }
    return 0;
  }
  getMaxRows() { return Math.max(this.data.length, 1000); }
  setFrozenRows() { return this; }
  setFrozenColumns() { return this; }
  autoResizeColumns() { return this; }
  setColumnWidth() { return this; }
  setColumnWidths() { return this; }
  deleteRow(rowIndex) { this.data.splice(rowIndex - 1, 1); }
}

class FakeSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = new Map();
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  getSheets() { return Array.from(this.sheets.values()); }
  insertSheet(name) {
    const sh = new FakeSheet(name, this);
    this.sheets.set(name, sh);
    return sh;
  }
}

const spreadsheets = new Map();
let ssSeq = 0;

const SpreadsheetApp = {
  create(name) {
    const id = 'ss_' + ++ssSeq;
    const ss = new FakeSpreadsheet(id, name);
    spreadsheets.set(id, ss);
    return ss;
  },
  openById(id) {
    const ss = spreadsheets.get(id);
    if (!ss) throw new Error('找不到試算表 ' + id);
    return ss;
  },
  getActive() { return null; },
  flush() {}
};

const DriveApp = {
  getFileById(id) {
    return { setTrashed() { spreadsheets.delete(id); } };
  }
};

// UrlFetchApp.fetch() 在本機當然打不到真的 docs.google.com 匯出網址，
// 這裡只回一段假的 bytes，讓程式流程（base64 編碼、回傳 filename/base64/rowCount）
// 能被跑到跟驗證，實際 xlsx 的視覺格式仍然只能在真的 GAS 上部署後打開來看。
const UrlFetchApp = {
  fetch(url, options) {
    return {
      getResponseCode() { return 200; },
      getBlob() {
        return { getBytes() { return Buffer.from('fake-xlsx-bytes:' + url); } };
      }
    };
  }
};

// ── 屬性與快取 ──────────────────────────────────────────

const scriptProps = new Map();
const PropertiesService = {
  getScriptProperties() {
    return {
      getProperty: (k) => (scriptProps.has(k) ? scriptProps.get(k) : null),
      setProperty: (k, v) => { scriptProps.set(k, String(v)); },
      deleteProperty: (k) => { scriptProps.delete(k); }
    };
  }
};

const cacheStore = new Map();
const CacheService = {
  getScriptCache() {
    return {
      get(key) {
        const hit = cacheStore.get(key);
        if (!hit) return null;
        if (hit.expires < Date.now()) { cacheStore.delete(key); return null; }
        return hit.value;
      },
      put(key, value, seconds) {
        cacheStore.set(key, { value: String(value), expires: Date.now() + (seconds || 600) * 1000 });
      },
      remove(key) { cacheStore.delete(key); }
    };
  }
};

// ── Utilities ───────────────────────────────────────────

function formatDate(date, tz, pattern) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = {};
  dtf.formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return pattern
    .replace('yyyy', parts.year)
    .replace('MM', parts.month)
    .replace('dd', parts.day)
    .replace('HH', hour)
    .replace('mm', parts.minute)
    .replace('ss', parts.second);
}

const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest(_algo, str) {
    const buf = crypto.createHash('sha256').update(String(str), 'utf8').digest();
    // GAS 回傳有號位元組，這裡照做，才能測到同樣的轉換邏輯
    return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
  },
  getUuid() { return crypto.randomUUID(); },
  formatDate,
  base64Encode(bytes) {
    return Buffer.from(bytes).toString('base64');
  }
};

const LockService = {
  getScriptLock() {
    return { tryLock: () => true, releaseLock: () => {} };
  }
};

const Session = { getScriptTimeZone: () => 'Asia/Taipei' };

// ── 觸發器 ──────────────────────────────────────────────
//
// 只模擬 archiveOldRecords() 那種「裝一個每月執行一次」的時間觸發器需要的
// 最小介面：newTrigger().timeBased().onMonthDay().atHour().create()，
// 跟 getProjectTriggers() 讓程式碼可以判斷「已經裝過了，不要重複裝」。
// 不會真的排程執行——本機測試只驗證「有沒有裝上去」，不驗證它真的會
// 在某個時間點觸發（那件事只有部署到真正的 GAS 上才驗得到）。

const _triggers = [];
let _triggerSeq = 0;

const ScriptApp = {
  getOAuthToken() { return 'fake-oauth-token'; },
  getProjectTriggers() {
    return _triggers.map((t) => ({
      getHandlerFunction: () => t.handlerFunction,
      getUniqueId: () => t.id
    }));
  },
  newTrigger(handlerFunction) {
    const spec = { handlerFunction };
    const builder = {
      timeBased() { return builder; },
      onMonthDay(d) { spec.monthDay = d; return builder; },
      atHour(h) { spec.hour = h; return builder; },
      create() {
        const id = 'trig_' + (++_triggerSeq);
        _triggers.push(Object.assign({ id: id }, spec));
        return { getUniqueId: () => id };
      }
    };
    return builder;
  },
  deleteTrigger(trigger) {
    const id = trigger.getUniqueId();
    const idx = _triggers.findIndex((t) => t.id === id);
    if (idx >= 0) _triggers.splice(idx, 1);
  }
};

const ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput(text) {
    return { text, setMimeType() { return this; }, getContent() { return this.text; } };
  }
};

const logLines = [];
const Logger = { log: (msg) => logLines.push(String(msg)) };

// ── 組裝 ────────────────────────────────────────────────

const GAS_FILE_ORDER = ['Db.gs', 'Auth.gs', 'Service.gs', 'SupabasePush.gs', 'SupabaseWebhook.gs', 'Reports.gs', 'Archive.gs', 'Code.gs', 'Test.gs'];

/**
 * 載入 apps-script/*.gs 到一個模擬環境裡。
 * 回傳 { run(expr), logLines }，run 可以直接執行 GAS 裡的任何函式。
 */
function createGasSandbox(options) {
  const opts = options || {};
  const dir = path.join(__dirname, '..', 'apps-script');

  let source;
  if (opts.bundlePath) {
    // 讀合併後的單一檔案（apps-script/dist/Code.gs），
    // 用來驗證「貼給使用者的那份檔案」本身真的能動，不是只驗證分開的原始檔。
    source = fs.readFileSync(opts.bundlePath, 'utf8');
  } else {
    const files = opts.files || GAS_FILE_ORDER;
    source = files
      .map((f) => '/* ==== ' + f + ' ==== */\n' + fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n\n');
  }

  const sandbox = {
    SpreadsheetApp, DriveApp, UrlFetchApp, PropertiesService, CacheService,
    Utilities, LockService, Session, ScriptApp, ContentService, Logger,
    console, Date, JSON, Math, Object, Array, String, Number,
    RegExp, Error, isNaN, isFinite, Intl, Promise
  };
  vm.createContext(sandbox);

  scriptProps.set('SPREADSHEET_ID', SpreadsheetApp.create(opts.spreadsheetName || '本機測試主表').getId());

  vm.runInContext(source, sandbox, { filename: 'apps-script-bundle.js' });

  return {
    sandbox,
    logLines,
    run(expr) { return vm.runInContext(expr, sandbox); },
    call(fnName, ...args) {
      sandbox.__args = args;
      return vm.runInContext(fnName + '.apply(null, __args)', sandbox);
    }
  };
}

module.exports = { createGasSandbox, GAS_FILE_ORDER };
