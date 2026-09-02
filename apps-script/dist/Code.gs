/**
 * 娃娃機管理系統 — 後端（自動合併版）
 *
 * 這份檔案是自動產生的，請勿手動編輯。
 * 原始碼分成 6 個檔案維護：apps-script/Db.gs, Auth.gs, Service.gs,
 * Reports.gs, Code.gs, Test.gs —— 需要改動時請改那 6 個檔案，
 * 再執行 `node tools/bundle-gas.js`（或 `npm run bundle`）重新產生這份檔案。
 *
 * 部署方式：把這份檔案的內容整個貼進 GAS 專案唯一的 Code.gs，
 * 詳細步驟見 guide/DEPLOY.md。
 */

// ────────────────────────────────────────────────────────────
// Db.gs
// ────────────────────────────────────────────────────────────
/**
 * Db.gs — 試算表存取層
 *
 * 所有分頁的欄位定義、建表、讀寫、鎖都集中在這裡。
 * 上層（Auth / Service / Reports）不直接碰 SpreadsheetApp。
 */

/** 每個分頁的欄位順序。setup() 會照這個建表頭。 */
const SCHEMA = {
  Users: ['user_id', 'username', 'display_name', 'password_hash', 'salt', 'role', 'status', 'created_at', 'last_login_at'],
  Machines: ['machine_id', 'name', 'location', 'status', 'color', 'sort_order', 'note', 'created_at', 'category', 'icon',
    'carry_in', 'carry_out', 'carry_prize', 'carry_chip_in', 'carry_chip_out'],
  Records: ['record_id', 'machine_id', 'type', 'amount', 'prize_id', 'prize_name', 'unit_amount', 'count', 'user_id', 'created_at', 'note', 'voided', 'voided_by', 'voided_at', 'client_token', 'meter_start', 'meter_end', 'business_date'],
  Prizes: ['prize_id', 'machine_id', 'name', 'amount', 'sort_order', 'active'],
  QuickAmounts: ['qa_id', 'machine_id', 'type', 'amount', 'label', 'sort_order'],
  MeterRates: ['rate_id', 'machine_id', 'rate'],
  Permissions: ['user_id', 'machine_id', 'granted_by', 'granted_at'],
  Sessions: ['token', 'user_id', 'created_at', 'expires_at', 'remember'],
  Config: ['key', 'value'],
  BizDays: ['biz_id', 'business_date', 'opened_at', 'opened_by', 'closed_at', 'closed_by', 'auto_closed'],
  DailyLedger: ['ledger_id', 'business_date', 'turnover', 'transport', 'given_to_owner', 'taken_by_owner', 'returned_to_house', 'updated_by', 'updated_at', 'biz_id',
    'manual_432', 'manual_441', 'given_to_owner_items', 'taken_by_owner_items', 'manual_expense']
};

/**
 * 這些欄位格式必須鎖成純文字，不能讓 Sheets 自己依內容猜型別：
 *
 *   - 日期／時間欄位：存 ISO 時間字串或 yyyy-MM-dd 日期字串，沒鎖住的話
 *     Sheets 會自作主張轉成日期／時間型別（改天再讀出來就變成 Date 物件，
 *     不是原本存的字串，字串排序、比對全部跟著壞掉）。
 *   - name / prize_name：使用者自由輸入的名稱，理論上什麼都可能打，
 *     萬一剛好整串是數字（例如把獎型直接取名叫「432」，這個系統就真的
 *     有這種用法——首頁「今日432數量」卡片認的就是這個名字），沒鎖住
 *     文字格式的話會被 Sheets 自動轉成數字型別 432（不是字串 "432"），
 *     跟程式裡拿字串常數做 `===` 比對就永遠對不起來。
 *
 * 這是入幣改版那次欄位錯位之外，另一種「忘記鎖格式」會踩到的坑，
 * 不要重蹈覆轍。
 */
const TEXT_COLUMNS = ['created_at', 'last_login_at', 'voided_at', 'granted_at', 'expires_at', 'business_date', 'opened_at', 'closed_at', 'updated_at', 'name', 'prize_name',
  'given_to_owner_items', 'taken_by_owner_items'];

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
  Machines: ['機台編號', '名稱', '位置', '狀態', '顏色', '排序', '備註', '建立時間', '分類', '圖案',
    '封存前累計入幣', '封存前累計出幣', '封存前累計活動', '封存前累計開分', '封存前累計洗分'],
  Records: ['紀錄編號', '機台編號', '類型', '金額', '獎型編號', '獎型名稱', '單價', '次數',
    '操作人編號', '建立時間', '備註', '已作廢', '作廢人', '作廢時間', '防重複權杖', '上班表', '下班表', '營業日期'],
  Prizes: ['獎型編號', '機台編號', '名稱', '金額', '排序', '啟用中'],
  QuickAmounts: ['快捷編號', '機台編號', '類型', '金額', '顯示文字', '排序'],
  MeterRates: ['設定編號', '機台編號', '每格金額'],
  Permissions: ['帳號編號', '機台編號', '授權人', '授權時間'],
  Sessions: ['登入權杖', '帳號編號', '建立時間', '到期時間', '記住我'],
  Config: ['設定鍵', '設定值'],
  BizDays: ['營業日編號', '營業日期', '開始時間', '開始人', '結束時間', '結束人', '自動結單'],
  DailyLedger: ['帳目編號', '營業日期', '週轉金', '運拿', '台主給（舊，已改用明細）', '台主領（舊，已改用明細）', '還內場', '更新人', '更新時間', '所屬營業日編號',
    '手動活動支出432', '手動活動支出441', '台主給明細（JSON）', '台主領明細（JSON）', '開銷']
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
  BizDays: '營業日',
  DailyLedger: '每日手動帳目'
};

/** 單次執行內的分頁快取，避免同一次請求重複讀同一張表。 */
let _sheetCache = {};

function _clearSheetCache() {
  _sheetCache = {};
}

/**
 * 「跨執行」的分頁快取（GAS CacheService）——上面 _sheetCache 那層只在單次
 * 執行內有效，每一次新的請求（每次 doPost）都是全新的執行環境，一樣要
 * 重新真的打一次 Sheets API 讀整張表。dashboard／report 這種高流量的
 * API 短時間內常常被重複打好幾次（多個使用者、同一人背景輪詢），這層
 * 快取讓短時間內的重複請求可以直接吃快取，不用每次都真的讀 Sheets。
 *
 * 正確性完全靠「主動失效」保證，不是靠 TTL 自然過期：dbInsertMany／
 * dbUpdate／dbDeleteRows，以及任何直接改儲存格、繞過這幾支寫入的地方
 * （例如 _fixTextColumnFormatting()／_migrateRecordsMeterColumns() 這種
 * 修復函式），一律要呼叫 _invalidateSheetCache()，寫入當下就把這張表的
 * 快取砍掉。CacheService 是全 script 共用（不像 _sheetCache 只在單次
 * 執行內有效），砍掉之後**所有使用者**下一次讀都會直接 miss、重新從
 * Sheets 讀到最新的值。TTL 只是防呆用的安全網，不是靠它保證資料新鮮。
 *
 * 快取鍵值帶進目前試算表的 ID，不是只用分頁名稱——runSelfTest() 會透過
 * _spreadsheetOverride 暫時切到一份全新的暫時試算表跑完整套測試，如果
 * 快取鍵值沒帶試算表 ID，暫時試算表讀到的資料會被寫進跟正式試算表共用
 * 的快取鍵，等暫時試算表用完丟進垃圾桶、下次正式站台的使用者剛好命中
 * 這個快取，讀到的會是已經不存在的測試資料。帶了 ID 之後兩者天生互不
 * 干擾，不需要另外為了測試特別關閉這層快取。
 *
 * Sessions／Users 這兩張表刻意不進這層快取：登入驗證、登出、改密碼
 * 要求「立刻生效」，不能有任何一段快取窗口讓已經失效的 token／舊密碼
 * 還能通過驗證；這兩張表本來就很小，讀取成本不高，不快取也無妨。
 *
 * Records 也刻意不進這層快取，跟其他表理由不一樣：這張表是全系統寫入
 * 最頻繁的一張（每筆入幣/出幣/開獎都在寫），而且幾乎每次寫入後緊接著
 * 就要重讀（addRecord 等寫入動作回應要附上最新的 machineDetail，見
 * Service.gs 的說明），也就是「這次執行剛把它的快取砍掉，馬上又要
 * 重新整張讀一次、重新整張寫回快取」——快取在這張表上幾乎沒有機會被
 * 別的請求命中就先被自己的下一次寫入砍掉，等於白白多付一次
 * JSON.stringify 整張表＋CacheService.put() 的成本，卻換不到對應的
 * 讀取加速，反而讓「入幣/出幣送出」這種寫入動作因為回應前多了這段
 * 序列化／網路呼叫而變慢。這張表通常也是所有分頁裡筆數最多的一張，
 * 序列化成本最貴，不快取它是目前這幾張表裡投資報酬率最差的一個，
 * 其餘寫入頻率低很多的表（機台設定／獎型／快捷金額／入幣費率／
 * 台主授權／營業日／每日手動帳目／系統設定）快取效益才划算。
 */
