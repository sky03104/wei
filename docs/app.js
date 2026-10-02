/* ============================================================
   娃娃機管理系統 — 前端主程式
   單頁應用，無框架、無 CDN。所有畫面用 DOM API 組出來
   （不用 innerHTML 拼字串，資料一律走 textContent，天生免疫 XSS）。
   ============================================================ */
'use strict';

// ── 像素娃娃機圖案 ──────────────────────────────────────
// 必須與 tools/pixel-machine.txt 一致；改完跑 node tools/check-pixelmap.js 驗證。
const PIXEL_MACHINE = [
  '................',
  '..KKKKKKKKKKKK..',
  '..KLLLLLLLLLLK..',
  '..KLBBBBBBBBLK..',
  '.KKKKKKKKKKKKKK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGCCCCCCCCGBK.',
  '.KBGGGGCCGGGGBK.',
  '.KBGGGCCCCGGGBK.',
  '.KBGGGCGGCGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGGPPGGYYGGBK.',
  '.KBGPPPPGYYYYBK.',
  '.KKKKKKKKKKKKKK.',
  '.KBBBBBBBBBBBBK.',
  '.KBSSBBBBBBWWBK.',
  '.KBBBBBBBBBBBBK.',
  '.KKKKKKKKKKKKKK.',
  '..KK........KK..'
];

/**
 * 其他款式的像素風娃娃機圖案，跟 PIXEL_MACHINE（經典款）並列——
 * 只有經典款是 App 圖示（tools/pixel-machine.txt、tools/make-icons.py）的
 * 權威版本，這幾款是額外的「機台圖案」選項，只用在畫面裡，不影響 App 圖示。
 */
const PIXEL_MACHINE_ROUND = [
  '....KKKKKKKK....',
  '..KKLLLLLLLLKK..',
  '.KKLLLLLLLLLLKK.',
  '.KLBBBBBBBBBBLK.',
  'KKBBBBBBBBBBBBKK',
  '.KBBBBBBBBBBBBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGCCCCCCCCGBK.',
  '.KBGGGGCCGGGGBK.',
  '.KBGGGCCCCGGGBK.',
  '.KBGGGCGGCGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGGYYYYYYGGBK.',
  '.KBGGYYYYYYGGBK.',
  '.KKKKKKKKKKKKKK.',
  '.KBBBBBBBBBBBBK.',
  '.KBSSBBBBBBWWBK.',
  '.KBBBBBBBBBBBBK.',
  '.KKKKKKKKKKKKKK.',
  '..KK........KK..'
];

const PIXEL_MACHINE_TWIN = [
  '.KKKKKKK.KK.KKKKKKK.',
  '.KLLLLLK.KK.KLLLLLK.',
  'KKKKKKKKKKKKKKKKKKKK',
  'KBGGGGGBKKKKBGGGGGBK',
  'KBGCCCGBKKKKBGCCCGBK',
  'KBGGCGGBKKKKBGGCGGBK',
  'KBGGCGGBKKKKBGGCGGBK',
  'KBGPPGGBKKKKBGYYGGBK',
  'KBGPPGGBKKKKBGYYGGBK',
  'KKKKKKKKKKKKKKKKKKKK',
  'KBBBBBBBKKKKBBBBBBBK',
  'KBSBBBBBKKKKBSBBBBBK',
  'KBBBBBBBKKKKBBBBBBBK',
  'KKKKKKKKKKKKKKKKKKKK',
  '.KK...KK.KK.KK...KK.'
];

const PIXEL_MACHINE_TALL = [
  '..KKKKKKKKKKKK..',
  '..KRRRRRRRRRRK..',
  '..KOOOOOOOOOOK..',
  '..KKKKKKKKKKKK..',
  '.KKKKKKKKKKKKKK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGCCCCCCCCGBK.',
  '.KBGGGGCCGGGGBK.',
  '.KBGGGCCCCGGGBK.',
  '.KBGGGCGGCGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGGPPGGYYGGBK.',
  '.KBGPPPPGYYYYBK.',
  '.KKKKKKKKKKKKKK.',
  '.KBBBBBBBBBBBBK.',
  '.KBSSBBBBBBWWBK.',
  '.KBBBBBBBBBBBBK.',
  '.KKKKKKKKKKKKKK.',
  '..KK........KK..'
];

/**
 * 夾骰子機：跟經典款共用同一套機身／爪子，把底下的娃娃換成兩顆有點數的骰子。
 * 左邊「一點」骰子的點是紅色（R）——很多實體骰子的「1」點就是印紅色，
 * 使用者看過黑白版之後特別要求改的。
 */
const PIXEL_MACHINE_DICE = [
  '................',
  '..KKKKKKKKKKKK..',
  '..KLLLLLLLLLLK..',
  '..KLBBBBBBBBLK..',
  '.KKKKKKKKKKKKKK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGCCCCCCCCGBK.',
  '.KBGGGGCCGGGGBK.',
  '.KBGGGCCCCGGGBK.',
  '.KBGGGCGGCGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBWWWWGGWKWWBK.',
  '.KBWWWWGGWWWWBK.',
  '.KBWRRWGGWWWWBK.',
  '.KBWWWWGGWWKWBK.',
  '.KKKKKKKKKKKKKK.',
  '.KBBBBBBBBBBBBK.',
  '.KBSSBBBBBBWWBK.',
  '.KBBBBBBBBBBBBK.',
  '.KKKKKKKKKKKKKK.',
  '..KK........KK..'
];

/** 單顆骰子、六點的娃娃機：跟經典款共用機身／爪子，底下換成一顆大骰子，六點排成 2 欄 3 列。 */
const PIXEL_MACHINE_SIXDICE = [
  '................',
  '..KKKKKKKKKKKK..',
  '..KLLLLLLLLLLK..',
  '..KLBBBBBBBBLK..',
  '.KKKKKKKKKKKKKK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGCCCCCCCCGBK.',
  '.KBGGGGCCGGGGBK.',
  '.KBGGGCCCCGGGBK.',
  '.KBGGGCGGCGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGGGGGGGGGGBK.',
  '.KBGWWWWWWWWGBK.',
  '.KBGWKKWWKKWGBK.',
  '.KBGWKKWWKKWGBK.',
  '.KBGWWWWWWWWGBK.',
  '.KBGWKKWWKKWGBK.',
  '.KBGWKKWWKKWGBK.',
  '.KBGWWWWWWWWGBK.',
  '.KBGWKKWWKKWGBK.',
  '.KBGWKKWWKKWGBK.',
  '.KBGWWWWWWWWGBK.',
  '.KKKKKKKKKKKKKK.',
  '.KBBBBBBBBBBBBK.',
  '.KBSSBBBBBBWWBK.',
  '.KBBBBBBBBBBBBK.',
  '.KKKKKKKKKKKKKK.',
  '..KK........KK..'
];

/** 圖案鍵值 → 對應的像素圖陣列；經典款以外都是後來新增的機台圖案選項。 */
const MACHINE_ICON_MAPS = {
  classic: PIXEL_MACHINE,
  round: PIXEL_MACHINE_ROUND,
  twin: PIXEL_MACHINE_TWIN,
  tall: PIXEL_MACHINE_TALL,
  dice: PIXEL_MACHINE_DICE,
  sixdice: PIXEL_MACHINE_SIXDICE
};
const MACHINE_ICON_LABELS = { classic: '經典', round: '圓頂', twin: '雙爪', tall: '招牌', dice: '骰子', sixdice: '六點骰' };
const DEFAULT_MACHINE_ICON = 'classic';

const STATUS_COLORS = { running: '#4ADE80', maintenance: '#FBBF24', offline: '#6B7488' };
const STATUS_LABELS = { running: '營運中', maintenance: '維修中', offline: '停機' };
const TYPE_LABELS = { in: '入幣', out: '出幣', prize: '活動', chip_in: '開分', chip_out: '洗分' };
const MACHINE_COLORS = ['#4F7BE8', '#E8574F', '#4ADE80', '#FBBF24', '#C084FC', '#22D3EE', '#F472B6', '#94A3B8'];

const STORAGE_TOKEN = 'claw_token';
const STORAGE_REMEMBER = 'claw_remember';
const STORAGE_LAST_USER = 'claw_last_username'; // 上次登入的帳號（不含密碼），登入頁自動帶入
const POLL_MS = 300000;

/** Phase 5 雙軌驗證用（supabase/MIGRATION_PLAN.md）：'gas'（預設，跟現在
 *  完全一樣）或 'supabase'（改走 supabaseApi()，見 api() 附近的說明）。 */
const BACKEND = (window.APP_CONFIG && window.APP_CONFIG.BACKEND) || 'gas';

/** 前端版本號，登入頁顯示用，方便確認手機上是不是最新版。
 *  跟 sw.js 的 CACHE_VERSION 手動保持一致——每次改前端兩個都要加。 */
const APP_VERSION = 'v67';

// ── 狀態 ────────────────────────────────────────────────

const state = {
  token: null,
  remember: false,
  user: null,
  view: 'boot',
  machineId: null,
  home: null,
  detail: null,
  report: null,
  admin: null,
  panel: null,        // 'in' | 'out' | 'prize' | 'chip_in' | 'chip_out' | null
  homeTab: 'dice',    // 首頁分頁籤：'dice' 骰台（預設）| 'electronic' 電子 | 'total' 加總
  editMode: false,
  prizeCounts: {},
  reportParams: { machineId: '', category: '', preset: 'day', from: '', to: '', type: '', userId: '' },
  activityParams: { from: '', to: '' },
  activityResult: null,
  adminTab: 'users',
  permExpanded: {}, // 台主授權頁每個台主的卡片是否展開，key 是 userId
  busy: false,
  // 導覽用的「先秒開、背景再刷新」快取（stale-while-revalidate）。
  // 純記憶體、關頁就沒了，而且每次進畫面一定會立刻再打一次 API 確認最新資料，
  // 只是不讓使用者對著空白畫面等那一趟網路來回——跟 sw.js 刻意不快取 API
  // 回應的規則不衝突：那條規則防的是「回應被存起來、之後可能完全不再連網
  // 就一直拿舊資料」，這裡永遠都會再打一次，只是不擋畫面先出來。
  cache: {}
};

let pollTimer = null;

// ── 小工具 ──────────────────────────────────────────────

/** 建立元素。children 可以是字串、節點或陣列；字串一律當文字，不當 HTML。 */
function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'disabled' || k === 'checked' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v);
    });
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  if (children === null || children === undefined) return;
  if (Array.isArray(children)) {
    children.forEach((c) => appendChildren(el, c));
  } else if (children instanceof Node) {
    el.appendChild(children);
  } else {
    el.appendChild(document.createTextNode(String(children)));
  }
}

function money(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
  return (v < 0 ? '-$' : '$') + abs;   // 負數要寫成 -$200，不是 $-200
}

function netClass(n) {
  return Number(n) > 0 ? 'pos' : (Number(n) < 0 ? 'neg' : 'zero');
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 'yyyy-MM-dd' → 「8月24日」，跟 apps-script/Reports.gs 的 _dayKeyToLabel 同一種寫法（不補零）。 */
function dayKeyToLabel(key) {
  const p = String(key).split('-');
  return Number(p[1]) + '月' + Number(p[2]) + '日';
}

function formatTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return sameDay ? time : (pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + time);
}

function todayInputValue() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 給「自訂」區間日期選擇器的下限用：n 個月前的今天，'yyyy-MM-dd'。 */
function monthsAgoInputValue(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function uuid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'ct-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function lighten(hex, amount) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#86A9FF';
  const num = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return '#' + [16, 8, 0]
    .map((shift) => mix((num >> shift) & 255).toString(16).padStart(2, '0'))
    .join('');
}

let toastTimer = null;
function toast(message, kind) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 4200 : 2400);
}

/** 馬上收掉目前的提示（例如登入成功時，剛剛那句「帳號或密碼錯誤」不要跟著進首頁）。 */
function hideToast() {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.hidden = true;
}

// ── 動態效果（docs/ui_fx.js）────────────────────────────
// ui_fx.js 提供的函式都掛在 window.fx…；這裡每個都先確認存在，沒載到（例如手機上
// 還是舊版快取）就退回原本的行為，不影響功能。
// 注意：這裡的函式名稱不能用 fx 開頭——app.js 不是 module，最外層的 function
// 會變成 window 上的同名屬性，會把 ui_fx.js 的函式蓋掉。

/** 漏填／填錯的欄位：跳出錯誤提示，並把那一格紅框、抖一下、游標跳過去。 */
function fieldError(input, message) {
  toast(message, 'error');
  if (typeof window.fxFieldError === 'function') window.fxFieldError(input);
}

/**
 * 刪除／作廢成功後、重畫清單之前呼叫：按下去的那一列先往左滑出收起來
 * （ui_fx.js 在按下刪除鈕的當下就記住是哪一列）。找不到那一列、只剩一筆、
 * 或 ui_fx.js 沒載到時，馬上往下做。
 */
function collapseDeletedRow() {
  return new Promise((resolve) => {
    if (typeof window.fxRemoveThen === 'function') window.fxRemoveThen(resolve);
    else resolve();
  });
}

/** 骨架畫面的一條灰色閃光（樣式在 ui_fx.css）；寬度可以給數字（px）或百分比字串。 */
function skBar(width, height, extraStyle) {
  return h('span', {
    class: 'fx-sk',
    style: 'width:' + (typeof width === 'number' ? width + 'px' : width) + ';height:' + height + 'px;' + (extraStyle || '')
  });
}

/** 骨架版的數字方塊（跟真的 statBox 一樣大小）。 */
function skStat() {
  return h('div', { class: 'fx-sk-stat' }, [skBar('56%', 12, 'margin:0 auto'), skBar('72%', 20, 'margin:8px auto 0')]);
}

/** 骨架版的一筆紀錄（標籤＋兩行字＋金額）。 */
function skRecordRow() {
  return h('div', { class: 'fx-sk-row' }, [
    skBar(40, 20, 'border-radius:999px;flex:0 0 auto'),
    h('div', { class: 'fx-sk-grow' }, [skBar('70%', 14), skBar('40%', 12, 'margin-top:6px')]),
    skBar(64, 16, 'flex:0 0 auto')
  ]);
}

/**
 * 資料還沒回來時的畫面。ui_fx.js 有載到就畫「跟真畫面同一個版面」的骨架，
 * 資料到了換上去時位置不會跳；沒載到就維持原本的轉圈圈。
 * 版面 class 都是 fx-sk- 開頭（見 ui_fx.css）：外觀跟真的一樣，但不用 .detail-hero、
 * .admin-item 這些真的 class，免得程式或測試把骨架誤當成資料已經到了。
 * 最外層一律是 .fx-sk-view，render() 用它認出「剛剛畫的是骨架」。
 */
function loadingView(kind) {
  if (typeof window.fxSkeletonCards !== 'function') {
    return h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' })]);
  }
  const root = { class: 'fx-sk-view', 'aria-busy': 'true', 'aria-label': '讀取中' };

  if (kind === 'home') {
    return h('div', root, [
      h('div', { class: 'fx-sk-row', style: 'justify-content:space-between;margin-bottom:4px' }, [
        h('div', {}, [skBar(96, 24), skBar(128, 14, 'margin-top:8px')]),
        skBar(64, 34, 'border-radius:9px;flex:0 0 auto')
      ]),
      h('div', { class: 'fx-sk-stats fx-sk-3' }, [1, 2, 3, 4, 5, 6].map(skStat)),
      h('div', { html: window.fxSkeletonCards(3, '正在讀取機台資料…') })
    ]);
  }

  if (kind === 'machine') {
    return h('div', root, [
      h('div', { class: 'fx-sk-row' }, [
        skBar(77, 96, 'border-radius:10px;flex:0 0 auto'),
        h('div', { class: 'fx-sk-grow' }, [skBar('60%', 22), skBar('40%', 14, 'margin-top:8px'), skBar(52, 20, 'margin-top:8px;border-radius:999px')])
      ]),
      h('div', { class: 'fx-sk-figs' }, [
        h('div', { class: 'fx-sk-stat' }, [skBar('46%', 12, 'margin:0 auto'), skBar('38%', 34, 'margin:10px auto 0'), skBar('30%', 12, 'margin:10px auto 0')]),
        skStat(), skStat(), skStat()
      ]),
      h('div', { class: 'fx-sk-box' }, [
        skBar(96, 17),
        h('div', { style: 'display:grid;gap:14px;margin-top:14px' }, [skRecordRow(), skRecordRow(), skRecordRow()])
      ])
    ]);
  }

  if (kind === 'report' || kind === 'activity') {
    return h('div', root, [
      h('div', { class: 'fx-sk-stats fx-sk-4' }, Array.from({ length: kind === 'report' ? 4 : 3 }, skStat)),
      kind === 'report'
        ? h('div', { class: 'fx-sk-box' }, [skBar(128, 17), skBar('100%', 160, 'margin-top:12px;border-radius:8px')])
        : null,
      kind === 'report'
        ? h('div', { class: 'fx-sk-box' }, [skBar(80, 17), h('div', { style: 'display:grid;gap:12px;margin-top:14px' }, [1, 2, 3, 4].map(() => skBar('100%', 16)))])
        : null
    ]);
  }

  // 系統管理的清單（帳號／機台／獎型…）
  return h('div', root, [1, 2, 3, 4].map(() => h('div', { class: 'fx-sk-item' }, [
    h('div', { style: 'flex:1;min-width:0' }, [skBar('45%', 16), skBar('65%', 12, 'margin-top:6px')]),
    skBar(52, 34, 'border-radius:9px;flex:0 0 auto')
  ])));
}

/**
 * 空白提示（還沒有紀錄、還沒有機台…）：上面放一台灰色的像素娃娃機在打瞌睡，
 * 頭上飄「z z z」（ui_fx.css 的 .sleepy），不會只有一行字。
 * z 是用 CSS 的 content 畫的，不算在文字內容裡，textContent 還是只有提示文字。
 * extraClass：例如 'card'（整塊卡片樣式）；size：娃娃機的高度（面板裡用小一點的）。
 */
function emptyState(text, extraClass, size) {
  return h('div', { class: 'empty empty-art' + (extraClass ? ' ' + extraClass : '') }, [
    h('div', { class: 'sleepy', 'aria-hidden': 'true' }, [
      machineSvg(size || 52, '#5B6478', 'offline', DEFAULT_MACHINE_ICON, { still: true }),
      h('span', { class: 'zzz' }, [h('i'), h('i'), h('i')])
    ]),
    h('p', { text: text })
  ]);
}

// ── 像素娃娃機 SVG ──────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, String(attrs[k])));
  return el;
}

/**
 * 找出某一款圖案裡「會動的零件」在哪幾格，每一款都用同一套規則，不用各寫一份：
 *   橫桿：第一排出現 C 的那一排（不動）
 *   爪子：橫桿以下的 C；左右能晃幾格、能往下降幾格，看旁邊／底下還有幾格空的玻璃（G）
 *   娃娃：爪子底下、玻璃櫃裡的 P／Y／W／R／O（骰子的黑點 K 夾在白格中間，也算骰子的一部分），
 *         上下左右相連的算同一個（一次跳一個）
 *   燈泡：玻璃櫃上面招牌區的 L（「招牌」款是紅、橘兩排 R／O）
 *   投幣口：玻璃櫃下面的 W
 * 分析結果照款式快取起來。
 */
const _machinePartsCache = {};
function machinePartsOf(icon) {
  const key = MACHINE_ICON_MAPS[icon] ? icon : DEFAULT_MACHINE_ICON;
  if (_machinePartsCache[key]) return _machinePartsCache[key];
  const map = MACHINE_ICON_MAPS[key];
  const rows = map.length;
  const cols = map[0].length;
  const at = (x, y) => (y >= 0 && y < rows && x >= 0 && x < cols ? map[y][x] : '.');

  let railRow = -1;
  let firstGlassRow = -1;
  let glassBottom = -1;
  for (let y = 0; y < rows; y++) {
    if (railRow < 0 && map[y].indexOf('C') >= 0) railRow = y;
    if (map[y].indexOf('G') >= 0) {
      if (firstGlassRow < 0) firstGlassRow = y;
      glassBottom = y;
    }
  }

  const role = map.map((line) => line.split('').map(() => ''));
  const clawCells = [];
  let clawBottom = -1;
  for (let y = railRow + 1; y <= glassBottom; y++) {
    for (let x = 0; x < cols; x++) {
      if (map[y][x] === 'C') { role[y][x] = 'claw'; clawCells.push([x, y]); clawBottom = Math.max(clawBottom, y); }
    }
  }

  // 左右能晃幾格：每一段爪子往左／往右數，碰到「不是玻璃也不是爪子」的格子就停；
  // 取最緊的那一段再留一格空隙，最多 2 格
  const freeToward = (x, y, dx) => {
    let n = 0;
    for (let cx = x + dx; ; cx += dx) {
      const ch = at(cx, y);
      if (ch === 'G' || role[y][cx] === 'claw') n++;
      else break;
    }
    return n;
  };
  let sway = 2;
  clawCells.forEach(([x, y]) => {
    if (role[y][x - 1] !== 'claw') sway = Math.min(sway, freeToward(x, y, -1) - 1);
    if (role[y][x + 1] !== 'claw') sway = Math.min(sway, freeToward(x, y, 1) - 1);
  });
  sway = Math.max(0, sway);

  // 往下能降幾格：每一欄最底下那格爪子，底下還有幾格玻璃；最多 2 格（剛好碰到娃娃）
  let drop = 2;
  const lowest = {};
  clawCells.forEach(([x, y]) => { lowest[x] = Math.max(lowest[x] === undefined ? -1 : lowest[x], y); });
  Object.keys(lowest).forEach((xs) => {
    const x = Number(xs);
    let n = 0;
    for (let y = lowest[x] + 1; y <= glassBottom && at(x, y) === 'G'; y++) n++;
    drop = Math.min(drop, n);
  });
  drop = clawCells.length ? drop : 0;

  // 纜繩：爪子往下降時，橫桿跟爪子中間露出來的那一段（位置＝爪子最上面那一排）
  const cables = [];
  if (drop > 0) {
    const top = railRow + 1;
    for (let x = 0; x < cols; x++) {
      if (role[top][x] === 'claw' && role[top][x - 1] !== 'claw') {
        let w = 1;
        while (role[top][x + w] === 'claw') w++;
        cables.push({ x: x, y: top, w: w });
      }
    }
  }

  // 娃娃（骰子）：爪子底下、玻璃櫃裡的東西，相連的一組
  const isPrizeCell = (x, y) => {
    const ch = at(x, y);
    if ('PYWRO'.indexOf(ch) >= 0) return true;
    return ch === 'K' && (at(x - 1, y) === 'W' || at(x + 1, y) === 'W');
  };
  for (let y = clawBottom + 1; y <= glassBottom; y++) {
    for (let x = 0; x < cols; x++) if (isPrizeCell(x, y)) role[y][x] = 'prize';
  }
  const prizes = [];
  const seen = {};
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (role[y][x] !== 'prize' || seen[x + ',' + y]) continue;
      const cells = [];
      const stack = [[x, y]];
      seen[x + ',' + y] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        cells.push([cx, cy]);
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const nx = cx + dx;
          const ny = cy + dy;
          if (role[ny] && role[ny][nx] === 'prize' && !seen[nx + ',' + ny]) { seen[nx + ',' + ny] = true; stack.push([nx, ny]); }
        });
      }
      const xs = cells.map((c) => c[0]);
      prizes.push({ cells: cells, minX: Math.min.apply(null, xs), maxX: Math.max.apply(null, xs) });
    }
  }

  // 招牌燈泡、投幣口
  const bulbs = [];
  const slot = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ch = map[y][x];
      if (y < firstGlassRow && (ch === 'L' || ch === 'R' || ch === 'O')) bulbs.push([x, y]);
      if (y > glassBottom && ch === 'W') slot.push([x, y]);
    }
  }

  const clawXs = clawCells.map((c) => c[0]);
  const parts = {
    rows: rows, cols: cols, role: role, sway: sway, drop: drop, cables: cables, prizes: prizes, bulbs: bulbs,
    slot: slot, glassBottom: glassBottom,
    clawMinX: clawXs.length ? Math.min.apply(null, clawXs) : 0,
    clawMaxX: clawXs.length ? Math.max.apply(null, clawXs) : 0
  };
  _machinePartsCache[key] = parts;
  return parts;
}

/** 字串→穩定的小整數（讓每台機台的動畫節奏固定錯開，重畫也一樣）。 */
function hashSeed(str) {
  let n = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 100000;
  return n * 997;
}

/**
 * 把某一款像素圖案展開成 SVG。icon 對應 MACHINE_ICON_MAPS 的鍵值，
 * 沒給或給了不認得的鍵值就落回經典款。
 * 同一個函式供首頁小圖、詳細頁大圖、登入頁使用，只有一份圖案定義。
 * 相鄰同色的格子會合併成一個 rect，節點數少一半以上。
 *
 * 會動的零件（爪子、娃娃、招牌燈泡，見 machinePartsOf）另外包成群組疊在最上面，
 * 原位補上玻璃色，零件移開時看到的是玻璃。營運中的機台（px-alive）零件會自己動：
 * 招牌跑馬燈、爪子左右晃＋偶爾下去抓一下、娃娃偶爾跳一下（styles.css 的「像素娃娃機會動的部分」）。
 * 記帳時的反應（掉金幣、夾娃娃…）由 machineAct() 播。
 * opts.still：只要靜態圖（例如選圖案的小按鈕），不拆零件、不動；
 * opts.seed：讓這台的節奏跟別台錯開的種子（通常給機台編號）。
 */
