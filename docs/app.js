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
const POLL_MS = 300000;

/** 前端版本號，登入頁顯示用，方便確認手機上是不是最新版。
 *  跟 sw.js 的 CACHE_VERSION 手動保持一致——每次改前端兩個都要加。 */
const APP_VERSION = 'v43';

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

// ── 像素娃娃機 SVG ──────────────────────────────────────

/**
 * 把某一款像素圖案展開成 SVG。icon 對應 MACHINE_ICON_MAPS 的鍵值，
 * 沒給或給了不認得的鍵值就落回經典款。
 * 同一個函式供首頁小圖、詳細頁大圖、登入頁使用，只有一份圖案定義。
 * 相鄰同色的格子會合併成一個 rect，節點數少一半以上。
 */
function machineSvg(height, bodyColor, status, icon) {
  const map = MACHINE_ICON_MAPS[icon] || MACHINE_ICON_MAPS[DEFAULT_MACHINE_ICON];
  const rows = map.length;
  const cols = map[0].length;
  const unit = height / rows;
  const width = cols * unit;

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

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pixel-machine');
  svg.setAttribute('width', String(Math.round(width)));
  svg.setAttribute('height', String(Math.round(height)));
  svg.setAttribute('viewBox', '0 0 ' + cols + ' ' + rows);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '娃娃機（' + (STATUS_LABELS[status] || '營運中') + '）');

  for (let y = 0; y < rows; y++) {
    const line = map[y];
    let x = 0;
    while (x < cols) {
      const ch = line[x];
      let run = 1;
      while (x + run < cols && line[x + run] === ch) run++;
      if (ch !== '.') {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(run));
        rect.setAttribute('height', '1');
        rect.setAttribute('fill', palette[ch] || '#000');
        if (ch === 'S') rect.setAttribute('class', 'status-light ' + (status || 'running'));
        svg.appendChild(rect);
      }
      x += run;
    }
  }
  return svg;
}

// ── API ─────────────────────────────────────────────────

function ApiError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 打去 GAS。
 *
 * 用 form-urlencoded POST 是刻意的：這屬於 CORS simple request，
 * 瀏覽器不會先發 preflight，而 GAS 沒辦法回應 preflight。
 * 換成 application/json 會直接壞掉。
 */
async function api(action, payload) {
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
      state.view = 'login';
      render();
    }
    throw ApiError(json.error || '操作失敗', json.code);
  }
  return json.data;
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
  if (!options.silent && ++visibleRunDepth === 1) showBusy(true);
  try {
    const result = await fn();
    if (options.success) toast(options.success, 'success');
    return result;
  } catch (err) {
    // 背景輪詢失敗不打擾使用者（離線時本來就有提示條，不需要每次輪詢都再彈一次）。
    // AUTH 錯誤預設也不彈 toast——這是為了「操作到一半 session 過期，靜靜跳回
    // 登入頁就好，不用再彈一個刺眼的錯誤」設計的。但登入表單本身送出的帳密錯誤／
    // 帳號被鎖，後端一樣是用 AUTH 這個代碼回傳，如果照這條規則整個吃掉，
    // 使用者會看到轉圈圈轉完、什麼也沒發生、停在空白登入頁，完全不知道錯在哪。
    // 呼叫端（登入表單）用 showAuthError:true 蓋掉這個預設，帳密錯誤才會顯示出來。
    if (!options.silent && (err.code !== 'AUTH' || options.showAuthError)) toast(err.message, 'error');
    return undefined;
  } finally {
    runDepth--;
    if (runDepth === 0) state.busy = false;
    if (!options.silent && --visibleRunDepth === 0) showBusy(false);
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

function loadSession() {
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
  const backdrop = h('div', {
    class: 'dialog-backdrop',
    id: 'dialog-backdrop',
    onclick: (e) => { if (e.target === backdrop) closeDialog(); }
  }, [
    h('div', { class: 'dialog' }, [
      h('h3', { text: title }),
      contentNodes,
      h('div', { class: 'dialog-actions' }, actions)
    ])
  ]);
  document.body.appendChild(backdrop);
  return backdrop;
}

function closeDialog() {
  const existing = document.getElementById('dialog-backdrop');
  if (existing) existing.remove();
}

function dialogField(label, input) {
  return h('div', { class: 'field' }, [h('label', { text: label }), input]);
}

// ── 畫面：登入 ──────────────────────────────────────────

function viewLogin() {
  const username = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const remember = h('input', { type: 'checkbox', checked: state.remember });
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, '登入');

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      const data = await run(() => api('login', {
        username: username.value.trim(),
        password: password.value,
        remember: remember.checked
      }), { showAuthError: true });
      submitBtn.disabled = false;
      if (!data) return;
      saveSession(data.token, data.remember);
      state.user = data.user;
      password.value = '';
      // login 已經把首頁資料一起帶回來了（見 Auth.gs），不用再多打一次 dashboard。
      state.home = data.dashboard;
      _resetToHomeNav();
      render();
      prefetchMachineDetails();
    }
  }, [
    dialogField('帳號', username),
    dialogField('密碼', password),
    h('label', { class: 'checkbox', style: 'margin-bottom:18px' }, [
      remember,
      h('span', {}, '記住我（7 天內免重新登入）')
    ]),
    submitBtn
  ]);

  return h('div', { class: 'login-wrap' }, [
    h('div', { class: 'login-head' }, [
      machineSvg(104, '#4F7BE8', 'running'),
      h('h1', { text: '娃娃機管理系統' })
    ]),
    h('div', { class: 'card' }, form),
    h('p', { class: 'small muted center', style: 'margin-top:14px' },
      '帳號由管理員建立。忘記密碼請找管理員重設。'),
    h('p', { class: 'small muted center', style: 'margin-top:6px', text: '版本號 ' + APP_VERSION })
  ]);
}