const CROSS_EXEC_CACHE_TTL_SEC = 300;
const CROSS_EXEC_CACHEABLE = {
  Machines: true, Prizes: true, QuickAmounts: true,
  MeterRates: true, Permissions: true, Config: true, BizDays: true, DailyLedger: true
};

function _crossExecCacheKey(name) {
  return 'sheet:' + _spreadsheet().getId() + ':' + name;
}

function _crossExecCacheGet(name) {
  if (!CROSS_EXEC_CACHEABLE[name]) return null;
  try {
    const raw = CacheService.getScriptCache().get(_crossExecCacheKey(name));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null; // 快取讀取／解析失敗就退回正常讀 Sheets，不讓這層快取影響正確性
  }
}

function _crossExecCachePut(name, rows) {
  if (!CROSS_EXEC_CACHEABLE[name]) return;
  try {
    CacheService.getScriptCache().put(_crossExecCacheKey(name), JSON.stringify(rows), CROSS_EXEC_CACHE_TTL_SEC);
  } catch (err) {
    // CacheService 單一鍵值上限 100KB，資料量大的分頁可能超過——放棄快取
    // 這張表就好，不要讓快取寫入失敗連累整支請求。
  }
}

function _crossExecCacheClear(name) {
  if (!CROSS_EXEC_CACHEABLE[name]) return;
  try {
    CacheService.getScriptCache().remove(_crossExecCacheKey(name));
  } catch (err) { /* 清不掉就算了，反正還有 TTL 會讓它自然過期 */ }
}

/** 清掉某一張分頁的快取，單次執行內＋跨執行 CacheService 兩層都清——
 *  任何一個地方寫入試算表之後都要呼叫這支，不能只清單次執行內那層。 */
function _invalidateSheetCache(name) {
  delete _sheetCache[name];
  _crossExecCacheClear(name);
}

/**
 * 只在「這一次執行」裡生效的試算表覆寫，給 runSelfTest() 這種要暫時切到
 * 別份試算表跑的情境用。**故意不透過 PropertiesService**：Apps Script
 * 每次執行（不管是編輯器手動執行、或 Web App 的每一次請求）都是全新、
 * 互相獨立的執行環境，一般變數本來就不會跨執行共用，只有 PropertiesService／
 * CacheService／試算表本身才會跨執行持久。如果當初改成把 SPREADSHEET_ID
 * 這個 Script Property 直接覆寫過去再用 finally 改回來，一旦這次執行被
 * Apps Script 6 分鐘執行上限強制砍斷，finally 不會被執行，SPREADSHEET_ID
 * 就會永久卡在暫時測試用的試算表上，讓正式站台跟著讀不到真實資料——
 * 這正是「登入頁一直帳號密碼錯誤」這個問題實際發生過的原因。改用這個
 * 執行期變數就不會有這個風險：就算 runSelfTest() 那次執行被砍斷，
 * 也只有那一次執行的記憶體不見了，不會動到 SPREADSHEET_ID 這個持久設定，
 * 其他請求（包含使用者登入）完全不受影響。
 */
let _spreadsheetOverride = null;

/**
 * 取得試算表。優先用本次執行的覆寫（見上方 _spreadsheetOverride），
 * 其次用 Script Property SPREADSHEET_ID，沒設就退回綁定的試算表
 * （方便從試算表選單直接跑 setup）。
 */
function _spreadsheet() {
  if (_spreadsheetOverride) return _spreadsheetOverride;
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
    // 重組出來的是「改版前 17 欄」的排法；第 17 欄（索引 17）之後不管未來
    // 又加了幾個新欄位（目前是 business_date，之後也可能更多），這些欄位
    // 的位置本來就是對的，原封不動用 slice 接在後面帶過去——不能漏掉，
    // 漏掉的話 setValues() 寫回去的欄數會跟範圍對不起來，真正的 Sheets
    // 會直接丟錯（本機模擬器不會驗欄數，這個地雷不會在本機測試現形）。
    return [
      row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7],
      row[10], row[11], row[12], row[13], row[14], row[15], row[16],
      row[8], row[9]
    ].concat(row.slice(17));
  });

  if (fixed > 0) {
    range.setValues(out);
    _invalidateSheetCache('Records');
  }
  return fixed;
}

/** business_date 存 'yyyy-MM-dd'；TEXT_COLUMNS 其餘欄位都存完整 ISO 時間字串。 */
const DATE_ONLY_TEXT_COLUMNS = ['business_date'];

/**
 * 修正「這一欄該存純文字，卻被 Sheets 自動猜成別的型別」的舊資料。
 *
 * `_sheet()` 只有在「分頁是全新建立」的當下，才會把 TEXT_COLUMNS 的欄位鎖成
 * 純文字格式（`'@'`）。這對「分頁本身早就存在、schema 後來才加了新欄位」的情況
 * 沒有回溯生效——`Records.business_date` 就是這樣：`Records` 分頁從系統一開始
 * 就存在，`business_date` 是後來才加進 schema 的新欄位，從來沒機會被鎖成文字，
 * 寫進去的 `'2026-08-20'` 會被自動解析成日期序列值，讀出來變成 `Date` 物件。
 * `name`／`prize_name` 則是另一種情況：這兩欄從系統一開始就存在，但從來沒被
 * 認為需要鎖文字格式——直到這個系統真的出現「獎型名稱剛好整串是數字」的用法
 * （首頁「今日432數量」卡片認的就是名叫「432」的獎型），寫進去的 `'432'`
 * 被自動轉成數字 `432`。兩種情況共同點都是：所有拿這幾欄做字串比對的地方
 * （今日彙總、營業日比對、432 名稱比對）就全部對不起來，而且不會噴任何錯誤，
 * 只是默默算出 0。`BizDays` 不會踩到日期那個坑，因為它是跟「營業日」功能
 * 一起誕生的全新分頁，建立當下 `business_date` 就已經在 schema 裡了，
 * `isNew` 分支照樣鎖住了格式。
 *
 * 這裡對每張分頁的每個 TEXT_COLUMNS 欄位：**先讀出目前的值，再把整欄格式
 * 鎖回純文字，最後才把讀到的、已經被誤存成 `Date` 物件或數字的儲存格轉回
 * 正確的文字格式寫回去**（日期類欄位視 `DATE_ONLY_TEXT_COLUMNS` 轉回
 * `'yyyy-MM-dd'` 或完整 ISO 字串；數字直接 `String()` 轉回字串）。
 * 已經是字串的儲存格原封不動，天生冪等，重跑不會誤傷正常資料。
 *
 * 讀值跟鎖格式的順序不能反過來。曾經寫成「先鎖格式、再讀值」，結果讀出來的
 * `Date` 物件全部已經被 Sheets 自己用它預設的地區日期格式（例如
 * `8/20/2026`）转成字串了——不是我這裡指定的 `'yyyy-MM-dd'`，
 * 而且因為讀到的已經是字串（不再是 `Date` 物件），`v instanceof Date`
 * 判斷會直接跳過，錯誤格式的字串就這樣被誤判成「已經是正常資料」留下來，
 * 完全沒被修正。一定要在還沒動格式之前，先把當下還是 `Date`／數字的原始值
 * 讀出來存好，才不會被 Sheets 自己搶先轉成不受控的格式。
 */