function machineSvg(height, bodyColor, status, icon, opts) {
  const o = opts || {};
  const map = MACHINE_ICON_MAPS[icon] || MACHINE_ICON_MAPS[DEFAULT_MACHINE_ICON];
  const rows = map.length;
  const cols = map[0].length;
  const unit = height / rows;
  const width = cols * unit;
  const parts = o.still ? null : machinePartsOf(icon);
  const alive = !!parts && (status || 'running') === 'running';

  const palette = {
    K: '#0B0E14',
    B: bodyColor || '#4F7BE8',
    L: lighten(bodyColor || '#4F7BE8', 0.35),
    G: '#1B2333',
    C: '#B8C0D0',
    W: '#FFFFFF',
    P: '#FF6FA5',
    Y: '#FFD34D',
    S: STATUS_COLORS[status] || STATUS_COLORS.running,
    R: '#E8574F',
    O: '#FBBF24'
  };

  const svg = svgEl('svg', {
    class: 'pixel-machine' + (alive ? ' px-alive' : ''),
    width: Math.round(width),
    height: Math.round(height),
    viewBox: '0 0 ' + cols + ' ' + rows,
    role: 'img',
    'aria-label': '娃娃機（' + (STATUS_LABELS[status] || '營運中') + '）'
  });
  if (alive) {
    // 動畫的起點用「現在幾點」算：同一台機台重畫（背景更新、記帳後）時接著原本的節奏，不會跳回開頭。
    // 24 秒是所有零件動畫週期的公倍數（爪子 8 秒、雙爪 6 秒、燈泡 1.2 秒、娃娃 6 秒）
    svg.style.setProperty('--px-t', -((Date.now() + hashSeed(o.seed)) % 24000) + 'ms');
  }

  // 底圖：零件的位置先畫成玻璃色
  const cellChar = (x, y) => (parts && parts.role[y][x] ? 'G' : map[y][x]);
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      const ch = cellChar(x, y);
      let run = 1;
      while (x + run < cols && cellChar(x + run, y) === ch) run++;
      if (ch !== '.') {
        const rect = svgEl('rect', { x: x, y: y, width: run, height: 1, fill: palette[ch] || '#000' });
        if (ch === 'S') rect.setAttribute('class', 'status-light ' + (status || 'running'));
        svg.appendChild(rect);
      }
      x += run;
    }
  }
  if (!parts) return svg;

  // 把一組格子畫成一個群組（同一排相鄰的合併成一個 rect）
  const drawGroup = (cells, cls, colorOf) => {
    const g = svgEl('g', { class: cls });
    const byRow = {};
    cells.forEach(([x, y]) => { (byRow[y] = byRow[y] || []).push(x); });
    Object.keys(byRow).forEach((ys) => {
      const y = Number(ys);
      const xs = byRow[y].sort((a, b) => a - b);
      let i = 0;
      while (i < xs.length) {
        let j = i;
        while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1 && colorOf(xs[j + 1], y) === colorOf(xs[i], y)) j++;
        g.appendChild(svgEl('rect', { x: xs[i], y: y, width: j - i + 1, height: 1, fill: colorOf(xs[i], y) }));
        i = j + 1;
      }
    });
    return g;
  };
  const mapColor = (x, y) => palette[map[y][x]] || '#000';

  // 娃娃：一個一組，各自錯開跳的時間
  const prizeGroups = parts.prizes.map((p, i) => {
    const g = drawGroup(p.cells, 'px-prize', mapColor);
    g.style.setProperty('--px-o', (i * 1700 + 600) + 'ms');
    svg.appendChild(g);
    return g;
  });

  // 纜繩（平常縮成 0 高、看不到；爪子往下時才拉長）
  const cableEls = parts.cables.map((c) => {
    const r = svgEl('rect', { class: 'px-cable px-drop-' + parts.drop, x: c.x, y: c.y, width: c.w, height: parts.drop, fill: palette.C });
    svg.appendChild(r);
    return r;
  });

  // 爪子
  const clawCells = [];
  parts.role.forEach((line, y) => line.forEach((r, x) => { if (r === 'claw') clawCells.push([x, y]); }));
  const claw = drawGroup(clawCells, 'px-claw px-sway-' + parts.sway + ' px-drop-' + parts.drop, mapColor);
  svg.appendChild(claw);

  // 招牌燈泡：只有營運中的機台有；照 x 分成三組輪流亮，看起來像往右跑的跑馬燈
  if (alive && parts.bulbs.length) {
    [0, 1, 2].forEach((k) => {
      const cells = parts.bulbs.filter(([x]) => x % 3 === k);
      if (cells.length) svg.appendChild(drawGroup(cells, 'px-bulbs px-bulbs-' + k, () => '#FFF4C4'));
    });
  }

  // 投幣口（掉金幣時亮一下用）
  const slotRects = [];
  svg.querySelectorAll('rect').forEach((r) => {
    const x = Number(r.getAttribute('x'));
    const y = Number(r.getAttribute('y'));
    if (parts.slot.some(([sx, sy]) => sx === x && sy === y)) slotRects.push(r);
  });

  svg._px = { parts: parts, claw: claw, cables: cableEls, prizes: prizeGroups, slotRects: slotRects, unit: unit };
  if (alive) watchMachineVisibility(svg);
  return svg;
}

/**
 * 捲到畫面外的機台先停下來（.px-off），回到畫面上再接著動——機台一多（二、三十台），
 * 全部一起動會讓手機一直在重畫看不到的東西、比較耗電。停的時候節奏照樣用 --px-t 對時，
 * 捲回來不會整排從頭開始。
 */
let _pxObserver = null;
function watchMachineVisibility(svg) {
  if (!('IntersectionObserver' in window)) return;
  if (!_pxObserver) {
    _pxObserver = new IntersectionObserver((entries) => {
      entries.forEach((en) => en.target.classList.toggle('px-off', !en.isIntersecting));
    }, { rootMargin: '80px 0px' });
  }
  svg.classList.add('px-off'); // 還沒確認看得到之前先停著，觀察器一回報就開始動
  _pxObserver.observe(svg);
}

/**
 * 讓一台像素娃娃機做一個動作（記帳時的反應、登入頁的互動）：
 *   'grab'     爪子下去抓一下，把底下的娃娃帶上來一點再放掉（活動、登入成功、點登入頁的娃娃機）
 *   'coinIn'   一枚金幣從上面掉進投幣口，投幣口亮一下（入幣、開分）
 *   'coinOut'  一枚金幣從出口彈出來（出幣、洗分）
 *   'shake'    整台左右搖一下（作廢、登入失敗）
 *   'powerOn'  燈亮起來（營業開始）／'powerOff' 燈熄掉再恢復（結單）
 * 一律一格一格跳（steps），維持像素風。用 Web Animations 疊在平常的動畫上面，做完就拿掉，
 * 平常的跑馬燈、爪子晃動接著原本的節奏繼續。
 * 回傳 Promise，做完才 resolve；手機開了「減少動態效果」或這台沒有零件時馬上 resolve。
 */
function machineAct(svg, kind) {
  return new Promise((resolve) => {
    try {
      const reduced = typeof window.fxReduced === 'function' ? window.fxReduced() : false;
      if (!svg || !svg.animate || reduced) { resolve(); return; }
      const px = svg._px;
      const step = (frames) => frames.map((f) => Object.assign({ easing: 'steps(1, end)' }, f));
      const finish = (anim) => {
        let done = false;
        const go = () => { if (!done) { done = true; resolve(); } };
        anim.onfinish = go;
        anim.oncancel = go;
        setTimeout(go, (anim.effect && anim.effect.getTiming().duration || 1000) + 400);
      };

      if (kind === 'shake') {
        const u = Math.max(2, Math.round(px ? px.unit : 4));
        finish(svg.animate(step([
          { translate: '0 0' }, { translate: -u + 'px 0', offset: 0.15 }, { translate: u + 'px 0', offset: 0.35 },
          { translate: -u + 'px 0', offset: 0.55 }, { translate: u + 'px 0', offset: 0.75 }, { translate: '0 0', offset: 0.9 },
          { translate: '0 0' }
        ]), { duration: 420 }));
        return;
      }
      if (kind === 'powerOn') {
        finish(svg.animate([
          { filter: 'brightness(0.3) saturate(0.2)' }, { filter: 'brightness(1.5)', offset: 0.25 },
          { filter: 'brightness(0.45) saturate(0.4)', offset: 0.4 }, { filter: 'brightness(1.3)', offset: 0.6 },
          { filter: 'brightness(1)' }
        ], { duration: 700, easing: 'steps(1, end)' }));
        return;
      }
      if (kind === 'powerOff') {
        finish(svg.animate([
          { filter: 'brightness(1)' }, { filter: 'brightness(0.3) saturate(0.25)', offset: 0.2 },
          { filter: 'brightness(0.3) saturate(0.25)', offset: 0.75 }, { filter: 'brightness(1)' }
        ], { duration: 1300, easing: 'ease-in-out' }));
        return;
      }
      if (!px) { resolve(); return; }
      const P = px.parts;

      if (kind === 'grab') {
        const D = P.drop;
        if (!D) {
          // 雙爪這種沒空間往下的：原地左右扭一下
          finish(px.claw.animate(step([
            { transform: 'translate(0px, 0px)' }, { transform: 'translate(-1px, 0px)', offset: 0.25 },
            { transform: 'translate(1px, 0px)', offset: 0.5 }, { transform: 'translate(0px, 0px)', offset: 0.75 },
            { transform: 'translate(0px, 0px)' }
          ]), { duration: 600 }));
          return;
        }
        // 時間軸（1 秒）：0.1 起一格一格往下 → 停在底下（夾）→ 0.5 起一格一格往上，娃娃跟著上來 →
        // 在頂上停一下 → 0.85 起娃娃一格一格掉回去
        const down = [];
        const up = [];
        for (let i = 1; i <= D; i++) down.push({ y: i, at: 0.1 * i });
        for (let i = D - 1; i >= 0; i--) up.push({ y: i, at: 0.5 + 0.1 * (D - 1 - i) });
        const clawFrames = [{ transform: 'translate(0px, 0px)', offset: 0 }]
          .concat(down.map((s) => ({ transform: 'translate(0px, ' + s.y + 'px)', offset: s.at })))
          .concat(up.map((s) => ({ transform: 'translate(0px, ' + s.y + 'px)', offset: s.at })))
          .concat([{ transform: 'translate(0px, 0px)', offset: 1 }]);
        const cableFrames = [{ transform: 'scaleY(0)', offset: 0 }]
          .concat(down.map((s) => ({ transform: 'scaleY(' + (s.y / D) + ')', offset: s.at })))
          .concat(up.map((s) => ({ transform: 'scaleY(' + (s.y / D) + ')', offset: s.at })))
          .concat([{ transform: 'scaleY(0)', offset: 1 }]);
        const anim = px.claw.animate(step(clawFrames), { duration: 1000 });
        px.cables.forEach((c) => c.animate(step(cableFrames), { duration: 1000 }));
        // 帶上來的娃娃：跟爪子左右重疊最多的那一個
        let best = null;
        let bestOverlap = 0;
        P.prizes.forEach((p, i) => {
          const overlap = Math.min(p.maxX, P.clawMaxX) - Math.max(p.minX, P.clawMinX) + 1;
          if (overlap > bestOverlap) { bestOverlap = overlap; best = px.prizes[i]; }
        });
        if (best) {
          const lift = [{ transform: 'translate(0px, 0px)', offset: 0 }]
            .concat(up.map((s) => ({ transform: 'translate(0px, ' + (s.y - D) + 'px)', offset: s.at })))
            .concat([{ transform: 'translate(0px, ' + -D + 'px)', offset: 0.85 }]);
          for (let i = D - 1; i >= 0; i--) lift.push({ transform: 'translate(0px, ' + -i + 'px)', offset: 0.85 + 0.05 * (D - i) });
          lift.push({ transform: 'translate(0px, 0px)', offset: 1 });
          best.animate(step(lift), { duration: 1000 });
        }
        finish(anim);
        return;
      }

      if (kind === 'coinIn' || kind === 'coinOut') {
        // 投幣口：玻璃櫃下面的白格；沒有投幣口的款式（雙爪）就落在機台正中央下方
        const sx = P.slot.length ? Math.min.apply(null, P.slot.map((c) => c[0])) : Math.floor(P.cols / 2) - 1;
        const sy = P.slot.length ? P.slot[0][1] : P.glassBottom + 2;
        const coin = svgEl('g', { class: 'px-coin' });
        [[0, 0, '#FFF1A8'], [1, 0, '#FFD34D'], [0, 1, '#FFD34D'], [1, 1, '#D9A300']].forEach(([cx, cy, fill]) => {
          coin.appendChild(svgEl('rect', { x: sx + cx, y: cy, width: 1, height: 1, fill: fill }));
        });
        svg.appendChild(coin);
        let anim;
        if (kind === 'coinIn') {
          // 從機台上面外面一路掉到投幣口上方，消失的那一下投幣口亮起來
          const from = -3;
          const to = sy - 2;
          anim = coin.animate([
            { transform: 'translate(0px, ' + from + 'px)', opacity: 1, easing: 'steps(' + (to - from) + ', end)' },
            { transform: 'translate(0px, ' + to + 'px)', opacity: 1, offset: 0.8 },
            { transform: 'translate(0px, ' + to + 'px)', opacity: 0, offset: 0.81 },
            { transform: 'translate(0px, ' + to + 'px)', opacity: 0 }
          ], { duration: 800 });
          px.slotRects.forEach((r) => r.animate(step([
            { fill: '#FFFFFF' }, { fill: '#FFD34D', offset: 0.8 }, { fill: '#FFFFFF', offset: 0.95 }, { fill: '#FFFFFF' }
          ]), { duration: 900 }));
        } else {
          // 從投幣口跳出來：往右上彈兩格，再往右下掉出機台外面淡掉
          anim = coin.animate(step([
            { transform: 'translate(0px, ' + (sy - 1) + 'px)', opacity: 1 },
            { transform: 'translate(1px, ' + (sy - 3) + 'px)', offset: 0.15 },
            { transform: 'translate(2px, ' + (sy - 4) + 'px)', offset: 0.3 },
            { transform: 'translate(3px, ' + (sy - 3) + 'px)', offset: 0.45 },
            { transform: 'translate(4px, ' + (sy - 1) + 'px)', offset: 0.6, opacity: 1 },
            { transform: 'translate(5px, ' + (sy + 1) + 'px)', offset: 0.75, opacity: 0.6 },
            { transform: 'translate(6px, ' + (sy + 3) + 'px)', offset: 0.9, opacity: 0.2 },
            { transform: 'translate(6px, ' + (sy + 3) + 'px)', opacity: 0 }
          ]), { duration: 800 });
        }
        const cleanup = () => { if (coin.parentNode) coin.parentNode.removeChild(coin); };
        anim.addEventListener('finish', cleanup);
        anim.addEventListener('cancel', cleanup);
        finish(anim);
        return;
      }
      resolve();
    } catch (err) {
      resolve(); // 動畫失敗不能擋住登入、記帳
    }
  });
}

// ── API ─────────────────────────────────────────────────

function ApiError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 統一的 API 入口，兩條後端路徑的唯一分岔點。
 *
 * BACKEND 預設 'gas'（config.js），走原本打 GAS 的路徑，行為完全不變。
 * 改成 'supabase' 才會走 supabaseApi()（見下面「Supabase 後端」那段）。
 * 兩條路徑對外是同一份合約：成功回傳 data；失敗丟
 * ApiError(message, code)，code==='AUTH' 的處理方式（強制退回登入頁）
 * 對兩條路徑一致，呼叫端（畫面邏輯）完全不用知道現在是哪條後端。
 */
async function api(action, payload) {
  if (BACKEND === 'supabase') return supabaseApi(action, payload);
  return apiGas(action, payload);
}

/**
 * 打去 GAS。
 *
 * 用 form-urlencoded POST 是刻意的：這屬於 CORS simple request，
 * 瀏覽器不會先發 preflight，而 GAS 沒辦法回應 preflight。
 * 換成 application/json 會直接壞掉。
 */
async function apiGas(action, payload) {
  const url = (window.APP_CONFIG && window.APP_CONFIG.GAS_API_URL) || '';
  if (!url) throw ApiError('尚未設定後端網址', 'NO_CONFIG');

  const body = new URLSearchParams();
  body.set('payload', JSON.stringify(Object.assign({ action: action, token: state.token }, payload || {})));

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      redirect: 'follow'
    });
  } catch (err) {
    throw ApiError(navigator.onLine ? '連線失敗，請稍後再試' : '目前離線，請恢復網路後再試', 'NETWORK');
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw ApiError('後端回應格式不正確，請確認 GAS 已部署為新版本', 'BAD_RESPONSE');
  }

  if (!json.ok) {
    if (json.code === 'AUTH') {
      clearSession();
      // 已經在登入頁（這次就是登入本身帳密打錯）就不要重畫：重畫會把剛打的帳號清掉，
      // 登入框裡的錯誤訊息也會跟著不見
      if (state.view !== 'login') {
        state.view = 'login';
        render();
      }
    }
    throw ApiError(json.error || '操作失敗', json.code);
  }
  return json.data;
}

// ── Supabase 後端（Phase 5 雙軌驗證，supabase/MIGRATION_PLAN.md）──
//
// 只有 config.js 的 BACKEND 設成 'supabase' 才會用到這一段。
// 設計原則：api(action, payload) 的合約不變（成功回傳 data，失敗丟
// ApiError），這裡只是把同一份合約換一種方式兌現——一部分 action 對
// 一支 Postgres function 的 rpc()，少數幾個（login／logout／
// homeBootstrap／exportLedgerGrids）在 GAS 版本本來就是「後端組合好幾
// 支邏輯回傳一份」，這裡改成前端組合好幾次 Supabase 呼叫，效果一樣。

const SB_SESSION_KEY = 'claw-sb-session';
let _sb = null;

/**
 * 讓 Supabase session 存 localStorage 還是 sessionStorage 跟著
 * state.remember 走，跟現有 GAS 版本 saveSession() 的「記住我」規則
 * 一致（勾了留到關瀏覽器也還在，沒勾分頁關掉就失效）。
 */
const _sbStorageAdapter = {
  getItem(key) {
    try { return localStorage.getItem(key) || sessionStorage.getItem(key); } catch (e) { return null; }
  },
  setItem(key, value) {
    try {
      if (state.remember) { localStorage.setItem(key, value); sessionStorage.removeItem(key); }
      else { sessionStorage.setItem(key, value); localStorage.removeItem(key); }
    } catch (e) { /* 無痕模式寫不進去，這次啟動仍可正常使用 */ }
  },
  removeItem(key) {
    try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }
};

function supabaseClient() {
  if (_sb) return _sb;
  const cfg = window.APP_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) throw ApiError('尚未設定 Supabase 網址／金鑰', 'NO_CONFIG');
  _sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: SB_SESSION_KEY, storage: _sbStorageAdapter }
  });
  // Token 更新失敗（例如在別的裝置改了密碼、refresh token 被撤銷）會讓
  // SDK 自己觸發 SIGNED_OUT——跟 GAS 版本 AUTH 錯誤碼同一個效果：靜靜
  // 清掉本機狀態、退回登入頁，不用等使用者下一次操作才發現連不上。
  _sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && state.token) {
      clearSession();
      state.view = 'login';
      render();
    }
  });
  return _sb;
}

/**
 * 把 PostgREST／rpc() 的錯誤轉成 ApiError，code 對照 GAS 版本的語意：
 * 42501（insufficient_privilege，can_record()/is_admin()/can_see_machine()
 * 明確擋下的）對應 GAS 的 PermissionError → 'PERMISSION'；JWT 過期或
 * 被撤銷對應 AuthError → 'AUTH'；其餘一律 'ERROR'（對照一般驗證錯誤
 * 那種 throw new Error()）。
 */
function _pgError(err) {
  if (!err) return ApiError('操作失敗', 'ERROR');
  if (err.code === '42501') return ApiError(err.message, 'PERMISSION');
  if (err.code === 'PGRST301' || err.status === 401) return ApiError('請重新登入', 'AUTH');
  return ApiError(err.message || '操作失敗', 'ERROR');
}

async function _rpc(sb, name, params) {
  const { data, error } = await sb.rpc(name, params);
  if (error) throw _pgError(error);
  return data;
}

/**
 * 呼叫 supabase/functions/admin-users/ 這支 Edge Function（建立帳號／
 * 重設密碼，見該檔案開頭的說明）。supabase-js 打 Edge Function 失敗時
 * error 本身的 message 通常只有「Edge Function returned a non-2xx
 * status code」這種沒有意義的話，真正的錯誤訊息在 error.context 這個
 * Response 物件的 body 裡，要另外解析出來才看得到我們自己在 Function
 * 裡回的中文錯誤訊息。
 */
async function _invokeAdminUsersFn(sb, body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body: body });
  if (error) {
    let msg = error.message || '操作失敗';
    try {
      if (error.context && typeof error.context.json === 'function') {
        const parsed = await error.context.json();
        if (parsed && parsed.error) msg = parsed.error;
      }
    } catch (e) { /* 解析不出來就用預設訊息 */ }
    throw ApiError(msg, 'ERROR');
  }
  if (data && data.error) throw ApiError(data.error, 'ERROR');
  return data;
}

const ROLE_LABELS_FE = { admin: '管理員', patrol: '巡邏人員', owner: '台主' };

/**
 * 登入／開啟 App 共用：一次 RPC 拿回使用者資料＋首頁 dashboard
 * （對照 supabase/functions.sql 的 me_and_dashboard()）。
 * 原本這裡分開打「查 profile」＋「算 dashboard」共 3 趟網路來回
 * （auth.getUser() + profiles 查詢 + dashboard RPC），合成一支
 * function 後只要 1 趟，登入/開啟 App 明顯變快。
 */
async function _meAndDashboard(sb) {
  const data = await _rpc(sb, 'me_and_dashboard', {});
  if (!data.user) throw ApiError('請重新登入', 'AUTH');
  return data;
}

/** forkScope/resetScope 的 sheet 名稱（GAS 分頁名）→ Postgres 資料表名稱。 */
const SCOPE_SHEET_TO_TABLE = { QuickAmounts: 'quick_amounts', Prizes: 'prizes', MeterRates: 'meter_rates' };

/** 這個分類看得到的機台（RLS 已篩過），依 sort_order、名稱排序；一台都沒有就報錯。 */
async function _listCategoryMachines(sb, category) {
  const { data: machines, error: mErr } = await sb.from('machines').select('machine_id, name, sort_order').eq('category', category);
  if (mErr) throw _pgError(mErr);
  if (!machines || !machines.length) {
    const label = category === 'electronic' ? '電子機台' : '骰台';
    throw ApiError('目前沒有看得到的' + label + '，無法匯出', 'ERROR');
  }
  machines.sort((a, b) => (a.sort_order - b.sort_order) || String(a.name).localeCompare(String(b.name)));
  return machines;
}

/**
 * 對照 GAS 的 exportLedgerGrids()：不指定機台、只指定分類，一台一台
 * 各自呼叫 ledger_grid()，組成跟 GAS 版本一樣的 {range, machines[]} 形狀。
 * machines 資料表本身已經被 RLS 篩過，這裡查到的就是「看得到的」那些。
 */
async function _exportLedgerGridsSupabase(sb, p) {
  if (p.machineId || !p.category) {
    throw ApiError('這個功能只支援「全部骰台」／「全部電子機台」這種分類查詢', 'ERROR');
  }
  const machines = await _listCategoryMachines(sb, p.category);

  const rangeRows = await _rpc(sb, 'resolve_range', { p_preset: p.preset || 'day', p_from: p.from || null, p_to: p.to || null });
  const rangeRow = Array.isArray(rangeRows) ? rangeRows[0] : rangeRows;
  const range = { from: rangeRow.range_from, to: rangeRow.range_to, preset: rangeRow.preset };

  // 每一台各打一次 ledger_grid() RPC，17 台如果一支一支序列等下去，累加
  // 起來的時間很容易拖到好幾秒——這件事本身還好，但緊接在後面的
  // exportLedgerScreenshots() 要靠 navigator.share() 分享一次全部截圖，
  // 而 share() 需要「使用者剛剛按下去」的有效期內呼叫才會生效（transient
  // user activation，瀏覽器過幾秒就會判定失效）。序列等 17 次 RPC 實測
  // 就是會拖過這個有效期，導致 share() 失敗、整個退回成一張一張下載
  // （GAS 版本的 exportLedgerGrids() 是伺服器端一次迴圈跑完直接回傳，
  // 沒有這個問題）。改成 Promise.all 平行送出全部請求，把總等待時間
  // 壓到跟最慢那一次單一 RPC 差不多，才不會吃光使用者互動的有效期。
  const grids = await Promise.all(machines.map(async (m) => {
    const grid = await _rpc(sb, 'ledger_grid', {
      p_machine_id: m.machine_id, p_category: null, p_preset: p.preset || 'day',
      p_from: p.from || null, p_to: p.to || null, p_type: p.type || null, p_user_id: p.userId || null
    });
    return {
      machineId: m.machine_id, machineName: m.name,
      headerRow: grid.headerRow, outRows: grid.outRows, summaryRows: grid.summaryRows,
      colCount: grid.colCount, rowCount: grid.rowCount
    };
  }));
  if (p.settlement) await _applySettlement(sb, grids, range, p.settlement);
  return { range: range, machines: grids };
}

// ── 骰台結算區（本期／前期／租金／入幣*5%／總額）───────────
//
// 「全部骰台」匯出截圖／Excel 前，askSettlementOptions() 會先問要不要加
// 前期、租金。每台的逐日表在「總出幣…+/-」那組標籤/數字欄右邊再多兩欄，
// 剛好對齊五列小計：
//   本期     = 該台 +/- 總計（照原數字，負的就是負的）
//   前期     = 該台上一期存下的總額（settlements；只帶有勾的那幾台，其他台空白、不算）
//   租金     = -租金金額（名稱＋金額填一次，只扣有勾的那幾台；其他台空白）
//   入幣*5%  = -round(總入幣 × 5%)
//   總額     = 本期 + 前期 - 租金 - 入幣*5%
// 算完把每台的總額 upsert 回 settlements（同台同區間覆寫），下一期的前期就抓得到。

const SETTLEMENT_FEE_RATE = 0.05;

/** 純計算：從一台的 summaryRows 算出結算區五項，不碰資料庫（方便單獨測）。 */
function _computeSettlement(summaryRows, prevTotal, opts, machineId) {
  const rent = opts.rent && (opts.rent.machineIds || []).indexOf(machineId) >= 0 ? opts.rent : null;
  const hasPrev = !!opts.prev && (opts.prev.machineIds || []).indexOf(machineId) >= 0;
  const last = (row) => Number(row[row.length - 1]) || 0;
  const net = last(summaryRows[4]);     // +/- 那列的總計
  const inTotal = last(summaryRows[3]); // 總入幣
  const prev = hasPrev ? (Number(prevTotal) || 0) : 0;
  const rentAmt = rent ? (Number(rent.amount) || 0) : 0;
  const fee = Math.round(inTotal * SETTLEMENT_FEE_RATE);
  return {
    net: net, prev: prev, rentName: rent ? rent.name : null, rentAmt: rentAmt, fee: fee,
    total: net + prev - rentAmt - fee,
    cells: [
      ['本期', net],
      ['前期', hasPrev ? prev : ''],
      [rent ? rent.name : '租金', rent ? -rentAmt : ''],
      ['入幣*5%', -fee],
      ['總額', net + prev - rentAmt - fee]
    ]
  };
}

/** 抓每台「range_to 早於 fromDate」的最新一筆總額，回傳 {machineId: total}。 */
async function _fetchPrevSettlements(sb, machineIds, fromDate) {
  const { data, error } = await sb.from('settlements')
    .select('machine_id, range_to, total')
    .in('machine_id', machineIds)
    .lt('range_to', fromDate)
    .order('range_to', { ascending: false });
  if (error) throw _pgError(error);
  const map = {};
  (data || []).forEach((r) => { if (!(r.machine_id in map)) map[r.machine_id] = Number(r.total) || 0; });
  return map;
}

/**
 * 把結算區接到每台 grid 的右邊（就地修改 grids：每列多兩格、colCount += 2、
 * 標記 settlement），並把總額存回 settlements。
 * grids 的每一筆要有 machineId；range 是 {from, to}。
 */
async function _applySettlement(sb, grids, range, opts) {
  const prevIds = opts.prev ? grids.map((g) => g.machineId).filter((id) => opts.prev.machineIds.indexOf(id) >= 0) : [];
  const prevMap = prevIds.length ? await _fetchPrevSettlements(sb, prevIds, range.from) : {};
  const saveRows = grids.map((g) => {
    const s = _computeSettlement(g.summaryRows, prevMap[g.machineId], opts, g.machineId);
    g.headerRow = g.headerRow.concat(['', '']);
    g.outRows = g.outRows.map((row) => row.concat(['', '']));
    g.summaryRows = g.summaryRows.map((row, i) => row.concat(s.cells[i]));
    g.colCount += 2;
    g.settlement = true;
    return {
      machine_id: g.machineId, range_from: range.from, range_to: range.to,
      current_amt: s.net, prev_amt: s.prev,
      rent_name: s.rentName, rent_amt: s.rentAmt,
      fee_amt: s.fee, total: s.total
    };
  });
  // 台主只能看、不能寫（RLS 也會擋），就只算不存
  if (canRecord() && saveRows.length) {
    const { error } = await sb.from('settlements')
      .upsert(saveRows, { onConflict: 'machine_id,range_from,range_to' });
    if (error) throw _pgError(error);
  }
}

