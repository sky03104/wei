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

const STATUS_COLORS = { running: '#4ADE80', maintenance: '#FBBF24', offline: '#6B7488' };
const STATUS_LABELS = { running: '營運中', maintenance: '維修中', offline: '停機' };
const TYPE_LABELS = { in: '入幣', out: '出幣', prize: '開獎' };
const MACHINE_COLORS = ['#4F7BE8', '#E8574F', '#4ADE80', '#FBBF24', '#C084FC', '#22D3EE', '#F472B6', '#94A3B8'];

const STORAGE_TOKEN = 'claw_token';
const STORAGE_REMEMBER = 'claw_remember';
const POLL_MS = 20000;

/** 前端版本號，登入頁顯示用，方便確認手機上是不是最新版。
 *  跟 sw.js 的 CACHE_VERSION 手動保持一致——每次改前端兩個都要加。 */
const APP_VERSION = 'v10';

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
  panel: null,        // 'in' | 'out' | 'prize' | null
  editMode: false,
  prizeCounts: {},
  reportParams: { machineId: '', preset: 'day', from: '', to: '', type: '', userId: '' },
  adminTab: 'users',
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
 * 把 PIXEL_MACHINE 展開成 SVG。
 * 同一個函式供首頁小圖、詳細頁大圖、登入頁使用，只有一份圖案定義。
 * 相鄰同色的格子會合併成一個 rect，節點數少一半以上。
 */
function machineSvg(height, bodyColor, status) {
  const rows = PIXEL_MACHINE.length;
  const cols = PIXEL_MACHINE[0].length;
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
    S: STATUS_COLORS[status] || STATUS_COLORS.running
  };

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pixel-machine');
  svg.setAttribute('width', String(Math.round(width)));
  svg.setAttribute('height', String(Math.round(height)));
  svg.setAttribute('viewBox', '0 0 ' + cols + ' ' + rows);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '娃娃機（' + (STATUS_LABELS[status] || '營運中') + '）');

  for (let y = 0; y < rows; y++) {
    const line = PIXEL_MACHINE[y];
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
  // 才顯示，不然每 20 秒的背景刷新也會跳一下，反而更干擾。
  if (!options.silent && ++visibleRunDepth === 1) showBusy(true);
  try {
    const result = await fn();
    if (options.success) toast(options.success, 'success');
    return result;
  } catch (err) {
    // 背景輪詢失敗不打擾使用者（離線時本來就有提示條，不需要每 20 秒再彈一次）
    if (err.code !== 'AUTH' && !options.silent) toast(err.message, 'error');
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
      }));
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
    h('p', { class: 'small muted center', style: 'margin-top:6px', text: APP_VERSION })
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

  const t = data.todayTotal;

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

  const summary = h('div', { class: 'summary-strip' }, [
    statBox('今日入幣', money(t.in), 'net pos'),
    statBox('今日出幣', money(t.out), ''),
    statBox('今日開獎', money(t.prize), ''),
    statBox('今日淨收益', money(t.net), 'net ' + netClass(t.net))
  ]);

  const list = data.machines.length
    ? h('div', { class: 'machine-list' }, data.machines.map(machineCard))
    : h('div', { class: 'card empty' }, isAdmin()
      ? '還沒有任何機台。到「⚙ 系統管理 → 機台」新增第一台。'
      : '目前沒有開放給你的機台，請聯絡管理員。');

  return h('div', {}, [
    h('div', { class: 'home-sticky' }, [header, summary]),
    list
  ]);
}