// ── 畫面：首頁 ──────────────────────────────────────────

function statBox(label, value, cls) {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'stat-label', text: label }),
    h('div', { class: 'stat-value num ' + (cls || ''), text: value })
  ]);
}

function viewHome() {
  const data = state.home;
  if (!data) return h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' })]);

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
      h('button', { class: 'btn btn-sm btn-ghost', onclick: doLogout }, '登出')
    ])
  ]);

  let summary;
  let list;

  if (state.homeTab === 'electronic') {
    const t = data.electronicTotal;
    summary = h('div', { class: 'summary-strip' }, [
      statBox('今日開分', money(t.chipIn), 'net pos'),
      statBox('今日洗分', money(t.chipOut), ''),
      statBox('今日盈虧', money(t.chipNet), 'net ' + netClass(t.chipNet))
    ]);
    const machines = data.machines.filter((m) => m.category === 'electronic');
    list = machines.length
      ? h('div', { class: 'machine-list' }, machines.map(machineCard))
      : h('div', { class: 'card empty' }, isAdmin()
        ? '還沒有電子機台。到「⚙ 系統管理 → 機台」新增一台。'
        : '目前沒有開放給你的電子機台。');
  } else if (state.homeTab === 'total') {
    const dice = data.diceTotal;
    const electronic = data.electronicTotal;
    const grandNet = dice.net + electronic.chipNet;
    summary = h('div', {}, [
      // 本月432/441支數放最上面，跟下面「今日」那排分開——是不同時間
      // 範圍的數字，混在同一排容易誤看成也是「今日」的。
      h('div', { class: 'summary-strip', style: 'grid-template-columns:repeat(2, 1fr); margin-bottom:8px' }, [
        statBox('本月432支數', String(data.month432Count || 0), ''),
        statBox('本月441支數', String(data.month441Count || 0), '')
      ]),
      h('div', { class: 'summary-strip' }, [
        statBox('今日骰台淨收益', money(dice.net), 'net ' + netClass(dice.net)),
        statBox('今日電子淨收益', money(electronic.chipNet), 'net ' + netClass(electronic.chipNet)),
        statBox('今日總淨收益', money(grandNet), 'net ' + netClass(grandNet))
      ])
    ]);
    list = ledgerCard(data);
  } else {
    const t = data.diceTotal;
    // 骰台這排是 6 張卡片，跟其他分頁籤（電子/加總各 3 張）不一樣，桌機版
    // 用專屬的 summary-strip-6 排成 3 欄 2 排，不是共用 4 欄（6 張塞進 4 欄
    // 會變成「4+2」，最後一排看起來缺兩塊）。
    summary = h('div', { class: 'summary-strip summary-strip-6' }, [
      statBox('今日入幣', money(t.in), 'net pos'),
      statBox('今日出幣', money(t.out), ''),
      statBox('今日432數量', String(data.today432Count || 0), ''),
      statBox('今日441數量', String(data.today441Count || 0), ''),
      statBox('今日活動金額', money(t.prize), ''),
      statBox('今日總筆數', String((data.todayOutCount || 0) + (data.today432Count || 0) + (data.today441Count || 0)), '')
    ]);
    const machines = data.machines.filter((m) => m.category !== 'electronic');
    list = machines.length
      ? h('div', { class: 'machine-list' }, machines.map(machineCard))
      : h('div', { class: 'card empty' }, isAdmin()
        ? '還沒有任何機台。到「⚙ 系統管理 → 機台」新增第一台。'
        : '目前沒有開放給你的機台，請聯絡管理員。');
  }

  return h('div', {}, [
    h('div', { class: 'home-sticky' }, [header, summary, businessDayBar(data.businessDay), homeTabBar()]),
    list
  ].filter((n) => n !== null));
}