/** 匯出視窗裡的機台勾選清單（前期、租金各一份）：標題＋全選／全不選＋每台一個勾選框，預設都不勾。 */
function _machinePicker(machines, title) {
  const boxes = machines.map((m) => ({ id: m.machine_id, box: h('input', { type: 'checkbox', value: m.machine_id }) }));
  const allBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, '全選');
  const syncAllBtn = () => {
    allBtn.textContent = boxes.every((x) => x.box.checked) ? '全不選' : '全選';
  };
  boxes.forEach((x) => x.box.addEventListener('change', syncAllBtn));
  allBtn.addEventListener('click', () => {
    const check = !boxes.every((x) => x.box.checked);
    boxes.forEach((x) => { x.box.checked = check; });
    syncAllBtn();
  });
  const el = h('div', {}, [
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px' }, [
      h('span', { class: 'small muted', style: 'font-weight:600', text: title }),
      allBtn
    ]),
    h('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:6px 10px;max-height:36vh;overflow:auto;margin-bottom:14px'
    }, boxes.map((x, i) => h('label', {
      style: 'display:flex;align-items:center;gap:6px;cursor:pointer'
    }, [x.box, h('span', { text: machines[i].name })])))
  ]);
  return { el: el, selectedIds: () => boxes.filter((x) => x.box.checked).map((x) => x.id) };
}

/** 預設租金名稱：本月，例如「租金9/1-9/30」。 */
function _defaultRentName() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const lastDay = new Date(now.getFullYear(), m, 0).getDate();
  return '租金' + m + '/1-' + m + '/' + lastDay;
}

/**
 * 匯出前的「總額／前期／租金」視窗。回傳 Promise：
 *   沒勾總額按匯出 → { total: false }（照原本匯出，不加結算區）
 *   有勾總額按匯出 → { total: true, prev: {machineIds} | null, rent: {name, amount, machineIds} | null }
 * machines：這次要匯出的骰台（_listCategoryMachines() 的結果），給租金勾選要扣哪幾台。
 *   取消／點外面／往下滑關掉 → null（不匯出）
 */
function askSettlementOptions(kindLabel, machines) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      closeDialog();
      resolve(val);
    };

    const totalBox = h('input', { type: 'checkbox', class: 'switch', role: 'switch' });
    const prevBox = h('input', { type: 'checkbox', class: 'switch', role: 'switch' });
    const rentBox = h('input', { type: 'checkbox', class: 'switch', role: 'switch' });
    const rentName = h('input', { type: 'text', value: _defaultRentName() });
    const rentAmt = h('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: '例：4500' });
    const errorEl = h('p', { class: 'small', style: 'color:var(--danger);margin:0 0 8px', hidden: true });
    const prevPicker = _machinePicker(machines, '要帶前期的機台');
    const rentPicker = _machinePicker(machines, '要扣租金的機台');
    const prevFields = h('div', { hidden: true }, [prevPicker.el]);
    prevBox.addEventListener('change', () => { prevFields.hidden = !prevBox.checked; });

    const rentFields = h('div', { hidden: true }, [
      dialogField('租金名稱', rentName),
      dialogField('租金金額', rentAmt),
      rentPicker.el
    ]);
    rentBox.addEventListener('change', () => {
      rentFields.hidden = !rentBox.checked;
      if (rentBox.checked) rentAmt.focus();
    });

    const toggleRow = (box, label, hint) => h('label', {
      style: 'display:flex;align-items:center;gap:10px;margin-bottom:12px;cursor:pointer'
    }, [box, h('div', {}, [
      h('div', { text: label, style: 'font-weight:600' }),
      h('div', { class: 'small muted', text: hint })
    ])]);

    // 前期／租金只有勾了「總額」才有意義，收在一起、沒勾總額就藏起來
    const totalOptions = h('div', {
      hidden: true,
      style: 'padding-left:14px;border-left:2px solid var(--border);margin-bottom:12px'
    }, [
      toggleRow(prevBox, '加入前期', '勾要帶的機台，自動帶入該台上一期匯出時的總額'),
      prevFields,
      toggleRow(rentBox, '加入租金', '填一次名稱和金額，再勾要扣的機台'),
      rentFields
    ]);
    totalBox.addEventListener('change', () => {
      totalOptions.hidden = !totalBox.checked;
      errorEl.hidden = true;
    });

    const body = [
      toggleRow(totalBox, '總額', '在總出幣右邊加上 本期／前期／租金／入幣*5%／總額'),
      totalOptions,
      errorEl
    ];

    const submit = () => {
      errorEl.hidden = true;
      if (!totalBox.checked) { finish({ total: false }); return; }
      let prev = null;
      if (prevBox.checked) {
        const prevIds = prevPicker.selectedIds();
        if (!prevIds.length) {
          errorEl.textContent = '請勾選要帶前期的機台';
          errorEl.hidden = false;
          return;
        }
        prev = { machineIds: prevIds };
      }
      let rent = null;
      if (rentBox.checked) {
        const name = rentName.value.trim() || '租金';
        const amount = Number(rentAmt.value);
        if (!rentAmt.value || !isFinite(amount) || amount < 0) {
          errorEl.textContent = '請輸入租金金額';
          errorEl.hidden = false;
          rentAmt.focus();
          return;
        }
        const machineIds = rentPicker.selectedIds();
        if (!machineIds.length) {
          errorEl.textContent = '請勾選要扣租金的機台';
          errorEl.hidden = false;
          return;
        }
        rent = { name: name, amount: Math.round(amount), machineIds: machineIds };
      }
      finish({ total: true, prev: prev, rent: rent });
    };

    const backdrop = openDialog('匯出' + kindLabel, body, [
      h('button', { class: 'btn', onclick: () => finish(null) }, '取消'),
      h('button', { class: 'btn btn-primary', onclick: submit }, '匯出')
    ]);
    backdrop._onClose = () => finish(null);
  });
}

/** 「全部骰台」匯出才跳總額視窗；電子機台、單一機台維持原本的匯出。 */
function _wantsSettlement(p) {
  return !p.machineId && p.category === 'dice';
}

// ── 匯出 Excel（Supabase 後端）─────────────────────────────
//
// GAS 版本是後端借 Google 試算表的服務現場轉存 .xlsx（_exportLedgerWorkbook()：
// 建一份暫時試算表、填資料、flush、打匯出網址、刪掉暫時試算表），
// Postgres 沒有等價的服務可以借，改成瀏覽器端用 ExcelJS（docs/index.html
// 用 CDN 載入的 `ExcelJS` 全域）現場組出檔案，回傳的形狀
// {filename, base64, rowCount} 跟 GAS 版本一模一樣，downloadLedgerXlsx()
// 完全不用改。樣式對照 apps-script/Reports.gs 的 _writeLedgerSheet()：
// 表頭粗體置中、全部資料置中、凍結首列、出幣列跟小計列中間一條黑色
// 分隔列、小計列倒數第二欄粉紅底、「+/-」那列紅字。

/** 對照 _sanitizeSheetName()：Excel 分頁名稱不能有這幾個字元，上限 28 字
 *  （留空間給撞名時加的 "(2)" 後綴，Excel 分頁名稱本身上限 31 字）。 */
function _sanitizeSheetName(name) {
  const cleaned = String(name || '機台').replace(/[[\]*?/\\:]/g, '-').trim();
  return (cleaned || '機台').substring(0, 28);
}

/** 對照 _uniqueSheetName()：分頁名稱不能重複，撞名就加 (2)(3)... 後綴。 */
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

/** ArrayBuffer → base64，downloadLedgerXlsx() 是照 GAS 版本的形狀寫的，
 *  預期拿到的是 base64 字串（用 atob() 解碼），不是原始的 ArrayBuffer。 */
function _arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 一次太大會爆 String.fromCharCode 的參數上限
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** 把一份 ledger_grid() 的格線資料寫進一個新的分頁，樣式對照 _writeLedgerSheet()。 */
function _writeLedgerWorksheet(workbook, sheetName, grid) {
  const ws = workbook.addWorksheet(sheetName);
  const numCols = grid.colCount;
  ws.columns = new Array(numCols).fill(0).map(() => ({ width: 13 })); // 對照 setColumnWidths(1, numCols, 90) 的比例換算

  const headerRow = ws.addRow(grid.headerRow);
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: 'center' };

  grid.outRows.forEach((row) => {
    ws.addRow(row).alignment = { horizontal: 'center' };
  });

  // 分隔列整列沒有任何文字內容，只塗黑——用 addRow() 塞一整排空字串會
  // 被 ExcelJS 判定成「這列沒有內容」，寫出 .xlsx 時整列（含樣式）都會
  // 被丟掉（實測確認過的行為，不是猜的）。改成直接用 getRow()/getCell()
  // 逐一取出儲存格設定樣式，不透過 addRow()，樣式才會真的寫進檔案。
  const dividerRowIndex = 1 + grid.outRows.length + 1;
  const dividerRow = ws.getRow(dividerRowIndex);
  for (let c = 1; c <= numCols; c++) {
    dividerRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };
  }
  dividerRow.commit();

  grid.summaryRows.forEach((row) => {
    const r = ws.addRow(row);
    r.alignment = { horizontal: 'center' };
    const labelCols = grid.settlement ? [numCols - 3, numCols - 1] : [numCols - 1];
    labelCols.forEach((c) => { r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8CBCB' } }; });
    if (row[0] === '+/-') {
      r.eachCell({ includeEmpty: true }, (cell) => { cell.font = { color: { argb: 'FFC00000' } }; });
    }
  });

  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

async function _exportLedgerXlsxSupabase(sb, p) {
  if (typeof ExcelJS === 'undefined') {
    throw ApiError('缺少產生 Excel 檔案需要的套件（ExcelJS 沒載入成功，檢查網路連線或重新整理頁面）', 'ERROR');
  }

  const workbook = new ExcelJS.Workbook();
  const isCategoryScope = !p.machineId && p.category;
  let filenameBase;
  let totalRowCount = 0;

  if (!isCategoryScope) {
    const grid = await _rpc(sb, 'ledger_grid', {
      p_machine_id: p.machineId || null, p_category: p.category || null, p_preset: p.preset || 'day',
      p_from: p.from || null, p_to: p.to || null, p_type: p.type || null, p_user_id: p.userId || null
    });
    filenameBase = grid.filenameBase;
    totalRowCount = grid.rowCount;
    _writeLedgerWorksheet(workbook, '對帳表', grid);
  } else {
    const machines = await _listCategoryMachines(sb, p.category);

    const rangeRows = await _rpc(sb, 'resolve_range', { p_preset: p.preset || 'day', p_from: p.from || null, p_to: p.to || null });
    const rangeRow = Array.isArray(rangeRows) ? rangeRows[0] : rangeRows;
    const categoryLabel = p.category === 'electronic' ? '全部電子機台' : '全部骰台';
    filenameBase = '娃娃機對帳表_' + categoryLabel + '_' + rangeRow.range_from + '_' + rangeRow.range_to;

    const grids = [];
    for (const m of machines) {
      const grid = await _rpc(sb, 'ledger_grid', {
        p_machine_id: m.machine_id, p_category: null, p_preset: p.preset || 'day',
        p_from: p.from || null, p_to: p.to || null, p_type: p.type || null, p_user_id: p.userId || null
      });
      grid.machineId = m.machine_id;
      grid.machineName = m.name;
      grids.push(grid);
    }
    if (p.settlement) await _applySettlement(sb, grids, { from: rangeRow.range_from, to: rangeRow.range_to }, p.settlement);

    const usedNames = {};
    grids.forEach((grid) => {
      totalRowCount += grid.rowCount;
      _writeLedgerWorksheet(workbook, _uniqueSheetName(usedNames, grid.machineName), grid);
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return { filename: filenameBase + '.xlsx', base64: _arrayBufferToBase64(buffer), rowCount: totalRowCount };
}

async function supabaseApi(action, payload) {
  const p = payload || {};
  const sb = supabaseClient();

  if (action === 'login') {
    state.remember = !!p.remember; // 要在 signInWithPassword 之前設好，_sbStorageAdapter 才知道存哪個 storage
    const email = await _rpc(sb, 'resolve_username_email', { p_username: p.username });
    if (!email) throw ApiError('帳號或密碼錯誤', 'AUTH');
    const { data: signInData, error: signInErr } = await sb.auth.signInWithPassword({ email: email, password: p.password });
    if (signInErr) throw ApiError('帳號或密碼錯誤', 'AUTH');
    const { user, dashboard } = await _meAndDashboard(sb);
    return { token: signInData.session.access_token, remember: state.remember, user: user, dashboard: dashboard };
  }

  if (action === 'logout') {
    await sb.auth.signOut();
    return {};
  }

  // 自己改密碼——GAS 後端沒有這個動作（那邊密碼重設一直是管理員專屬），
  // 只有 Supabase 後端有，讓遷移後拿到臨時密碼的帳號能自己換成新密碼。
  // Supabase Auth 內建 updateUser() 就能做，不需要另外寫 Postgres function。
  if (action === 'changePassword') {
    const { error } = await sb.auth.updateUser({ password: p.newPassword });
    if (error) throw _pgError(error);
    return { ok: true };
  }

  if (action === 'homeBootstrap') {
    const { user, dashboard } = await _meAndDashboard(sb);
    return { user: user, dashboard: dashboard };
  }

  if (action === 'exportLedgerGrids') return _exportLedgerGridsSupabase(sb, p);
  if (action === 'exportLedgerXlsx') return _exportLedgerXlsxSupabase(sb, p);

  // adminSaveUser：改已存在帳號（有 userId）不需要 service role，走一般
  // RPC；建立全新帳號（沒有 userId）要呼叫 Supabase Auth Admin API，
  // 只能靠 supabase/functions/admin-users/ 這支 Edge Function（見
  // MIGRATION_PLAN.md「Auth & RLS」那節）。adminResetPassword 同理，
  // 一律要走 Edge Function。
  if (action === 'adminSaveUser') {
    if (p.userId) {
      return _rpc(sb, 'admin_update_user', {
        p_user_id: p.userId, p_display_name: p.displayName || null, p_role: p.role, p_status: p.status || 'active'
      });
    }
    return _invokeAdminUsersFn(sb, {
      action: 'createUser', username: p.username, password: p.password, role: p.role, displayName: p.displayName
    });
  }
  if (action === 'adminResetPassword') {
    return _invokeAdminUsersFn(sb, { action: 'resetPassword', userId: p.userId, password: p.password });
  }

  const RPC_MAP = {
    dashboard: () => ['dashboard', {}],
    machineDetail: () => ['machine_detail', { p_machine_id: p.machineId, p_record_limit: p.recordLimit || null }],
    allMachineDetails: () => ['all_machine_details', { p_record_limit: p.recordLimit || null }],
    report: () => ['report', {
      p_machine_id: p.machineId || null, p_category: p.category || null, p_preset: p.preset || 'day',
      p_from: p.from || null, p_to: p.to || null, p_type: p.type || null, p_user_id: p.userId || null
    }],
    activityQuery: () => ['activity_query', { p_from: p.from, p_to: p.to }],
    addRecord: () => ['add_record', { p_machine_id: p.machineId, p_type: p.type, p_amount: p.amount, p_note: p.note || null, p_client_token: p.clientToken || '' }],
    addMeterRecord: () => ['add_meter_record', { p_machine_id: p.machineId, p_meter_start: p.meterStart, p_meter_end: p.meterEnd, p_note: p.note || null, p_client_token: p.clientToken || '' }],
    addPrizeRecord: () => ['add_prize_record', { p_machine_id: p.machineId, p_items: p.items, p_note: p.note || null, p_client_token: p.clientToken || '' }],
    startBusinessDay: () => ['start_business_day', { p_business_date: p.businessDate || null, p_opened_at: p.openedAt || null }],
    endBusinessDay: () => ['end_business_day', {}],
    reopenBusinessDay: () => ['reopen_business_day', {}],
    saveDailyLedger: () => ['save_daily_ledger', {
      p_turnover: p.turnover || 0, p_manual_expense: p.manualExpense || 0, p_manual432: p.manual432 || 0,
      p_manual441: p.manual441 || 0, p_given_to_owner_items: p.givenToOwnerItems || [], p_taken_by_owner_items: p.takenByOwnerItems || [],
      p_returned_to_house: 0
    }],
    voidRecord: () => ['void_record', { p_record_id: p.recordId }],
    saveQuickAmount: () => ['save_quick_amount', {
      p_qa_id: p.qaId || null, p_machine_id: p.machineId || '', p_type: p.type, p_amount: p.amount, p_label: p.label || '', p_sort_order: p.sortOrder || 0
    }],
    deleteQuickAmount: () => ['delete_quick_amount', { p_qa_id: p.qaId }],
    savePrize: () => ['save_prize', {
      p_prize_id: p.prizeId || null, p_machine_id: p.machineId || '', p_name: p.name, p_amount: p.amount,
      p_sort_order: p.sortOrder || 0, p_active: p.active === undefined ? null : p.active
    }],
    deletePrize: () => ['delete_prize', { p_prize_id: p.prizeId }],
    saveMeterRate: () => ['save_meter_rate', { p_machine_id: p.machineId || '', p_rate: p.rate }],
    forkScope: () => ['fork_scope_to_machine', { p_table: SCOPE_SHEET_TO_TABLE[p.sheet], p_machine_id: p.machineId }],
    resetScope: () => ['reset_scope_to_global', { p_table: SCOPE_SHEET_TO_TABLE[p.sheet], p_machine_id: p.machineId }],
    adminListUsers: () => ['admin_list_users', {}],
    adminSaveMachine: () => ['admin_save_machine', {
      p_machine_id: p.machineId || null, p_name: p.name, p_location: p.location || '', p_status: p.status,
      p_color: p.color, p_sort_order: p.sortOrder || 0, p_note: p.note || '', p_icon: p.icon, p_category: p.category || null
    }],
    adminListPermissions: () => ['admin_list_permissions', {}],
    adminSetPermission: () => ['admin_set_permission', { p_user_id: p.userId, p_machine_id: p.machineId, p_granted: !!p.granted }],
    adminBootstrap: () => ['admin_bootstrap', {}]
  };

  const entry = RPC_MAP[action];
  if (!entry) throw ApiError('不支援的操作：' + action, 'ERROR');
  const [rpcName, rpcParams] = entry();
  return _rpc(sb, rpcName, rpcParams);
}

/**
 * 包一層共用的忙碌狀態與錯誤提示，讓每個按鈕不用各自寫 try/catch。
 *
 * 用深度計數而不是布林旗標：像「記一筆帳 → 重新載入詳細頁」這種
 * run 包 run 的情況很常見，用布林的話內層會被自己擋掉。
 * 防連點靠的是後端的 clientToken 冪等，不是靠這裡。
 */
let runDepth = 0;
let visibleRunDepth = 0;
async function run(fn, opts) {
  const options = opts || {};
  runDepth++;
  state.busy = true;
  // 背景輪詢（silent）不顯示讀取動畫，只有按鈕按下去這種使用者主動觸發的
  // 才顯示，不然每次背景刷新也會跳一下，反而更干擾。
  // quiet：一樣不顯示「處理中…」，但失敗照樣跳提示——給下拉更新用，
  // 它自己有轉圈的指示圈，兩個疊在畫面最上面反而擋到彼此。
  const showsBusy = !options.silent && !options.quiet;
  if (showsBusy && ++visibleRunDepth === 1) showBusy(true);
  // button：按下去的那顆按鈕——等後端的這段時間在按鈕上轉圈、換成 busyText（例如「送出中…」），
  // 暫時不能再按，避免連點（ui_fx.js 的 fxButtonBusy；沒載到就只有上面的「處理中…」）
  const restoreButton = options.button && typeof window.fxButtonBusy === 'function'
    ? window.fxButtonBusy(options.button, options.busyText)
    : null;
  try {
    const result = await fn();
    if (options.success) toast(options.success, 'success');
    return result;
  } catch (err) {
    // onError：呼叫端要自己顯示錯誤（登入表單把錯誤寫在登入框裡），就交給它，不跳提示。
    // 登入表單一定要自己接：帳密錯誤／帳號被鎖，後端一樣是用 AUTH 這個代碼回傳，
    // 照下面的預設會整個被吃掉，使用者只會看到轉圈圈轉完、什麼也沒發生。
    // 背景輪詢失敗不打擾使用者（離線時本來就有提示條，不需要每次輪詢都再彈一次）。
    // AUTH 錯誤預設也不彈 toast——這是為了「操作到一半 session 過期，靜靜跳回
    // 登入頁就好，不用再彈一個刺眼的錯誤」設計的。
    if (options.onError) options.onError(err);
    else if (!options.silent && err.code !== 'AUTH') toast(err.message, 'error');
    return undefined;
  } finally {
    if (restoreButton) restoreButton();
    runDepth--;
    if (runDepth === 0) state.busy = false;
    if (showsBusy && --visibleRunDepth === 0) showBusy(false);
  }
}

function showBusy(show) {
  const el = document.getElementById('busy-badge');
  if (el) el.hidden = !show;
}

// ── Session 儲存 ────────────────────────────────────────

/**
 * 勾了記住我就放 localStorage（關掉 App 也留著，伺服器給 7 天），
 * 沒勾就放 sessionStorage（分頁關掉即失效，伺服器給 12 小時）。
 */
function saveSession(token, remember) {
  state.token = token;
  state.remember = !!remember;
  try {
    if (remember) {
      localStorage.setItem(STORAGE_TOKEN, token);
      localStorage.setItem(STORAGE_REMEMBER, '1');
      sessionStorage.removeItem(STORAGE_TOKEN);
    } else {
      sessionStorage.setItem(STORAGE_TOKEN, token);
      localStorage.removeItem(STORAGE_TOKEN);
      localStorage.removeItem(STORAGE_REMEMBER);
    }
  } catch (err) { /* 無痕模式下寫不進去，這次啟動仍可正常使用 */ }
}

/**
 * Supabase 後端的 session 是 supabase-js 自己管的（_sbStorageAdapter），
 * 不是這裡的 STORAGE_TOKEN——開機時要另外問 SDK「有沒有已經存好的
 * session」，而且這是非同步的（可能要驗一下 token 有沒有過期），跟 GAS
 * 版本純讀 localStorage 是同步的不一樣，所以 loadSession() 整支改成
 * async，boot() 那邊要 await。
 */
async function loadSession() {
  if (BACKEND === 'supabase') {
    try {
      // 一定要在 supabaseClient()（進而可能觸發 SDK 內部立刻做的 token
      // refresh）之前，就先知道原本的 session 到底存在 localStorage 還是
      // sessionStorage：_sbStorageAdapter.setItem() 是看 state.remember
      // 決定寫哪裡，如果這裡沒有先設好，state.remember 預設是 false，
      // refresh 剛好在這個空檔觸發的話，會把明明勾了「記住我」、存在
      // localStorage 的 session 誤寫進 sessionStorage，還會順便清掉
      // localStorage 那份——變成「明明勾了記住我，過一陣子還是被登出」。
      state.remember = !!(function () { try { return !!localStorage.getItem(SB_SESSION_KEY); } catch (e) { return false; } })();
      const sb = supabaseClient();
      const { data } = await sb.auth.getSession();
      if (data && data.session) {
        state.token = data.session.access_token;
      } else {
        state.remember = false;
      }
    } catch (err) { /* 讀不到就當沒登入 */ }
    return;
  }
  try {
    const remembered = localStorage.getItem(STORAGE_TOKEN);
    if (remembered) { state.token = remembered; state.remember = true; return; }
    const temp = sessionStorage.getItem(STORAGE_TOKEN);
    if (temp) { state.token = temp; state.remember = false; }
  } catch (err) { /* 讀不到就當沒登入 */ }
}

function clearSession() {
  state.token = null;
  state.user = null;
  state.remember = false;

  // 把上一位使用者看到的畫面資料也一併清掉。
  // 不同角色看得到的機台不一樣（台主只看自己的），如果同一台裝置換人登入
  // 卻沒清掉，新使用者在下一輪 API 回來之前，會先閃過上一位使用者的舊畫面。
  state.home = null;
  state.detail = null;
  state.report = null;
  state.admin = null;
  state.cache = {};
  state.homeTab = 'dice';
  _countMem = {};   // 數字跳動的記憶：不能讓下一位使用者看到數字從上一位的金額跳過來

  try {
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_REMEMBER);
    sessionStorage.removeItem(STORAGE_TOKEN);
  } catch (err) { /* 忽略 */ }
}

function isAdmin() { return state.user && state.user.role === 'admin'; }
function canRecord() { return state.user && (state.user.role === 'admin' || state.user.role === 'patrol'); }

// ── 對話框 ──────────────────────────────────────────────

function openDialog(title, contentNodes, actions) {
  closeDialog();
  const sheet = h('div', { class: 'dialog' }, [
    // 手機上是從底部滑出來的面板：上面一條小把手，提示可以往下滑關掉（ui_fx.js 的 fxSwipeToClose）
    h('div', { class: 'dialog-handle', 'aria-hidden': 'true' }),
    h('h3', { text: title }),
    contentNodes,
    h('div', { class: 'dialog-actions' }, actions)
  ]);
  const backdrop = h('div', {
    class: 'dialog-backdrop',
    id: 'dialog-backdrop',
    onclick: (e) => { if (e.target === backdrop) closeDialog(); }
  }, [sheet]);
  document.body.appendChild(backdrop);
  if (typeof window.fxSwipeToClose === 'function') {
    window.fxSwipeToClose(sheet, () => { if (backdrop.isConnected) closeDialog(); }, backdrop);
  }
  return backdrop;
}

/**
 * 關掉目前的對話框。對話框可以在 backdrop._onClose 掛一個「被關掉時」要做的事——
 * askConfirm() 用它：不管是按取消、點外面、往下滑關掉，還是被下一個對話框頂掉，
 * 都當成「不要」回報給呼叫端，不會有等不到答案、卡住的確認。
 */
function closeDialog() {
  const existing = document.getElementById('dialog-backdrop');
  if (!existing) return;
  const onClose = existing._onClose;
  existing._onClose = null;
  existing.remove();
  if (onClose) onClose();
}

/**
 * App 自己樣式的確認面板，取代瀏覽器內建的 confirm()：內建的小視窗在手機上會拿網址
 * 當標題、白底樣式跟 App 不搭，也看不出哪個是「刪了就沒了」的動作。
 * 回傳 Promise：按確定 → true；按取消、點外面、往下滑關掉 → false。
 * opts：
 *   title   標題（一句問句）
 *   message 補充說明（可以用 \n 換行）
 *   detail  要處理的是哪一筆（例如「出幣 $50」），放在醒目的框裡，避免刪錯
 *   okText  確定鈕的字（預設「確定」）
 *   danger  true＝刪除／作廢這類動作，確定鈕是紅色
 * 注意：呼叫端如果還要用到 e.currentTarget（按鈕轉圈），要在 await 之前先存起來——
 * 事件處理完之後 currentTarget 就變成 null 了。
 */
function askConfirm(opts) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      closeDialog();
      resolve(ok);
    };
    const body = [
      opts.message ? h('p', { class: 'confirm-msg', text: opts.message }) : null,
      opts.detail ? h('div', { class: 'confirm-detail', text: opts.detail }) : null
    ];
    const backdrop = openDialog(opts.title, body, [
      h('button', { class: 'btn confirm-cancel', onclick: () => finish(false) }, '取消'),
      h('button', {
        class: 'btn confirm-ok ' + (opts.danger ? 'btn-danger-solid' : 'btn-primary'),
        onclick: () => finish(true)
      }, opts.okText || '確定')
    ]);
    backdrop.classList.add('confirm-backdrop');
    backdrop._onClose = () => finish(false);
  });
}