function _fixTextColumnFormatting() {
  const tz = _tz();
  let fixedCells = 0;

  Object.keys(SCHEMA).forEach(function (name) {
    const cols = SCHEMA[name];
    const textCols = cols.filter(function (c) { return TEXT_COLUMNS.indexOf(c) >= 0; });
    if (!textCols.length) return;

    const sh = _sheet(name);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return;

    const range = sh.getRange(2, 1, lastRow - 1, cols.length);
    const values = range.getValues(); // 一定要在改格式之前讀，見上面的說明

    textCols.forEach(function (col) {
      const c = cols.indexOf(col) + 1;
      sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
    });

    let changed = false;
    for (let r = 0; r < values.length; r++) {
      textCols.forEach(function (col) {
        const c = cols.indexOf(col);
        const v = values[r][c];
        if (v instanceof Date) {
          values[r][c] = DATE_ONLY_TEXT_COLUMNS.indexOf(col) >= 0
            ? Utilities.formatDate(v, tz, 'yyyy-MM-dd')
            : v.toISOString();
          changed = true;
          fixedCells++;
        } else if (typeof v === 'number') {
          // name／prize_name 剛好整串是數字（例如獎型叫「432」）被 Sheets 自動轉成
          // 數字型別時會落在這裡，不是 Date——直接轉回字串就能還原成原本打的內容。
          values[r][c] = String(v);
          changed = true;
          fixedCells++;
        }
      });
    }

    if (changed) {
      range.setValues(values);
      _invalidateSheetCache(name);
    }
  });

  return fixedCells;
}

/**
 * 讀出整張分頁，回傳物件陣列。每個物件多一個 _row（實際列號，從 2 起算）。
 * 同一次執行內只會真的讀一次；跨執行的話先試跨執行快取（見上面
 * _crossExecCacheGet 的說明），還是沒有才真的打 Sheets API。
 */
function dbReadAll(name) {
  if (_sheetCache[name]) return _sheetCache[name];

  const cached = _crossExecCacheGet(name);
  if (cached) {
    _sheetCache[name] = cached;
    return cached;
  }

  const sh = _sheet(name);
  const lastRow = sh.getLastRow();
  const cols = SCHEMA[name];
  if (lastRow < 2) {
    _sheetCache[name] = [];
    _crossExecCachePut(name, []);
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
  _crossExecCachePut(name, rows);
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
  _invalidateSheetCache(name);
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
  _invalidateSheetCache(name);
}

/** 刪除指定列（由大到小刪，避免列號位移）。 */
function dbDeleteRows(name, rowIndexes) {
  if (!rowIndexes.length) return;
  const sh = _sheet(name);
  rowIndexes.slice().sort(function (a, b) { return b - a; }).forEach(function (r) {
    sh.deleteRow(r);
  });
  _invalidateSheetCache(name);
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

// ────────────────────────────────────────────────────────────
// Auth.gs
// ────────────────────────────────────────────────────────────
/**
 * Auth.gs — 密碼、Session、角色與機台權限
 *
 * 整套權限的把關點只有這個檔案裡的 requireRole / assertMachineAccess，
 * 其他地方一律透過它們，不要各自判斷角色。
 */

const ROLE_ADMIN = 'admin';
const ROLE_PATROL = 'patrol';
const ROLE_OWNER = 'owner';

const ROLE_LABELS = { admin: '管理員', patrol: '巡邏人員', owner: '台主' };

const SESSION_HOURS_DEFAULT = 12;
const SESSION_DAYS_REMEMBER = 7;

const HASH_ITERATIONS = 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MINUTES = 15;

// ── 密碼 ────────────────────────────────────────────────

/**
 * 全站 pepper。存在 Script Properties，不進 repo、不進試算表。
 * 首次呼叫自動產生，之後固定不變（換掉會讓所有既有密碼失效）。
 */
function _pepper() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('PEPPER');
  if (!p) {
    p = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PEPPER', p);
  }
  return p;
}

function _sha256Hex(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/**
 * salt + pepper 迭代 SHA-256。
 * GAS 沒有 bcrypt，這是在平台限制下能做到的合理強度：
 * 單純撞一組密碼要跑 1000 次雜湊，暴力破解成本高很多。
 */
function hashPassword(password, salt) {
  let h = salt + '|' + _pepper() + '|' + password;
  for (let i = 0; i < HASH_ITERATIONS; i++) h = _sha256Hex(h);
  return h;
}

function newSalt() {
  return Utilities.getUuid().replace(/-/g, '');
}

/** 定時比較，避免用字串比較洩漏前綴資訊。 */
function _safeEquals(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// ── 登入限流 ────────────────────────────────────────────

function _failKey(username) {
  return 'loginfail_' + String(username).toLowerCase();
}

function _assertNotLocked(username) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(_failKey(username)) || 0);
  if (n >= LOGIN_MAX_FAILS) {
    throw new Error('登入失敗次數過多，請於 ' + LOGIN_LOCK_MINUTES + ' 分鐘後再試');
  }
}

function _recordFail(username) {
  const cache = CacheService.getScriptCache();
  const key = _failKey(username);
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), LOGIN_LOCK_MINUTES * 60);
}

function _clearFails(username) {
  CacheService.getScriptCache().remove(_failKey(username));
}

// ── Session ─────────────────────────────────────────────

function _sessionCacheKey(token) {
  return 'sess_' + token;
}

function _createSession(userId, remember) {
  const now = new Date();
  const ms = remember
    ? SESSION_DAYS_REMEMBER * 24 * 60 * 60 * 1000
    : SESSION_HOURS_DEFAULT * 60 * 60 * 1000;
  const expires = new Date(now.getTime() + ms);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');

  dbInsert('Sessions', {
    token: token,
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    remember: !!remember
  });

  CacheService.getScriptCache().put(
    _sessionCacheKey(token),
    JSON.stringify({ user_id: userId, expires_at: expires.toISOString(), remember: !!remember }),
    21600 // Cache 上限 6 小時；過期後自動退回讀試算表
  );

  return { token: token, expiresAt: expires.toISOString() };
}

/**
 * 驗證 token 並回傳使用者。
 *
 * 有效期以試算表的 expires_at 為準（前端動 localStorage 沒有用）。
 * 未勾記住我的 session 會滑動延展，但只在剩不到一半時才真的寫回試算表，
 * 免得每個請求都寫一次。
 */
function validateSession(token) {
  if (!token) throw new AuthError('尚未登入');

  const cache = CacheService.getScriptCache();
  const cacheKey = _sessionCacheKey(token);
  let sess = null;
  let row = null;

  const cached = cache.get(cacheKey);
  if (cached) {
    sess = JSON.parse(cached);
  } else {
    row = dbFind('Sessions', 'token', token);
    if (!row) throw new AuthError('登入已失效，請重新登入');
    sess = { user_id: row.user_id, expires_at: row.expires_at, remember: toBool(row.remember) };
  }

  const now = new Date();
  const expires = new Date(sess.expires_at);
  if (!(expires > now)) {
    cache.remove(cacheKey);
    throw new AuthError('登入已逾時，請重新登入');
  }

  const user = dbFind('Users', 'user_id', sess.user_id);
  if (!user) throw new AuthError('帳號不存在，請重新登入');
  if (String(user.status) !== 'active') throw new AuthError('此帳號已停用');

  if (!sess.remember) {
    const windowMs = SESSION_HOURS_DEFAULT * 60 * 60 * 1000;
    if (expires.getTime() - now.getTime() < windowMs / 2) {
      const next = new Date(now.getTime() + windowMs);
      if (!row) row = dbFind('Sessions', 'token', token);
      if (row) dbUpdate('Sessions', row._row, { expires_at: next.toISOString() });
      sess.expires_at = next.toISOString();
    }
  }

  cache.put(cacheKey, JSON.stringify(sess), 21600);
  return _publicUser(user);
}

function login(username, password, remember) {
  const uname = String(username || '').trim();
  if (!uname || !password) throw new AuthError('請輸入帳號與密碼');

  _assertNotLocked(uname);

  const user = dbReadAll('Users').filter(function (u) {
    return String(u.username).toLowerCase() === uname.toLowerCase();
  })[0];

  // 帳號不存在也要跑一次雜湊，讓回應時間一致，不洩漏帳號是否存在
  const salt = user ? user.salt : 'nonexistent';
  const hash = hashPassword(String(password), String(salt));

  if (!user || !_safeEquals(hash, user.password_hash)) {
    _recordFail(uname);
    throw new AuthError('帳號或密碼錯誤');
  }
  if (String(user.status) !== 'active') {
    throw new AuthError('此帳號已停用，請聯絡管理員');
  }

  _clearFails(uname);
  _cleanupExpiredSessions();

  const sess = _createSession(user.user_id, !!remember);
  dbUpdate('Users', user._row, { last_login_at: nowIso() });

  const publicUser = _publicUser(user);
  return {
    token: sess.token,
    expiresAt: sess.expiresAt,
    remember: !!remember,
    user: publicUser,
    // 登入完一定接著要進首頁，順便把首頁資料一起帶回去，
    // 前端就不用登入成功後再多打一次 dashboard——跟 homeBootstrap 同一個道理，
    // 省下登入當下那一整趟 GAS 來回。
    dashboard: getDashboard(publicUser)
  };
}