/** 首頁分頁籤：骰台（預設）／電子／加總。放在「今日營業開始／結單」下面。 */
function homeTabBar() {
  const tabs = [['dice', '骰台'], ['electronic', '電子'], ['total', '加總']];
  return h('div', { class: 'seg', style: 'margin-top:10px' }, tabs.map(([key, label]) =>
    h('button', {
      class: state.homeTab === key ? 'active' : '',
      onclick: () => { state.homeTab = key; render(); }
    }, label)));
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
 * 週轉金／入幣／電子總結／出幣是每天一定會有、獨立列出的項目（電子總結
 * 放在入幣跟出幣中間，方便對照電子機台當天的開分/洗分淨額）；其餘手動
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
    ['電子總結', data.electronicTotal.chipNet],
    ['出幣', -data.diceTotal.out],
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
  const actionsRow = h('div', { class: 'row', style: 'flex-wrap:nowrap; overflow-x:auto; gap:8px; margin-bottom:10px; justify-content:flex-end' }, [
    h('button', { class: 'btn btn-sm', style: 'white-space:nowrap; flex:0 0 auto', onclick: goActivityQuery }, '🎁 活動查詢'),
    h('button', { class: 'btn btn-sm', style: 'white-space:nowrap; flex:0 0 auto', onclick: () => goReport('', 'dice') }, '📊 骰台查詢'),
    canRecord()
      ? h('button', { class: 'btn btn-sm btn-prize', style: 'white-space:nowrap; flex:0 0 auto', onclick: () => editDailyLedger(data) }, '✎ 設定今日數字')
      : null
  ]);

  return h('div', { class: 'card' }, [
    actionsRow,
    h('div', { class: 'panel-head' }, [
      h('h3', { text: dayKeyToLabel(data.today) + ' 今日現金結餘明細' })
    ]),
    h('div', {}, rows.map((row) => row.section
      ? h('div', { class: 'ledger-section-title', text: row.section })
      : h('div', { class: 'ledger-row' }, [
        h('span', { class: 'ledger-label', text: row[0] }),
        h('span', { class: 'ledger-value num ' + netClass(row[1]), text: money(row[1]) })
      ]))),
    h('div', { class: 'ledger-row ledger-total' }, [
      h('span', { class: 'ledger-label', text: '總結餘' }),
      h('span', { class: 'ledger-value num ' + netClass(data.ledgerTotal), text: money(data.ledgerTotal) })
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
  ctx.fillText(dayKeyToLabel(data.today) + ' 今日現金結餘明細', padX, headerH / 2 + 4);

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
  const file = (typeof File !== 'undefined') ? new File([blob], filename, { type: 'image/png' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file] }).catch(function () {});
    return;
  }

  // 桌機／不支援分享面板的瀏覽器：走原本的下載連結，但一定要先把 <a>
  // 掛進畫面再點擊——沒掛進畫面點擊在部分瀏覽器一樣會被吃掉沒反應。
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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

/** 設定今天（進行中營業日）的週轉金／台主給／台主領／開銷／432／441，每天只存一組，重新儲存會覆蓋。 */
/**
 * 週轉金幾乎每天都是同一筆固定的浮動金額，今天還沒設定過的話直接帶入這個
 * 預設值，不用每次都手動刪掉「0」再重打一次；其他項目每天金額都不一樣，
 * 還沒設定過的話留白，比留著「0」等使用者自己刪更順手（空白跟 0 存檔時
 * 效果相同，saveDailyLedger 送出時 Number('') || 0 本來就會存成 0）。
 * 今天已經設定過的話，一律照實際存的值顯示（包含存過的 0），不會覆蓋掉
 * 使用者剛存的東西。
 */
const DEFAULT_TURNOVER = 416000;

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
  const turnover = h('input', { type: 'number', inputmode: 'decimal', value: setToday ? l.turnover : DEFAULT_TURNOVER });
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
      onclick: () => run(async () => {
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
      }, { success: '已儲存' })
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
  const status = isOpen
    ? '營業中 · ' + formatTime(biz.current.openedAt) + ' 開始'
      + (biz.current.openedByName ? '（' + biz.current.openedByName + '）' : '')
    : '尚未開始今日營業，記帳暫時照行事曆日期算';

  return h('div', { class: 'bizday-bar' }, [
    h('div', { class: 'bizday-status small muted', text: status }),
    h('div', { class: 'bizday-actions' }, [
      h('button', { class: 'btn btn-in', onclick: doStartBusinessDay }, '▶ 今日營業開始'),
      h('button', { class: 'btn btn-out', onclick: doEndBusinessDay }, '⏹ 今日營業結單')
    ])
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

function doStartBusinessDay() {
  const biz = state.home && state.home.businessDay;
  if (biz && biz.open && !confirm('目前已經在營業中，確定要重新開始今日營業嗎？\n這會自動結算目前這個營業日，並開一個新的。')) return;
  run(async () => {
    await api('startBusinessDay', {});
    _clearMachineDetailCache();
    await loadHome();
  }, { success: '已開始今日營業，所有機台的今日數字已重置' });
}

function doEndBusinessDay() {
  if (!confirm('確定要結算今日營業嗎？結單後才能再次「今日營業開始」。')) return;
  run(async () => {
    await api('endBusinessDay', {});
    _clearMachineDetailCache();
    await loadHome();
  }, { success: '已結算今日營業' });
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
    machineSvg(72, m.color, m.status, m.icon),
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
      h('div', { class: 'net num ' + netClass(net), text: money(net) }),
      h('div', { class: 'breakdown num' }, breakdown)
    ])
  ]);
}

// ── 畫面：機台詳細 ──────────────────────────────────────

function viewMachine() {
  const d = state.detail;
  if (!d) return h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' })]);

  const m = d.machine;

  const nav = h('div', { class: 'navbar' }, [
    h('button', { class: 'btn btn-sm', onclick: goHome }, '← 返回主畫面'),
    h('button', { class: 'btn btn-sm', onclick: () => goReport(m.machineId) }, '📊 查詢報表')
  ]);

  const hero = h('div', { class: 'detail-hero' }, [
    machineSvg(96, m.color, m.status, m.icon),
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

  if (m.category === 'electronic') return viewElectronicMachine(d, nav, hero, switcher);

  const figures = h('div', { class: 'figures-panel' }, [
    h('div', { class: 'stat net-stat center' }, [
      h('div', { class: 'stat-label', text: '今日淨收益（已扣活動成本）' }),
      h('div', { class: 'stat-value num net ' + netClass(d.today.net), text: money(d.today.net) }),
      h('div', { class: 'small muted num', text: '本週淨收益 ' + money(d.total.net) })
    ]),
    statBox('今日入幣', money(d.today.in)),
    statBox('今日出幣', money(d.today.out)),
    statBox('今日432數量', String(d.today432Count || 0))
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
    state.panel ? renderPanel(d) : null,
    renderRecords(d)
  ]);
}

/** 電子機台的詳細頁：只有開分／洗分兩顆按鈕，沒有入幣/出幣/活動。 */
function viewElectronicMachine(d, nav, hero, switcher) {
  const figures = h('div', { class: 'figures-panel' }, [
    statBox('開分金額', money(d.today.chipIn), 'net pos'),
    statBox('洗分金額', money(d.today.chipOut), ''),
    statBox('盈虧金額', money(d.today.chipNet), 'net ' + netClass(d.today.chipNet))
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
    state.panel ? renderPanel(d) : null,
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
  render();
}

function renderPanel(d) {
  if (state.panel === 'prize') return prizePanel(d);
  if (state.panel === 'in') return meterPanel(d);
  if (state.panel === 'chip_in' || state.panel === 'chip_out') return chipPanel(d, state.panel);
  return quickPanel(d, state.panel); // 只剩 'out' 會走到這裡
}

// ── 面板：電子機台開分／洗分（永遠手動輸入，沒有快捷金額）───

function chipPanel(d, type) {
  const custom = h('input', { type: 'number', inputmode: 'decimal', min: '1', placeholder: '輸入金額', autofocus: true });

  const submit = () => {
    const v = Number(custom.value);
    if (!v || v <= 0) { toast('請輸入大於 0 的金額', 'error'); return; }
    custom.value = '';
    submitAmount(d.machine.machineId, type, v);
  };
  custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [h('h3', { text: TYPE_LABELS[type] })]),
    h('div', { class: 'custom-amount' }, [
      custom,
      h('button', { class: 'btn btn-' + (type === 'chip_in' ? 'in' : 'out'), onclick: submit }, '送出')
    ])
  ]);
}

// ── 面板：出幣快捷金額 ──────────────────────────────────

function quickPanel(d, type) {
  const list = d.quickAmounts[type] || [];
  const scope = d.quickAmounts.scope;

  const buttons = list.map((qa) => {
    const btn = h('button', {
      class: 'btn quick-btn btn-' + type,
      onclick: () => submitAmount(d.machine.machineId, type, qa.amount)
    }, qa.label || money(qa.amount));

    if (!state.editMode) return btn;

    return h('div', { class: 'quick-item' }, [
      btn,
      h('div', { class: 'quick-edit' }, [
        h('button', { class: 'btn', onclick: () => editQuickAmount(d, type, qa) }, '改'),
        h('button', { class: 'btn btn-danger', onclick: () => deleteQuickAmount(qa) }, '刪')
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
      : h('div', { class: 'empty' }, isAdmin() ? '還沒有快捷金額，點「✎ 編輯」新增。' : '尚未設定快捷金額，請用下方自訂金額。'),
    h('div', { class: 'custom-amount' }, [
      custom,
      h('button', {
        class: 'btn btn-' + type,
        onclick: () => {
          const v = Number(custom.value);
          if (!v || v <= 0) { toast('請輸入大於 0 的金額', 'error'); return; }
          custom.value = '';
          submitAmount(d.machine.machineId, type, v);
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
      onclick: () => run(async () => {
        if (isGlobal) {
          await api('forkScope', { sheet: sheet, machineId: machineId });
        } else {
          if (!confirm('要刪除本台的專屬設定、改回沿用全局嗎？')) return;
          await api('resetScope', { sheet: sheet, machineId: machineId });
        }
        await loadDetail(machineId);
      }, { success: isGlobal ? '已改為本台專屬設定' : '已改回沿用全局' })
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
      onclick: () => run(async () => {
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
      }, { success: '已儲存' })
    }, '儲存')
  ]);
}

function deleteQuickAmount(qa) {
  if (!confirm('確定要刪除這個快捷鍵嗎？')) return;
  run(async () => {
    await api('deleteQuickAmount', { qaId: qa.qaId });
    await loadDetail(state.machineId);
  }, { success: '已刪除' });
}

function submitAmount(machineId, type, amount) {
  run(async () => {
    const res = await api('addRecord', {
      machineId: machineId,
      type: type,
      amount: amount,
      clientToken: uuid()
    });
    if (res.duplicated) toast('這筆已經記過了', 'success');
    else toast(TYPE_LABELS[type] + ' ' + money(amount) + ' 已登錄', 'success');
    // 後端已經把送出之後最新的詳細頁資料一起回傳（見 Service.gs 的
    // addRecord），不用再另外打一次 machineDetail，省一趟網路來回。
    applyDetail(machineId, res.detail);
  });
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

    const ok = filled && validNumbers && increasing;
    previewEl.textContent = money(ok ? (end - start) * rateInfo.rate : 0);
    submitBtn.disabled = !ok;
  }
  startInput.addEventListener('input', recalc);
  endInput.addEventListener('input', recalc);
  submitBtn.addEventListener('click', () => submitMeterRecord(d.machine.machineId, startInput, endInput));
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
    h('div', { class: 'panel-total' }, [
      h('span', { class: 'muted' }, '本次入幣'),
      h('div', { class: 'row' }, [previewEl, submitBtn])
    ]),
    isAdmin() && state.editMode ? meterRateEditor(d) : null
  ]);
}

function submitMeterRecord(machineId, startInput, endInput) {
  const meterStart = Number(startInput.value);
  const meterEnd = Number(endInput.value);
  run(async () => {
    const res = await api('addMeterRecord', {
      machineId: machineId,
      meterStart: meterStart,
      meterEnd: meterEnd,
      clientToken: uuid()
    });
    if (res.duplicated) toast('這筆已經記過了', 'success');
    else toast('入幣 ' + money(res.records[0].amount) + ' 已登錄', 'success');
    // 後端已經把送出之後最新的詳細頁資料一起回傳（見 Service.gs 的
    // addMeterRecord），不用再另外打一次 machineDetail，省一趟網路來回。
    applyDetail(machineId, res.detail);
  });
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
        onclick: () => run(async () => {
          await api('saveMeterRate', {
            machineId: rateInfo.scope === 'machine' ? d.machine.machineId : '',
            rate: Number(input.value)
          });
          await loadDetail(d.machine.machineId);
        }, { success: '已儲存' })
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

  function recalc() {
    let sum = 0;
    prizes.forEach((p) => { sum += (state.prizeCounts[p.prizeId] || 0) * p.amount; });
    totalEl.textContent = money(sum);
    submitBtn.disabled = sum <= 0;
  }

  const rows = prizes.map((p) => {
    const row = h('div', { class: 'prize-row' });
    const input = h('input', {
      type: 'number', inputmode: 'numeric', min: '0', value: String(state.prizeCounts[p.prizeId] || 0)
    });

    function setCount(n) {
      const v = Math.max(0, Math.min(9999, Math.floor(Number(n) || 0)));
      state.prizeCounts[p.prizeId] = v;
      input.value = String(v);
      row.classList.toggle('has-count', v > 0);
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
          h('button', { type: 'button', onclick: () => setCount((state.prizeCounts[p.prizeId] || 0) - 1) }, '−'),
          input,
          h('button', { type: 'button', onclick: () => setCount((state.prizeCounts[p.prizeId] || 0) + 1) }, '＋')
        ])
    ]);

    if ((state.prizeCounts[p.prizeId] || 0) > 0) row.classList.add('has-count');
    return row;
  });

  submitBtn.addEventListener('click', () => submitPrizes(d.machine.machineId, prizes));
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
    prizes.length ? h('div', {}, rows) : h('div', { class: 'empty' },
      isAdmin() ? '還沒有獎型，點「✎ 編輯」新增。' : '尚未設定獎型，請聯絡管理員。'),
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

function submitPrizes(machineId, prizes) {
  const items = prizes
    .map((p) => ({ prizeId: p.prizeId, count: state.prizeCounts[p.prizeId] || 0 }))
    .filter((it) => it.count > 0);
  if (!items.length) return;

  run(async () => {
    const res = await api('addPrizeRecord', {
      machineId: machineId,
      items: items,
      clientToken: uuid()
    });
    if (res.duplicated) toast('這筆已經記過了', 'success');
    else toast('活動 ' + money(res.total) + ' 已登錄', 'success');
    state.prizeCounts = {};
    await loadDetail(machineId);
  });
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
      onclick: () => run(async () => {
        await api('savePrize', {
          prizeId: prize ? prize.prizeId : '',
          machineId: prize ? prize.machineId : (d.prizes.length && d.prizes[0].scope === 'machine' ? d.machine.machineId : ''),
          name: name.value.trim(),
          amount: Number(amount.value),
          sortOrder: Number(order.value) || 0
        });
        closeDialog();
        await loadDetail(d.machine.machineId);
      }, { success: '已儲存' })
    }, '儲存')
  ]);
}