function dialogField(label, input) {
  return h('div', { class: 'field' }, [h('label', { text: label }), input]);
}

// ── 畫面：登入 ──────────────────────────────────────────

/** 上一次成功登入的帳號（只記帳號、不記密碼），下次打開登入頁自動帶入。 */
function readLastUsername() {
  try { return localStorage.getItem(STORAGE_LAST_USER) || ''; } catch (err) { return ''; }
}
function saveLastUsername(name) {
  try { localStorage.setItem(STORAGE_LAST_USER, name); } catch (err) { /* 無痕模式寫不進去就算了 */ }
}

function viewLogin() {
  const lastUser = readLastUsername();
  // enterkeyhint：手機鍵盤右下角那顆鍵，帳號格顯示「下一個」、密碼格顯示「前往」
  const username = h('input', {
    type: 'text', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    enterkeyhint: 'next', value: lastUser || null
  });
  const password = h('input', { type: 'password', autocomplete: 'current-password', enterkeyhint: 'go' });
  const remember = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: state.remember });
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, '登入');
  // 登入失敗的訊息直接寫在登入框裡：畫面最下面的小提示在手機鍵盤開著時會被擋住，看起來像按了沒反應
  const errorEl = h('p', { class: 'login-error', role: 'alert', hidden: true });
  const machine = machineSvg(104, '#4F7BE8', 'running', null, { seed: 'login' });
  machine.classList.add('login-machine');
  // 小彩蛋：點一下娃娃機，爪子下去抓一下
  machine.addEventListener('click', () => { machineAct(machine, 'grab'); });

  // 密碼旁邊的「👁」：點一下看得到自己打了什麼（手機上最容易打錯），再點一下藏起來
  const pwToggle = h('button', { type: 'button', class: 'pw-toggle', 'aria-label': '顯示密碼', 'aria-pressed': 'false' }, '👁');
  let pwHadFocus = false;
  pwToggle.addEventListener('pointerdown', () => { pwHadFocus = document.activeElement === password; });
  pwToggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    pwToggle.classList.toggle('on', show);
    pwToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    pwToggle.setAttribute('aria-label', show ? '隱藏密碼' : '顯示密碼');
    // 本來就在打密碼的話，游標放回去（按這顆鈕會讓密碼格失去焦點、手機鍵盤收起來）
    if (pwHadFocus) {
      password.focus();
      try { password.setSelectionRange(password.value.length, password.value.length); } catch (err) { /* 有些瀏覽器不給設 */ }
    }
  });

  let card = null;
  const clearError = () => { errorEl.hidden = true; errorEl.textContent = ''; };
  const showError = (message, field) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
    if (field && typeof window.fxFieldError === 'function') window.fxFieldError(field);
    else if (typeof window.fxShake === 'function') window.fxShake(card);
  };
  username.addEventListener('input', clearError);
  password.addEventListener('input', clearError);

  // 帳號格按 Enter：跳到密碼格（原本會直接送出，再跳一個「請輸入密碼」的錯誤）
  username.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (!username.value.trim()) { showError('請輸入帳號', username); return; }
    password.focus();
  });

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      clearError();
      // 空白就不用送到後端再等它回「請輸入帳號與密碼」：直接標出漏填的那一格
      if (!username.value.trim()) { showError('請輸入帳號', username); return; }
      if (!password.value) { showError('請輸入密碼', password); return; }
      submitBtn.disabled = true;
      machine.classList.add('fx-m-busy'); // 等後端的時候爪子上下動
      let failure = null;
      const data = await run(() => api('login', {
        username: username.value.trim(),
        password: password.value,
        remember: remember.checked
      }), { button: submitBtn, busyText: '登入中…', onError: (err) => { failure = err; } });
      submitBtn.disabled = false;
      machine.classList.remove('fx-m-busy');
      if (!data) {
        // 帳密錯誤、帳號被鎖、連不上……都寫在框裡；框搖一下、機台也搖一下，密碼清掉讓人直接重打
        showError(failure ? failure.message : '登入失敗，請再試一次');
        machineAct(machine, 'shake');
        password.value = '';
        password.focus();
        return;
      }
      saveLastUsername(username.value.trim());
      hideToast(); // 剛剛打錯的那句錯誤提示不要跟著進首頁
      saveSession(data.token, data.remember);
      state.user = data.user;
      password.value = '';
      // login 已經把首頁資料一起帶回來了（見 Auth.gs），不用再多打一次 dashboard。
      state.home = data.dashboard;
      _resetToHomeNav();
      // 爪子抓一下再進首頁（0.6 秒；減少動態效果時馬上進）
      await machineAct(machine, 'grab');
      render();
      prefetchMachineDetails();
    }
  }, [
    dialogField('帳號', username),
    dialogField('密碼', h('div', { class: 'pw-wrap' }, [password, pwToggle])),
    h('label', { class: 'checkbox', style: 'margin-bottom:18px' }, [
      remember,
      h('span', {}, '記住我（7 天內免重新登入）')
    ]),
    errorEl,
    submitBtn
  ]);
  card = h('div', { class: 'card login-card' }, form);

  // 上次登入過就帶好帳號，游標直接放在密碼格（render() 畫好之後才放得進去）
  if (lastUser) _focusAfterRender = password;

  // 進場動畫只在「剛打開登入頁」播一次，同一頁重畫不重播
  const intro = !(_lastRenderKey && _lastRenderKey.indexOf('login:') === 0);
  return h('div', { class: 'login-wrap' + (intro ? ' fx-login-intro' : '') }, [
    h('div', { class: 'login-head' }, [
      machine,
      h('h1', { text: '娃娃機管理系統' })
    ]),
    card,
    h('div', { class: 'login-foot' }, [
      h('p', { class: 'small muted center', style: 'margin-top:14px' },
        '帳號由管理員建立。忘記密碼請找管理員重設。'),
      h('p', { class: 'small muted center', style: 'margin-top:6px', text: '版本號 ' + APP_VERSION })
    ])
  ]);
}

// ── 畫面：首頁 ──────────────────────────────────────────

function statBox(label, value, cls) {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'stat-label', text: label }),
    h('div', { class: 'stat-value num ' + (cls || ''), text: value })
  ]);
}

/**
 * 金額／數量跳動：跟上一次畫這一格時的值比，有變才從舊數字跳到新數字（ui_fx.js 的
 * fxCountFrom，0.65 秒）——記帳送出、下拉更新之後，一眼看得出變了多少。
 * 第一次出現、數字沒變、沒載到 ui_fx.js、手機開了減少動態效果，都直接顯示結果。
 * key 要能分辨是哪一格，例如 'home:dice:in'、'card:<機台編號>'。
 * 換人登入時 clearSession() 會清掉這份記憶，不會從上一位使用者看到的數字跳過來。
 */
let _countMem = {};
function countUp(el, n, key, fmt) {
  const prev = _countMem[key];
  _countMem[key] = n;
  el.textContent = fmt(n);
  if (prev !== undefined && prev !== n && typeof window.fxCountFrom === 'function') window.fxCountFrom(el, prev, n, fmt);
}

/** 會跳動的數字元素（見 countUp）。 */
function countEl(tag, cls, n, fmt, key) {
  const el = h(tag, { class: cls });
  countUp(el, Number(n) || 0, key, fmt);
  return el;
}

/** 跟 statBox 一樣的數字方塊，但數字會跳動（見 countUp）。fmt 是 money 或 countText。 */
function statNum(label, n, fmt, cls, key) {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'stat-label', text: label }),
    countEl('div', 'stat-value num ' + (cls || ''), n, fmt, key)
  ]);
}

/** 數量（支數、筆數）的顯示格式：跟原本 String(n) 一樣，不加 $。 */
function countText(n) { return String(n); }

function viewHome() {
  const data = state.home;
  if (!data) return loadingView('home');

  const header = h('div', { class: 'topbar' }, [
    h('div', {}, [
      h('h1', { text: '機台總覽' }),
      h('div', { class: 'user-meta' }, [
        h('span', { class: 'muted', text: state.user.displayName }),
        h('span', { class: 'badge badge-' + state.user.role, text: state.user.roleLabel })
      ])
    ]),
    h('div', { class: 'row' }, [
      isAdmin() ? h('button', { class: 'btn btn-sm', onclick: goAdmin }, '⚙ 系統管理') : null,
      BACKEND === 'supabase' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: openChangePasswordDialog }, '🔑 改密碼') : null,
      h('button', { class: 'btn btn-sm btn-ghost', onclick: doLogout }, '登出')
    ])
  ]);

  let summary;
  let list;

  if (state.homeTab === 'electronic') {
    const t = data.electronicTotal;
    summary = h('div', { class: 'summary-strip summary-strip-3' }, [
      statNum('今日開分', t.chipIn, money, 'net pos', 'home:el:chipIn'),
      statNum('今日洗分', t.chipOut, money, '', 'home:el:chipOut'),
      statNum('今日盈虧', t.chipNet, money, 'net ' + netClass(t.chipNet), 'home:el:chipNet')
    ]);
    const machines = data.machines.filter((m) => m.category === 'electronic');
    list = machines.length
      ? h('div', { class: 'machine-list' }, machines.map(machineCard))
      : emptyState(isAdmin()
        ? '還沒有電子機台。到「⚙ 系統管理 → 機台」新增一台。'
        : '目前沒有開放給你的電子機台。', 'card');
  } else if (state.homeTab === 'total') {
    const dice = data.diceTotal;
    const electronic = data.electronicTotal;
    const grandNet = dice.net + electronic.chipNet;
    // 今日總淨收益是這一頁最重要的數字：手機上自己佔一整排、字放大（.stat-hero），一眼看到
    const grandStat = statNum('今日總淨收益', grandNet, money, 'net ' + netClass(grandNet), 'home:total:grandNet');
    grandStat.classList.add('stat-hero');
    summary = h('div', {}, [
      // 本月432/441支數放最上面，跟下面「今日」那排分開——是不同時間
      // 範圍的數字，混在同一排容易誤看成也是「今日」的。
      h('div', { class: 'summary-strip', style: 'grid-template-columns:repeat(2, 1fr); margin-bottom:8px' }, [
        statNum('本月432支數', data.month432Count || 0, countText, '', 'home:total:m432'),
        statNum('本月441支數', data.month441Count || 0, countText, '', 'home:total:m441')
      ]),
      h('div', { class: 'summary-strip summary-strip-3' }, [
        statNum('今日骰台淨收益', dice.net, money, 'net ' + netClass(dice.net), 'home:total:diceNet'),
        statNum('今日電子淨收益', electronic.chipNet, money, 'net ' + netClass(electronic.chipNet), 'home:total:elNet'),
        grandStat
      ])
    ]);
    list = ledgerCard(data);
  } else {
    const t = data.diceTotal;
    // 骰台這排是 6 張卡片，跟其他分頁籤（電子/加總各 3 張）不一樣，桌機版
    // 用專屬的 summary-strip-6 排成 3 欄 2 排，不是共用 4 欄（6 張塞進 4 欄
    // 會變成「4+2」，最後一排看起來缺兩塊）。
    summary = h('div', { class: 'summary-strip summary-strip-6' }, [
      statNum('今日入幣', t.in, money, 'net pos', 'home:dice:in'),
      statNum('今日出幣', t.out, money, '', 'home:dice:out'),
      statNum('今日432數量', data.today432Count || 0, countText, '', 'home:dice:432'),
      statNum('今日441數量', data.today441Count || 0, countText, '', 'home:dice:441'),
      statNum('今日活動金額', t.prize, money, '', 'home:dice:prize'),
      statNum('今日總筆數', (data.todayOutCount || 0) + (data.today432Count || 0) + (data.today441Count || 0), countText, '', 'home:dice:records')
    ]);
    const machines = data.machines.filter((m) => m.category !== 'electronic');
    list = machines.length
      ? h('div', { class: 'machine-list' }, machines.map(machineCard))
      : emptyState(isAdmin()
        ? '還沒有任何機台。到「⚙ 系統管理 → 機台」新增第一台。'
        : '目前沒有開放給你的機台，請聯絡管理員。', 'card');
  }

  return h('div', {}, [
    h('div', { class: 'home-sticky' }, [header, summary, businessDayBar(data.businessDay), homeTabBar()]),
    list
  ].filter((n) => n !== null));
}

/**
 * 分頁滑動膠囊（ui_fx.js 的 fxMoveSlider）：選中的藍底從上一次選中的那顆滑到新的這顆，
 * 而不是瞬間跳過去。每次切換都會整個重畫，所以要自己記住「這一組分頁上次選中第幾顆」
 * （key 分辨是哪一組）。膠囊怎麼疊在按鈕底下見 ui_fx.css 的 .fx-tabs-slide；
 * 沒載到 ui_fx.js 就什麼都不加，維持原本 .active 的底色。
 */
const _tabsLastActive = {};
function slidingTabs(container, key) {
  if (typeof window.fxMoveSlider !== 'function') return container;
  container.classList.add('fx-tabs-slide');
  const slider = h('span', { class: 'fx-slider', 'aria-hidden': 'true' });
  container.insertBefore(slider, container.firstChild);
  // 要等 render() 把它放進畫面、排好版才量得到位置；requestAnimationFrame 會在畫出來之前跑，不會先閃一下
  requestAnimationFrame(() => {
    if (!container.isConnected) return;
    const buttons = Array.prototype.slice.call(container.querySelectorAll('button'));
    const active = container.querySelector('button.active');
    if (!active) return;
    const idx = buttons.indexOf(active);
    const prev = _tabsLastActive[key];
    _tabsLastActive[key] = idx;
    window.fxMoveSlider(slider, active, prev !== undefined && prev !== idx ? buttons[prev] : null);
  });
  return container;
}

/** 首頁分頁籤：骰台（預設）／電子／加總。放在「今日營業開始／結單」下面。 */
function homeTabBar() {
  const tabs = [['dice', '骰台'], ['electronic', '電子'], ['total', '加總']];
  return slidingTabs(h('div', { class: 'seg', style: 'margin-top:10px' }, tabs.map(([key, label]) =>
    h('button', {
      class: state.homeTab === key ? 'active' : '',
      onclick: () => { state.homeTab = key; render(); }
    }, label))), 'home');
}

/**
 * 「加總」分頁的今日現金結餘明細——跟上面三張淨收益卡片是不同的概念：
 * 淨收益是機台本身的營收表現（入幣/出幣/開分/洗分，含活動成本），這裡
 * 則是整間店當天實際的「現金」進出對帳（跟原本紙本/Excel 記的那張表
 * 一一對應）。「活動出獎」（系統自動算出來的432活動金額）不列在這裡、
 * 也不扣進總結餘——給出去的是獎品不是現金，不會讓收銀機裡的錢變少，
 * 不算現金支出。「432(手動)」「441(手動)」是另外辦活動時的手動支出，
 * 是真的現金流出，所以繼續扣。
 * 台主給／台主領可能不只一筆（不只一位台主），各自可以命名，這裡逐筆列出
 * 用各自的名字當標籤，不是只顯示一個「台主給」的總和——沒有任何一筆時
 * 退回顯示「台主給／台主領 $0」這一行占位，維持跟其他固定項目一樣的排版。
 * 「運拿」「還內場」都已經用不到了，不列在這裡，總結餘也不會扣（DailyLedger
 * 分頁還留著這兩欄只是為了讀舊資料，新存的值不影響這裡）。
 * 週轉金／入幣／出幣／電子總結是每天一定會有、獨立列出的項目（電子總結
 * 放在出幣下面）；其餘手動
 * 輸入、會加回或扣掉總結餘的項目再拆成「收入（+）」「支出（-）」兩個
 * 小分類，方便現場核對明細時知道哪些是加、哪些是扣。
 *
 * 這份資料跟卡片畫面（DOM）跟匯出截圖（canvas）共用同一份，避免兩邊
 * 各寫一次、改一邊忘了改另一邊。每一行是 [標籤, 金額]，分類標題則是
 * { section: 標題文字 }。
 */
function ledgerRows(data) {
  const l = data.ledger;
  const givenRows = (l.givenToOwnerItems.length ? l.givenToOwnerItems : [{ name: '台主給', amount: 0 }])
    .map((it) => [it.name, it.amount]);
  const takenRows = (l.takenByOwnerItems.length ? l.takenByOwnerItems : [{ name: '台主領', amount: 0 }])
    .map((it) => [it.name, -it.amount]);
  return [
    ['週轉金', l.turnover],
    ['入幣', data.diceTotal.in],
    ['出幣', -data.diceTotal.out],
    ['電子總結', data.electronicTotal.chipNet],
    { section: '收入（+）' },
    ...givenRows,
    { section: '支出（-）' },
    ['432活動出獎', -l.manual432],
    ['441活動出獎', -l.manual441],
    ['開銷', -l.manualExpense],
    ...takenRows
  ];
}

function ledgerCard(data) {
  const l = data.ledger;
  const rows = ledgerRows(data);

  // 上面一排橫的兩顆——手機螢幕塞不下時用橫向捲動（跟 .tabs／
  // .machine-switcher 同一種做法），不要讓按鈕擠壓成直的好幾排。
  // 「匯出明細截圖」放最下面總結餘下面，不跟這排擠在一起。
  // 靠右排用第一顆的 margin-left:auto，不用 justify-content:flex-end——後者在按鈕總寬超過
  // 螢幕時會把多出來的部分推到「左邊外面」，那一截捲不回來（最左邊的「活動查詢」會被切掉一截）；
  // auto 外距在塞不下時自動變成 0，改成從左邊開始排、往右捲得到全部。
  const actionsRow = h('div', { class: 'row', style: 'flex-wrap:nowrap; overflow-x:auto; gap:8px; margin-bottom:10px' }, [
    h('button', { class: 'btn btn-sm', style: 'white-space:nowrap; flex:0 0 auto; margin-left:auto', onclick: goActivityQuery }, '🎁 活動查詢'),
    h('button', { class: 'btn btn-sm', style: 'white-space:nowrap; flex:0 0 auto', onclick: () => goReport('', 'dice') }, '📊 骰台查詢'),
    canRecord()
      ? h('button', { class: 'btn btn-sm btn-prize', style: 'white-space:nowrap; flex:0 0 auto', onclick: () => editDailyLedger(data) }, '✎ 設定今日數字')
      : null
  ]);

  return h('div', { class: 'card' }, [
    actionsRow,
    h('div', { class: 'panel-head' }, [
      h('h3', { text: (data.todayOpenedByName ? data.todayOpenedByName + ' ' : '') + dayKeyToLabel(data.today) })
    ]),
    h('div', {}, rows.map((row) => row.section
      ? h('div', { class: 'ledger-section-title', text: row.section })
      : h('div', { class: 'ledger-row' }, [
        h('span', { class: 'ledger-label', text: row[0] }),
        h('span', { class: 'ledger-value num ' + netClass(row[1]), text: money(row[1]) })
      ]))),
    h('div', { class: 'ledger-row ledger-total' }, [
      h('span', { class: 'ledger-label', text: '總結餘' }),
      countEl('span', 'ledger-value num ' + netClass(data.ledgerTotal), data.ledgerTotal, money, 'home:ledgerTotal')
    ]),
    h('p', { class: 'small muted', style: 'margin-top:10px' },
      '今日432支數 ' + (data.today432Count || 0) + '　今日441支數 ' + (data.today441Count || 0)),
    h('button', {
      class: 'btn btn-sm',
      style: 'width:100%; margin-top:12px',
      onclick: () => exportLedgerImage(data)
    }, '📷 匯出明細截圖'),
    l.updatedAt
      ? h('p', { class: 'small muted', style: 'margin-top:10px', text: '週轉金／台主給／台主領／開銷／432／441 最後更新：' + formatTime(l.updatedAt) })
      : h('p', { class: 'small muted', style: 'margin-top:10px' }, isAdmin() || canRecord()
        ? '週轉金／台主給／台主領／開銷／432／441 今天還沒設定，點上面「✎ 設定今日數字」輸入。'
        : '週轉金／台主給／台主領／開銷／432／441 今天還沒設定。')
  ]);
}

/**
 * 把「今日現金結餘明細」卡片畫成一張 PNG 圖片下載——現場對帳習慣截圖傳
 * 群組，明細列一多手機螢幕塞不下，一次截圖只能截到一半，還要拼兩張。
 * 用 canvas 手繪而不是叫 html2canvas 之類的套件，是因為這個 App 是
 * 離線可用的 PWA（見 docs/sw.js），不想為了這個功能多裝一個外部套件、
 * 多一個離線時可能載不到的依賴。
 */
function exportLedgerImage(data) {
  const rows = ledgerRows(data);
  const scale = 2;
  const width = 360;
  const rowH = 32;
  const padX = 16;
  const headerH = 44;
  const totalH = 44;
  const font = 'system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';
  const colorBg = '#141926';
  const colorBorder = '#263049';
  const colorText = '#E8ECF5';
  const colorMuted = '#8B96AD';
  const colorSection = '#FBBF24';
  const colorPos = '#4ADE80';
  const colorNeg = '#F87171';
  const valueColor = (v) => (v > 0 ? colorPos : v < 0 ? colorNeg : colorMuted);

  const footerH = 30;
  const height = headerH + rows.length * rowH + totalH + footerH + 16;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = colorBg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = colorText;
  ctx.font = 'bold 17px ' + font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText((data.todayOpenedByName ? data.todayOpenedByName + ' ' : '') + dayKeyToLabel(data.today), padX, headerH / 2 + 4);

  let y = headerH;
  rows.forEach((row) => {
    if (row.section) {
      ctx.font = 'bold 13px ' + font;
      ctx.fillStyle = colorSection;
      ctx.textAlign = 'left';
      ctx.fillText(row.section, padX, y + rowH / 2);
      y += rowH;
      return;
    }
    const [label, value] = row;

    ctx.strokeStyle = colorBorder;
    ctx.beginPath();
    ctx.moveTo(padX, y + rowH - 0.5);
    ctx.lineTo(width - padX, y + rowH - 0.5);
    ctx.stroke();

    ctx.font = '14px ' + font;
    ctx.fillStyle = colorMuted;
    ctx.textAlign = 'left';
    ctx.fillText(label, padX, y + rowH / 2);

    ctx.font = 'bold 14px ' + font;
    ctx.fillStyle = valueColor(value);
    ctx.textAlign = 'right';
    ctx.fillText(money(value), width - padX, y + rowH / 2);

    y += rowH;
  });

  y += 8;
  ctx.strokeStyle = colorBorder;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padX, y);
  ctx.lineTo(width - padX, y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = 'bold 16px ' + font;
  ctx.fillStyle = colorText;
  ctx.textAlign = 'left';
  ctx.fillText('總結餘', padX, y + totalH / 2 + 4);

  ctx.font = 'bold 19px ' + font;
  ctx.fillStyle = valueColor(data.ledgerTotal);
  ctx.textAlign = 'right';
  ctx.fillText(money(data.ledgerTotal), width - padX, y + totalH / 2 + 4);

  y += totalH;
  ctx.font = '13px ' + font;
  ctx.fillStyle = colorMuted;
  ctx.textAlign = 'left';
  ctx.fillText('今日432支數 ' + (data.today432Count || 0) + '　今日441支數 ' + (data.today441Count || 0), padX, y + footerH / 2 + 2);

  const filename = '今日現金結餘明細_' + (data.today || todayInputValue()) + '.png';
  const blob = _dataUrlToBlob(canvas.toDataURL('image/png'));

  // 手機（尤其 iPhone Safari，裝成 PWA 獨立模式後更明顯）不吃「憑空建立
  // 一個 <a download> 沒放進畫面就直接點擊」這招——按下去完全沒反應，
  // 這是手機版按鈕沒動靜最常見的原因。改用手機原生的分享面板（能選「儲存
  // 圖片」），share() 一定要在點擊當下同步呼叫，不能等 toDataURL 之後的
  // 非同步流程，不然手機會判定不是使用者主動觸發而擋下來——所以上面轉
  // Blob 用同步的 _dataUrlToBlob，不是用非同步的 canvas.toBlob。
  // 桌機／不支援分享面板的瀏覽器：走原本的下載連結，但一定要先把 <a>
  // 掛進畫面再點擊——沒掛進畫面點擊在部分瀏覽器一樣會被吃掉沒反應。
  // canShare() 過了不保證 share() 真的會成功（例如檔案太大被系統分享
  // 面板拒絕），share() 失敗時退回這條路，不要整個吞掉沒反應。
  function downloadFallback() {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  const file = (typeof File !== 'undefined') ? new File([blob], filename, { type: 'image/png' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file] }).catch(downloadFallback);
    return;
  }

  downloadFallback();
}

/** 同步把 data: URL 轉成 Blob——刻意不用非同步的 canvas.toBlob()，見上面呼叫端註解。 */
function _dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)[1];
  const bin = atob(parts[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * 設定今天（進行中營業日）的週轉金／台主給／台主領／開銷／432／441，
 * 每天只存一組，重新儲存會覆蓋。
 *
 * 週轉金今天還沒設定過的話，預設帶入上一次已結單的營業日算出來的「總
 * 結餘」（data.previousLedgerTotal，見 getDashboard() 的說明）——現金
 * 週轉金本來就是上次結完帳留在收銀機裡的錢，直接延續比每次手動回頭查
 * 上一次金額方便；完全沒有已結單的歷史（剛上線）時退回空白。其他項目
 * 每天金額都不一樣，還沒設定過的話留白，比留著「0」等使用者自己刪更
 * 順手（空白跟 0 存檔時效果相同，saveDailyLedger 送出時 Number('') || 0
 * 本來就會存成 0）。今天已經設定過的話，一律照實際存的值顯示（包含存過
 * 的 0），不會覆蓋掉使用者剛存的東西。
 */

/**
 * 台主給／台主領可能不只一位台主，這裡做成可以按「+」新增好幾筆、
 * 每筆名字都能自己改的清單編輯器，不是固定一個輸入框。
 * initialItems 沒有資料時預設放一筆空白列（名字留白、金額留白），
 * 讓使用者一打開就有地方可以直接打字，不用自己先按一次「+」。
 */
function ledgerItemsEditor(initialItems, defaultName) {
  const rowsWrap = h('div', { class: 'ledger-items-wrap' });
  const rows = [];

  function addRow(name, amount) {
    const nameInput = h('input', { type: 'text', maxlength: '30', placeholder: defaultName, value: name || '' });
    const amountInput = h('input', {
      type: 'number', inputmode: 'decimal', placeholder: '金額',
      value: amount === '' || amount === undefined || amount === null ? '' : amount
    });
    const entry = { nameInput, amountInput, rowEl: null };
    const removeBtn = h('button', {
      type: 'button', class: 'btn btn-sm ledger-item-remove',
      onclick: () => { entry.rowEl.remove(); rows.splice(rows.indexOf(entry), 1); }
    }, '×');
    entry.rowEl = h('div', { class: 'ledger-item-row' }, [nameInput, amountInput, removeBtn]);
    rows.push(entry);
    rowsWrap.appendChild(entry.rowEl);
  }

  (initialItems && initialItems.length ? initialItems : [{ name: '', amount: '' }])
    .forEach((it) => addRow(it.name, it.amount));

  const addBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => addRow('', '') }, '+ 新增一筆');

  return {
    node: h('div', { class: 'ledger-items-editor' }, [rowsWrap, addBtn]),
    getItems: () => rows.map((r) => ({ name: r.nameInput.value, amount: Number(r.amountInput.value) || 0 }))
  };
}