function logout(token) {
  const row = dbFind('Sessions', 'token', token);
  if (row) dbDeleteRows('Sessions', [row._row]);
  CacheService.getScriptCache().remove(_sessionCacheKey(token));
  return { ok: true };
}

/** 踢掉某帳號的所有登入狀態（改密碼、停用時用）。 */
function invalidateUserSessions(userId) {
  const rows = dbFilter('Sessions', 'user_id', userId);
  if (!rows.length) return 0;
  const cache = CacheService.getScriptCache();
  rows.forEach(function (r) { cache.remove(_sessionCacheKey(r.token)); });
  dbDeleteRows('Sessions', rows.map(function (r) { return r._row; }));
  return rows.length;
}

function _cleanupExpiredSessions() {
  const now = new Date();
  const stale = dbReadAll('Sessions').filter(function (s) {
    return !(new Date(s.expires_at) > now);
  });
  if (stale.length) dbDeleteRows('Sessions', stale.map(function (s) { return s._row; }));
}

/** 回傳給前端的使用者資料，永遠不含密碼與 salt。 */
function _publicUser(user) {
  return {
    userId: user.user_id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    status: user.status
  };
}

// ── 角色與機台權限 ──────────────────────────────────────

/** 自訂錯誤型別，讓前端能分辨「要重新登入」與一般錯誤。 */
function AuthError(message) {
  const e = new Error(message);
  e.name = 'AuthError';
  return e;
}

function PermissionError(message) {
  const e = new Error(message || '你沒有這項操作的權限');
  e.name = 'PermissionError';
  return e;
}

function isAdmin(user) {
  return user.role === ROLE_ADMIN;
}

function canRecord(user) {
  return user.role === ROLE_ADMIN || user.role === ROLE_PATROL;
}

function requireRole(user, roles) {
  if (roles.indexOf(user.role) < 0) throw PermissionError();
}

/**
 * 這個帳號看得到哪些機台。
 * 管理員與巡邏人員一律全部（新增機台不用補設定）；台主只看授權過的。
 */
function visibleMachineIds(user) {
  const all = dbReadAll('Machines').map(function (m) { return String(m.machine_id); });
  if (user.role === ROLE_ADMIN || user.role === ROLE_PATROL) return all;

  const granted = dbFilter('Permissions', 'user_id', user.userId)
    .map(function (p) { return String(p.machine_id); });
  return all.filter(function (id) { return granted.indexOf(id) >= 0; });
}

/** 台主拿別台的 id 直接打 API，擋在這裡。 */
function assertMachineAccess(user, machineId) {
  if (!machineId) throw new Error('缺少機台編號');
  if (visibleMachineIds(user).indexOf(String(machineId)) < 0) {
    throw PermissionError('你沒有這台機台的權限');
  }
}

// ────────────────────────────────────────────────────────────
// Service.gs
// ────────────────────────────────────────────────────────────
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

/** 依 user_id 查顯示名稱，查不到回傳空字串。 */
function _userDisplayName(id) {
  if (!id) return '';
  const users = dbReadAll('Users');
  for (let i = 0; i < users.length; i++) {
    if (String(users[i].user_id) === String(id)) return users[i].display_name || users[i].username;
  }
  return '';
}