function deletePrize(prize) {
  if (!confirm('確定要刪除「' + prize.name + '」嗎？\n已登錄的歷史紀錄不會受影響。')) return;
  run(async () => {
    await api('deletePrize', { prizeId: prize.prizeId });
    await loadDetail(state.machineId);
  }, { success: '已刪除' });
}

// ── 紀錄清單 ────────────────────────────────────────────

function renderRecords(d) {
  const items = d.records.length
    ? d.records.map(recordItem)
    : [h('div', { class: 'empty' }, '還沒有任何紀錄')];

  return h('div', { class: 'card' }, [
    h('div', { class: 'panel-head' }, [
      h('h3', { text: '本機台紀錄' }),
      d.hasMore ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => goReport(d.machine.machineId) }, '看全部') : null
    ]),
    h('div', { class: 'record-list' }, items)
  ]);
}

function recordItem(r) {
  const sign = (r.type === 'in' || r.type === 'chip_in') ? '+' : '−';
  const hasMeter = r.type === 'in' && r.meterStart !== null && r.meterEnd !== null;
  const title = r.type === 'prize'
    ? (r.prizeName + ' ×' + r.count)
    : hasMeter
      ? ('上班表 ' + r.meterStart.toLocaleString('zh-TW') + ' → 下班表 ' + r.meterEnd.toLocaleString('zh-TW'))
      : TYPE_LABELS[r.type];

  return h('div', { class: 'record-item' }, [
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

function voidRecord(r) {
  if (!confirm('確定要作廢這筆紀錄嗎？\n' + TYPE_LABELS[r.type] + ' ' + money(r.amount))) return;
  run(async () => {
    await api('voidRecord', { recordId: r.recordId });
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

async function loadActivityQuery() {
  const data = await run(() => api('activityQuery', state.activityParams));
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

  const title = h('h1', { text: '活動查詢' });

  if (!r) {
    return h('div', {}, [nav, title, customRange, h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' })])]);
  }

  const stats = h('div', { class: 'report-stats' }, [
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

  const presets = h('div', { class: 'seg', style: 'margin-bottom:12px' },
    [['day', '今日'], ['week', '本週'], ['month', '本月'], ['custom', '自訂'], ['history', '歷史']].map(([key, label]) =>
      h('button', {
        class: p.preset === key ? 'active' : '',
        onclick: () => {
          p.preset = key;
          if ((key === 'custom' || key === 'history') && !p.from) { p.from = todayInputValue(); p.to = todayInputValue(); }
          loadReport();
        }
      }, label)
    ));

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
    return h('div', {}, [nav, presets, customRange, rangeHint, h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' })])]);
  }

  const s = rep.summary;
  // 電子機台只有開分／洗分紀錄，沒有入幣/出幣/活動——
  // 用骰台那套（in/out/prize/net）算出來的淨收益永遠是 0，
  // 要改用 chipIn/chipOut/chipNet。
  const isElectronic = rep.scope.category === 'electronic';
  const stats = isElectronic
    ? h('div', { class: 'report-stats', style: 'margin-bottom:12px' }, [
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
  svg.setAttribute('class', 'chart');
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
      : h('div', { class: 'empty' }, '這個區間沒有紀錄')
  ]);
}

/**
 * 匯出對帳表 .xlsx（後端回 base64，這裡解碼成二進位再包成 Blob 下載）。
 */
function downloadLedgerXlsx() {
  run(async () => {
    const p = state.reportParams;
    const xlsx = await api('exportLedgerXlsx', p);
    const binary = atob(xlsx.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: xlsx.filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已匯出 ' + xlsx.rowCount + ' 筆', 'success');
  });
}

/**
 * 「骰台查詢」／「電子查詢」（不指定單台、看整個分類）頁「📷 匯出截圖」
 * 用的畫布繪製——每台機台一段，內容跟 exportLedgerXlsx 每個分頁一模一樣
 * 的逐日對帳表（圖數逐筆列出，底下接出幣/432/441/入幣/+/-五列小計），
 * 疊成一張直向捲動的長圖，每一段最上面標該機台的名稱＋查詢區間，模擬
 * Excel「一台機台一個分頁」的概念，但不用另外開 Excel 才看得到。
 * 手繪 canvas、不叫外部套件，同一個理由見 exportLedgerImage() 的說明。
 */
function _gridCellText(cell) {
  if (cell === '' || cell === null || cell === undefined) return '';
  return typeof cell === 'number' ? money(cell) : String(cell);
}

function drawLedgerGridsCanvas(rangeLabel, machines) {
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
  const sectionGap = 22;
  const firstColW = 56;
  const dayColW = 62;
  const tailColWidths = [70, 78]; // 每列小計最右邊的「標籤欄／數字欄」

  const colWidthsOf = (colCount) => {
    const days = colCount - 1 - tailColWidths.length;
    return [firstColW].concat(new Array(days).fill(dayColW)).concat(tailColWidths);
  };

  let width = 320;
  let height = 16;
  machines.forEach((m) => {
    const widths = colWidthsOf(m.colCount);
    width = Math.max(width, padX * 2 + widths.reduce((a, b) => a + b, 0));
    height += titleH + rowH /* 表頭 */ + m.outRows.length * rowH + dividerH + m.summaryRows.length * rowH + sectionGap;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = colorBg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  let y = 12;
  machines.forEach((m) => {
    const widths = colWidthsOf(m.colCount);
    const colX = [padX];
    widths.forEach((w) => colX.push(colX[colX.length - 1] + w));
    const tableRight = colX[colX.length - 1];

    ctx.font = 'bold 16px ' + font;
    ctx.fillStyle = colorText;
    ctx.textAlign = 'left';
    ctx.fillText(m.machineName + '　' + rangeLabel, padX, y + titleH / 2);
    y += titleH;

    const drawRow = (cells, opts) => {
      opts = opts || {};
      cells.forEach((cell, i) => {
        // 只有右邊那個「總出幣/432/441/總入幣/+/-」標籤欄套底色，跟
        // Excel（_writeLedgerSheet）的樣式規則一致——最左邊那欄（出幣/432/
        // 441/入幣/+/-）在 Excel 裡沒有套底色，這裡照抄同一個規則。
        const isLabelCol = i === widths.length - 2;
        if (opts.labelBg && isLabelCol) {
          ctx.fillStyle = colorSummaryLabelBg;
          ctx.fillRect(colX[i], y, widths[i], rowH);
        }
        ctx.font = (opts.bold ? 'bold ' : '') + '12px ' + font;
        ctx.fillStyle = opts.neg ? colorNeg : (opts.bold ? colorText : colorMuted);
        ctx.textAlign = 'center';
        ctx.fillText(_gridCellText(cell), colX[i] + widths[i] / 2, y + rowH / 2);
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

    m.summaryRows.forEach((row) => drawRow(row, { bold: true, labelBg: true, neg: row[0] === '+/-' }));

    y += sectionGap;
  });

  return canvas;
}

function exportLedgerScreenshots() {
  run(async () => {
    const p = state.reportParams;
    const data = await api('exportLedgerGrids', p);
    const rangeLabel = data.range.from + ' ~ ' + data.range.to;
    const canvas = drawLedgerGridsCanvas(rangeLabel, data.machines);
    const filename = '骰台查詢對帳表截圖_' + data.range.from + '_' + data.range.to + '.png';
    const blob = _dataUrlToBlob(canvas.toDataURL('image/png'));

    // 分享面板／下載連結的取捨理由見 exportLedgerImage() 的說明——這裡
    // 只有一個檔案，同一套邏輯直接照搬。
    const file = (typeof File !== 'undefined') ? new File([blob], filename, { type: 'image/png' }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(function () {});
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已匯出 ' + data.machines.length + ' 台機台的截圖', 'success');
  });
}

// ── 畫面：系統管理 ──────────────────────────────────────

function viewAdmin() {
  const data = state.admin;

  const nav = h('div', { class: 'navbar' }, [
    h('button', { class: 'btn btn-sm', onclick: goHome }, '← 返回主畫面'),
    h('h1', { style: 'font-size:18px', text: '系統管理' })
  ]);

  const tabs = h('div', { class: 'tabs' },
    [['users', '帳號'], ['machines', '機台'], ['prizes', '獎型'], ['perms', '台主授權']].map(([key, label]) =>
      h('button', {
        class: state.adminTab === key ? 'active' : '',
        // 純粹切換要看哪個分頁，資料已經在 goAdmin() 進頁面時一次抓齊了
        // （放在 state.admin 裡），不用每點一次分頁就重新打 4 個 API。
        // 任何一個分頁的新增/編輯/刪除動作都會自己呼叫 loadAdmin() 刷新，
        // 所以這裡拿到的一定是當下最新的資料。
        onclick: () => { state.adminTab = key; render(); }
      }, label)));

  if (!data) return h('div', {}, [nav, tabs, h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' })])]);

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
      onclick: () => run(async () => {
        await api('adminSaveUser', {
          userId: u ? u.userId : '',
          username: username.value.trim(),
          displayName: displayName.value.trim(),
          role: role.value,
          status: u ? status.value : 'active',
          password: password.value
        });
        closeDialog();
        if (!u) showPasswordOnce(username.value.trim(), password.value);
        await loadAdmin();
      }, { success: '已儲存' })
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
      onclick: () => run(async () => {
        const value = password.value;
        await api('adminResetPassword', { userId: u.userId, password: value });
        closeDialog();
        showPasswordOnce(u.username, value);
        await loadAdmin();
      })
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
    machineSvg(40, m.color, m.status, m.icon),
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

  const refreshPreview = () => preview.replaceChildren(machineSvg(72, color, status.value, icon));

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
      machineSvg(40, '#4F7BE8', 'running', key),
      MACHINE_ICON_LABELS[key] || key
    ]);
    return btn;
  }));

  const preview = h('div', { class: 'center', style: 'margin-bottom:14px' }, machineSvg(72, color, m ? m.status : 'running', icon));
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
      onclick: () => run(async () => {
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
      }, { success: '已儲存' })
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
    items.length ? h('div', { class: 'admin-list' }, items) : h('div', { class: 'card empty' }, '還沒有獎型'),
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
      onclick: () => run(async () => {
        await api('savePrize', {
          prizeId: p ? p.prizeId : '',
          machineId: '',
          name: name.value.trim(),
          amount: Number(amount.value),
          sortOrder: Number(order.value) || 0
        });
        closeDialog();
        await loadAdmin();
      }, { success: '已儲存' })
    }, '儲存')
  ]);
}

function deletePrizeFromAdmin(p) {
  if (!confirm('確定要刪除「' + p.name + '」嗎？\n已登錄的歷史紀錄不會受影響。')) return;
  run(async () => {
    await api('deletePrize', { prizeId: p.prizeId });
    await loadAdmin();
  }, { success: '已刪除' });
}

function adminPerms(data) {
  const perms = data.perms;

  if (!perms.owners.length) {
    return h('div', {}, [
      h('div', { class: 'perm-note' }, '管理員與巡邏人員自動擁有全部機台，不需要在這裡設定。'),
      h('div', { class: 'card empty' }, '目前沒有台主帳號。到「帳號」分頁新增角色為「台主」的帳號後，就能在這裡指定他看得到哪些機台。')
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
          machineSvg(28, m.color, m.status, m.icon),
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

async function loadReport() {
  const key = 'report:' + JSON.stringify(state.reportParams);
  state.report = cacheRead(key);
  render();
  const data = await run(() => api('report', state.reportParams));
  if (data) {
    cacheWrite(key, data);
    state.report = data;
    render();
  }
}

async function loadAdmin() {
  // 四組資料合併成一次 API 呼叫（後端 adminBootstrap），
  // 而不是分開打 4 支——省下 3 次「/exec 轉址 + GAS 執行」的固定成本。
  const data = await run(() => api('adminBootstrap'));
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

function doLogout() {
  const token = state.token;
  clearSession();
  state.view = 'login';
  render();
  api('logout', { token: token }).catch(() => { /* 本機已登出就好 */ });
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
  else node = h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' }), h('p', {}, '載入中…')]);

  const renderKey = state.view + ':' + (state.machineId || '') + ':' + (state.homeTab || '');
  const isNavigation = renderKey !== _lastRenderKey;
  const prevScrollY = window.scrollY;
  _lastRenderKey = renderKey;

  app.replaceChildren(node);

  if (isNavigation) window.scrollTo(0, 0);
  else if (prevScrollY > 0) window.scrollTo(0, prevScrollY);
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
  const update = () => { bar.hidden = navigator.onLine; };
  window.addEventListener('online', () => { update(); if (state.token) refreshCurrent(); });
  window.addEventListener('offline', update);
  update();
}

function refreshCurrent() {
  if (state.view === 'home') loadHome();
  else if (state.view === 'machine' && state.machineId) loadDetail(state.machineId);
  else if (state.view === 'report') loadReport();
  else if (state.view === 'activity') loadActivityQuery();
  else if (state.view === 'admin') loadAdmin();
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

async function boot() {
  setupNetworkIndicators();
  registerServiceWorker();
  startPolling();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.token) refreshCurrent();
  });

  if (!(window.APP_CONFIG && window.APP_CONFIG.GAS_API_URL)) { render(); return; }

  loadSession();
  if (!state.token) { state.view = 'login'; render(); return; }

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