function editDailyLedger(data) {
  const l = data.ledger;
  const setToday = !!l.updatedAt;
  const manualExpense = h('input', { type: 'number', inputmode: 'decimal', min: '0', value: setToday ? (l.manualExpense || '') : '' });
  const turnover = h('input', {
    type: 'number', inputmode: 'decimal',
    value: setToday ? l.turnover : (data.previousLedgerTotal === null || data.previousLedgerTotal === undefined ? '' : data.previousLedgerTotal)
  });
  const manual432 = h('input', { type: 'number', inputmode: 'decimal', min: '0', value: setToday ? (l.manual432 || '') : '' });
  const manual441 = h('input', { type: 'number', inputmode: 'decimal', min: '0', value: setToday ? (l.manual441 || '') : '' });
  const givenEditor = ledgerItemsEditor(setToday ? l.givenToOwnerItems : [], '台主給');
  const takenEditor = ledgerItemsEditor(setToday ? l.takenByOwnerItems : [], '台主領');

  openDialog('設定今日數字', [
    h('p', { class: 'small muted', style: 'margin-bottom:12px' },
      '這些是整間店當天的現金調度，跟哪一台機台無關。台主領、開銷、432/441 請直接輸入正數金額，系統會自動從總結餘扣除；週轉金、台主給則是加回總結餘。432/441 是自動算出來的活動金額之外，另外辦活動時的手動支出；開銷是每天一般的手動現金支出。台主給／台主領可以按「+ 新增一筆」記好幾位台主，名字可以自己改。每天只會存一組數字，重新儲存會覆蓋掉今天原本的值。'),
    dialogField('開銷（會自動扣除）', manualExpense),
    dialogField('週轉金', turnover),
    dialogField('432活動出獎（會自動扣除）', manual432),
    dialogField('441活動出獎（會自動扣除）', manual441),
    dialogField('台主給', givenEditor.node),
    dialogField('台主領（會自動扣除）', takenEditor.node)
  ], [
    h('button', { class: 'btn', onclick: closeDialog }, '取消'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (e) => run(async () => {
        await api('saveDailyLedger', {
          turnover: Number(turnover.value) || 0,
          manualExpense: Number(manualExpense.value) || 0,
          manual432: Number(manual432.value) || 0,
          manual441: Number(manual441.value) || 0,
          givenToOwnerItems: givenEditor.getItems(),
          takenByOwnerItems: takenEditor.getItems()
        });
        closeDialog();
        await loadHome();
      }, { success: '已儲存', button: e.currentTarget, busyText: '儲存中…' })
    }, '儲存')
  ]);
}

/**
 * 「今日營業開始／結單」——預設「今日」是凌晨 0 點自動換日，
 * 有些店家晚上開到隔天凌晨，帳會被行事曆日期從中間切開，跟現場
 * 認知的「一個晚上的營業額」對不起來。按了「開始」之後，記帳會
 * 一律算進按下去那一刻的日期，直到按「結單」為止，不受凌晨 0 點
 * 影響；沒按過的話，行為跟以前完全一樣。
 *
 * 只有能記帳的角色（管理員／巡邏人員）才看得到——台主唯讀，
 * 這兩顆按鈕不該出現在他們的畫面上。
 */
function businessDayBar(biz) {
  if (!canRecord()) return null;
  const isOpen = !!(biz && biz.open);
  // 選了不是今天的營業日期，狀態列要寫出來，免得以為帳記在今天
  const bizDate = isOpen ? biz.current.businessDate : '';
  const dateNote = bizDate && bizDate !== todayInputValue()
    ? '營業日 ' + Number(bizDate.slice(5, 7)) + '/' + Number(bizDate.slice(8, 10)) + ' · '
    : '';
  const status = isOpen
    ? '營業中 · ' + dateNote + formatTime(biz.current.openedAt) + ' 開始'
      + (biz.current.openedByName ? '（' + biz.current.openedByName + '）' : '')
    : '尚未開始今日營業，記帳暫時照行事曆日期算';

  // 兩顆都一直能按，只是「現在不該按的那顆」退成外框樣式（bizday-dim），提示該按哪一顆：
  // 還沒營業時突顯「開始」，營業中突顯「結單」
  const actions = [
    h('button', { class: 'btn btn-in' + (isOpen ? ' bizday-dim' : ''), onclick: doStartBusinessDay }, '▶ 今日營業開始'),
    h('button', { class: 'btn btn-out' + (isOpen ? '' : ' bizday-dim'), onclick: doEndBusinessDay }, '⏹ 今日營業結單')
  ];
  // 誤按「結單」的復原按鈕：只有管理員看得到，只在目前沒有進行中的
  // 營業日時才出現。真的「沒有可以復原的營業日」（例如從沒按過這個
  // 功能）由後端 reopenBusinessDay() 擋下、給明確的錯誤訊息，前端
  // 不用先精準判斷，維持簡單。
  if (!isOpen && isAdmin()) {
    actions.push(h('button', { class: 'btn btn-ghost', onclick: doReopenBusinessDay }, '↺ 復原剛剛的結單'));
  }

  return h('div', { class: 'bizday-bar' }, [
    // 狀態前面的小圓點：營業中是會呼吸的綠燈（ui_fx.css 的 .fx-breath），還沒營業是不亮的灰點
    h('div', { class: 'bizday-status small muted' }, [
      h('span', { class: 'bizday-dot' + (isOpen ? ' on fx-breath' : ''), 'aria-hidden': 'true' }),
      status
    ]),
    h('div', { class: 'bizday-actions' }, actions)
  ]);
}

/**
 * 開始/結單都會改變「今日」的計算邊界（哪些紀錄算今天），但機台詳細頁
 * 的快取（detail:機台編號）是靠 CACHE_FRESH_MS（5 分鐘）判斷新不新鮮，
 * 不知道營業日邊界剛剛換了——不清掉的話，剛按完「今日營業開始」馬上
 * 點進某台機台，看到的還會是快取裡按下去之前的舊「今日」數字，最多要
 * 等快取自然過期（5 分鐘）才會更新，等於「重置」沒有立刻生效。
 */
function _clearMachineDetailCache() {
  Object.keys(state.cache).forEach((k) => {
    if (k.indexOf('detail:') === 0) delete state.cache[k];
  });
}

/**
 * 「今日營業開始」：先跳視窗選營業日期跟開始時間（預設今天／現在，都不能選未來）——
 * 跨夜過了凌晨 0 點才開始、忘了按開始、或要補記前幾天的帳時，可以把這段營業
 * 算進選的那一天、從選的時間開始算「今日」。
 * 已經在營業中的話，視窗裡一併提醒會先自動結算目前這個營業日。
 * 回傳 Promise：按開始 → { businessDate: 'yyyy-MM-dd', openedAt: ISO 字串 }；
 * 取消／點外面／往下滑關掉 → null。
 */
function _localDateTimeValue(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function askBusinessDate(isOpen) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      closeDialog();
      resolve(val);
    };
    const today = todayInputValue();
    const dateInput = h('input', { type: 'date', value: today, max: today });
    const nowValue = _localDateTimeValue(new Date());
    const timeInput = h('input', { type: 'datetime-local', value: nowValue, max: nowValue });
    // 改了營業日期就把開始時間的日期跟著換過去（時間不動），省得兩個都要改；換過去會變未來就不動
    dateInput.addEventListener('change', () => {
      if (!dateInput.value || !timeInput.value) return;
      const moved = dateInput.value + timeInput.value.slice(10);
      if (moved <= _localDateTimeValue(new Date())) timeInput.value = moved;
    });
    const errorEl = h('p', { class: 'small', style: 'color:var(--danger);margin:0 0 8px', hidden: true });
    const body = [
      isOpen
        ? h('p', { class: 'confirm-msg', style: 'margin:0 0 12px', text: '目前已經在營業中。開始新的營業日會自動結算目前這個。' })
        : null,
      dialogField('營業日期', dateInput),
      dialogField('開始時間', timeInput),
      h('p', { class: 'small muted', style: 'margin:-6px 0 12px', text: '這段營業的帳都會算進選的日期，直到按「結單」；開始時間之後記的帳才算進今日數字。' }),
      errorEl
    ];
    const submit = () => {
      const v = dateInput.value;
      if (!v) { errorEl.textContent = '請選擇營業日期'; errorEl.hidden = false; return; }
      if (v > today) { errorEl.textContent = '不能選未來的日期'; errorEl.hidden = false; return; }
      const t = timeInput.value;
      if (!t) { errorEl.textContent = '請選擇開始時間'; errorEl.hidden = false; return; }
      const openedAt = new Date(t);
      if (isNaN(openedAt.getTime())) { errorEl.textContent = '開始時間格式不對'; errorEl.hidden = false; return; }
      if (openedAt.getTime() > Date.now() + 60000) { errorEl.textContent = '開始時間不能晚於現在'; errorEl.hidden = false; return; }
      finish({ businessDate: v, openedAt: openedAt.toISOString() });
    };
    const backdrop = openDialog(isOpen ? '重新開始營業？' : '今日營業開始', body, [
      h('button', { class: 'btn', onclick: () => finish(null) }, '取消'),
      h('button', { class: 'btn btn-primary', onclick: submit }, isOpen ? '重新開始' : '開始')
    ]);
    backdrop._onClose = () => finish(null);
  });
}

async function doStartBusinessDay(e) {
  const btn = e && e.currentTarget; // 見 askConfirm() 的說明：要在 await 之前記下來
  const biz = state.home && state.home.businessDay;
  const picked = await askBusinessDate(!!(biz && biz.open));
  if (!picked) return;
  const businessDate = picked.businessDate;
  const isToday = businessDate === todayInputValue();
  run(async () => {
    await api('startBusinessDay', picked);
    _clearMachineDetailCache();
    await loadHome();
    playShopLights('open');
  }, {
    success: isToday
      ? '已開始今日營業，所有機台的今日數字已重置'
      : '已開始 ' + Number(businessDate.slice(5, 7)) + '/' + Number(businessDate.slice(8, 10)) + ' 的營業',
    button: btn, busyText: '處理中…'
  });
}

async function doEndBusinessDay(e) {
  const btn = e && e.currentTarget;
  if (!(await askConfirm({
    title: '結算今日營業？',
    message: '結單後才能再次「今日營業開始」。',
    okText: '結單'
  }))) return;
  run(async () => {
    await api('endBusinessDay', {});
    _clearMachineDetailCache();
    await loadHome();
    playShopLights('close');
  }, { success: '已結算今日營業', button: btn, busyText: '處理中…' });
}

async function doReopenBusinessDay(e) {
  const btn = e && e.currentTarget;
  if (!(await askConfirm({
    title: '復原剛剛的結單？',
    message: '會把最近一筆營業日改回「進行中」。',
    okText: '復原'
  }))) return;
  run(async () => {
    await api('reopenBusinessDay', {});
    _clearMachineDetailCache();
    await loadHome();
    playShopLights('open');
  }, { success: '已復原，回到營業中', button: btn, busyText: '處理中…' });
}

function machineCard(m) {
  const isElectronic = m.category === 'electronic';
  const net = isElectronic ? m.today.chipNet : m.today.net;
  const breakdown = isElectronic
    ? ('開 ' + money(m.today.chipIn) + ' · 洗 ' + money(m.today.chipOut))
    : ('入 ' + money(m.today.in) + ' · 出 ' + money(m.today.out) + ' · 動 ' + money(m.today.prize));

  return h('button', {
    class: 'machine-card',
    type: 'button',
    onclick: () => goMachine(m.machineId)
  }, [
    machineSvg(72, m.color, m.status, m.icon, { seed: m.machineId }),
    h('div', { class: 'info' }, [
      h('div', { class: 'name', text: m.name }),
      h('div', { class: 'loc' }, [
        m.location || '—',
        m.status !== 'running'
          ? h('span', { class: 'badge badge-owner', style: 'margin-left:6px', text: STATUS_LABELS[m.status] })
          : null
      ])
    ]),
    h('div', { class: 'figures' }, [
      countEl('div', 'net num ' + netClass(net), net, money, 'card:' + m.machineId),
      h('div', { class: 'breakdown num' }, breakdown)
    ])
  ]);
}

// ── 畫面：機台詳細 ──────────────────────────────────────

/**
 * 記帳成功後，機台頁上面那台大娃娃機跟著做動作（machineAct），「今日淨收益」旁邊飄出這筆的金額。
 * 送出成功時先用 queueMachineReaction() 記下來，接著畫面重畫、viewMachine() 畫到同一台時
 * 用 playMachineReaction() 播——跟「新紀錄亮一下」同一個做法：只用一次，15 秒內、同一台才算
 * （送出後還沒等到後端回來就切去別台，不會在別台播）。
 * delta：{ amount：這筆讓淨收益加減多少, tone：'in'／'out'／'prize'（飄字的顏色）}，可省略。
 */
let _machineReaction = null;
function queueMachineReaction(machineId, act, delta) {
  _machineReaction = { machineId: machineId, act: act, delta: delta || null, at: Date.now() };
}
function playMachineReaction(machineId, svg, anchor) {
  const r = _machineReaction;
  if (!r || r.machineId !== machineId) return;
  _machineReaction = null;
  if (Date.now() - r.at > 15000) return;
  if (typeof window.fxReduced !== 'function' || window.fxReduced()) return; // 沒載到 ui_fx 或減少動態效果：不播
  // 畫面要等 render() 放進頁面才看得到，下一個畫面更新再開始播
  requestAnimationFrame(() => { if (svg.isConnected) machineAct(svg, r.act); });
  if (r.delta && anchor) {
    const d = r.delta;
    const float = h('span', {
      class: 'fx-delta fx-delta-' + d.tone,
      'aria-hidden': 'true',
      text: (d.amount >= 0 ? '+' : '−') + money(Math.abs(d.amount))
    });
    anchor.classList.add('fx-delta-anchor');
    anchor.appendChild(float);
    setTimeout(() => float.remove(), 1700);
  }
}

/** 營業開始／結單後，首頁每台機台的燈從上到下依序亮起來（open）或熄掉再恢復（close）。 */
function playShopLights(kind) {
  if (typeof window.fxReduced !== 'function' || window.fxReduced()) return;
  document.querySelectorAll('.machine-list .pixel-machine').forEach((svg, i) => {
    setTimeout(() => machineAct(svg, kind === 'open' ? 'powerOn' : 'powerOff'), i * 110);
  });
}

function viewMachine() {
  const d = state.detail;
  // 還沒有這台的資料（背景預取還沒跑完就點進來）：返回／查詢報表照樣能按，其他先放骨架
  if (!d) {
    return h('div', { class: 'detail-grid' }, [
      h('div', { class: 'navbar' }, [
        h('button', { class: 'btn btn-sm', onclick: goHome }, '← 返回主畫面'),
        h('button', { class: 'btn btn-sm', onclick: () => goReport(state.machineId) }, '📊 查詢報表')
      ]),
      loadingView('machine')
    ]);
  }

  const m = d.machine;

  const nav = h('div', { class: 'navbar' }, [
    h('button', { class: 'btn btn-sm', onclick: goHome }, '← 返回主畫面'),
    h('button', { class: 'btn btn-sm', onclick: () => goReport(m.machineId) }, '📊 查詢報表')
  ]);

  const heroSvg = machineSvg(96, m.color, m.status, m.icon, { seed: m.machineId });
  const hero = h('div', { class: 'detail-hero' }, [
    heroSvg,
    h('div', { class: 'title' }, [
      h('h2', { text: m.name }),
      h('div', { class: 'small muted', text: m.location || '—' }),
      h('span', {
        class: 'badge badge-' + (m.status === 'running' ? 'patrol' : 'owner'),
        text: STATUS_LABELS[m.status]
      })
    ])
  ]);

  const switcher = machineSwitcher(m.machineId);

  if (m.category === 'electronic') return viewElectronicMachine(d, nav, hero, switcher, heroSvg);

  const netStat = h('div', { class: 'stat net-stat center' }, [
    h('div', { class: 'stat-label', text: '今日淨收益（已扣活動成本）' }),
    countEl('div', 'stat-value num net ' + netClass(d.today.net), d.today.net, money, 'detail:' + m.machineId + ':net'),
    countEl('div', 'small muted num', d.total.net, (n) => '本週淨收益 ' + money(n), 'detail:' + m.machineId + ':week')
  ]);
  playMachineReaction(m.machineId, heroSvg, netStat);

  const figures = h('div', { class: 'figures-panel' }, [
    netStat,
    statNum('今日入幣', d.today.in, money, '', 'detail:' + m.machineId + ':in'),
    statNum('今日出幣', d.today.out, money, '', 'detail:' + m.machineId + ':out'),
    // 今日筆數＝今日出幣筆數＋432＋441 的支數（跟首頁「今日總筆數」同一套算法）；後端還沒更新、沒給的欄位當 0
    statNum('今日筆數', (d.todayOutCount || 0) + (d.today432Count || 0) + (d.today441Count || 0), countText, '', 'detail:' + m.machineId + ':records')
  ]);

  const actions = canRecord()
    ? h('div', { class: 'action-buttons' }, [
      h('button', { class: 'btn btn-in' + (state.panel === 'in' ? ' active' : ''), onclick: () => togglePanel('in') }, '入幣'),
      h('button', { class: 'btn btn-out' + (state.panel === 'out' ? ' active' : ''), onclick: () => togglePanel('out') }, '出幣'),
      h('button', { class: 'btn btn-prize' + (state.panel === 'prize' ? ' active' : ''), onclick: () => togglePanel('prize') }, '🎁 活動')
    ])
    : null;

  const top = h('div', { class: 'detail-top' }, [hero, switcher, figures, actions]);

  return h('div', { class: 'detail-grid' }, [
    nav,
    top,
    panelView(d),
    renderRecords(d)
  ]);
}

/** 電子機台的詳細頁：只有開分／洗分兩顆按鈕，沒有入幣/出幣/活動。 */
function viewElectronicMachine(d, nav, hero, switcher, heroSvg) {
  const netStat = statNum('盈虧金額', d.today.chipNet, money, 'net ' + netClass(d.today.chipNet), 'detail:' + d.machine.machineId + ':chipNet');
  playMachineReaction(d.machine.machineId, heroSvg, netStat);
  const figures = h('div', { class: 'figures-panel' }, [
    statNum('開分金額', d.today.chipIn, money, 'net pos', 'detail:' + d.machine.machineId + ':chipIn'),
    statNum('洗分金額', d.today.chipOut, money, '', 'detail:' + d.machine.machineId + ':chipOut'),
    netStat
  ]);

  const actions = canRecord()
    ? h('div', { class: 'action-buttons' }, [
      h('button', { class: 'btn btn-in' + (state.panel === 'chip_in' ? ' active' : ''), onclick: () => togglePanel('chip_in') }, '開分'),
      h('button', { class: 'btn btn-out' + (state.panel === 'chip_out' ? ' active' : ''), onclick: () => togglePanel('chip_out') }, '洗分')
    ])
    : null;

  const top = h('div', { class: 'detail-top' }, [hero, switcher, figures, actions]);

  return h('div', { class: 'detail-grid' }, [
    nav,
    top,
    panelView(d),
    renderRecords(d)
  ]);
}

/**
 * 好幾排可以橫向捲動的機台小按鈕，讓巡機時可以直接跳下一台，不用先按
 * 「返回主畫面」再從列表點一次。資料直接沿用 state.home（首頁載入時
 * 就有了，不用為了這排按鈕多打一次 API）；只有一台機台或首頁資料還
 * 沒載入過時就不顯示，沒有意義。
 *
 * 骰台跟電子機台分開排——併在一起的話機台一多（尤其兩種都有時）那排
 * 籤會長到要一直滑，而且兩種機台的記帳方式完全不同（入幣/出幣/活動
 * vs 開分/洗分），混在一起也容易點錯台。同一分類機台超過
 * SWITCHER_CHUNK_SIZE 台（例如骰台有 20 台）還會再往下分成好幾排，
 * 每排最多這個數字，不用在一排裡橫向滑很遠才找得到最後幾台。
 */
/**
 * 記住上一次 machineSwitcher() 是幫哪一台機台畫的，用來分辨這次重畫
 * 是「真的切到別台」還是「同一台機台原地重繪」（記帳送出後的背景
 * 重新整理、背景輪詢…）。render() 每次都整個 replaceChildren，
 * 這排籤跟著整個重建，瀏覽器自己的捲動位置記憶完全沒用，
 * 一定要手動處理，不然使用者手動滑到後面找機台，一遇到背景重繪
 * 就會被強制捲回目前這台，變成「切著切著自己彈回去」。
 */
let _switcherLastMachineId = null;

/** 一個分類最多幾台擠在同一排橫向捲動籤——超過的話換下一排，不然機台一多
 * （例如 20 台骰台）要滑很遠才找得到後面那幾台。 */
const SWITCHER_CHUNK_SIZE = 10;

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 單一排籤（某分類的其中一段，最多 SWITCHER_CHUNK_SIZE 台）。
 * rowKey 是這一排的獨立識別（分類＋第幾段），各自記自己的捲動位置；
 * showLabel 只有分類的第一段才會顯示文字，同分類換行的其他段不用重複標——
 * 但標籤那個「位子」每一排都保留（寬度用 CSS 固定死，不是靠文字撐開），
 * 沒文字的那幾排就是空白佔位，這樣每一排的第一顆機台籤才會對齊在同一個
 * X 座標，不會因為有沒有文字而一排比一排凸出去。
 */
function _machineSwitcherRow(machines, rowKey, category, showLabel, currentMachineId, isNavigation) {
  if (!machines.length) return null;

  const prevEl = document.querySelector('.machine-switcher[data-row-key="' + rowKey + '"]');
  const prevScrollLeft = prevEl ? prevEl.scrollLeft : 0;
  const hasCurrent = machines.some(function (m) { return m.machineId === currentMachineId; });

  const label = h('span', {
    class: 'switcher-row-label',
    text: showLabel ? (MACHINE_CATEGORY_LABELS[category] || category) : ''
  });

  const chips = [label].concat(machines.map(function (m) {
    const active = m.machineId === currentMachineId;
    return h('button', {
      class: 'machine-chip' + (active ? ' active' : ''),
      type: 'button',
      'aria-current': active ? 'true' : null,
      onclick: () => { if (!active) goMachine(m.machineId); }
    }, [
      h('span', { class: 'chip-dot', style: 'background:' + (STATUS_COLORS[m.status] || STATUS_COLORS.running) }),
      m.name
    ]);
  }));

  const el = h('div', { class: 'machine-switcher', 'data-row-key': rowKey }, chips);
  requestAnimationFrame(() => {
    if (isNavigation && hasCurrent) {
      // 真的切到這一排裡的機台了：捲到看得到目前這台，機台一多、剛好在畫面外時不用自己找。
      const activeChip = el.querySelector('.machine-chip.active');
      if (activeChip) activeChip.scrollIntoView({ inline: 'center', block: 'nearest' });
    } else {
      // 同一台機台的背景重繪，或目前這台不在這一排：把使用者手動滑到的位置還原回去，不要幫倒忙。
      el.scrollLeft = prevScrollLeft;
    }
  });
  return el;
}

function machineSwitcher(currentMachineId) {
  const machines = state.home && state.home.machines;
  if (!machines || machines.length < 2) return null;

  // prevAny 不存在（剛進頁面／從別頁回來）也當成「新的」，理由同下面切換的情況：
  // 都該把目前這台捲到看得到的地方，而不是沿用一個不存在的捲動位置。
  const isNavigation = !document.querySelector('.machine-switcher') || currentMachineId !== _switcherLastMachineId;
  _switcherLastMachineId = currentMachineId;

  const dice = machines.filter(function (m) { return m.category !== 'electronic'; });
  const electronic = machines.filter(function (m) { return m.category === 'electronic'; });

  const rows = [];
  [['dice', dice], ['electronic', electronic]].forEach(function ([category, list]) {
    _chunk(list, SWITCHER_CHUNK_SIZE).forEach(function (part, i) {
      rows.push(_machineSwitcherRow(part, category + '-' + i, category, i === 0, currentMachineId, isNavigation));
    });
  });
  const nonEmpty = rows.filter(Boolean);

  if (nonEmpty.length < 2) return nonEmpty[0] || null; // 只有一排時，不用多包一層容器
  return h('div', { class: 'machine-switcher-group' }, nonEmpty);
}

function togglePanel(kind) {
  state.panel = state.panel === kind ? null : kind;
  state.editMode = false;
  state.prizeCounts = {};
  _panelJustOpened = !!state.panel;
  render();
}

/**
 * 記帳面板（入幣／出幣／活動、開分／洗分）：按下去「打開」的那一次，面板從上面滑下來
 * （ui_fx.css 的 .fx-panel-in）。之後的重畫（送出後刷新、切換編輯模式…）不再播。
 */
let _panelJustOpened = false;
function panelView(d) {
  if (!state.panel) return null;
  const panel = renderPanel(d);
  if (_panelJustOpened) { panel.classList.add('fx-panel-in'); _panelJustOpened = false; }
  return panel;
}

function renderPanel(d) {
  if (state.panel === 'prize') return prizePanel(d);
  if (state.panel === 'in') return meterPanel(d);
  if (state.panel === 'chip_in' || state.panel === 'chip_out') return chipPanel(d, state.panel);
  return quickPanel(d, state.panel); // 只剩 'out' 會走到這裡
}

// ── 面板：電子機台開分／洗分（永遠手動輸入，沒有快捷金額）───

function chipPanel(d, type) {
  const custom = h('input', { type: 'number', inputmode: 'decimal', min: '1', placeholder: '輸入金額' });
  // 剛打開面板：游標直接放進金額格，數字鍵盤馬上出來（autofocus 屬性只有頁面第一次有效，所以不用它）
  if (_panelJustOpened) _focusAfterRender = custom;

  const sendBtn = h('button', { class: 'btn btn-' + (type === 'chip_in' ? 'in' : 'out') }, '送出');
  const submit = () => {
    const v = Number(custom.value);
    if (!v || v <= 0) { fieldError(custom, '請輸入大於 0 的金額'); return; }
    custom.value = '';
    submitAmount(d.machine.machineId, type, v, sendBtn);
  };
  sendBtn.addEventListener('click', submit);
  custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [h('h3', { text: TYPE_LABELS[type] })]),
    h('div', { class: 'custom-amount' }, [custom, sendBtn])
  ]);
}

// ── 面板：出幣快捷金額 ──────────────────────────────────

function quickPanel(d, type) {
  const list = d.quickAmounts[type] || [];
  const scope = d.quickAmounts.scope;

  const buttons = list.map((qa) => {
    const btn = h('button', {
      class: 'btn quick-btn btn-' + type,
      onclick: (e) => submitAmount(d.machine.machineId, type, qa.amount, e.currentTarget)
    }, qa.label || money(qa.amount));

    if (!state.editMode) return btn;

    return h('div', { class: 'quick-item' }, [
      btn,
      h('div', { class: 'quick-edit' }, [
        h('button', { class: 'btn', onclick: () => editQuickAmount(d, type, qa) }, '改'),
        h('button', { class: 'btn btn-danger', onclick: () => deleteQuickAmount(qa, type) }, '刪')
      ])
    ]);
  });

  if (state.editMode) {
    buttons.push(h('button', {
      class: 'btn quick-btn',
      onclick: () => editQuickAmount(d, type, null)
    }, '＋ 新增'));
  }

  const custom = h('input', { type: 'number', inputmode: 'decimal', min: '1', placeholder: '自訂金額' });

  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('h3', { text: TYPE_LABELS[type] + '金額' }),
      isAdmin()
        ? h('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: () => { state.editMode = !state.editMode; render(); }
        }, state.editMode ? '完成' : '✎ 編輯')
        : null
    ]),
    list.length
      ? h('div', { class: 'quick-grid' }, buttons)
      : emptyState(isAdmin() ? '還沒有快捷金額，點「✎ 編輯」新增。' : '尚未設定快捷金額，請用下方自訂金額。', null, 40),
    h('div', { class: 'custom-amount' }, [
      custom,
      h('button', {
        class: 'btn btn-' + type,
        onclick: (e) => {
          const v = Number(custom.value);
          if (!v || v <= 0) { fieldError(custom, '請輸入大於 0 的金額'); return; }
          custom.value = '';
          submitAmount(d.machine.machineId, type, v, e.currentTarget);
        }
      }, '送出')
    ]),
    isAdmin() ? scopeNote(d.machine.machineId, 'QuickAmounts', scope) : null
  ]);
}