function _publicBizDay(row) {
  if (!row) return null;
  return {
    businessDate: String(row.business_date),
    openedAt: row.opened_at,
    openedByName: _userDisplayName(row.opened_by),
    closedAt: row.closed_at || null,
    closedByName: row.closed_by ? _userDisplayName(row.closed_by) : null,
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
      const closePatch = { closed_at: now, closed_by: user.userId, auto_closed: true };
      dbUpdate('BizDays', open._row, closePatch);
      pushBizDayToSupabase(Object.assign({}, open, closePatch));
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
    pushBizDayToSupabase(row);
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
    pushBizDayToSupabase(closed);
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

/**
 * 跟 _validAmount 不同：允許輸入負數（用於偶爾需要沖正的修正），只限制數字的大小。
 * raw 沒帶（undefined/null/''）當 0 處理，不當成非法輸入——運拿／還內場
 * 這兩個舊欄位前端已經不再收集、不會送這個 key，不能因為缺席就整個請求失敗。
 */
function _validSignedAmount(raw) {
  const n = Number(raw || 0);
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
    const savedRow = _dailyLedgerRow(businessDate);
    pushDailyLedgerToSupabase(savedRow);
    return _publicDailyLedger(savedRow);
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
    todayOpenedByName: openBiz ? _userDisplayName(openBiz.opened_by) : '',
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
 *
 * 回傳的 total（畫面上顯示「累計淨收益」）算的是「本週」，不是機台開帳
 * 以來的全部歷史——跟報表頁「本週」查詢同一套 resolveRange('week') 邊界
 * （週日到今天，今天照營業日期算，不是行事曆日期）。
 */
function _buildMachineDetail(m, records, recordLimit, openBiz) {
  const today = openBiz ? String(openBiz.business_date) : todayKey();
  // 「累計淨收益」改成本週（週日起算，跟報表頁 week 這個 preset 用同一套
  // resolveRange() 邊界，不用重複寫一次），不是像以前那樣算機台開帳以來
  // 的全部歷史。用營業日期（_recordBusinessDate，記帳當下就snapshot好的）
  // 判斷落在哪一天，不是看記錄時間戳——跨過午夜才打烊的營業日，這筆帳
  // 的營業日期還是「昨天」，不會因為實際寫入時間是凌晨就被算進下一週。
  const weekRange = resolveRange('week');
  const total = emptySummary();
  const todaySum = emptySummary();
  let today432Count = 0;

  records.forEach(function (r) {
    const bd = _recordBusinessDate(r);
    if (bd >= weekRange.from && bd <= weekRange.to) _accumulate(total, r);
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
    pushRecordsToSupabase([rec]);
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
    pushRecordsToSupabase([rec]);
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
    pushRecordsToSupabase(rows);
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
    const patch = { voided: true, voided_by: user.userId, voided_at: nowIso() };
    dbUpdate('Records', r._row, patch);
    pushVoidToSupabase(Object.assign({}, r, patch));
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

// ────────────────────────────────────────────────────────────
// SupabasePush.gs
// ────────────────────────────────────────────────────────────
/**
 * SupabasePush.gs — 試算表寫入的當下，順便即時推一份到 Supabase。
 *
 * 跟 supabase/migrate-from-sheets.js／supabase/MigrateToSupabase.gs 那套
 * 「定期整批 upsert」搭配，不是取代：這裡處理「剛剛寫的這一筆」，
 * 讓「試算表 → 資料庫」這個方向從「最多等 5 分鐘」變成「幾乎即時」；
 * 定期整批同步繼續留著當保險網——這裡推送失敗（網路問題、Supabase
 * 剛好打不通）不會讓使用者發現，缺的那一筆會在下一次定期同步時自然
 * 補上，不需要在這裡做重試。
 *
 * ── 最重要的設計原則 ──────────────────────────────────────
 *
 * **絕對不能因為 Supabase 打不通，就讓試算表本身的寫入跟著失敗或變慢
 * 到使用者有感。** 這裡每一支對外函式都自己包 try/catch，出錯只印一行
 * 警告到執行記錄，不會往外拋——呼叫端（Service.gs 的 addRecord 等）
 * 完全不用理會這裡有沒有成功。
 *
 * ── 什麼時候真的會推送 ──────────────────────────────────
 *
 * 只有指令碼屬性同時設定了 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY
 * 才會真的打 API；main 正式站台目前沒有設這兩個屬性，這裡所有呼叫都會
 * 靜靜跳過（_sbPushEnabled() 回傳 false），不影響任何現有行為——這也是
 * 為什麼可以放心把這些呼叫直接加進 Service.gs：沒設定這兩個屬性的環境
 * 完全不受影響。
 */

function _sbPushEnabled() {
  const props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('SUPABASE_URL') && props.getProperty('SUPABASE_SERVICE_ROLE_KEY'));
}

function _sbPushConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: String(props.getProperty('SUPABASE_URL') || '').replace(/\/+$/, ''),
    key: props.getProperty('SUPABASE_SERVICE_ROLE_KEY')
  };
}

function _sbPushFetch(method, path, payload, extraHeaders) {
  const cfg = _sbPushConfig();
  const headers = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
  if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
  const options = { method: method, headers: headers, muteHttpExceptions: true };
  if (payload !== undefined) options.payload = JSON.stringify(payload);
  const resp = UrlFetchApp.fetch(cfg.url + path, options);
  const code = resp.getResponseCode();
  if (code >= 300) throw new Error('(' + code + ') ' + method + ' ' + path + '：' + resp.getContentText());
}

/**
 * 試算表 user_id（文字）→ Supabase profiles.id（uuid），靠兩邊都有的
 * username 對照。查一次 Supabase 的 profiles 表要花一次網路來回，快取
 * 1 小時，避免每一次記帳都多打一次 API 拖慢使用者的操作。
 */
function _sbPushUserId(sheetUserId) {
  if (!sheetUserId) return null;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'sbPushUidMap';
  let map = null;
  try {
    const cached = cache.get(cacheKey);
    if (cached) map = JSON.parse(cached);
  } catch (e) { map = null; }

  if (!map) {
    map = {};
    const usernameToSheetId = {};
    dbReadAll('Users').forEach(function (u) { usernameToSheetId[u.username] = u.user_id; });
    const cfg = _sbPushConfig();
    const headers = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
    const resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/profiles?select=id,username', { method: 'GET', headers: headers, muteHttpExceptions: true });
    const profiles = JSON.parse(resp.getContentText() || '[]');
    profiles.forEach(function (p) {
      const sid = usernameToSheetId[p.username];
      if (sid) map[sid] = p.id;
    });
    try { cache.put(cacheKey, JSON.stringify(map), 3600); } catch (e) { /* 快取放不下就算了，這次還是能正常查完 */ }
  }
  return map[sheetUserId] || null;
}

function _sbPushUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  _sbPushFetch('POST', '/rest/v1/' + table + '?on_conflict=' + encodeURIComponent(onConflict), rows,
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

/** 入幣／出幣／碼表入幣／開獎：一次可能好幾筆（開獎一次登錄多個獎型）。 */
function pushRecordsToSupabase(recs) {
  if (!_sbPushEnabled() || !recs || !recs.length) return;
  try {
    const rows = recs.map(function (r) {
      const uid = _sbPushUserId(r.user_id);
      if (!uid) throw new Error('user_id=' + r.user_id + ' 在 Supabase 找不到對應帳號');
      return {
        record_id: r.record_id, machine_id: r.machine_id, type: r.type, amount: r.amount,
        prize_id: r.prize_id || null, prize_name: r.prize_name || '',
        unit_amount: r.unit_amount === '' ? null : r.unit_amount,
        count: r.count === '' ? null : r.count,
        user_id: uid, created_at: r.created_at, note: r.note || '',
        voided: !!r.voided, voided_by: null, voided_at: null,
        client_token: r.client_token || null,
        meter_start: r.meter_start === '' ? null : r.meter_start,
        meter_end: r.meter_end === '' ? null : r.meter_end,
        business_date: r.business_date
      };
    });
    _sbPushUpsert('records', rows, 'record_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（records）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}

/** 作廢一筆紀錄。 */
function pushVoidToSupabase(rec) {
  if (!_sbPushEnabled() || !rec) return;
  try {
    _sbPushUpsert('records', [{
      record_id: rec.record_id,
      voided: true,
      voided_by: _sbPushUserId(rec.voided_by),
      voided_at: rec.voided_at
    }], 'record_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（voidRecord）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}

/** 每日手動帳目（設定今日數字）。 */
function pushDailyLedgerToSupabase(row) {
  if (!_sbPushEnabled() || !row) return;
  try {
    _sbPushUpsert('daily_ledger', [{
      ledger_id: row.ledger_id,
      business_date: row.business_date,
      turnover: toNumber(row.turnover),
      transport: toNumber(row.transport),
      given_to_owner: 0,
      taken_by_owner: 0,
      given_to_owner_items: _parseLedgerItems(row.given_to_owner_items),
      taken_by_owner_items: _parseLedgerItems(row.taken_by_owner_items),
      returned_to_house: toNumber(row.returned_to_house),
      updated_by: _sbPushUserId(row.updated_by),
      updated_at: row.updated_at,
      biz_id: row.biz_id || null,
      manual_432: toNumber(row.manual_432),
      manual_441: toNumber(row.manual_441),
      manual_expense: toNumber(row.manual_expense)
    }], 'ledger_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（daily_ledger）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}

/** 今日營業開始／結單。 */
function pushBizDayToSupabase(row) {
  if (!_sbPushEnabled() || !row) return;
  try {
    _sbPushUpsert('biz_days', [{
      biz_id: row.biz_id,
      business_date: row.business_date,
      opened_at: row.opened_at,
      opened_by: _sbPushUserId(row.opened_by),
      closed_at: row.closed_at || null,
      closed_by: _sbPushUserId(row.closed_by),
      auto_closed: !!row.auto_closed
    }], 'biz_id');
  } catch (e) {
    Logger.log('⚠ 即時推送 Supabase 失敗（biz_days）：' + (e && e.message) + '——下次定期同步會補上，不影響這次試算表寫入');
  }
}

// ────────────────────────────────────────────────────────────
// Reports.gs
// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
// Archive.gs
// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
// Code.gs
// ────────────────────────────────────────────────────────────
/**
 * Code.gs — Web App 進入點、API 路由、初始化、自我測試
 *
 * 這支 GAS 只回 JSON，不輸出任何 HTML。
 * 前端是 GitHub Pages 上的 PWA，透過 form-urlencoded POST 打進來
 * （form-urlencoded 屬於 CORS simple request，不會觸發 preflight）。
 */

const API_VERSION = '1.0.0';

/** action → 允許的角色。沒列在這裡的 action 一律拒絕。 */
const ACTION_ROLES = {
  ping: 'public',
  login: 'public',

  me: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  homeBootstrap: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  logout: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  dashboard: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  machineDetail: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  allMachineDetails: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  report: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  exportLedgerXlsx: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  exportLedgerGrids: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  activityQuery: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listQuickAmounts: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listPrizes: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],
  listMeterRate: [ROLE_ADMIN, ROLE_PATROL, ROLE_OWNER],

  addRecord: [ROLE_ADMIN, ROLE_PATROL],
  addPrizeRecord: [ROLE_ADMIN, ROLE_PATROL],
  addMeterRecord: [ROLE_ADMIN, ROLE_PATROL],
  startBusinessDay: [ROLE_ADMIN, ROLE_PATROL],
  endBusinessDay: [ROLE_ADMIN, ROLE_PATROL],
  saveDailyLedger: [ROLE_ADMIN, ROLE_PATROL],

  voidRecord: [ROLE_ADMIN],
  saveQuickAmount: [ROLE_ADMIN],
  deleteQuickAmount: [ROLE_ADMIN],
  savePrize: [ROLE_ADMIN],
  deletePrize: [ROLE_ADMIN],
  saveMeterRate: [ROLE_ADMIN],
  forkScope: [ROLE_ADMIN],
  resetScope: [ROLE_ADMIN],

  adminListUsers: [ROLE_ADMIN],
  adminSaveUser: [ROLE_ADMIN],
  adminResetPassword: [ROLE_ADMIN],
  adminListPrizes: [ROLE_ADMIN],
  adminListMachines: [ROLE_ADMIN],
  adminSaveMachine: [ROLE_ADMIN],
  adminListPermissions: [ROLE_ADMIN],
  adminSetPermission: [ROLE_ADMIN],
  adminBootstrap: [ROLE_ADMIN]
};

// ── HTTP 進入點 ─────────────────────────────────────────

function doPost(e) {
  let payload = {};
  try {
    const raw = (e && e.parameter && e.parameter.payload) ? e.parameter.payload : '{}';
    payload = JSON.parse(raw);
  } catch (err) {
    return _json({ ok: false, error: '請求格式錯誤', code: 'BAD_REQUEST' });
  }
  return _json(handleApi(payload));
}

/** 直接用瀏覽器開 /exec 時給個確認畫面，順便當健康檢查。 */
function doGet() {
  return _json({ ok: true, data: { service: '娃娃機管理系統 API', version: API_VERSION, hint: '這是 API 端點，請從前端網站使用' } });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 路由本體。抽出來是為了讓 runSelfTest 能直接呼叫，測到跟線上同一條路徑。 */
function handleApi(payload) {
  const action = String(payload.action || '');
  const allowed = ACTION_ROLES[action];

  try {
    _clearSheetCache();

    if (!allowed) throw new Error('不支援的操作：' + action);

    if (allowed === 'public') {
      return { ok: true, data: _dispatchPublic(action, payload) };
    }

    const user = validateSession(payload.token);
    requireRole(user, allowed);
    return { ok: true, data: _dispatch(action, payload, user) };

  } catch (err) {
    const name = err && err.name;
    return {
      ok: false,
      error: (err && err.message) ? err.message : '發生未預期的錯誤',
      code: name === 'AuthError' ? 'AUTH' : (name === 'PermissionError' ? 'PERMISSION' : 'ERROR')
    };
  }
}

function _dispatchPublic(action, p) {
  if (action === 'ping') return { version: API_VERSION, time: nowIso() };
  if (action === 'login') return login(p.username, p.password, p.remember);
  throw new Error('不支援的操作：' + action);
}

function _dispatch(action, p, user) {
  switch (action) {
    case 'me':
      return { user: user, machineCount: visibleMachineIds(user).length };
    case 'logout':
      return logout(p.token);

    case 'dashboard':
      return getDashboard(user);
    case 'homeBootstrap':
      return homeBootstrap(user);
    case 'machineDetail':
      return getMachineDetail(user, p.machineId, p.recordLimit);
    case 'allMachineDetails':
      return getAllMachineDetails(user, p.recordLimit);
    case 'report':
      return getReport(user, p);
    case 'exportLedgerXlsx':
      return exportLedgerXlsx(user, p);
    case 'exportLedgerGrids':
      return exportLedgerGrids(user, p);
    case 'activityQuery':
      return getActivityQuery(user, p);
    case 'listQuickAmounts':
      return listQuickAmounts(user, p.machineId);
    case 'listPrizes':
      return listPrizes(user, p.machineId);
    case 'listMeterRate':
      return listMeterRate(user, p.machineId);

    case 'addRecord':
      return addRecord(user, p);
    case 'addPrizeRecord':
      return addPrizeRecord(user, p);
    case 'addMeterRecord':
      return addMeterRecord(user, p);
    case 'startBusinessDay':
      return startBusinessDay(user);
    case 'endBusinessDay':
      return endBusinessDay(user);
    case 'saveDailyLedger':
      return saveDailyLedger(user, p);
    case 'voidRecord':
      return voidRecord(user, p.recordId);

    case 'saveQuickAmount':
      return saveQuickAmount(user, p);
    case 'deleteQuickAmount':
      return deleteQuickAmount(user, p.qaId);
    case 'savePrize':
      return savePrize(user, p);
    case 'deletePrize':
      return deletePrize(user, p.prizeId);
    case 'saveMeterRate':
      return saveMeterRate(user, p);
    case 'forkScope':
      return forkScopeToMachine(user, p.sheet, p.machineId);
    case 'resetScope':
      return resetScopeToGlobal(user, p.sheet, p.machineId);

    case 'adminListUsers':
      return adminListUsers(user);
    case 'adminSaveUser':
      return adminSaveUser(user, p);
    case 'adminResetPassword':
      return adminResetPassword(user, p);
    case 'adminListPrizes':
      return adminListPrizes(user);
    case 'adminListMachines':
      return adminListMachines(user);
    case 'adminSaveMachine':
      return adminSaveMachine(user, p);
    case 'adminListPermissions':
      return adminListPermissions(user);
    case 'adminSetPermission':
      return adminSetPermission(user, p);
    case 'adminBootstrap':
      return adminBootstrap(user);

    default:
      throw new Error('不支援的操作：' + action);
  }
}

// ── 初始化 ──────────────────────────────────────────────

/**
 * 第一次部署時在 GAS 編輯器手動執行這一支。
 * 會建好所有分頁、產生 pepper、開一個管理員帳號、放幾組預設快捷金額與獎型。
 * 重複執行是安全的：已存在的東西不會被覆蓋。
 */
function setup() {
  const out = [];

  Object.keys(SCHEMA).forEach(function (name) {
    dbReadAll(name); // 觸發建表
    applyHeaderLabels(name); // 表頭一律覆寫成中文，既有分頁也會被修正，不影響資料列
    out.push('分頁 ' + name + ' 就緒');
  });

  const fixedRecords = _migrateRecordsMeterColumns();
  if (fixedRecords > 0) {
    out.push('已修正 ' + fixedRecords + ' 筆紀錄的欄位錯位（入幣改版當時造成的問題，資料已搬回正確位置，沒有遺失任何資料）');
  }

  const fixedTextCells = _fixTextColumnFormatting();
  if (fixedTextCells > 0) {
    out.push('已修正 ' + fixedTextCells + ' 個被 Sheets 自動轉成日期型別的儲存格（例如舊分頁後來才加的 business_date 欄位），改回純文字並鎖住格式，數值本身沒有變過');
  }

  _pepper();
  out.push('PEPPER 就緒');

  const triggerInstalled = _ensureArchiveTrigger();
  out.push(triggerInstalled
    ? '已設定每月自動封存檢查（每月 2 號凌晨 3 點，會把上一季以前還留在「紀錄」分頁的資料搬去封存分頁）'
    : '每月自動封存檢查已經設定過，略過');

  const props = PropertiesService.getScriptProperties();
  const admins = dbReadAll('Users').filter(function (u) { return String(u.role) === ROLE_ADMIN; });
  // 忘記密碼的救援流程：使用者在試算表把某個 admin 列的 password_hash/salt 清空後重跑 setup，
  // 這裡要能認出「有 admin 但密碼是空的」，不能只看「完全沒有 admin」。
  const brokenAdmin = admins.find(function (u) { return !u.password_hash || !u.salt; });

  if (!admins.length || brokenAdmin) {
    const username = brokenAdmin ? brokenAdmin.username : (props.getProperty('INITIAL_ADMIN_USERNAME') || 'admin');
    let password = props.getProperty('INITIAL_ADMIN_PASSWORD');
    let generated = false;
    if (!password) {
      password = Utilities.getUuid().replace(/-/g, '').substring(0, 12);
      generated = true;
    }
    const salt = newSalt();
    const passwordHash = hashPassword(password, salt);

    if (brokenAdmin) {
      dbUpdate('Users', brokenAdmin._row, { password_hash: passwordHash, salt: salt });
      invalidateUserSessions(brokenAdmin.user_id);
    } else {
      dbInsert('Users', {
        user_id: newId('usr'),
        username: username,
        display_name: '系統管理員',
        password_hash: passwordHash,
        salt: salt,
        role: ROLE_ADMIN,
        status: 'active',
        created_at: nowIso(),
        last_login_at: ''
      });
    }
    out.push('');
    out.push(brokenAdmin ? '=== 管理員密碼已重設 ===' : '=== 管理員帳號已建立 ===');
    out.push('帳號：' + username);
    out.push('密碼：' + password + (generated ? '（系統隨機產生，請立刻登入後改掉）' : ''));
    out.push('========================');
    props.deleteProperty('INITIAL_ADMIN_PASSWORD');
  } else {
    out.push('已有管理員帳號，略過建立');
  }

  if (!dbReadAll('QuickAmounts').length) {
    // 入幣改用碼表讀數計算，不再需要快捷金額按鈕，只保留出幣的預設值。
    const seed = [];
    [10, 50, 100].forEach(function (a, i) {
      seed.push({ qa_id: newId('qa'), machine_id: '', type: RECORD_OUT, amount: a, label: '$' + a, sort_order: i + 1 });
    });
    dbInsertMany('QuickAmounts', seed);
    out.push('已建立預設快捷金額（全局，僅出幣）');
  }

  if (!dbReadAll('Prizes').length) {
    dbInsertMany('Prizes', [
      { prize_id: newId('prz'), machine_id: '', name: '大娃', amount: 150, sort_order: 1, active: true },
      { prize_id: newId('prz'), machine_id: '', name: '中娃', amount: 80, sort_order: 2, active: true },
      { prize_id: newId('prz'), machine_id: '', name: '小娃', amount: 40, sort_order: 3, active: true }
    ]);
    out.push('已建立預設獎型（全局）');
  }

  if (!dbReadAll('MeterRates').length) {
    dbInsert('MeterRates', { rate_id: newId('mr'), machine_id: '', rate: 100 });
    out.push('已建立預設碼表費率（全局，每格 $100）');
  }

  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * 手動執行：正式上線前，把測試期間累積的交易資料清空，機台本身的設定不動。
 *
 * 只能在 GAS 編輯器裡手動執行——刻意不透過 App 任何按鈕或 API action 觸發，
 * 避免有人在手機上不小心點到，把資料清掉。**這是不可逆的動作，執行前
 * 建議先把整份試算表複製一份備份。**
 *
 * 會清空：
 *   - Records（入幣／出幣／活動／開分／洗分紀錄）
 *   - DailyLedger（每日手動帳目：週轉金／運拿／台主給／台主領／432／441）
 *   - BizDays（今日營業開始／結單的歷史）
 *   - 機台上的「封存前累計」欄位（carry_in／carry_out／carry_prize／
 *     carry_chip_in／carry_chip_out）歸零——這幾個數字是封存機制銜接用的
 *     累計基準，Records 清空後這幾個數字也該跟著歸零，不然機台的「累計」
 *     淨收益會對不起來（還留著測試期間的假數字）
 *
 * 不會動：Machines 本身（名稱、位置、顏色、分類、圖案、狀態、排序）、
 * Prizes／QuickAmounts／MeterRates（機台的按鈕設定）、Users／Permissions
 * （帳號與授權）、Config、封存分頁（如果已經有封存過的舊資料，這支不會去
 * 動它——那是「已經封存」的歷史，跟這裡要清的「測試期間交易資料」是兩回事）。
 */
function clearTestData() {
  return withLock(function () {
    const out = [];

    const recordRows = dbReadAll('Records').map(function (r) { return r._row; });
    dbDeleteRows('Records', recordRows);
    out.push('已清空「紀錄」分頁：' + recordRows.length + ' 筆');

    const ledgerRows = dbReadAll('DailyLedger').map(function (r) { return r._row; });
    dbDeleteRows('DailyLedger', ledgerRows);
    out.push('已清空「每日手動帳目」分頁：' + ledgerRows.length + ' 筆');

    const bizRows = dbReadAll('BizDays').map(function (r) { return r._row; });
    dbDeleteRows('BizDays', bizRows);
    out.push('已清空「營業日」分頁：' + bizRows.length + ' 筆');

    const machines = dbReadAll('Machines');
    machines.forEach(function (m) {
      dbUpdate('Machines', m._row, {
        carry_in: 0, carry_out: 0, carry_prize: 0, carry_chip_in: 0, carry_chip_out: 0
      });
    });
    out.push('已把 ' + machines.length + ' 台機台的「封存前累計」欄位歸零');

    out.push('');
    out.push('機台本身（名稱／位置／顏色／分類／圖案／排序）、快捷金額、獎型、入幣費率、帳號與授權都沒有被動過。');

    const msg = out.join('\n');
    Logger.log(msg);
    return msg;
  });
}

/**
 * 手動執行：只用來讓「匯出對帳表 Excel」需要的新權限（建立/刪除暫存試算表、
 * 對外發出 HTTP 請求）第一次跳出 Google 授權畫面。
 *
 * 部署成 Web App 之後，App 端按「匯出 Excel」是背景呼叫，沒有互動介面可以
 * 顯示授權視窗，第一次遇到還沒授權過的權限只會直接失敗，不會跳出「允許」
 * 畫面——授權畫面只有在編輯器裡手動執行函式時才會出現。這支函式故意只做
 * 最少的事（建一份空試算表、打一次匯出網址、刪掉），跑幾秒鐘就結束，
 * 不用像 runSelfTest 那樣跑完整套測試（在真正的試算表上跑 90 幾項測試，
 * 常常會超過 Apps Script 6 分鐘的執行上限，反而還沒跑到會用到這個權限的
 * 測試就先逾時了）。
 *
 * 用法：編輯器上方函式下拉選單選這支 → 執行 → 跳出畫面就照著「進階」→
 * 「前往（不安全）」→「允許」點下去。跑完看執行紀錄確認印出「授權沒問題」，
 * 之後 App 上的「匯出 Excel」就能正常用了。
 */
function authorizeExportXlsx() {
  const ss = SpreadsheetApp.create('授權測試_可刪除');
  const id = ss.getId();
  try {
    const url = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx';
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code !== 200) {
      throw new Error('匯出網址回傳 HTTP ' + code + '，預期 200。');
    }
    Logger.log('授權沒問題，「匯出 Excel」現在可以正常用了。');
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}

// ────────────────────────────────────────────────────────────
// Test.gs
// ────────────────────────────────────────────────────────────
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
    _invalidateSheetCache('Machines');
    const before = dbReadAll('Machines'); // 目前已經是中文頁籤「機台」
    const beforeCount = before.length;

    // 模擬「用改版前的程式碼建立的舊試算表」：頁籤名稱改回英文鍵值
    ss.getSheetByName(SHEET_TAB_NAMES.Machines).setName('Machines');
    _invalidateSheetCache('Machines');

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

  _t(results, '跨執行快取（CacheService）：dbReadAll 命中快取時直接用快取內容、不會重新讀 Sheets；dbInsert／dbUpdate／dbDeleteRows 寫入後快取要立刻失效', function () {
    // 用最底層的 dbInsert／dbUpdate／dbDeleteRows，不走 adminSaveMachine
    // 這個 API——那支會建立「使用者看得到」的真實機台，讓後面依賴機台
    // 總數的測試對不起來。這裡的機台只是為了驗證快取行為，測完（不管
    // 成功還是斷言失敗）都會在 finally 裡刪乾淨，不留痕跡。
    const tempId = newId('mch');
    dbInsert('Machines', { machine_id: tempId, name: '跨執行快取測試台', sort_order: 999, category: 'dice', status: 'running' });
    _clearSheetCache();

    try {
      const real = dbReadAll('Machines');
      _assert(real.some(function (m) { return m.machine_id === tempId; }), '正常讀取應該看得到剛新增的機台');

      const cachedAfterRead = _crossExecCacheGet('Machines');
      _assert(cachedAfterRead && cachedAfterRead.length === real.length, 'dbReadAll 讀完之後應該把結果寫進跨執行快取');

      // 直接竄改快取內容（塞一筆假機台）：下一次 dbReadAll 如果真的是命中
      // 快取、不是重新打 Sheets，看到的就會是這筆竄改進去的假機台；如果
      // 意外又重新讀了 Sheets，看到的會是真實資料，不會有這筆假機台。
      const fakeRows = real.concat([{ _row: 99999, machine_id: 'fake_from_cache', name: '只存在快取裡的假機台' }]);
      _crossExecCachePut('Machines', fakeRows);
      _clearSheetCache(); // 只清單次執行內那層，跨執行那層要保留才測得出命中

      const hit = dbReadAll('Machines');
      _assert(hit.some(function (m) { return m.machine_id === 'fake_from_cache'; }),
        'dbReadAll 命中跨執行快取時應該直接回傳快取內容，證明真的沒有重新打 Sheets');

      // dbUpdate 寫入之後，跨執行快取應該立刻失效，下一次讀到的要是
      // 真實資料，不會再看到剛才竄改進去的假機台。
      dbUpdate('Machines', dbFind('Machines', 'machine_id', tempId)._row, { note: '改一下觸發快取失效' });
      _assert(!_crossExecCacheGet('Machines'), '寫入之後跨執行快取應該立刻被清掉');

      const afterWrite = dbReadAll('Machines');
      _assert(!afterWrite.some(function (m) { return m.machine_id === 'fake_from_cache'; }),
        '寫入之後重新讀到的應該是真實資料，不會再看到快取竄改進去的假機台');
    } finally {
      dbDeleteRows('Machines', [dbFind('Machines', 'machine_id', tempId)._row]);
    }
  });

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

  _t(results, '每日手動帳目：前端「設定今日數字」已經不收運拿／還內場這兩個舊欄位，不帶這兩個 key 也要能存成功（曾經因為 undefined 被當非法數字擋掉整個請求）', function () {
    const saved = _ok({
      action: 'saveDailyLedger', token: patrolTok,
      turnover: 416000, manualExpense: 500,
      givenToOwnerItems: [{ name: '老王', amount: 1000 }],
      takenByOwnerItems: [], manual432: 0, manual441: 0
    });
    _assertEq(saved.transport, 0, '沒帶運拿時應該當 0，不報錯');
    _assertEq(saved.returnedToHouse, 0, '沒帶還內場時應該當 0，不報錯');
    _assertEq(saved.turnover, 416000, '週轉金要正常存下來');
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
    // 這裡是繞過 dbUpdate() 的原始寫入（模擬「早就存在的壞資料」），跨執行
    // 快取不會自動知道，得手動清掉，不然下面的讀取會撈到清掉之前、還沒
    // 損壞的舊快取值，測試就驗不到真正想模擬的損壞狀態。
    _invalidateSheetCache('Records');

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
    _invalidateSheetCache('Records'); // 繞過 dbUpdate 的原始寫入，見上一個測試同樣的說明

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
    _invalidateSheetCache('Records'); // 繞過 dbUpdate 的原始寫入，見前面同類測試的說明

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
    _invalidateSheetCache('Records');

    const fixedCount = _migrateRecordsMeterColumns();
    _assert(fixedCount >= 1, '應該至少修好剛剛塞的那筆錯位紀錄');
    _invalidateSheetCache('Records');

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

  _t(results, '骰台查詢匯出：不指定機台改指定分類時，各骰台各自算好的小計要加總成整體 rowCount，電子機台不算進去；exportLedgerGrids（匯出截圖用）內容要跟 xlsx 各分頁一致', function () {
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

    // 「📷 匯出截圖」exportLedgerGrids：不用建立/轉存真的 Excel，直接把
    // 每台機台的格線資料整批回傳給前端畫 canvas，內容要跟 exportLedgerXlsx
    // 每個分頁一模一樣。
    const grids = _ok({ action: 'exportLedgerGrids', token: scopedTok, category: 'dice', preset: 'day' });
    _assertEq(grids.machines.length, 2, '只看得到這個台主被授權的兩台骰台，電子機台不算進來');
    _assertEq(grids.machines[0].machineName, '骰台查詢測試Y', '排序照 sort_order，Y（94）排在 X（95）前面');
    _assertEq(grids.machines[1].machineName, '骰台查詢測試X', '排序照 sort_order，X（95）排在 Y 後面');

    const byName = {};
    grids.machines.forEach(function (g) { byName[g.machineName] = g; });
    _assertEq(JSON.stringify(byName['骰台查詢測試X'].headerRow), JSON.stringify(xGrid.headerRow), 'X 的表頭應該跟 exportLedgerXlsx 那個分頁一致');
    _assertEq(JSON.stringify(byName['骰台查詢測試X'].outRows), JSON.stringify(xGrid.outRows), 'X 的出幣逐筆列應該跟 exportLedgerXlsx 那個分頁一致');
    _assertEq(JSON.stringify(byName['骰台查詢測試X'].summaryRows), JSON.stringify(xGrid.summaryRows), 'X 的五列小計應該跟 exportLedgerXlsx 那個分頁一致');
    _assertEq(JSON.stringify(byName['骰台查詢測試Y'].summaryRows), JSON.stringify(yGrid.summaryRows), 'Y 的五列小計應該跟 exportLedgerXlsx 那個分頁一致');

    // 指定單一機台，或完全沒指定分類，都不是這支的使用情境，該直接報錯。
    _fails({ action: 'exportLedgerGrids', token: scopedTok, machineId: diceX, preset: 'day' });
    _fails({ action: 'exportLedgerGrids', token: scopedTok, preset: 'day' });
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

  _t(results, '封存：把上一季以前的紀錄搬到封存分頁，不影響今天的紀錄；機台詳細頁的「本週淨收益」本來就不看 200 天前的舊紀錄，封存前後都不變', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '封存測試台', sortOrder: 96 }).machineId;
    const oldDate = _addDays(todayKey(), -200); // 200 天前，保證是更早的季度，也遠在本週範圍之外

    const oldIn = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 1000, clientToken: newId('ct') }).records[0];
    const oldOut = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'out', amount: 300, clientToken: newId('ct') }).records[0];
    [oldIn, oldOut].forEach(function (rec) {
      const row = dbFind('Records', 'record_id', rec.recordId);
      dbUpdate('Records', row._row, { business_date: oldDate });
    });
    _clearSheetCache();

    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 50, clientToken: newId('ct') });

    const before = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(before.total.in, 50, '封存前：本週淨收益不算 200 天前的舊紀錄，只有今天這 50');
    _assertEq(before.total.out, 0, '封存前：本週累計出幣不受舊紀錄影響');
    _assertEq(before.records.length, 3, '封存前：明細應該看得到全部 3 筆');

    const oldQ = _quarterKey(oldDate);
    const result = archiveOldRecords();
    _assert(result.archived >= 2, '至少應該封存剛剛那兩筆舊紀錄，實際 ' + result.archived);
    _assert(result.quarters.indexOf(oldQ) >= 0, '回傳的季度清單應該包含 ' + oldQ);

    const after = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(after.total.in, 50, '封存後：本週淨收益不變，本來就沒把舊紀錄算進去');
    _assertEq(after.total.out, 0, '封存後：本週累計出幣一樣不變');
    _assertEq(after.records.length, 1, '封存後：明細應該只剩今天那 1 筆，舊的已經搬走');
    _assertEq(after.today.in, 50, '今日彙總不該被封存動到');

    const archiveKey = 'RecordsArchive_' + oldQ;
    const archived = dbReadAll(archiveKey).filter(function (r) { return String(r.machine_id) === mid; });
    _assertEq(archived.length, 2, '封存分頁應該存有剛剛那兩筆舊紀錄');
    _assertEq(configGet('last_archived_quarter', ''), oldQ, 'Config 應該記下最後封存到哪一季');

    const again = archiveOldRecords();
    _assertEq(again.archived, 0, '天生冪等：再跑一次不該重複封存');
  });

  _t(results, '機台詳細頁「累計淨收益」是本週（週日到今天），不是全部歷史；跨夜營業日的紀錄照 business_date（記帳當下 snapshot 好的營業日期）歸類進哪一週，不是看實際寫入的時間戳', function () {
    const mid = _ok({ action: 'adminSaveMachine', token: adminTok, name: '本週淨收益測試台', sortOrder: 97 }).machineId;
    const weekRange = resolveRange('week');

    // 上週最後一天（週六）：模擬「上週記的帳」，不該被算進本週的累計淨收益。
    const lastWeekRec = _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 700, clientToken: newId('ct') }).records[0];
    dbUpdate('Records', dbFind('Records', 'record_id', lastWeekRec.recordId)._row, { business_date: _addDays(weekRange.from, -1) });
    _clearSheetCache();

    // 本週的第一天（週日）：模擬跨夜營業日——營業日是週日晚上開始、跨過
    // 午夜才記帳，記帳當下的實際時間戳已經是「今天」，但 business_date
    // 快照的是營業日開始那天（週日），不是實際寫入當下的日期。
    const started = _ok({ action: 'startBusinessDay', token: patrolTok });
    _assert(started.open, '應該成功開始營業日');
    const bizRow = _openBizDay();
    dbUpdate('BizDays', bizRow._row, { business_date: weekRange.from });
    _clearSheetCache();
    _ok({ action: 'addRecord', token: patrolTok, machineId: mid, type: 'in', amount: 300, clientToken: newId('ct') });
    _ok({ action: 'endBusinessDay', token: adminTok });
    _clearSheetCache();

    // 今天再記一筆，確定也算進本週。
    _ok({ action: 'addRecord', token: adminTok, machineId: mid, type: 'in', amount: 100, clientToken: newId('ct') });

    const detail = _ok({ action: 'machineDetail', token: adminTok, machineId: mid });
    _assertEq(detail.total.in, 400,
      '本週淨收益應該是週日那筆跨夜營業日記的 300 ＋今天的 100 ＝400，上週那筆 700 不該算進來，實際 ' + detail.total.in);
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