function machineCard(m) {
  return h('button', {
    class: 'machine-card',
    type: 'button',
    onclick: () => goMachine(m.machineId)
  }, [
    machineSvg(72, m.color, m.status),
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
      h('div', { class: 'net num ' + netClass(m.today.net), text: money(m.today.net) }),
      h('div', { class: 'breakdown num' },
        '入 ' + money(m.today.in) + ' · 出 ' + money(m.today.out) + ' · 獎 ' + money(m.today.prize))
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
    machineSvg(96, m.color, m.status),
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

  const figures = h('div', { class: 'figures-panel' }, [
    h('div', { class: 'stat net-stat center' }, [
      h('div', { class: 'stat-label', text: '今日淨收益（已扣開獎）' }),
      h('div', { class: 'stat-value num net ' + netClass(d.today.net), text: money(d.today.net) }),
      h('div', { class: 'small muted num', text: '累計淨收益 ' + money(d.total.net) })
    ]),
    statBox('今日入幣', money(d.today.in)),
    statBox('今日出幣', money(d.today.out)),
    statBox('今日開獎', money(d.today.prize))
  ]);

  const actions = canRecord()
    ? h('div', { class: 'action-buttons' }, [
      h('button', { class: 'btn btn-in' + (state.panel === 'in' ? ' active' : ''), onclick: () => togglePanel('in') }, '入幣'),
      h('button', { class: 'btn btn-out' + (state.panel === 'out' ? ' active' : ''), onclick: () => togglePanel('out') }, '出幣'),
      h('button', { class: 'btn btn-prize' + (state.panel === 'prize' ? ' active' : ''), onclick: () => togglePanel('prize') }, '🎁 開獎')
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
 * 一排可以橫向捲動的機台小按鈕，讓巡機時可以直接跳下一台，
 * 不用先按「返回主畫面」再從列表點一次。資料直接沿用 state.home
 * （首頁載入時就有了，不用為了這排按鈕多打一次 API）；
 * 只有一台機台或首頁資料還沒載入過時就不顯示，沒有意義。
 */
/**
 * 記住上一次 machineSwitcher() 是幫哪一台機台畫的，用來分辨這次重畫
 * 是「真的切到別台」還是「同一台機台原地重繪」（記帳送出後的背景
 * 重新整理、20 秒輪詢…）。render() 每次都整個 replaceChildren，
 * 這排籤跟著整個重建，瀏覽器自己的捲動位置記憶完全沒用，
 * 一定要手動處理，不然使用者手動滑到後面找機台，一遇到背景重繪
 * 就會被強制捲回目前這台，變成「切著切著自己彈回去」。
 */
let _switcherLastMachineId = null;

function machineSwitcher(currentMachineId) {
  const machines = state.home && state.home.machines;
  if (!machines || machines.length < 2) return null;

  const prevEl = document.querySelector('.machine-switcher');
  // prevEl 不存在（剛進頁面／從別頁回來）也當成「新的」，理由同下面切換的情況：
  // 都該把目前這台捲到看得到的地方，而不是沿用一個不存在的捲動位置。
  const isNavigation = !prevEl || currentMachineId !== _switcherLastMachineId;
  const prevScrollLeft = prevEl ? prevEl.scrollLeft : 0;
  _switcherLastMachineId = currentMachineId;

  const chips = machines.map(function (m) {
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
  });

  const el = h('div', { class: 'machine-switcher' }, chips);
  requestAnimationFrame(() => {
    if (isNavigation) {
      // 真的切機台了：捲到看得到目前這台，機台一多、剛好在畫面外時不用自己找。
      const activeChip = el.querySelector('.machine-chip.active');
      if (activeChip) activeChip.scrollIntoView({ inline: 'center', block: 'nearest' });
    } else {
      // 同一台機台的背景重繪：把使用者手動滑到的位置還原回去，不要幫倒忙。
      el.scrollLeft = prevScrollLeft;
    }
  });
  return el;
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
  return quickPanel(d, state.panel); // 只剩 'out' 會走到這裡
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
    await loadDetail(machineId);
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
    await loadDetail(machineId);
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

// ── 面板：開獎 ──────────────────────────────────────────

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
      h('h3', { text: '開獎登錄' }),
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
    else toast('開獎 ' + money(res.total) + ' 已登錄', 'success');
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
  const sign = r.type === 'in' ? '+' : '−';
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
      onclick: downloadCsv
    }, '⬇ 匯出 CSV')
  ]);

  const presets = h('div', { class: 'seg', style: 'margin-bottom:12px' },
    [['day', '今日'], ['week', '本週'], ['month', '本月'], ['custom', '自訂']].map(([key, label]) =>
      h('button', {
        class: p.preset === key ? 'active' : '',
        onclick: () => {
          p.preset = key;
          if (key === 'custom' && !p.from) { p.from = todayInputValue(); p.to = todayInputValue(); }
          loadReport();
        }
      }, label)
    ));

  const customRange = p.preset === 'custom'
    ? h('div', { class: 'filter-row', style: 'margin-bottom:12px' }, [
      dialogField('起始日期', h('input', {
        type: 'date', value: p.from,
        onchange: (e) => { p.from = e.target.value; loadReport(); }
      })),
      dialogField('結束日期', h('input', {
        type: 'date', value: p.to,
        onchange: (e) => { p.to = e.target.value; loadReport(); }
      }))
    ])
    : null;

  if (!rep) {
    return h('div', {}, [nav, presets, customRange, h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' })])]);
  }

  const s = rep.summary;
  const stats = h('div', { class: 'report-stats', style: 'margin-bottom:12px' }, [
    statBox('入幣', money(s.in), 'net pos'),
    statBox('出幣', money(s.out)),
    statBox('開獎成本', money(s.prize)),
    statBox('淨收益', money(s.net), 'net ' + netClass(s.net))
  ]);

  const title = h('div', { class: 'topbar' }, [
    h('div', {}, [
      h('h1', { text: rep.scope.machineName || '全部機台報表' }),
      h('div', { class: 'small muted', text: rep.range.from + ' ~ ' + rep.range.to + '（共 ' + rep.recordCount + ' 筆）' })
    ])
  ]);

  return h('div', {}, [
    nav, title, presets, customRange, stats,
    trendCard(rep.trend),
    prizeStatsCard(rep.prizeStats),
    recordsTableCard(rep)
  ]);
}

/** 純手繪 SVG 長條圖：每日淨收益，正值綠、負值紅。 */
function trendCard(trend) {
  const width = Math.max(300, trend.length * 34);
  const height = 160;
  const padTop = 12;
  const padBottom = 26;
  const plot = height - padTop - padBottom;

  let max = 1;
  trend.forEach((d) => { max = Math.max(max, Math.abs(d.net)); });

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);

  const zeroY = padTop + plot / 2;
  const axis = document.createElementNS(svgNs, 'line');
  axis.setAttribute('class', 'axis');
  axis.setAttribute('x1', '0'); axis.setAttribute('x2', String(width));
  axis.setAttribute('y1', String(zeroY)); axis.setAttribute('y2', String(zeroY));
  svg.appendChild(axis);

  const step = width / Math.max(1, trend.length);
  const barW = Math.max(6, Math.min(44, step * 0.6));  // 只有一兩天時別讓長條胖到佔滿整張圖

  trend.forEach((d, i) => {
    const ratio = Math.abs(d.net) / max;
    const barH = Math.max(d.net === 0 ? 0 : 2, ratio * (plot / 2));
    const x = i * step + (step - barW) / 2;
    const y = d.net >= 0 ? zeroY - barH : zeroY;

    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('class', d.net >= 0 ? 'bar-pos' : 'bar-neg');
    rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW)); rect.setAttribute('height', String(barH));
    rect.setAttribute('rx', '2');
    const t = document.createElementNS(svgNs, 'title');
    t.textContent = d.date + '：' + money(d.net);
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
  }, [['', '全部類型'], ['in', '入幣'], ['out', '出幣'], ['prize', '開獎']].map(([v, l]) =>
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
        '畫面只顯示最新 ' + rep.records.length + ' 筆，完整資料請匯出 CSV。')
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
 * 匯出 CSV。
 * 前面加 UTF-8 BOM，否則 Excel 打開中文會變亂碼。
 */
function downloadCsv() {
  run(async () => {
    const p = state.reportParams;
    const csv = await api('exportCsv', p);
    const blob = new Blob(['\uFEFF' + csv.content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: csv.filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已匯出 ' + csv.rowCount + ' 筆', 'success');
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

function adminMachines(data) {
  const items = data.machines.map((m) => h('div', { class: 'admin-item' }, [
    machineSvg(40, m.color, m.status),
    h('div', { class: 'admin-main' }, [
      h('div', { class: 'admin-name', text: m.name }),
      h('div', { class: 'admin-sub', text: (m.location || '—') + ' · ' + STATUS_LABELS[m.status] })
    ]),
    h('button', { class: 'btn btn-sm', onclick: () => editMachine(m) }, '編輯')
  ]));

  return h('div', {}, [
    h('button', { class: 'btn btn-primary btn-block', style: 'margin-bottom:14px', onclick: () => editMachine(null) }, '＋ 新增機台'),
    h('div', { class: 'admin-list' }, items)
  ]);
}

function editMachine(m) {
  const name = h('input', { type: 'text', maxlength: '30', value: m ? m.name : '' });
  const location = h('input', { type: 'text', maxlength: '50', value: m ? m.location : '' });
  const status = h('select', {}, [['running', '營運中'], ['maintenance', '維修中'], ['offline', '停機']]
    .map(([v, l]) => h('option', { value: v, selected: (m ? m.status : 'running') === v }, l)));
  const order = h('input', { type: 'number', value: m ? m.sortOrder : (state.admin.machines.length + 1) });

  let color = m ? m.color : MACHINE_COLORS[0];
  const swatches = h('div', { class: 'color-swatches' }, MACHINE_COLORS.map((c) => {
    const btn = h('button', {
      type: 'button',
      class: c === color ? 'active' : '',
      style: 'background:' + c,
      onclick: () => {
        color = c;
        Array.prototype.forEach.call(swatches.children, (child) => child.classList.remove('active'));
        btn.classList.add('active');
        preview.replaceChildren(machineSvg(72, color, status.value));
      }
    });
    return btn;
  }));

  const preview = h('div', { class: 'center', style: 'margin-bottom:14px' }, machineSvg(72, color, m ? m.status : 'running'));
  status.addEventListener('change', () => preview.replaceChildren(machineSvg(72, color, status.value)));

  openDialog(m ? '編輯機台' : '新增機台', [
    preview,
    dialogField('機台名稱', name),
    dialogField('位置', location),
    dialogField('狀態', status),
    dialogField('機身顏色', swatches),
    dialogField('排序', order)
  ], [
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
          sortOrder: Number(order.value) || 0
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
      + '某台需要不一樣時，到那台的詳細頁按「🎁 開獎 → ✎ 編輯 → 改成本台自訂」。'),
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

  const blocks = perms.owners.map((o) => {
    const granted = perms.grants[o.userId] || [];
    return h('div', { class: 'card', style: 'margin-bottom:12px' }, [
      h('div', { class: 'panel-head' }, [
        h('h3', {}, [o.displayName, h('span', { class: 'muted small', text: ' @' + o.username })]),
        h('span', { class: 'small muted', text: granted.length + ' / ' + perms.machines.length + ' 台' })
      ]),
      h('div', {}, perms.machines.map((m) => {
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
          machineSvg(28, m.color, m.status),
          h('span', { class: 'grow', text: m.name }),
          h('span', { class: 'small muted', text: m.location || '' })
        ]);
      }))
    ]);
  });

  return h('div', {}, [
    h('div', { class: 'perm-note' }, '管理員與巡邏人員自動擁有全部機台，不需要在這裡設定；新增機台後也不用回來補。這一頁只影響台主。'),
    blocks
  ]);
}

// ── 資料載入 ────────────────────────────────────────────

async function loadHome(opts) {
  const data = await run(() => api('dashboard'), opts);
  if (data) { state.home = data; render(); prefetchMachineDetails(); }
}

/**
 * 首頁一載入就趁背景把每一台機台的詳細資料先抓回來存進快取，
 * 用機台切換籤跳來跳去時大多是「第一次」進某一台，本來一定要
 * 等一趟 GAS 來回；預先抓好之後不管跳去哪一台都秒開。
 *
 * 不走 run()：這是背景低優先度的事，不該讓 state.busy 卡住、
 * 影響到使用者正在做的事情或每 20 秒的輪詢；失敗也靜靜略過，
 * 使用者真的點進去時 loadDetail 會照正常流程重新抓一次。
 * 用小併發（3 個一批）避免機台一多時一次炸出二三十個請求。
 * 不用旗標擋重複呼叫——內部本來就會先看快取，已經抓過的機台
 * 直接跳過，同一批 id 被叫第二次也只是白檢查一次，沒有副作用。
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
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        if (state.cache['detail:' + id]) continue;
        try {
          state.cache['detail:' + id] = await api('machineDetail', { machineId: id });
        } catch (err) {
          // 背景預取失敗不用理，使用者真的點進去時走正常流程會重新抓一次
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
  } finally {
    _prefetchInFlight = false;
  }
}

async function loadDetail(machineId, opts) {
  const data = await run(() => api('machineDetail', { machineId: machineId }), opts);
  if (data) {
    state.cache['detail:' + machineId] = data;
    state.detail = data;
    render();
  }
}

async function loadReport() {
  const key = 'report:' + JSON.stringify(state.reportParams);
  state.report = state.cache[key] || null;
  render();
  const data = await run(() => api('report', state.reportParams));
  if (data) {
    state.cache[key] = data;
    state.report = data;
    render();
  }
}

async function loadAdmin() {
  // 四組資料合併成一次 API 呼叫（後端 adminBootstrap），
  // 而不是分開打 4 支——省下 3 次「/exec 轉址 + GAS 執行」的固定成本。
  const data = await run(() => api('adminBootstrap'));
  if (!data) return;
  state.cache.admin = data;
  state.admin = data;
  render();
}

// ── 導覽 ────────────────────────────────────────────────
//
// goX() 系列進畫面時，先看 state.cache 有沒有這個畫面上次的資料：
// 有就直接秒開（同時背景照樣打 API 拿最新的來覆蓋），完全沒有才顯示轉圈圈。

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
  state.detail = state.cache['detail:' + machineId] || null;
  render();
  loadDetail(machineId);
}

function goReport(machineId) {
  state.view = 'report';
  state.reportParams = {
    machineId: machineId || '',
    preset: 'day', from: '', to: '', type: '', userId: ''
  };
  state.report = state.cache['report:' + JSON.stringify(state.reportParams)] || null;
  render();
  loadReport();
}

function goAdmin() {
  state.view = 'admin';
  state.adminTab = 'users';
  state.admin = state.cache.admin || null;
  render();
  loadAdmin();
}

function doLogout() {
  const token = state.token;
  clearSession();
  state.view = 'login';
  render();
  api('logout', { token: token }).catch(() => { /* 本機已登出就好 */ });
}

// ── 繪製 ────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  let node;

  if (!(window.APP_CONFIG && window.APP_CONFIG.GAS_API_URL)) node = viewSetupNotice();
  else if (state.view === 'login') node = viewLogin();
  else if (state.view === 'home') node = viewHome();
  else if (state.view === 'machine') node = viewMachine();
  else if (state.view === 'report') node = viewReport();
  else if (state.view === 'admin') node = viewAdmin();
  else node = h('div', { class: 'boot' }, [h('div', { class: 'boot-spinner' }), h('p', {}, '載入中…')]);

  app.replaceChildren(node);
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