function scopeNote(machineId, sheet, scope) {
  const isGlobal = scope === 'global';
  return h('div', { class: 'scope-note' }, [
    h('span', { text: isGlobal ? '目前沿用全局設定（改動會影響所有機台）' : '目前是本台專屬設定' }),
    h('button', {
      class: 'btn btn-sm btn-ghost',
      onclick: async (e) => {
        const btn = e.currentTarget; // 見 askConfirm() 的說明：要在 await 之前記下來
        if (!isGlobal && !(await askConfirm({
          title: '改回沿用全局？',
          message: '會刪除本台的專屬設定，改回跟其他機台共用的全局設定。',
          okText: '改回全局',
          danger: true
        }))) return;
        run(async () => {
          if (isGlobal) await api('forkScope', { sheet: sheet, machineId: machineId });
          else await api('resetScope', { sheet: sheet, machineId: machineId });
          await loadDetail(machineId);
        }, { success: isGlobal ? '已改為本台專屬設定' : '已改回沿用全局', button: btn, busyText: '處理中…' });
      }
    }, isGlobal ? '改成本台自訂' : '改回沿用全局')
  ]);
}

function editQuickAmount(d, type, qa) {
  const amount = h('input', { type: 'number', inputmode: 'decimal', min: '1', value: qa ? qa.amount : '' });
  const label = h('input', { type: 'text', maxlength: '20', value: qa ? qa.label : '', placeholder: '留空則顯示金額' });
  const order = h('input', { type: 'number', value: qa ? qa.sortOrder : (d.quickAmounts[type].length + 1) });

  openDialog(qa ? '編輯快捷鍵' : '新增快捷鍵', [
    dialogField('金額', amount),
    dialogField('顯示文字', label),
    dialogField('排序', order)
  ], [
    h('button', { class: 'btn', onclick: closeDialog }, '取消'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (e) => {
        if (!(Number(amount.value) > 0)) { fieldError(amount, '請輸入大於 0 的金額'); return; }
        run(async () => {
          await api('saveQuickAmount', {
            qaId: qa ? qa.qaId : '',
            machineId: qa ? qa.machineId : (d.quickAmounts.scope === 'machine' ? d.machine.machineId : ''),
            type: type,
            amount: Number(amount.value),
            label: label.value.trim(),
            sortOrder: Number(order.value) || 0
          });
          closeDialog();
          await loadDetail(d.machine.machineId);
        }, { success: '已儲存', button: e.currentTarget, busyText: '儲存中…' });
      }
    }, '儲存')
  ]);
}

async function deleteQuickAmount(qa, type) {
  if (!(await askConfirm({
    title: '刪除這個快捷鍵？',
    detail: TYPE_LABELS[type] + ' ' + (qa.label || money(qa.amount)),
    okText: '刪除',
    danger: true
  }))) return;
  run(async () => {
    await api('deleteQuickAmount', { qaId: qa.qaId });
    await collapseDeletedRow();
    await loadDetail(state.machineId);
  }, { success: '已刪除' });
}

function submitAmount(machineId, type, amount, btn) {
  const before = shownRecordIds();
  run(async () => {
    const res = await api('addRecord', {
      machineId: machineId,
      type: type,
      amount: amount,
      clientToken: uuid()
    });
    if (res.duplicated) toast('這筆已經記過了', 'success');
    else {
      toast(TYPE_LABELS[type] + ' ' + money(amount) + ' 已登錄', 'success');
      flashNewRecords(before);
      // 開分：金幣掉進去、盈虧變多；出幣／洗分：金幣彈出來、淨收益變少
      if (type === 'chip_in') queueMachineReaction(machineId, 'coinIn', { amount: amount, tone: 'in' });
      else queueMachineReaction(machineId, 'coinOut', { amount: -amount, tone: 'out' });
    }
    // 後端已經把送出之後最新的詳細頁資料一起回傳（見 Service.gs 的
    // addRecord），不用再另外打一次 machineDetail，省一趟網路來回。
    applyDetail(machineId, res.detail);
  }, { button: btn, busyText: '送出中…' });
}

// ── 面板：入幣（碼表登錄）───────────────────────────────

/**
 * 入幣不再直接輸入金額，改成登記上班表／下班表兩個碼表讀數，
 * 金額 = (下班表 − 上班表) × 每格金額，由後端算好才是準的
 * （前端這裡的即時試算只是給操作人看，送出時不會把算出來的金額帶過去）。
 */
function meterPanel(d) {
  const rateInfo = d.meterRate;

  const startInput = h('input', {
    type: 'number', inputmode: 'numeric', min: '0', step: '1',
    value: d.lastMeterReading === null ? '' : String(d.lastMeterReading)
  });
  const endInput = h('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1' });
  // 剛打開面板：游標直接放進下班表（上班表已經帶好上次的讀數）；第一次用、上班表還空著就放上班表
  if (_panelJustOpened) _focusAfterRender = startInput.value === '' ? startInput : endInput;
  const previewEl = h('span', { class: 'amount num', text: money(0) });
  const submitBtn = h('button', { class: 'btn btn-in', disabled: true }, '送出');
  const hintEl = h('p', { class: 'small muted', style: 'margin-top:6px' }, '');

  function recalc() {
    const start = Number(startInput.value);
    const end = Number(endInput.value);
    const filled = startInput.value !== '' && endInput.value !== '';
    const validNumbers = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= 0;
    const increasing = end > start;

    let hint = '';
    if (filled && validNumbers && !increasing) hint = '下班表必須大於上班表';
    hintEl.textContent = hint;
    // 從對變錯的那一下會抖一次（ui_fx.css 的 .fx-field-err），改對了紅框就消失；沒載到 ui_fx.css 就只是多一個沒作用的 class
    endInput.classList.toggle('fx-field-err', !!hint);

    const ok = filled && validNumbers && increasing;
    previewEl.textContent = money(ok ? (end - start) * rateInfo.rate : 0);
    submitBtn.disabled = !ok;
  }
  startInput.addEventListener('input', recalc);
  endInput.addEventListener('input', recalc);
  submitBtn.addEventListener('click', () => submitMeterRecord(d.machine.machineId, startInput, endInput, submitBtn));
  recalc();

  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('h3', { text: '入幣（碼表登錄）' }),
      isAdmin()
        ? h('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: () => { state.editMode = !state.editMode; render(); }
        }, state.editMode ? '完成' : '✎ 編輯')
        : null
    ]),
    h('p', { class: 'small muted', style: 'margin-bottom:12px' },
      '目前費率：每格 ' + money(rateInfo.rate) + (rateInfo.scope === 'machine' ? '（本台自訂）' : '（全局）')),
    dialogField('上班表', startInput),
    dialogField('下班表', endInput),
    hintEl,
    // panel-total-in：金額用入幣的綠色（.panel-total 預設是活動的紫色，那是給活動面板用的）
    h('div', { class: 'panel-total panel-total-in' }, [
      h('span', { class: 'muted' }, '本次入幣'),
      h('div', { class: 'row' }, [previewEl, submitBtn])
    ]),
    isAdmin() && state.editMode ? meterRateEditor(d) : null
  ]);
}

function submitMeterRecord(machineId, startInput, endInput, btn) {
  const meterStart = Number(startInput.value);
  const meterEnd = Number(endInput.value);
  const before = shownRecordIds();
  run(async () => {
    const res = await api('addMeterRecord', {
      machineId: machineId,
      meterStart: meterStart,
      meterEnd: meterEnd,
      clientToken: uuid()
    });
    if (res.duplicated) toast('這筆已經記過了', 'success');
    else {
      toast('入幣 ' + money(res.records[0].amount) + ' 已登錄', 'success');
      flashNewRecords(before);
      queueMachineReaction(machineId, 'coinIn', { amount: res.records[0].amount, tone: 'in' });
    }
    // 後端已經把送出之後最新的詳細頁資料一起回傳（見 Service.gs 的
    // addMeterRecord），不用再另外打一次 machineDetail，省一趟網路來回。
    applyDetail(machineId, res.detail);
  }, { button: btn, busyText: '送出中…' });
}

/**
 * 費率編輯：還在全局範圍時，直接改這裡改的就是全局值（跟快捷金額/獎型
 * 在還沒 fork 之前編輯就是在改全局，是同一套邏輯）；已經 fork 成本台
 * 專屬之後，改這裡只影響這一台。「改成本台自訂／改回沿用全局」共用
 * scopeNote()，跟快捷金額/獎型長一樣、操作起來也一樣。
 */
function meterRateEditor(d) {
  const rateInfo = d.meterRate;
  const input = h('input', { type: 'number', inputmode: 'decimal', min: '1', value: rateInfo.rate });

  return h('div', { class: 'panel meter-rate-panel', style: 'margin-top:10px' }, [
    h('div', { class: 'panel-head' }, [h('h3', { text: '每格金額（碼表費率）' })]),
    h('div', { class: 'custom-amount' }, [
      input,
      h('button', {
        class: 'btn btn-primary',
        onclick: (e) => run(async () => {
          await api('saveMeterRate', {
            machineId: rateInfo.scope === 'machine' ? d.machine.machineId : '',
            rate: Number(input.value)
          });
          await loadDetail(d.machine.machineId);
        }, { success: '已儲存', button: e.currentTarget, busyText: '儲存中…' })
      }, '儲存')
    ]),
    scopeNote(d.machine.machineId, 'MeterRates', rateInfo.scope)
  ]);
}

// ── 面板：活動（原「開獎」）──────────────────────────────────────────

function prizePanel(d) {
  const prizes = d.prizes || [];

  const totalEl = h('span', { class: 'amount num', text: money(0) });
  const submitBtn = h('button', { class: 'btn btn-prize', disabled: true }, '送出');

  // 合計金額：按＋／－之後從舊數字跳到新數字（第一次畫直接顯示）
  let shownSum = null;
  function recalc() {
    let sum = 0;
    prizes.forEach((p) => { sum += (state.prizeCounts[p.prizeId] || 0) * p.amount; });
    if (shownSum !== null && shownSum !== sum && typeof window.fxCountFrom === 'function') window.fxCountFrom(totalEl, shownSum, sum, money);
    else totalEl.textContent = money(sum);
    shownSum = sum;
    submitBtn.disabled = sum <= 0;
  }

  const rows = prizes.map((p) => {
    const row = h('div', { class: 'prize-row' });
    const input = h('input', {
      type: 'number', inputmode: 'numeric', min: '0', value: String(state.prizeCounts[p.prizeId] || 0)
    });

    function setCount(n) {
      const v = Math.max(0, Math.min(9999, Math.floor(Number(n) || 0)));
      const changed = v !== (state.prizeCounts[p.prizeId] || 0);
      state.prizeCounts[p.prizeId] = v;
      input.value = String(v);
      row.classList.toggle('has-count', v > 0);
      // 數字變了就彈一下（ui_fx.js 的 fxBump），長按連加時看得出一直在加
      if (changed && typeof window.fxBump === 'function') window.fxBump(input);
      recalc();
    }

    input.addEventListener('input', () => setCount(input.value));

    appendChildren(row, [
      h('div', { class: 'prize-name' }, [
        h('div', { class: 'n', text: p.name }),
        h('div', { class: 'u num', text: '單價 ' + money(p.amount) })
      ]),
      isAdmin() && state.editMode
        ? h('div', { class: 'row' }, [
          h('button', { class: 'btn btn-sm', onclick: () => editPrize(d, p) }, '改'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: () => deletePrize(p) }, '刪')
        ])
        : h('div', { class: 'stepper' }, [
          holdRepeat(h('button', { type: 'button', 'aria-label': '減一' }, '−'), () => setCount((state.prizeCounts[p.prizeId] || 0) - 1)),
          input,
          holdRepeat(h('button', { type: 'button', 'aria-label': '加一' }, '＋'), () => setCount((state.prizeCounts[p.prizeId] || 0) + 1))
        ])
    ]);

    if ((state.prizeCounts[p.prizeId] || 0) > 0) row.classList.add('has-count');
    return row;
  });

  submitBtn.addEventListener('click', () => submitPrizes(d.machine.machineId, prizes, submitBtn));
  recalc();

  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('h3', { text: '活動登錄' }),
      isAdmin()
        ? h('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: () => { state.editMode = !state.editMode; render(); }
        }, state.editMode ? '完成' : '✎ 編輯')
        : null
    ]),
    prizes.length ? h('div', {}, rows) : emptyState(
      isAdmin() ? '還沒有獎型，點「✎ 編輯」新增。' : '尚未設定獎型，請聯絡管理員。', null, 40),
    state.editMode && isAdmin()
      ? h('button', { class: 'btn btn-block', style: 'margin-top:10px', onclick: () => editPrize(d, null) }, '＋ 新增獎型')
      : null,
    prizes.length && !state.editMode
      ? h('div', { class: 'panel-total' }, [
        h('span', { class: 'muted' }, '本次合計'),
        h('div', { class: 'row' }, [totalEl, submitBtn])
      ])
      : null,
    isAdmin() ? scopeNote(d.machine.machineId, 'Prizes', prizes.length ? prizes[0].scope : 'global') : null
  ]);
}

/**
 * 按住連續觸發（活動的＋／－）：點一下加一次；按住 0.45 秒後開始連加，越按越快。
 * 手指按下去就移動（其實是要捲動面板）不算；用鍵盤按（Enter／空白鍵）照樣加一次。
 * 回傳按鈕本身，方便直接放進 h() 的 children。
 */
function holdRepeat(btn, fn) {
  let timer = null;
  let active = false;
  let repeating = false;
  let n = 0;
  let sx = 0;
  let sy = 0;
  const stop = () => { clearTimeout(timer); timer = null; active = false; repeating = false; };
  const repeat = () => { fn(); n++; timer = setTimeout(repeat, Math.max(50, 150 - n * 10)); };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    stop();
    active = true;
    n = 0;
    sx = e.clientX;
    sy = e.clientY;
    timer = setTimeout(() => { repeating = true; repeat(); }, 450);
  });
  btn.addEventListener('pointermove', (e) => {
    if (active && !repeating && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) stop();
  });
  btn.addEventListener('pointerup', () => { if (active && !repeating) fn(); stop(); });
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('click', (e) => { if (e.detail === 0) fn(); }); // 鍵盤按的 click 沒有 pointer 事件
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // 長按不要跳出系統選單
  return btn;
}

function submitPrizes(machineId, prizes, btn) {
  const items = prizes
    .map((p) => ({ prizeId: p.prizeId, count: state.prizeCounts[p.prizeId] || 0 }))
    .filter((it) => it.count > 0);
  if (!items.length) return;

  const before = shownRecordIds();
  run(async () => {
    const res = await api('addPrizeRecord', {
      machineId: machineId,
      items: items,
      clientToken: uuid()
    });
    if (res.duplicated) toast('這筆已經記過了', 'success');
    else {
      toast('活動 ' + money(res.total) + ' 已登錄', 'success');
      flashNewRecords(before);
      // 爪子下去夾一個娃娃上來；活動成本從淨收益扣掉
      queueMachineReaction(machineId, 'grab', { amount: -res.total, tone: 'prize' });
    }
    state.prizeCounts = {};
    await loadDetail(machineId);
  }, { button: btn, busyText: '送出中…' });
}

function editPrize(d, prize) {
  const name = h('input', { type: 'text', maxlength: '30', value: prize ? prize.name : '' });
  const amount = h('input', { type: 'number', inputmode: 'decimal', min: '1', value: prize ? prize.amount : '' });
  const order = h('input', { type: 'number', value: prize ? prize.sortOrder : (d.prizes.length + 1) });

  openDialog(prize ? '編輯獎型' : '新增獎型', [
    dialogField('獎型名稱', name),
    dialogField('金額（成本）', amount),
    dialogField('排序', order)
  ], [
    h('button', { class: 'btn', onclick: closeDialog }, '取消'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (e) => {
        if (!name.value.trim()) { fieldError(name, '請輸入獎型名稱'); return; }
        if (!(Number(amount.value) > 0)) { fieldError(amount, '請輸入大於 0 的金額'); return; }
        run(async () => {
          await api('savePrize', {
            prizeId: prize ? prize.prizeId : '',
            machineId: prize ? prize.machineId : (d.prizes.length && d.prizes[0].scope === 'machine' ? d.machine.machineId : ''),
            name: name.value.trim(),
            amount: Number(amount.value),
            sortOrder: Number(order.value) || 0
          });
          closeDialog();
          await loadDetail(d.machine.machineId);
        }, { success: '已儲存', button: e.currentTarget, busyText: '儲存中…' });
      }
    }, '儲存')
  ]);
}

async function deletePrize(prize) {
  if (!(await askConfirm({
    title: '刪除這個獎型？',
    message: '已登錄的歷史紀錄不會受影響。',
    detail: prize.name + '（單價 ' + money(prize.amount) + '）',
    okText: '刪除',
    danger: true
  }))) return;
  run(async () => {
    await api('deletePrize', { prizeId: prize.prizeId });
    await collapseDeletedRow();
    await loadDetail(state.machineId);
  }, { success: '已刪除' });
}

// ── 紀錄清單 ────────────────────────────────────────────

/**
 * 剛送出的紀錄在「本機台紀錄」裡亮一下（ui_fx.css 的 .fx-flash，底色亮起再淡掉）：
 * 送出前先用 shownRecordIds() 記下畫面上已經有哪幾筆，送出成功後交給 flashNewRecords()；
 * 下一次畫紀錄清單時，不在這份名單裡的就是剛記的。只用一次，之後的背景重新整理不會再亮。
 * 看的是紀錄編號，不管哪個後端（GAS／Supabase）、一次新增幾筆（活動可以一次登好幾種）都適用。
 */
let _flashSince = null;
function shownRecordIds() {
  // 連同「是哪一台」一起記在按下送出的當下——後端回來時使用者可能已經切到別台了
  return {
    machineId: state.detail && state.detail.machine ? state.detail.machine.machineId : null,
    ids: new Set(((state.detail && state.detail.records) || []).map((r) => r.recordId))
  };
}
function flashNewRecords(before) {
  _flashSince = { machineId: before.machineId, ids: before.ids, at: Date.now() };
}

function renderRecords(d) {
  // 只認同一台機台、5 秒內送出的：送出後還沒等到後端回來就先切去別台的話，
  // 不能讓別台的紀錄全部被當成「新的」一起亮
  const f = _flashSince;
  _flashSince = null;
  const since = f && f.machineId === d.machine.machineId && Date.now() - f.at < 5000 ? f.ids : null;
  const items = d.records.length
    ? d.records.map((r) => recordItem(r, !!since && !since.has(r.recordId)))
    : [emptyState('還沒有任何紀錄')];

  return h('div', { class: 'card' }, [
    h('div', { class: 'panel-head' }, [
      h('h3', { text: '本機台紀錄' }),
      d.hasMore ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => goReport(d.machine.machineId) }, '看全部') : null
    ]),
    h('div', { class: 'record-list' }, items)
  ]);
}

function recordItem(r, isNew) {
  const sign = (r.type === 'in' || r.type === 'chip_in') ? '+' : '−';
  const hasMeter = r.type === 'in' && r.meterStart !== null && r.meterEnd !== null;
  const title = r.type === 'prize'
    ? (r.prizeName + ' ×' + r.count)
    : hasMeter
      ? ('上班表 ' + r.meterStart.toLocaleString('zh-TW') + ' → 下班表 ' + r.meterEnd.toLocaleString('zh-TW'))
      : TYPE_LABELS[r.type];

  return h('div', { class: 'record-item' + (isNew ? ' fx-flash' : ''), 'data-record-id': r.recordId }, [
    h('span', { class: 'badge badge-' + r.type, text: TYPE_LABELS[r.type] }),
    h('div', { class: 'rec-main' }, [
      h('div', { class: 'rec-title', text: title }),
      h('div', { class: 'rec-meta', text: formatTime(r.createdAt) + ' · ' + (r.userName || '—') })
    ]),
    h('div', { class: 'rec-amount ' + r.type, text: sign + money(r.amount) }),
    isAdmin()
      ? h('button', { class: 'btn btn-sm btn-ghost', title: '作廢', onclick: () => voidRecord(r) }, '✕')
      : null
  ]);
}

async function voidRecord(r) {
  const what = r.type === 'prize' ? ('活動 ' + r.prizeName + ' ×' + r.count) : TYPE_LABELS[r.type];
  if (!(await askConfirm({
    title: '作廢這筆紀錄？',
    detail: what + '　' + money(r.amount) + '\n' + formatTime(r.createdAt) + ' · ' + (r.userName || '—'),
    okText: '作廢',
    danger: true
  }))) return;
  run(async () => {
    await api('voidRecord', { recordId: r.recordId });
    await collapseDeletedRow();
    queueMachineReaction(state.machineId, 'shake'); // 作廢：機台搖一下
    await loadDetail(state.machineId);
  }, { success: '已作廢' });
}

// ── 畫面：活動查詢 ──────────────────────────────────────

/** 開啟「活動查詢」，預設查詢區間是今天，改日期會自動重新查詢。 */
function goActivityQuery() {
  state.view = 'activity';
  const t = todayInputValue();
  state.activityParams = { from: t, to: t };
  state.activityResult = null;
  render();
  loadActivityQuery();
}

async function loadActivityQuery(opts) {
  const data = await run(() => api('activityQuery', state.activityParams), opts);
  if (data) { state.activityResult = data; render(); }
}

/**
 * 自訂日期範圍查這段期間的432/441支數＋每天開銷加總，不特定看哪一台
 * 機台——是這個帳號看得到的全部機台合併算，跟「骰台查詢」共用同一個
 * 「合併所有機台」的邏輯精神，但這裡連電子機台也算（電子機台本來就
 * 不會有432/441活動紀錄，算不算都一樣）。
 */
function viewActivityQuery() {
  const p = state.activityParams;
  const r = state.activityResult;

  const nav = h('div', { class: 'navbar' }, [
    h('button', { class: 'btn btn-sm', onclick: goHome }, '← 返回')
  ]);

  // 跟查詢報表頁的「自訂」日期選擇器同一種限制：只能選近三個月內，
  // 更早的資料已經封存到別的分頁，這裡不查那麼久以前的。
  const customRange = h('div', { class: 'filter-row', style: 'margin-bottom:12px' }, [
    dialogField('起始日期', h('input', {
      type: 'date', value: p.from,
      min: monthsAgoInputValue(3), max: todayInputValue(),
      onchange: (e) => { p.from = e.target.value; loadActivityQuery(); }
    })),
    dialogField('結束日期', h('input', {
      type: 'date', value: p.to,
      min: monthsAgoInputValue(3), max: todayInputValue(),
      onchange: (e) => { p.to = e.target.value; loadActivityQuery(); }
    }))
  ]);

  // 標題包在 .topbar 裡，字級跟查詢報表頁的機台名稱一樣（styles.css 的 .topbar h1）；
  // 原本是沒套樣式的 h1，瀏覽器預設 2 倍大，比其他頁的標題大一截
  const title = h('div', { class: 'topbar' }, [h('h1', { text: '活動查詢' })]);

  if (!r) {
    return h('div', {}, [nav, title, customRange, loadingView('activity')]);
  }

  const stats = h('div', { class: 'report-stats report-stats-3' }, [
    statBox('432支數', String(r.count432 || 0), ''),
    statBox('441支數', String(r.count441 || 0), ''),
    statBox('開銷', money(r.manualExpense), '')
  ]);

  return h('div', {}, [nav, title, customRange, stats]);
}

// ── 畫面：報表 ──────────────────────────────────────────

function viewReport() {
  const rep = state.report;
  const p = state.reportParams;

  const nav = h('div', { class: 'navbar' }, [
    h('button', {
      class: 'btn btn-sm',
      onclick: () => { p.machineId ? goMachine(p.machineId) : goHome(); }
    }, '← 返回'),
    h('button', {
      class: 'btn btn-sm',
      disabled: !rep,
      onclick: downloadLedgerXlsx
    }, '⬇ 匯出 Excel'),
    // 只有「全部骰台／全部電子機台」這種分類查詢（沒指定單一機台）才有
    // 好幾台機台要各自截一張——單一機台頁本來就只有一台，用機台詳細頁
    // 自己的「📷 匯出明細截圖」就好，不需要在這裡重複一顆按鈕。
    (!p.machineId && p.category)
      ? h('button', {
        class: 'btn btn-sm',
        disabled: !rep,
        onclick: exportLedgerScreenshots
      }, '📷 匯出截圖')
      : null
  ]);

  const presets = slidingTabs(h('div', { class: 'seg', style: 'margin-bottom:12px' },
    [['day', '今日'], ['week', '本週'], ['month', '本月'], ['custom', '自訂'], ['history', '歷史']].map(([key, label]) =>
      h('button', {
        class: p.preset === key ? 'active' : '',
        onclick: () => {
          p.preset = key;
          if ((key === 'custom' || key === 'history') && !p.from) { p.from = todayInputValue(); p.to = todayInputValue(); }
          loadReport();
        }
      }, label)
    )), 'report');

  // 「自訂」的日期選擇器鎖在近三個月內——一般查帳用不到更久以前，
  // 選更早的區間本來就會被後端擋下來（那些資料已經封存走了），
  // 選擇器直接鎖住比讓使用者選了才報錯更清楚。
  // 「歷史」不設下限：後端會自動把封存分頁跟目前這一季合併查詢，
  // 想看多久以前都能選（受限於試算表裡實際還留著哪些封存分頁）。
  const customRange = (p.preset === 'custom' || p.preset === 'history')
    ? h('div', { class: 'filter-row', style: 'margin-bottom:12px' }, [
      dialogField('起始日期', h('input', {
        type: 'date', value: p.from,
        min: p.preset === 'custom' ? monthsAgoInputValue(3) : null,
        max: todayInputValue(),
        onchange: (e) => { p.from = e.target.value; loadReport(); }
      })),
      dialogField('結束日期', h('input', {
        type: 'date', value: p.to,
        min: p.preset === 'custom' ? monthsAgoInputValue(3) : null,
        max: todayInputValue(),
        onchange: (e) => { p.to = e.target.value; loadReport(); }
      }))
    ])
    : null;

  const rangeHint = p.preset === 'custom'
    ? h('p', { class: 'small muted', style: 'margin:-4px 0 12px' }, '自訂日期只能選近三個月內的區間，更早的資料請用「歷史」查詢。')
    : p.preset === 'history'
      ? h('p', { class: 'small muted', style: 'margin:-4px 0 12px' }, '會一併查詢已封存的歷史資料，區間拉太長可能要等一下。')
      : null;

  if (!rep) {
    return h('div', {}, [nav, presets, customRange, rangeHint, loadingView('report')]);
  }

  const s = rep.summary;
  // 電子機台只有開分／洗分紀錄，沒有入幣/出幣/活動——
  // 用骰台那套（in/out/prize/net）算出來的淨收益永遠是 0，
  // 要改用 chipIn/chipOut/chipNet。
  const isElectronic = rep.scope.category === 'electronic';
  const stats = isElectronic
    ? h('div', { class: 'report-stats report-stats-3', style: 'margin-bottom:12px' }, [
      statBox('開分', money(s.chipIn), 'net pos'),
      statBox('洗分', money(s.chipOut)),
      statBox('盈虧金額', money(s.chipNet), 'net ' + netClass(s.chipNet))
    ])
    : h('div', { class: 'report-stats', style: 'margin-bottom:12px' }, [
      statBox('入幣', money(s.in), 'net pos'),
      statBox('出幣', money(s.out)),
      statBox('活動成本', money(s.prize)),
      statBox('淨收益', money(s.net), 'net ' + netClass(s.net))
    ]);

  const title = h('div', { class: 'topbar' }, [
    h('div', {}, [
      h('h1', { text: rep.scope.machineName || '全部機台報表' }),
      h('div', { class: 'small muted', text: rep.range.from + ' ~ ' + rep.range.to + '（共 ' + rep.recordCount + ' 筆）' })
    ])
  ]);

  return h('div', {}, [
    nav, title, presets, customRange, rangeHint, stats,
    trendCard(rep.trend, isElectronic),
    prizeStatsCard(rep.prizeStats),
    recordsTableCard(rep)
  ]);
}

/** 純手繪 SVG 長條圖：每日淨收益，正值綠、負值紅。電子機台用 chipNet 而不是 net。 */
/** 上一次播過「長條長出來」的是哪一份資料——資料沒變的重畫（背景重新整理）不再播一次。 */
let _lastChartKey = null;

function trendCard(trend, isElectronic) {
  // width 只是給下面算長條間距、字型密度用的「邏輯座標」，不是真的畫面像素寬——
  // 不管 trend 有幾天，viewBox 都會用這個邏輯寬度，但透過 preserveAspectRatio="none"
  // 硬拉伸成卡片實際的寬度，所以不管幾天的資料都會直接塞進卡片裡，不會橫向捲動。
  const width = Math.max(300, trend.length * 34);
  const height = 160;
  const padTop = 12;
  const padBottom = 26;
  const plot = height - padTop - padBottom;
  const netOf = (d) => isElectronic ? d.chipNet : d.net;

  let max = 1;
  trend.forEach((d) => { max = Math.max(max, Math.abs(netOf(d))); });

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  // 換了區間／篩選、資料變了：長條從中間的零線長出來（ui_fx.css 的 .chart.fx-grow）
  const chartKey = JSON.stringify([isElectronic, trend.map((d) => [d.date, netOf(d)])]);
  const grow = chartKey !== _lastChartKey;
  _lastChartKey = chartKey;
  svg.setAttribute('class', 'chart' + (grow ? ' fx-grow' : ''));
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.setAttribute('preserveAspectRatio', 'none');

  const zeroY = padTop + plot / 2;
  const axis = document.createElementNS(svgNs, 'line');
  axis.setAttribute('class', 'axis');
  axis.setAttribute('x1', '0'); axis.setAttribute('x2', String(width));
  axis.setAttribute('y1', String(zeroY)); axis.setAttribute('y2', String(zeroY));
  svg.appendChild(axis);

  const step = width / Math.max(1, trend.length);
  const barW = Math.max(6, Math.min(44, step * 0.6));  // 只有一兩天時別讓長條胖到佔滿整張圖

  trend.forEach((d, i) => {
    const net = netOf(d);
    const ratio = Math.abs(net) / max;
    const barH = Math.max(net === 0 ? 0 : 2, ratio * (plot / 2));
    const x = i * step + (step - barW) / 2;
    const y = net >= 0 ? zeroY - barH : zeroY;

    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('class', net >= 0 ? 'bar-pos' : 'bar-neg');
    rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW)); rect.setAttribute('height', String(barH));
    rect.setAttribute('rx', '2');
    if (grow) rect.style.animationDelay = Math.min(i * 25, 300) + 'ms';   // 由左到右依序長出來
    const t = document.createElementNS(svgNs, 'title');
    t.textContent = d.date + '：' + money(net);
    rect.appendChild(t);
    svg.appendChild(rect);

    // 日期標籤太密就跳著標
    const every = trend.length > 16 ? 5 : (trend.length > 8 ? 2 : 1);
    if (i % every === 0) {
      const label = document.createElementNS(svgNs, 'text');
      label.setAttribute('class', 'lbl');
      label.setAttribute('x', String(i * step + step / 2));
      label.setAttribute('y', String(height - 8));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = d.date.slice(5);
      svg.appendChild(label);
    }
  });

  return h('div', { class: 'card', style: 'margin-bottom:12px' }, [
    h('div', { class: 'panel-head' }, [h('h3', { text: '每日淨收益趨勢' })]),
    h('div', { class: 'chart-wrap' }, svg)
  ]);
}

function prizeStatsCard(stats) {
  if (!stats.length) return null;
  return h('div', { class: 'card', style: 'margin-bottom:12px' }, [
    h('div', { class: 'panel-head' }, [h('h3', { text: '獎型統計' })]),
    h('div', { class: 'table-wrap' }, [
      h('table', {}, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '獎型' }),
          h('th', { class: 'num', text: '次數' }),
          h('th', { class: 'num', text: '金額' })
        ])),
        h('tbody', {}, stats.map((s) => h('tr', {}, [
          h('td', { text: s.name }),
          h('td', { class: 'num', text: String(s.count) }),
          h('td', { class: 'num', text: money(s.amount) })
        ])))
      ])
    ])
  ]);
}

function recordsTableCard(rep) {
  const p = state.reportParams;

  const typeSel = h('select', {
    onchange: (e) => { p.type = e.target.value; loadReport(); }
  }, [['', '全部類型'], ['in', '入幣'], ['out', '出幣'], ['prize', '活動'], ['chip_in', '開分'], ['chip_out', '洗分']].map(([v, l]) =>
    h('option', { value: v, selected: p.type === v }, l)));

  const userSel = h('select', {
    onchange: (e) => { p.userId = e.target.value; loadReport(); }
  }, [h('option', { value: '', selected: !p.userId }, '全部操作人')].concat(
    rep.operators.map((o) => h('option', { value: o.userId, selected: p.userId === o.userId }, o.name))));

  const rows = rep.records.map((r) => h('tr', {}, [
    h('td', { text: formatTime(r.createdAt) }),
    h('td', {}, h('span', { class: 'badge badge-' + r.type, text: TYPE_LABELS[r.type] })),
    h('td', { text: r.type === 'prize' ? (r.prizeName + ' ×' + r.count) : '—' }),
    h('td', { class: 'num', text: money(r.amount) }),
    h('td', { text: r.userName || '—' })
  ]));

  return h('div', { class: 'card' }, [
    h('div', { class: 'panel-head' }, [h('h3', { text: '明細紀錄' })]),
    h('div', { class: 'filter-row', style: 'margin-bottom:12px' }, [typeSel, userSel]),
    rep.truncated
      ? h('p', { class: 'small muted', style: 'margin-bottom:8px' },
        '畫面只顯示最新 ' + rep.records.length + ' 筆，完整資料請匯出 Excel。')
      : null,
    rows.length
      ? h('div', { class: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, h('tr', {}, [
            h('th', { text: '時間' }), h('th', { text: '類型' }), h('th', { text: '獎型' }),
            h('th', { class: 'num', text: '金額' }), h('th', { text: '操作人' })
          ])),
          h('tbody', {}, rows)
        ])
      ])
      : emptyState('這個區間沒有紀錄')
  ]);
}

/**
 * 匯出對帳表 .xlsx（後端回 base64，這裡解碼成二進位再包成 Blob 下載）。
 */
async function downloadLedgerXlsx(e) {
  const button = e && e.currentTarget; // await 之後 currentTarget 就變 null，先存起來
  const p = state.reportParams;
  let settlement = null;
  if (_wantsSettlement(p)) {
    const machines = await run(() => _listCategoryMachines(supabaseClient(), p.category), { button: button, busyText: '讀取中…' });
    if (!machines) return;
    settlement = await askSettlementOptions(' Excel', machines);
    if (!settlement) return;
    if (!settlement.total) settlement = null; // 沒勾總額：照原本匯出
  }
  run(async () => {
    const xlsx = await api('exportLedgerXlsx', Object.assign({}, p, { settlement: settlement }));
    const binary = atob(xlsx.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const blob = new Blob([bytes], { type: mime });

    // 這裡故意不用 navigator.share()：實測過 iOS 上 Safari 呼叫出來的
    // Web Share 面板，對 .xlsx 這種文件類型會過濾掉 LINE 之類的聊天 App
    // （只有圖片/影片類型的分享清單比較完整），跟直接下載後 iOS 自動
    // 跳出的 Quick Look 預覽頁裡「分享」按鈕叫出來的完整系統分享清單
    // 是兩個不同的東西、後者才有 LINE。單純下載反而能讓使用者用到
    // 比較完整的那個分享面板。
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: xlsx.filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已匯出 ' + xlsx.rowCount + ' 筆', 'success');
  }, { button: button, busyText: '匯出中…' });
}

/**
 * 「骰台查詢」／「電子查詢」（不指定單台、看整個分類）頁「📷 匯出截圖」
 * 用的畫布繪製——一台機台一張圖，內容跟 exportLedgerXlsx 那台機台自己的
 * 分頁一模一樣的逐日對帳表（圖數逐筆列出，底下接出幣/432/441/入幣/+/-
 * 五列小計），標題是該機台的名稱＋查詢區間，模擬 Excel「一台機台一個
 * 分頁」的概念，但不用另外開 Excel 才看得到；一台一張圖，不是全部疊成
 * 一張長圖，現場對帳習慣一台一台分開傳，疊在一起反而要自己裁切。
 * 手繪 canvas、不叫外部套件，同一個理由見 exportLedgerImage() 的說明。
 */
function _gridCellText(cell, isCount) {
  if (cell === '' || cell === null || cell === undefined) return '';
  if (typeof cell !== 'number') return String(cell);
  return isCount ? cell.toLocaleString('zh-TW') : money(cell);
}

function drawLedgerGridCanvas(rangeLabel, m) {
  const scale = 2;
  const font = 'system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';
  const colorBg = '#141926';
  const colorBorder = '#263049';
  const colorText = '#E8ECF5';
  const colorMuted = '#8B96AD';
  const colorNeg = '#F87171';
  const colorSummaryLabelBg = '#3A2230';

  const padX = 16;
  const rowH = 26;
  const titleH = 32;
  const dividerH = 5;
  const firstColW = 56;
  const dayColW = 62;
  // 每列小計最右邊的「標籤欄／數字欄」；有結算區（本期…總額）再多一組
  const tailColWidths = m.settlement ? [70, 78, 104, 78] : [70, 78];

  const days = m.colCount - 1 - tailColWidths.length;
  const widths = [firstColW].concat(new Array(days).fill(dayColW)).concat(tailColWidths);
  const colX = [padX];
  widths.forEach((w) => colX.push(colX[colX.length - 1] + w));
  const tableRight = colX[colX.length - 1];

  const width = Math.max(320, padX * 2 + widths.reduce((a, b) => a + b, 0));
  const height = 12 + titleH + rowH /* 表頭 */ + m.outRows.length * rowH + dividerH + m.summaryRows.length * rowH + 12;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = colorBg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  let y = 12;
  ctx.font = 'bold 16px ' + font;
  ctx.fillStyle = colorText;
  ctx.textAlign = 'left';
  ctx.fillText(m.machineName + '　' + rangeLabel, padX, y + titleH / 2);
  y += titleH;

  const countCols = widths.length - (m.settlement ? 2 : 0); // 結算區那兩欄以外的欄位
  const drawRow = (cells, opts) => {
    opts = opts || {};
    cells.forEach((cell, i) => {
      // 只有右邊那個「總出幣/432/441/總入幣/+/-」標籤欄套底色，跟
      // Excel（_writeLedgerSheet）的樣式規則一致——最左邊那欄（出幣/432/
      // 441/入幣/+/-）在 Excel 裡沒有套底色，這裡照抄同一個規則。
      const isLabelCol = i === widths.length - 2 || (m.settlement && i === widths.length - 4);
      if (opts.labelBg && isLabelCol) {
        ctx.fillStyle = colorSummaryLabelBg;
        ctx.fillRect(colX[i], y, widths[i], rowH);
      }
      ctx.font = (opts.bold ? 'bold ' : '') + '12px ' + font;
      ctx.fillStyle = opts.neg ? colorNeg : (opts.bold ? colorText : colorMuted);
      ctx.textAlign = 'center';
      // 432／441 列是支數不是金額，不加 $；但同一列右邊的結算區（前期、租金）還是金額
      const isCount = opts.count && i < countCols;
      ctx.fillText(_gridCellText(cell, isCount), colX[i] + widths[i] / 2, y + rowH / 2);
    });
    ctx.strokeStyle = colorBorder;
    ctx.beginPath();
    ctx.moveTo(padX, y + rowH - 0.5);
    ctx.lineTo(tableRight, y + rowH - 0.5);
    ctx.stroke();
    y += rowH;
  };

  drawRow(m.headerRow, { bold: true });
  m.outRows.forEach((row) => drawRow(row));

  ctx.fillStyle = colorText;
  ctx.fillRect(padX, y + 1, tableRight - padX, dividerH - 2);
  y += dividerH;

  m.summaryRows.forEach((row) => drawRow(row, {
    bold: true, labelBg: true, neg: row[0] === '+/-', count: row[0] === '432' || row[0] === '441'
  }));

  return canvas;
}

async function exportLedgerScreenshots(e) {
  const button = e && e.currentTarget; // await 之後 currentTarget 就變 null，先存起來
  const p = state.reportParams;
  let settlement = null;
  if (_wantsSettlement(p)) {
    const machines = await run(() => _listCategoryMachines(supabaseClient(), p.category), { button: button, busyText: '讀取中…' });
    if (!machines) return;
    settlement = await askSettlementOptions('截圖', machines);
    if (!settlement) return;
    if (!settlement.total) settlement = null; // 沒勾總額：照原本匯出
  }
  run(async () => {
    const data = await api('exportLedgerGrids', Object.assign({}, p, { settlement: settlement }));
    const rangeLabel = data.range.from + ' ~ ' + data.range.to;

    // 轉成 PNG：這裡前面已經等過一趟網路了，不用像 exportLedgerImage() 那樣為了
    // 「同步」硬用 toDataURL＋逐字解 base64（圖一寬、張數一多，光這一步手機上就要好幾秒）；
    // 改用瀏覽器原生的 canvas.toBlob()，全部同時轉，盡量縮短「按下去」到「叫出分享面板」的時間。
    const files = await Promise.all(data.machines.map(async (m) => {
      const canvas = drawLedgerGridCanvas(rangeLabel, m);
      const filename = '娃娃機對帳表_' + m.machineName + '_' + data.range.from + '_' + data.range.to + '.png';
      const blob = await _canvasToPngBlob(canvas);
      return (typeof File !== 'undefined') ? new File([blob], filename, { type: 'image/png' }) : { blob: blob, filename: filename };
    }));

    // 分享面板／下載連結的取捨理由見 exportLedgerImage() 的說明——這裡
    // 一次可能有好幾個檔案，先試分享面板一次全部帶走（實測：iOS 原生
    // 分享面板能正確把 17 張圖打包成一份「17 個影像」一起帶走，這條路
    // 一旦成功是最順的）。
    //
    // share() 只能在「使用者剛按下去」的有效期內叫（transient user activation，
    // 手機大約幾秒）。前面要等一趟網路、再畫 17 張圖——自訂區間一長，每台
    // 資料多、每張圖也更寬，準備時間很容易超過這個有效期，share() 就會被擋下
    // （NotAllowedError），以前這時會直接退回逐一下載，使用者收到 17 個分開的檔案。
    // 現在改成跳一個視窗讓使用者「再按一次」：那一按是新的互動，一定叫得出分享面板。
    // 使用者自己把分享面板關掉（AbortError）就真的是取消，不再自動下載 17 個檔案。
    if (typeof File !== 'undefined' && navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files });
      } catch (err) {
        if (!(err && err.name === 'AbortError')) offerShareScreenshots(files, rangeLabel);
      }
      return;
    }

    await downloadScreenshotFiles(files);
  }, { button: button, busyText: '匯出中…' });
}

/** canvas 轉 PNG Blob：有原生的 toBlob() 就用它（快、不佔用畫面），沒有才退回 toDataURL。 */
function _canvasToPngBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => resolve(blob || _dataUrlToBlob(canvas.toDataURL('image/png'))), 'image/png');
    } else {
      resolve(_dataUrlToBlob(canvas.toDataURL('image/png')));
    }
  });
}

/**
 * 截圖準備好了、但自動叫分享面板被手機擋下來時（見 exportLedgerScreenshots）：
 * 跳一個視窗，讓使用者按「一次分享」。share() 一定要在這個按鈕的點擊裡「同步」呼叫，
 * 中間不能有任何 await，才算是使用者剛按下去。分享失敗（例如總大小超過系統分享面板
 * 能處理的上限）就提示改用逐一下載；使用者自己取消分享面板則留在這個視窗，可以再選一次。
 */
function offerShareScreenshots(files, rangeLabel) {
  openDialog('截圖準備好了', [
    h('p', { class: 'small muted', style: 'margin-bottom:4px' },
      '共 ' + files.length + ' 張（' + rangeLabel + '）。區間比較長時，準備圖片要花一點時間，'
      + '手機會擋下自動跳出的分享選單——按下面的「一次分享」就會打開，可以一次全部傳到 LINE。')
  ], [
    h('button', {
      class: 'btn',
      onclick: () => { closeDialog(); downloadScreenshotFiles(files); }
    }, '逐一下載'),
    h('button', {
      class: 'btn btn-primary',
      onclick: () => {
        navigator.share({ files }).then(closeDialog).catch((err) => {
          if (err && err.name === 'AbortError') return;
          toast('手機的分享選單沒辦法一次帶走這麼多張，請改按「逐一下載」', 'error');
        });
      }
    }, '📤 一次分享 ' + files.length + ' 張')
  ]);
}

/**
 * 備援：逐一觸發下載。實測發現在 Safari／iOS 上，好幾個 `<a download>` 在同一個
 * tick 裡連續 click()，只有最後一個真的會被處理、其餘的被默默吞掉——改成一次觸發
 * 一個、中間等一小段時間再觸發下一個，讓瀏覽器有時間把每一次下載都真的處理完，
 * 17 張圖大約多花 17*300ms ≈ 5 秒，換來每張都真的存得到。
 */
async function downloadScreenshotFiles(files) {
  for (const file of files) {
    const blob = file instanceof File ? file : file.blob;
    const filename = file instanceof File ? file.name : file.filename;
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    link.remove();
    await new Promise((resolve) => setTimeout(resolve, 300));
    URL.revokeObjectURL(url);
  }
  toast(
    '已下載 ' + files.length + ' 張截圖'
      + (files.length > 1 ? '，要傳到 LINE 的話請到相簿/檔案裡多選後再分享，一次分享全部張數才不會漏掉' : ''),
    'success'
  );
}

// ── 畫面：系統管理 ──────────────────────────────────────

function viewAdmin() {
  const data = state.admin;

  const nav = h('div', { class: 'navbar' }, [
    h('button', { class: 'btn btn-sm', onclick: goHome }, '← 返回主畫面'),
    h('h1', { style: 'font-size:18px', text: '系統管理' })
  ]);

  const tabs = slidingTabs(h('div', { class: 'tabs' },
    [['users', '帳號'], ['machines', '機台'], ['prizes', '獎型'], ['perms', '台主授權']].map(([key, label]) =>
      h('button', {
        class: state.adminTab === key ? 'active' : '',
        // 純粹切換要看哪個分頁，資料已經在 goAdmin() 進頁面時一次抓齊了
        // （放在 state.admin 裡），不用每點一次分頁就重新打 4 個 API。
        // 任何一個分頁的新增/編輯/刪除動作都會自己呼叫 loadAdmin() 刷新，
        // 所以這裡拿到的一定是當下最新的資料。
        onclick: () => { state.adminTab = key; render(); }
      }, label))), 'admin');

  if (!data) return h('div', {}, [nav, tabs, loadingView('admin')]);

  let body;
  if (state.adminTab === 'users') body = adminUsers(data);
  else if (state.adminTab === 'machines') body = adminMachines(data);
  else if (state.adminTab === 'prizes') body = adminPrizes(data);
  else body = adminPerms(data);

  return h('div', {}, [nav, tabs, body]);
}

function adminUsers(data) {
  const items = data.users.map((u) => h('div', { class: 'admin-item' }, [
    h('div', { class: 'admin-main' }, [
      h('div', { class: 'admin-name' }, [
        u.displayName,
        h('span', { class: 'badge badge-' + u.role, style: 'margin-left:6px', text: u.roleLabel }),
        u.status !== 'active' ? h('span', { class: 'badge badge-owner', style: 'margin-left:4px', text: '已停用' }) : null
      ]),
      h('div', { class: 'admin-sub', text: '@' + u.username + (u.lastLoginAt ? ' · 最後登入 ' + formatTime(u.lastLoginAt) : ' · 尚未登入') })
    ]),
    h('button', { class: 'btn btn-sm', onclick: () => editUser(u) }, '編輯'),
    h('button', { class: 'btn btn-sm', onclick: () => resetPassword(u) }, '改密碼')
  ]));

  return h('div', {}, [
    h('button', { class: 'btn btn-primary btn-block', style: 'margin-bottom:14px', onclick: () => editUser(null) }, '＋ 新增帳號'),
    h('div', { class: 'admin-list' }, items)
  ]);
}

function roleSelect(current) {
  return h('select', {}, [['admin', '管理員（所有功能）'], ['patrol', '巡邏人員（看全部機台＋記帳）'], ['owner', '台主（只看被授權的機台）']]
    .map(([v, l]) => h('option', { value: v, selected: current === v }, l)));
}

function editUser(u) {
  const username = h('input', { type: 'text', value: u ? u.username : '', disabled: !!u, autocapitalize: 'none' });
  const displayName = h('input', { type: 'text', maxlength: '30', value: u ? u.displayName : '' });
  const role = roleSelect(u ? u.role : 'owner');
  const password = h('input', { type: 'text', autocomplete: 'new-password' });
  const status = h('select', {}, [['active', '啟用'], ['disabled', '停用']]
    .map(([v, l]) => h('option', { value: v, selected: (u ? u.status : 'active') === v }, l)));

  const fields = [
    dialogField('帳號' + (u ? '（建立後不可修改）' : '（英數字、_ . -，3~20 字）'), username),
    dialogField('顯示名稱', displayName),
    dialogField('角色', role)
  ];
  if (!u) fields.push(dialogField('初始密碼（至少 6 字）', password));
  else fields.push(dialogField('狀態', status));

  openDialog(u ? '編輯帳號' : '新增帳號', fields, [
    h('button', { class: 'btn', onclick: closeDialog }, '取消'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (e) => {
        // 跟後端（Service.gs adminSaveUser／Supabase admin-users）同一套規則，先在這裡標出填錯的那一格
        if (!u && !/^[A-Za-z0-9_.-]{3,20}$/.test(username.value.trim())) {
          fieldError(username, '帳號只能用英數字與 _ . -，長度 3~20'); return;
        }
        if (!u && password.value.length < 6) { fieldError(password, '密碼至少 6 個字'); return; }
        run(async () => {
          await api('adminSaveUser', {
            userId: u ? u.userId : '',
            username: username.value.trim(),
            displayName: displayName.value.trim(),
            role: role.value,
            status: u ? status.value : 'active',
            password: password.value
          });
          closeDialog();
          // 新帳號接著會跳「請把這組密碼交給使用者」
          if (!u) showPasswordOnce(username.value.trim(), password.value);
          await loadAdmin();
        }, { success: '已儲存', button: e.currentTarget, busyText: '儲存中…' });
      }
    }, '儲存')
  ]);
}

function resetPassword(u) {
  const password = h('input', { type: 'text', autocomplete: 'new-password', placeholder: '至少 6 個字' });
  openDialog('重設「' + u.displayName + '」的密碼', [
    h('p', { class: 'small muted', style: 'margin-bottom:12px' },
      '改完之後，這個帳號在所有裝置上的登入狀態會立刻失效，需要用新密碼重新登入。'),
    dialogField('新密碼', password)
  ], [
    h('button', { class: 'btn', onclick: closeDialog }, '取消'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (e) => {
        if (password.value.length < 6) { fieldError(password, '密碼至少 6 個字'); return; }
        run(async () => {
          const value = password.value;
          await api('adminResetPassword', { userId: u.userId, password: value });
          closeDialog();
          showPasswordOnce(u.username, value);
          await loadAdmin();
        }, { button: e.currentTarget, busyText: '處理中…' });
      }
    }, '確定重設')
  ]);
}

/** 密碼只在這裡顯示這一次，之後系統只留雜湊，查不回來。 */
function showPasswordOnce(username, password) {
  openDialog('請把這組密碼交給使用者', [
    h('p', { class: 'small muted', style: 'margin-bottom:10px' },
      '帳號 ' + username + ' 的密碼如下。關掉這個視窗之後就查不到了（系統只保存加密後的結果），忘記的話只能再重設一次。'),
    h('div', { class: 'password-reveal', text: password })
  ], [
    h('button', { class: 'btn btn-primary btn-block', onclick: closeDialog }, '我記下來了')
  ]);
}

const MACHINE_CATEGORY_LABELS = { dice: '骰台', electronic: '電子' };

function adminMachines(data) {
  const items = data.machines.map((m) => h('div', { class: 'admin-item' }, [
    machineSvg(40, m.color, m.status, m.icon, { seed: m.machineId }),
    h('div', { class: 'admin-main' }, [
      h('div', { class: 'admin-name' }, [
        m.name,
        h('span', { class: 'badge badge-owner', style: 'margin-left:6px', text: MACHINE_CATEGORY_LABELS[m.category] || '骰台' })
      ]),
      h('div', { class: 'admin-sub', text: (m.location || '—') + ' · ' + STATUS_LABELS[m.status] })
    ]),
    h('button', { class: 'btn btn-sm', onclick: () => editMachine(m) }, '編輯')
  ]));

  return h('div', {}, [
    h('div', { class: 'row', style: 'gap:10px;margin-bottom:14px' }, [
      h('button', { class: 'btn btn-primary', style: 'flex:1', onclick: () => editMachine(null, 'dice') }, '＋ 新增骰台機台'),
      h('button', { class: 'btn btn-primary', style: 'flex:1', onclick: () => editMachine(null, 'electronic') }, '＋ 新增電子機台')
    ]),
    h('div', { class: 'admin-list' }, items)
  ]);
}

/**
 * 分類（骰台／電子）只在新增當下決定——按哪顆新增按鈕就是哪個分類，
 * 之後編輯不能再改，所以這裡只有新增（沒有 m）時才顯示分類、才會把
 * category 帶進 adminSaveMachine 的 payload；編輯既有機台完全不碰這一欄。
 */
function editMachine(m, presetCategory) {
  const name = h('input', { type: 'text', maxlength: '30', value: m ? m.name : '' });
  const location = h('input', { type: 'text', maxlength: '50', value: m ? m.location : '' });
  const status = h('select', {}, [['running', '營運中'], ['maintenance', '維修中'], ['offline', '停機']]
    .map(([v, l]) => h('option', { value: v, selected: (m ? m.status : 'running') === v }, l)));
  const order = h('input', { type: 'number', value: m ? m.sortOrder : (state.admin.machines.length + 1) });
  const category = m ? (m.category || 'dice') : (presetCategory || 'dice');

  let color = m ? m.color : MACHINE_COLORS[0];
  let icon = m ? (m.icon || DEFAULT_MACHINE_ICON) : DEFAULT_MACHINE_ICON;

  const refreshPreview = () => preview.replaceChildren(machineSvg(72, color, status.value, icon, { seed: 'preview' }));

  const swatches = h('div', { class: 'color-swatches' }, MACHINE_COLORS.map((c) => {
    const btn = h('button', {
      type: 'button',
      class: c === color ? 'active' : '',
      style: 'background:' + c,
      onclick: () => {
        color = c;
        Array.prototype.forEach.call(swatches.children, (child) => child.classList.remove('active'));
        btn.classList.add('active');
        refreshPreview();
      }
    });
    return btn;
  }));

  // 圖案縮圖固定用預設藍色畫，只是給使用者看形狀分辨款式，
  // 不用跟著使用者現在選的機身顏色一起變，避免每次切顏色都要重畫一整排縮圖。
  const iconSwatches = h('div', { class: 'icon-swatches' }, Object.keys(MACHINE_ICON_MAPS).map((key) => {
    const btn = h('button', {
      type: 'button',
      class: key === icon ? 'active' : '',
      onclick: () => {
        icon = key;
        Array.prototype.forEach.call(iconSwatches.children, (child) => child.classList.remove('active'));
        btn.classList.add('active');
        refreshPreview();
      }
    }, [
      machineSvg(40, '#4F7BE8', 'running', key, { still: true }), // 選圖案的小按鈕：靜態圖就好
      MACHINE_ICON_LABELS[key] || key
    ]);
    return btn;
  }));

  const preview = h('div', { class: 'center', style: 'margin-bottom:14px' }, machineSvg(72, color, m ? m.status : 'running', icon, { seed: 'preview' }));
  status.addEventListener('change', refreshPreview);

  const fields = [
    preview,
    dialogField('分類', h('p', { class: 'small muted', text: MACHINE_CATEGORY_LABELS[category] + (m ? '（建立後不可修改）' : '') })),
    dialogField('機台名稱', name),
    dialogField('位置', location),
    dialogField('狀態', status),
    dialogField('機身顏色', swatches),
    dialogField('機台圖案', iconSwatches),
    dialogField('排序', order)
  ];

  openDialog(m ? '編輯機台' : '新增' + MACHINE_CATEGORY_LABELS[category] + '機台', fields, [
    h('button', { class: 'btn', onclick: closeDialog }, '取消'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (e) => {
        if (!name.value.trim()) { fieldError(name, '請輸入機台名稱'); return; }
        run(async () => {
          await api('adminSaveMachine', {
            machineId: m ? m.machineId : '',
            name: name.value.trim(),
            location: location.value.trim(),
            status: status.value,
            color: color,
            sortOrder: Number(order.value) || 0,
            category: category,
            icon: icon
          });
          closeDialog();
          await loadAdmin();
        }, { success: '已儲存', button: e.currentTarget, busyText: '儲存中…' });
      }
    }, '儲存')
  ]);
}

function adminPrizes(data) {
  const items = data.prizes.global.map((p) => h('div', { class: 'admin-item' }, [
    h('div', { class: 'admin-main' }, [
      h('div', { class: 'admin-name', text: p.name }),
      h('div', { class: 'admin-sub num', text: '單價 ' + money(p.amount) + ' · 排序 ' + p.sortOrder })
    ]),
    h('button', { class: 'btn btn-sm', onclick: () => editGlobalPrize(p) }, '編輯'),
    h('button', { class: 'btn btn-sm btn-danger', onclick: () => deletePrizeFromAdmin(p) }, '刪除')
  ]));

  return h('div', {}, [
    h('div', { class: 'perm-note' },
      '這裡設定的是「全局獎型」，所有機台預設都用這一組。'
      + '某台需要不一樣時，到那台的詳細頁按「🎁 活動 → ✎ 編輯 → 改成本台自訂」。'),
    h('button', { class: 'btn btn-primary btn-block', style: 'margin-bottom:14px', onclick: () => editGlobalPrize(null) }, '＋ 新增獎型'),
    items.length ? h('div', { class: 'admin-list' }, items) : emptyState('還沒有獎型', 'card'),
    data.prizes.overrides.length
      ? h('p', { class: 'small muted', style: 'margin-top:14px' },
        '注意：' + data.prizes.overrides.map((o) => o.name).join('、')
        + ' 已改用本台專屬獎型，不受這一頁影響。')
      : null
  ]);
}

function editGlobalPrize(p) {
  const name = h('input', { type: 'text', maxlength: '30', value: p ? p.name : '' });
  const amount = h('input', { type: 'number', inputmode: 'decimal', min: '1', value: p ? p.amount : '' });
  const order = h('input', { type: 'number', value: p ? p.sortOrder : (state.admin.prizes.global.length + 1) });

  openDialog(p ? '編輯獎型' : '新增獎型', [
    dialogField('獎型名稱', name),
    dialogField('金額（成本）', amount),
    dialogField('排序', order)
  ], [
    h('button', { class: 'btn', onclick: closeDialog }, '取消'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (e) => {
        if (!name.value.trim()) { fieldError(name, '請輸入獎型名稱'); return; }
        if (!(Number(amount.value) > 0)) { fieldError(amount, '請輸入大於 0 的金額'); return; }
        run(async () => {
          await api('savePrize', {
            prizeId: p ? p.prizeId : '',
            machineId: '',
            name: name.value.trim(),
            amount: Number(amount.value),
            sortOrder: Number(order.value) || 0
          });
          closeDialog();
          await loadAdmin();
        }, { success: '已儲存', button: e.currentTarget, busyText: '儲存中…' });
      }
    }, '儲存')
  ]);
}

async function deletePrizeFromAdmin(p) {
  if (!(await askConfirm({
    title: '刪除這個獎型？',
    message: '已登錄的歷史紀錄不會受影響。',
    detail: p.name + '（單價 ' + money(p.amount) + '）',
    okText: '刪除',
    danger: true
  }))) return;
  run(async () => {
    await api('deletePrize', { prizeId: p.prizeId });
    await collapseDeletedRow();
    await loadAdmin();
  }, { success: '已刪除' });
}

function adminPerms(data) {
  const perms = data.perms;

  if (!perms.owners.length) {
    return h('div', {}, [
      h('div', { class: 'perm-note' }, '管理員與巡邏人員自動擁有全部機台，不需要在這裡設定。'),
      emptyState('目前沒有台主帳號。到「帳號」分頁新增角色為「台主」的帳號後，就能在這裡指定他看得到哪些機台。', 'card')
    ]);
  }

  // 每個台主的機台清單預設收合——機台一多（例如 28 台）沒有要編輯的
  // 台主也要跟著捲一長串核取方塊，收合後標題列的「2/28 台」就看得到
  // 重點，要改權限再點開特定那位台主就好。
  const blocks = perms.owners.map((o) => {
    const granted = perms.grants[o.userId] || [];
    const open = !!state.permExpanded[o.userId];
    return h('div', { class: 'card', style: 'margin-bottom:12px' }, [
      h('button', {
        type: 'button',
        class: 'panel-head perm-head',
        onclick: () => { state.permExpanded[o.userId] = !open; render(); }
      }, [
        h('h3', {}, [o.displayName, h('span', { class: 'muted small', text: ' @' + o.username })]),
        h('div', { class: 'row', style: 'gap:8px;align-items:center' }, [
          h('span', { class: 'small muted', text: granted.length + ' / ' + perms.machines.length + ' 台' }),
          h('span', { class: 'perm-chevron', text: open ? '▲' : '▼' })
        ])
      ]),
      open ? h('div', {}, perms.machines.map((m) => {
        const checked = granted.indexOf(m.machineId) >= 0;
        return h('label', { class: 'perm-machine' }, [
          h('input', {
            type: 'checkbox',
            checked: checked,
            style: 'width:20px;height:20px;accent-color:var(--accent)',
            onchange: async (e) => {
              await run(() => api('adminSetPermission', {
                userId: o.userId,
                machineId: m.machineId,
                granted: e.target.checked
              }));
              await loadAdmin();
            }
          }),
          machineSvg(28, m.color, m.status, m.icon, { still: true }),
          h('span', { class: 'grow', text: m.name }),
          h('span', { class: 'small muted', text: m.location || '' })
        ]);
      })) : null
    ]);
  });

  return h('div', {}, [
    h('div', { class: 'perm-note' }, '管理員與巡邏人員自動擁有全部機台，不需要在這裡設定；新增機台後也不用回來補。這一頁只影響台主。'),
    blocks
  ]);
}

// ── 資料載入 ────────────────────────────────────────────

/**
 * state.cache 現在存的是 { data, at }，不是原始資料本身——多包一個
 * 時間戳，才分得出「這筆快取是剛抓的」還是「放了一陣子」。
 *
 * cacheFresh() 在 CACHE_FRESH_MS 之內視為夠新：進頁面時如果快取還新鮮，
 * 就不用再多打一次背景重新整理。原本的作法是「先秒開快取、無論如何
 * 都立刻背景重打一次」，好處是資料一定準，代價是每次進頁面都會看到
 * 數字先出現、過一下又跳一次——尤其是背景預取剛抓完沒多久就點進去，
 * 那個「跳」完全是白跑一趟，資料根本沒變。真的動到帳（送出入幣/出幣/
 * 活動、作廢…）之後的刷新不受影響，那些都是直接呼叫 loadDetail 之類
 * 的函式、不經過這裡的新鮮度判斷，一定會拿到最新的。
 */
const CACHE_FRESH_MS = 300000;

function cacheWrite(key, data) {
  state.cache[key] = { data: data, at: Date.now() };
}
function cacheRead(key) {
  const entry = state.cache[key];
  return entry ? entry.data : null;
}
function cacheFresh(key) {
  const entry = state.cache[key];
  return !!entry && (Date.now() - entry.at) < CACHE_FRESH_MS;
}

async function loadHome(opts) {
  const data = await run(() => api('dashboard'), opts);
  if (data) { state.home = data; render(); prefetchMachineDetails(); }
}

/**
 * 首頁一載入就趁背景把每一台機台的詳細資料先抓回來存進快取，
 * 用機台切換籤跳來跳去時大多是「第一次」進某一台，本來一定要
 * 等一趟 GAS 來回；預先抓好之後不管跳去哪一台都秒開。
 *
 * 原本是每台機台各打一次 machineDetail、用 3 個併發跑掉（機台一多，
 * 還是要跑好幾輪，每一輪都是一趟完整的「/exec 轉址＋GAS 執行＋讀
 * 試算表」來回）。現在改成呼叫後端合併好的 allMachineDetails，一次
 * 網路來回就把全部機台的詳細資料一起讀回來、後端也只讀一次 Records，
 * 不是每台各讀一次——這才是真的「登入後一次讀完，切換時秒切」。
 *
 * 不走 run()：這是背景低優先度的事，不該讓 state.busy 卡住、
 * 影響到使用者正在做的事情或背景輪詢；失敗也靜靜略過，
 * 使用者真的點進去時 loadDetail 會照正常流程重新抓一次。
 */
let _prefetchInFlight = false;
async function prefetchMachineDetails() {
  if (_prefetchInFlight || !state.home) return;
  const ids = state.home.machines
    .map((m) => m.machineId)
    .filter((id) => !state.cache['detail:' + id]);
  if (!ids.length) return;

  _prefetchInFlight = true;
  try {
    const all = await api('allMachineDetails');
    Object.keys(all).forEach((id) => cacheWrite('detail:' + id, all[id]));
  } catch (err) {
    // 背景預取失敗不用理，使用者真的點進去時走正常流程會重新抓一次
  } finally {
    _prefetchInFlight = false;
  }
}

async function loadDetail(machineId, opts) {
  const data = await run(() => api('machineDetail', { machineId: machineId }), opts);
  if (data) applyDetail(machineId, data);
}

/** 把一份機台詳細頁資料套進畫面＋快取，不管是從 machineDetail 單獨打來的，
 *  還是 addRecord／addMeterRecord 送出時順便帶回來的。 */
function applyDetail(machineId, data) {
  cacheWrite('detail:' + machineId, data);
  state.detail = data;
  render();
}

async function loadReport(opts) {
  const key = 'report:' + JSON.stringify(state.reportParams);
  state.report = cacheRead(key);
  render();
  const data = await run(() => api('report', state.reportParams), opts);
  if (data) {
    cacheWrite(key, data);
    state.report = data;
    render();
  }
}

async function loadAdmin(opts) {
  // 四組資料合併成一次 API 呼叫（後端 adminBootstrap），
  // 而不是分開打 4 支——省下 3 次「/exec 轉址 + GAS 執行」的固定成本。
  const data = await run(() => api('adminBootstrap'), opts);
  if (!data) return;
  cacheWrite('admin', data);
  state.admin = data;
  render();
}

// ── 導覽 ────────────────────────────────────────────────
//
// goX() 系列進畫面時，先看 state.cache 有沒有這個畫面上次的資料：
// 有就直接秒開，完全沒有才顯示轉圈圈。快取夠新鮮（CACHE_FRESH_MS 之內）
// 就不再多打一次背景重新整理，放久了才會真的重打一次確認資料還是最新的。

/** 重設成首頁該有的導覽狀態，不動 state.home——留給呼叫端決定要不要一起換資料。 */
function _resetToHomeNav() {
  state.view = 'home';
  state.panel = null;
  state.editMode = false;
  state.machineId = null;
}

function goHome() {
  _resetToHomeNav();
  render();
  loadHome();
}

function goMachine(machineId) {
  state.view = 'machine';
  state.machineId = machineId;
  state.panel = null;
  state.editMode = false;
  state.prizeCounts = {};
  const key = 'detail:' + machineId;
  state.detail = cacheRead(key);
  render();
  if (!cacheFresh(key)) loadDetail(machineId);
}

function goReport(machineId, category) {
  state.view = 'report';
  state.reportParams = {
    machineId: machineId || '',
    category: category || '',
    preset: 'day', from: '', to: '', type: '', userId: ''
  };
  const key = 'report:' + JSON.stringify(state.reportParams);
  state.report = cacheRead(key);
  render();
  if (!cacheFresh(key)) loadReport();
}

function goAdmin() {
  state.view = 'admin';
  state.adminTab = 'users';
  state.admin = cacheRead('admin');
  render();
  if (!cacheFresh('admin')) loadAdmin();
}

async function doLogout() {
  // 「登出」跟「改密碼」「系統管理」擠在右上角，按一下就登出很容易誤按，先問一聲
  if (!(await askConfirm({ title: '要登出嗎？', message: '登出後要重新輸入帳號密碼。', okText: '登出' }))) return;
  const token = state.token;
  clearSession();
  state.view = 'login';
  render();
  api('logout', { token: token }).catch(() => { /* 本機已登出就好 */ });
}

/**
 * 改密碼（只有 Supabase 後端有，見 api() 附近 supabaseApi() 的說明）。
 * 遷移過來的帳號一開始都是遷移腳本產生的隨機臨時密碼，這是讓每個人
 * 自己換成好記密碼的地方——不用問「目前密碼」，Supabase Auth 認的是
 * 「已經登入、session 有效」這件事本身，不是重新驗證一次舊密碼。
 */
function openChangePasswordDialog() {
  const newPw = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirmPw = h('input', { type: 'password', autocomplete: 'new-password' });

  openDialog('改密碼', [
    dialogField('新密碼（至少 6 個字）', newPw),
    dialogField('再輸入一次', confirmPw)
  ], [
    h('button', { class: 'btn', onclick: closeDialog }, '取消'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (e) => {
        if (newPw.value.length < 6) { fieldError(newPw, '密碼至少要 6 個字'); return; }
        if (newPw.value !== confirmPw.value) { fieldError(confirmPw, '兩次輸入的密碼不一樣'); return; }
        run(async () => {
          await api('changePassword', { newPassword: newPw.value });
          closeDialog();
        }, { success: '密碼改好了，下次登入請用新密碼', button: e.currentTarget, busyText: '處理中…' });
      }
    }, '確定')
  ]);
}

// ── 繪製 ────────────────────────────────────────────────

/**
 * 記住上一次 render() 是畫「哪一頁」，分辨這次重繪是「真的換頁／換機台」
 * 還是「同一頁的背景重新整理」（記帳後刷新、背景輪詢…）。
 *
 * machineSwitcher() 自己有一套 _switcherLastMachineId 邏輯，但那個只顧得到
 * 切換籤自己那條「水平」捲軸；整個頁面的「垂直」捲動位置是另一回事，
 * 沒有任何地方在保護它——app.replaceChildren() 整個換掉內容時，桌機版
 * 機台切換籤是自動換行（不像手機版是水平捲動、關在自己的框裡），內容
 * 高度一變，瀏覽器就可能把頁面往上彈；電子機台頁面本來就比骰台頁面短
 * （少一顆按鈕、沒有碼表相關內容），同樣的重繪高度變化在較短的頁面上
 * 彈動的比例更明顯，兩邊使用者都會感覺「切著切著自己彈回去」。
 * 這裡在頁面層級也做一次跟切換籤同樣邏輯的事：同一頁重繪就把捲動位置
 * 還原回去，真的換頁／換機台才捲回最上面（符合一般換頁的預期）。
 */
let _lastRenderKey = null;

/**
 * 畫完之後要把游標放進哪一格（例如打開入幣面板→下班表、登入頁帶好帳號→密碼）。
 * 一定要等 render() 把新畫面放進頁面才 focus 得到；render() 是在按鈕的點擊事件裡同步跑的，
 * 在這裡 focus 還算「使用者按下去的那一下」，手機才會直接跳出鍵盤。
 */
let _focusAfterRender = null;

/** 上一次 render() 畫的是不是讀取中骨架——是的話，這次資料到了，清單要依序浮上來。 */
let _lastRenderWasSkeleton = false;

/** 首頁每個分頁籤（骰台／電子／加總）離開時捲到哪裡，回首頁時捲回去（見 render()）。 */
const _homeScrollMemo = {};

function render() {
  const app = document.getElementById('app');
  let node;

  if (!(window.APP_CONFIG && window.APP_CONFIG.GAS_API_URL)) node = viewSetupNotice();
  else if (state.view === 'login') node = viewLogin();
  else if (state.view === 'home') node = viewHome();
  else if (state.view === 'machine') node = viewMachine();
  else if (state.view === 'report') node = viewReport();
  else if (state.view === 'activity') node = viewActivityQuery();
  else if (state.view === 'admin') node = viewAdmin();
  // 開機中：已經登入（有 session）就直接畫首頁骨架，等首頁資料回來；還沒登入的才是轉圈圈
  else if (state.token) node = loadingView('home');
  else node = h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' }), h('p', {}, '載入中…')]);

  // 骨架換成真資料的那一次：機台卡片／紀錄／數字方塊依序浮上來（ui_fx.css 的 .fx-fadein）
  const isSkeleton = node.classList.contains('fx-sk-view') || !!node.querySelector('.fx-sk-view');
  if (_lastRenderWasSkeleton && !isSkeleton) {
    node.querySelectorAll('.machine-list, .record-list, .report-stats, .admin-list')
      .forEach((el) => el.classList.add('fx-fadein'));
  }
  _lastRenderWasSkeleton = isSkeleton;

  const renderKey = state.view + ':' + (state.machineId || '') + ':' + (state.homeTab || '');
  const prevKey = _lastRenderKey;
  const isNavigation = renderKey !== prevKey;
  const prevScrollY = window.scrollY;
  _lastRenderKey = renderKey;

  // 離開首頁（點進機台、查詢、系統管理…）時記下首頁捲到哪裡，回首頁時捲回去——
  // 機台一多，從後面幾台返回不用再往下找一次
  const prevView = prevKey ? prevKey.split(':')[0] : null;
  if (isNavigation && prevView === 'home' && state.view !== 'home') _homeScrollMemo[prevKey.split(':')[2]] = prevScrollY;
  const backToHome = isNavigation && state.view === 'home' && ['machine', 'report', 'activity', 'admin'].indexOf(prevView) >= 0;

  app.replaceChildren(node);

  if (isNavigation) window.scrollTo(0, backToHome ? (_homeScrollMemo[state.homeTab || ''] || 0) : 0);
  else if (prevScrollY > 0) window.scrollTo(0, prevScrollY);

  const focusEl = _focusAfterRender;
  _focusAfterRender = null;
  if (focusEl && focusEl.isConnected) {
    try { focusEl.focus({ preventScroll: true }); } catch (err) { /* 不影響畫面 */ }
  }
}

function viewSetupNotice() {
  return h('div', { class: 'setup-notice card' }, [
    h('h2', { text: '還差最後一步' }),
    h('p', { class: 'muted', style: 'margin-top:10px' },
      '請打開 docs/config.js，把 GAS_API_URL 換成你的 Google Apps Script 網頁應用程式網址（結尾是 /exec），存檔後 push 到 GitHub 即可。'),
    h('code', { text: "window.APP_CONFIG = { GAS_API_URL: 'https://script.google.com/macros/s/xxxxx/exec' };" }),
    h('p', { class: 'small muted', style: 'margin-top:12px' }, '詳細步驟請見 guide/DEPLOY.md。')
  ]);
}

// ── 自動更新 ────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden || state.busy || !state.token || !navigator.onLine) return;
    if (state.view === 'home') loadHome({ silent: true });
    else if (state.view === 'machine' && state.machineId && !state.panel) loadDetail(state.machineId, { silent: true });
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ── 啟動 ────────────────────────────────────────────────

function setupNetworkIndicators() {
  const bar = document.getElementById('offline-bar');

  // 離線提示條滑進滑出。它固定在頁面最上面、佔版面（會把整頁往下推），所以動的是
  // 高度＋上下內距（從 0 長出來／縮回 0），下面的內容跟著平順讓位，不是突然被推下去、拉上來。
  // 沒載到 ui_fx.js 或手機開了「減少動態效果」就直接出現／消失。
  const canAnimate = () => !!bar.animate && typeof window.fxReduced === 'function' && !window.fxReduced();
  let hiding = null;
  function slide(show) {
    const cs = getComputedStyle(bar);
    const full = { height: bar.offsetHeight + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1 };
    const zero = { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 };
    bar.style.overflow = 'hidden';
    const a = bar.animate(show ? [zero, full] : [full, zero],
      { duration: show ? 260 : 220, easing: show ? 'cubic-bezier(.2,.8,.2,1)' : 'ease-in' });
    const cleanup = () => { bar.style.overflow = ''; };
    a.addEventListener('finish', cleanup);
    a.addEventListener('cancel', cleanup);
    return a;
  }
  function showBar() {
    if (hiding) { hiding.cancel(); hiding = null; }   // 正在收起來又斷線了：取消收起，維持顯示
    if (!bar.hidden) return;
    bar.hidden = false;
    if (canAnimate()) slide(true);
  }
  function hideBar() {
    if (bar.hidden || hiding) return;
    if (!canAnimate()) { bar.hidden = true; return; }
    hiding = slide(false);
    hiding.addEventListener('finish', () => { hiding = null; bar.hidden = true; });
  }

  window.addEventListener('online', () => {
    const wasOffline = !bar.hidden;
    hideBar();
    if (wasOffline) toast('已恢復連線', 'success');
    if (state.token) refreshCurrent();
  });
  window.addEventListener('offline', showBar);
  bar.hidden = navigator.onLine;   // 開機當下就離線：直接顯示，不播動畫
}

/** 重新讀取目前這個畫面的資料。回傳 Promise（下拉更新要轉圈到它結束）。 */
function refreshCurrent(opts) {
  if (state.view === 'home') return loadHome(opts);
  if (state.view === 'machine' && state.machineId) return loadDetail(state.machineId, opts);
  if (state.view === 'report') return loadReport(opts);
  if (state.view === 'activity') return loadActivityQuery(opts);
  if (state.view === 'admin') return loadAdmin(opts);
  return Promise.resolve();
}

/**
 * 下拉更新（ui_fx.js）：在畫面最上面往下拉，放開就重新讀取目前這個畫面。
 * 原本首頁只能等 5 分鐘的背景輪詢，或切出 App 再切回來才會更新。
 * 登入頁、開機中不理；機台頁的記帳面板開著時也不理——跟背景輪詢同一個規則，
 * 重新整理會把輸入到一半的碼表讀數、金額洗掉。
 */
function setupPullToRefresh() {
  if (typeof window.fxPullToRefresh !== 'function') return;
  window.fxPullToRefresh(() => refreshCurrent({ quiet: true }), {
    enabled: () => !!state.token && state.view !== 'login' && state.view !== 'boot'
      && !(state.view === 'machine' && state.panel)
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('sw.js').then((reg) => {
    const bar = document.getElementById('update-bar');
    const btn = document.getElementById('update-btn');

    function offerUpdate(worker) {
      bar.hidden = false;
      btn.onclick = () => {
        worker.postMessage('SKIP_WAITING');
        bar.hidden = true;
      };
    }

    if (reg.waiting) offerUpdate(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // 有舊版在跑時才提示，第一次安裝不用打擾使用者
        if (installing.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(installing);
      });
    });
  }).catch(() => { /* 沒有 SW 也不影響功能 */ });

  // 第一次安裝時 clients.claim() 也會觸發 controllerchange，
  // 那不是「更新」，不該把使用者的畫面重新整理掉。
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
}

/**
 * 畫面固定、不能放大縮小：記帳時常常快速連點，點兩下、兩指碰到就把整頁放大，要再縮回去很麻煩。
 * index.html 的 viewport 已經寫了 user-scalable=no、styles.css 有 touch-action:manipulation，
 * 但 iPhone 的 Safari 為了無障礙會忽略 user-scalable=no，雙指縮放要在這裡擋：
 *   gesturestart／gesturechange 是 Safari 專有的縮放手勢事件；兩指以上的 touchmove 一律不讓瀏覽器處理。
 * 兩指捲動清單這種用法本來就很少，一指捲動完全不受影響。
 */
function lockZoom() {
  const stop = (e) => { if (e.cancelable) e.preventDefault(); };
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, stop, { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) stop(e); }, { passive: false });
  // 點兩下放大交給 touch-action:manipulation 擋就好，不在 touchend 攔——攔了會吃掉快速連點的第二下（例如連按兩次 $50）
}

async function boot() {
  lockZoom();
  setupNetworkIndicators();
  registerServiceWorker();
  startPolling();
  setupPullToRefresh();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.token) refreshCurrent();
  });

  const cfg = window.APP_CONFIG || {};
  const configReady = BACKEND === 'supabase' ? !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) : !!cfg.GAS_API_URL;
  if (!configReady) { render(); return; }

  await loadSession();
  if (!state.token) { state.view = 'login'; render(); return; }
  render(); // 已登入：「載入中…」先換成首頁骨架（見 render()），等下面這趟首頁資料回來

  try {
    // 開起 App 時「驗登入」跟「拿首頁資料」合併成一次呼叫（homeBootstrap），
    // 不要分開打 me 再打 dashboard——每支 GAS API 呼叫都要付一次 /exec 轉址
    // 加上腳本執行的固定成本，開頭這兩支本來就是驗完登入一定接著要拿首頁資料，
    // 合併後每次開啟 App 就少等一整趟來回。
    const data = await api('homeBootstrap');
    state.user = data.user;
    state.home = data.dashboard;
    _resetToHomeNav();
    render();
    prefetchMachineDetails();
  } catch (err) {
    if (err.code !== 'AUTH') {
      state.view = 'login';
      render();
      toast(err.message, 'error');
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
