/**
 * tools/e2e-fx.js — 動態效果（docs/ui_fx.css／ui_fx.js）的瀏覽器測試
 *
 *   node tools/dev-server.js &
 *   node tools/e2e-fx.js
 *
 * 在真正的 App 上驗：
 *   第一批：讀取中骨架、送出成功打勾、漏填標紅、下拉更新、刪除收合，
 *           以及自動生效的按鈕漣漪、對話框／提示訊息進出場
 *   第二批：金額數字跳動、新紀錄亮一下、按鈕送出中、分頁滑動膠囊、記帳面板滑下來、
 *           報表長條長出來、首頁標題列陰影、離線提示條滑進滑出＋「已恢復連線」
 * 一般模式跑一輪，再開一個「手機設定：減少動態效果」的瀏覽器跑一輪——效果要全部關掉，
 * 但送出、作廢、下拉更新這些功能照常。任何 console 錯誤都算失敗。
 *
 * 一律走本機假後端：config.js 在這裡被換成 GAS_API_URL:'/api'，就算 docs/config.js
 * 設成 BACKEND:'supabase'（資料庫版），測試也不會碰到正式的 Supabase。
 * 會改到本機示範資料（記帳、作廢），要跟 tools/e2e.js 分開用各自的 dev-server 跑。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW_PATH || '/opt/node22/lib/node_modules/playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const SHOTS = process.env.SHOT_DIR || '/tmp/fx-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push('  ✅ ' + name); })
    .catch((err) => { results.push('  ❌ ' + name + ' → ' + String(err.message).split('\n')[0]); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '斷言失敗'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 開一個手機大小、有觸控的瀏覽器分頁。reducedMotion：'no-preference' 或 'reduce'。 */
async function openPhone(browser, reducedMotion) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-TW',
    hasTouch: true, isMobile: true, reducedMotion,
    serviceWorkers: 'block'   // 不讓 Service Worker 快取擋在中間，下面的 route 才攔得到每一個請求
  });
  // 強制走本機假後端（見檔頭）；CDN 上的 supabase-js／exceljs 在 GAS 模式用不到，給空檔就好
  await context.route('**/config.js', (r) => r.fulfill({
    contentType: 'text/javascript; charset=utf-8',
    body: "window.APP_CONFIG = { GAS_API_URL: '/api' };\n"
  }));
  await context.route(/cdn\.jsdelivr\.net/, (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));

  const errors = [];
  const apiCalls = [];
  const delays = {};   // action → 延遲毫秒，用來把「讀取中」「送出中」拉長到看得到
  await context.route('**/api', async (route) => {
    const action = (/"action":"([^"]+)"/.exec(decodeURIComponent(route.request().postData() || '')) || [])[1] || '';
    apiCalls.push(action);
    if (delays[action]) await sleep(delays[action]);
    await route.continue();
  });

  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());   // 作廢／刪除的 confirm() 一律按確定
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, errors, apiCalls, delays };
}

/** 用真的觸控事件（CDP）在 (x, y0) 往下拉 dy；release=false 時手指先不放開。 */
async function pull(cdp, x, y0, dy, release) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (dy * i) / 12 }] });
  }
  if (release !== false) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * 登入（勾記住我，之後 reload 才會直接進首頁）。登入那一趟故意拖慢，
 * 回傳按下去當下按鈕長什麼樣子（給「按鈕送出中」用）。
 */
async function loginObserved(env) {
  const { page } = env;
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.login-wrap form');
  await page.fill('input[autocomplete="username"]', 'admin');
  await page.fill('input[type="password"]', 'admin123');
  await page.check('.checkbox input');
  env.delays.login = 900;
  await page.click('button[type="submit"]');
  const btn = await page.evaluate(() => {
    const b = document.querySelector('button[type="submit"]');
    const sp = b.querySelector('.fx-btn-spin');
    return { text: b.textContent, disabled: b.disabled, spin: !!sp, spinShown: !!sp && getComputedStyle(sp).display !== 'none' };
  });
  await page.waitForSelector('.machine-card', { timeout: 8000 });
  delete env.delays.login;
  return btn;
}

/** 對話框關掉時的淡出複本（.fx-ghost）只存在 0.2 秒：點之前先裝好觀察器，出現過就記下來。 */
async function watchGhost(page) {
  await page.evaluate(() => {
    window.__fxGhostSeen = false;
    new MutationObserver(() => { if (document.querySelector('.fx-ghost')) window.__fxGhostSeen = true; })
      .observe(document.body, { childList: true, subtree: true });
  });
}

/** 每一格畫面記下 selector 那個元素的文字（元素重畫換掉也照樣記），給「數字跳動」用。 */
async function startSampling(page, selector) {
  await page.evaluate((sel) => {
    window.__fxSeen = [];
    window.__fxSampling = true;
    const tick = () => {
      const el = document.querySelector(sel);
      if (el && window.__fxSeen[window.__fxSeen.length - 1] !== el.textContent) window.__fxSeen.push(el.textContent);
      if (window.__fxSampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, selector);
}
async function stopSampling(page) {
  return page.evaluate(() => { window.__fxSampling = false; return window.__fxSeen; });
}

/** 分頁膠囊：點下 label 那一顆之後，膠囊有沒有「滑」（有 CSS transition 在跑），最後有沒有停在那一顆上。 */
async function clickTab(page, containerSel, label) {
  await page.click(containerSel + ' button:has-text("' + label + '")');
  let moving = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 500) {
    moving = await page.evaluate((sel) => {
      const s = document.querySelector(sel + ' > .fx-slider');
      return !!s && s.getAnimations().length > 0;
    }, containerSel);
    if (moving) break;
    await sleep(16);
  }
  await sleep(450);
  const end = await page.evaluate(({ sel, text }) => {
    const c = document.querySelector(sel);
    const s = c && c.querySelector(':scope > .fx-slider');
    const b = c && Array.from(c.querySelectorAll('button')).find((x) => x.textContent.trim() === text);
    if (!s || !b) return null;
    const rs = s.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return {
      aligned: Math.abs(rs.left - rb.left) < 1.5 && Math.abs(rs.width - rb.width) < 1.5 && Math.abs(rs.top - rb.top) < 1.5,
      active: b.classList.contains('active'),
      sliderBg: getComputedStyle(s).backgroundColor,
      buttonBg: getComputedStyle(b).backgroundColor
    };
  }, { sel: containerSel, text: label });
  return { moving, end };
}

async function openFirstMachine(page) {
  if (!(await page.locator('.machine-card').count())) {
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
  }
  await page.locator('.machine-card').first().click();
  await page.waitForSelector('.detail-hero', { timeout: 8000 });
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ════════ 一般模式 ════════
  const N = await openPhone(browser, 'no-preference');
  const p = N.page;
  const shot = (name) => p.screenshot({ path: path.join(SHOTS, name + '.png') });

  await check('載入：ui_fx 有啟動（<html> 有 fx-anim）、回到頂端鈕已裝好', async () => {
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.waitForSelector('.login-wrap');
    const s = await p.evaluate(() => ({
      anim: document.documentElement.classList.contains('fx-anim'),
      fns: ['fxSuccess', 'fxFieldError', 'fxPullToRefresh', 'fxRemoveThen', 'fxSkeletonCards', 'fxCountFrom', 'fxButtonBusy', 'fxMoveSlider']
        .every((f) => typeof window[f] === 'function'),
      top: !!document.querySelector('.fx-top'),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--fx-accent').trim()
    }));
    assert(s.anim && s.fns, 'ui_fx.js 沒有啟動：' + JSON.stringify(s));
    assert(s.top, '應該有回到頂端鈕');
    assert(/^#4F7BE8$/i.test(s.accent), '主色要引用 styles.css 的 --accent，實際 ' + s.accent);
    const css = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ui_fx.css'), 'utf8');
    assert(!/D4A800|FFD700|212\s*,\s*168\s*,\s*0/i.test(css), 'ui_fx.css 不該再有天鷹金');
  });

  await check('漏填標紅（登入）：空白按登入，帳號格紅框＋抖一下＋游標跳過去，不會送到後端', async () => {
    const before = N.apiCalls.length;
    await p.click('button[type="submit"]');
    const u = await p.evaluate(() => {
      const el = document.querySelector('input[autocomplete="username"]'), cs = getComputedStyle(el);
      return { err: el.classList.contains('fx-field-err'), focus: document.activeElement === el, anim: cs.animationName, outline: cs.outlineColor };
    });
    assert(u.err && u.focus, '帳號格應該標紅並取得焦點 ' + JSON.stringify(u));
    assert(u.anim === 'fxShake', '應該抖一下，實際 ' + u.anim);
    assert(u.outline === 'rgb(248, 113, 113)', '紅框要用 --danger，實際 ' + u.outline);
    const t = await p.evaluate(() => ({ cls: document.getElementById('toast').className, text: document.getElementById('toast').textContent }));
    assert(t.cls.includes('error') && t.text === '請輸入帳號', '應該提示「請輸入帳號」，實際 ' + JSON.stringify(t));
    await p.waitForTimeout(120);
    await shot('fx-app-01-login-error');
    await p.fill('input[autocomplete="username"]', 'admin');
    assert(!(await p.evaluate(() => document.querySelector('input[autocomplete="username"]').classList.contains('fx-field-err'))), '開始打字紅框要消失');
    await p.click('button[type="submit"]');
    assert(await p.evaluate(() => document.querySelector('input[type="password"]').classList.contains('fx-field-err')), '換密碼格標紅');
    assert(N.apiCalls.length === before, '漏填時不該呼叫後端');
  });

  await check('按鈕送出中（登入）：按下去按鈕轉圈、變成「登入中…」、不能再按，登入完進首頁', async () => {
    const b = await loginObserved(N);
    assert(b.text.includes('登入中…') && b.disabled && b.spinShown, '登入鈕應該轉圈＋「登入中…」＋不能按，實際 ' + JSON.stringify(b));
  });

  await check('讀取中骨架（開機）：已登入重開 App，「載入中…」直接換成機台卡片形狀的骨架，資料到了卡片依序浮上來', async () => {
    N.delays.homeBootstrap = 1500;
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.fx-sk-view .fx-sk-card', { timeout: 3000 });
    const sk = await p.evaluate(() => ({
      cards: document.querySelectorAll('.fx-sk-view .fx-sk-card').length,
      boot: !!document.querySelector('.boot'),
      shimmer: getComputedStyle(document.querySelector('.fx-sk')).animationName,
      fakeReal: document.querySelectorAll('.machine-card, .summary-strip, .detail-hero').length
    }));
    assert(sk.cards === 3 && !sk.boot, '應該是 3 張骨架、沒有轉圈圈 ' + JSON.stringify(sk));
    assert(sk.shimmer === 'fxShimmer', '骨架要有閃光動畫，實際 ' + sk.shimmer);
    assert(sk.fakeReal === 0, '骨架不能用真畫面的 class（會被當成資料已經到了）');
    await shot('fx-app-02-boot-skeleton');
    await p.waitForSelector('.machine-card', { timeout: 8000 });
    delete N.delays.homeBootstrap;
    const list = await p.evaluate(() => ({
      cls: document.querySelector('.machine-list').className,
      anim: getComputedStyle(document.querySelector('.machine-card')).animationName
    }));
    assert(list.cls.includes('fx-fadein') && list.anim === 'fxRise', '卡片要依序浮上來 ' + JSON.stringify(list));
  });

  await check('數字跳動：第一次出現直接顯示，不會從 0 跳起來', async () => {
    const a = await p.evaluate(() => Array.from(document.querySelectorAll('.summary-strip .stat-value')).map((e) => e.textContent));
    await p.waitForTimeout(150);
    const b = await p.evaluate(() => Array.from(document.querySelectorAll('.summary-strip .stat-value')).map((e) => e.textContent));
    assert(JSON.stringify(a) === JSON.stringify(b), '第一次出現的數字不該在跳：' + JSON.stringify(a) + ' → ' + JSON.stringify(b));
  });

  await check('下拉更新（首頁）：在最上面往下拉，拉過門檻變實心、放開轉圈、重新讀取首頁；不會再跳「處理中…」', async () => {
    await p.waitForTimeout(600);   // 等卡片浮上來的動畫跑完
    N.delays.dashboard = 900;
    const before = N.apiCalls.filter((a) => a === 'dashboard').length;
    await pull(N.cdp, 195, 250, 180, false);
    const ready = await p.evaluate(() => document.querySelector('.fx-ptr').className);
    assert(ready.includes('fx-ready'), '拉過門檻應該是 fx-ready，實際 ' + ready);
    await shot('fx-app-03-pull');
    await N.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(200);
    const busy = await p.evaluate(() => ({ cls: document.querySelector('.fx-ptr').className, badge: !document.getElementById('busy-badge').hidden }));
    assert(busy.cls.includes('fx-busy'), '放開後要轉圈，實際 ' + busy.cls);
    assert(!busy.badge, '下拉更新有自己的轉圈，不該再跳「處理中…」');
    await p.waitForFunction(() => !document.querySelector('.fx-ptr').className.includes('fx-busy'), null, { timeout: 5000 });
    delete N.delays.dashboard;
    assert(N.apiCalls.filter((a) => a === 'dashboard').length === before + 1, '應該重新讀一次首頁資料');
  });

  await check('分頁滑動（首頁 骰台／電子／加總）：藍底從上一顆滑到新的一顆，停下來剛好對齊', async () => {
    const r = await clickTab(p, '.home-sticky .seg', '電子');
    assert(r.moving, '點「電子」之後膠囊要滑過去（要有過場動畫）');
    assert(r.end && r.end.aligned && r.end.active, '膠囊最後要對齊「電子」 ' + JSON.stringify(r.end));
    assert(r.end.sliderBg === 'rgb(79, 123, 232)' && r.end.buttonBg === 'rgba(0, 0, 0, 0)',
      '藍底由膠囊畫（主色），按鈕本身透明 ' + JSON.stringify(r.end));
    const back = await clickTab(p, '.home-sticky .seg', '骰台');
    assert(back.moving && back.end && back.end.aligned, '切回「骰台」也要滑回去 ' + JSON.stringify(back.end));
    await p.waitForSelector('.machine-card');
  });

  await check('首頁標題列陰影：往下捲，固定在上面的標題／今日數字區下緣出現陰影；捲回最上面就消失', async () => {
    await p.setViewportSize({ width: 390, height: 520 });   // 示範資料只有幾台機台，畫面矮一點才捲得動
    await p.evaluate(() => window.scrollTo(0, 160));
    await p.waitForFunction(() => document.documentElement.classList.contains('fx-scrolled'), null, { timeout: 2000 });
    await p.waitForTimeout(250);
    const shadow = await p.evaluate(() => getComputedStyle(document.querySelector('.home-sticky')).boxShadow);
    assert(shadow && shadow !== 'none', '捲動後標題區要有陰影，實際 ' + shadow);
    await shot('fx-app-07-header-shadow');
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForFunction(() => !document.documentElement.classList.contains('fx-scrolled'), null, { timeout: 2000 });
    await p.setViewportSize({ width: 390, height: 844 });
  });

  await check('按鈕漣漪：按住「出幣」會出現漣漪（自動套用，app.js 不用改）', async () => {
    await openFirstMachine(p);
    const btn = p.locator('.action-buttons button:has-text("出幣")');
    const box = await btn.boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    const rip = await btn.evaluate((b) => !!b.querySelector('.fx-rip-wrap .fx-rip'));
    await p.mouse.up();
    assert(rip, '按下去應該出現漣漪');
    await p.waitForSelector('.custom-amount input');
  });

  await check('記帳面板：按「出幣」打開時面板從上面滑下來；之後的重畫不再滑', async () => {
    const a = await p.evaluate(() => { const el = document.querySelector('.panel'); return { cls: el.className, anim: getComputedStyle(el).animationName }; });
    assert(a.cls.includes('fx-panel-in') && a.anim === 'fxPanelIn', '剛打開的面板要滑下來 ' + JSON.stringify(a));
    await p.click('button:has-text("✎ 編輯")');   // 切換編輯模式會重畫
    await p.waitForSelector('button:has-text("完成")');
    assert(!(await p.evaluate(() => document.querySelector('.panel').classList.contains('fx-panel-in'))), '重畫不該再滑一次');
    await p.click('button:has-text("完成")');
    await p.waitForSelector('button:has-text("✎ 編輯")');
  });

  await check('漏填標紅（自訂金額）：沒填金額按送出，那一格標紅，不會送到後端', async () => {
    const before = N.apiCalls.length;
    await p.fill('.custom-amount input', '');
    await p.click('.custom-amount button:has-text("送出")');
    assert(await p.evaluate(() => document.querySelector('.custom-amount input').classList.contains('fx-field-err')), '自訂金額應該標紅');
    assert(N.apiCalls.length === before, '沒填金額不該呼叫後端');
  });

  await check('下拉更新：記帳面板開著時不理（重新整理會把輸入到一半的數字洗掉）', async () => {
    await p.evaluate(() => window.scrollTo(0, 0));
    const before = N.apiCalls.length;
    await pull(N.cdp, 195, 120, 200);
    await p.waitForTimeout(700);
    assert(N.apiCalls.length === before, '面板開著時下拉不該重新讀取');
  });

  // 送一筆出幣，把這一趟看到的都記下來，下面幾個 check 分開驗
  const sent = {};
  await check('送出成功打勾：出幣送出成功，畫面中間畫出綠色打勾，提示訊息滑入', async () => {
    sent.recordsBefore = await p.locator('.record-item').count();
    await startSampling(p, '.net-stat .stat-value');
    N.delays.addRecord = 700;
    await p.fill('.custom-amount input', '50');
    await p.click('.custom-amount button:has-text("送出")');
    sent.button = await p.evaluate(() => {
      const b = document.querySelector('.custom-amount button');
      const sp = b.querySelector('.fx-btn-spin');
      return { text: b.textContent, disabled: b.disabled, spinShown: !!sp && getComputedStyle(sp).display !== 'none' };
    });
    await shot('fx-app-08-button-busy');
    await p.waitForSelector('.fx-success svg', { timeout: 8000 });
    delete N.delays.addRecord;
    const s = await p.evaluate(() => ({
      draw: getComputedStyle(document.querySelector('.fx-success .fx-sc')).animationName,
      stroke: getComputedStyle(document.querySelector('.fx-success .fx-sk2')).stroke
    }));
    assert(s.draw === 'fxDraw' && s.stroke === 'rgb(74, 222, 128)', '要畫出成功綠的打勾 ' + JSON.stringify(s));
    sent.flash = await p.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.record-item'));
      return {
        first: rows[0] && rows[0].className, firstAnim: rows[0] && getComputedStyle(rows[0]).animationName,
        others: rows.slice(1).filter((r) => r.classList.contains('fx-flash')).length
      };
    });
    await p.waitForTimeout(300);
    await shot('fx-app-04-success');
    const t = await p.evaluate(() => {
      const el = document.getElementById('toast');
      return { hidden: el.hidden, cls: el.className, css: getComputedStyle(el).animationName };
    });
    assert(!t.hidden && t.cls.includes('success'), '要顯示成功提示');
    assert(t.css === 'none', 'styles.css 原本的 toast-in 要讓給 ui_fx（不然會滑兩次），實際 ' + t.css);
    await p.waitForFunction((n) => document.querySelectorAll('.record-item').length >= n, sent.recordsBefore, { timeout: 8000 });
    await p.waitForTimeout(700);
    sent.seen = await stopSampling(p);
    await p.waitForFunction(() => !document.querySelector('.fx-success'), null, { timeout: 3000 });
  });

  await check('按鈕送出中（送出）：等後端的時候送出鈕轉圈、變成「送出中…」、不能再按', async () => {
    const b = sent.button || {};
    assert(b.text && b.text.includes('送出中…') && b.disabled && b.spinShown, '實際 ' + JSON.stringify(b));
  });

  await check('新紀錄亮一下：剛送出的那一筆底色亮一下再淡掉，其他筆不亮', async () => {
    const f = sent.flash || {};
    assert(f.first && f.first.includes('fx-flash') && f.firstAnim === 'fxFlash', '最上面剛記的那筆要亮 ' + JSON.stringify(f));
    assert(f.others === 0, '其他筆不該亮，實際 ' + f.others + ' 筆');
  });

  await check('數字跳動（機台頁今日淨收益）：送出後從舊數字一路跳到新數字，最後停在正確的值', async () => {
    const seen = sent.seen || [];
    assert(seen.length >= 3, '應該看到舊值→中間值→新值，實際只看到 ' + JSON.stringify(seen));
    const n = (t) => Number(String(t).replace(/[^0-9.-]/g, ''));
    assert(n(seen[seen.length - 1]) === n(seen[0]) - 50, '出幣 50 之後淨收益應該少 50：' + seen[0] + ' → ' + seen[seen.length - 1]);
  });

  await check('漏填標紅（碼表）：下班表不大於上班表時，下班表那一格標紅；改對了紅框就消失', async () => {
    await p.click('.action-buttons button:has-text("入幣")');
    await p.waitForSelector('.panel-total');
    const start = p.locator('.panel input').nth(0);
    const end = p.locator('.panel input').nth(1);
    if ((await start.inputValue()) === '') await start.fill('100');
    const sv = Number(await start.inputValue());
    await end.fill(String(sv));
    assert(await end.evaluate((el) => el.classList.contains('fx-field-err')), '下班表＝上班表時要標紅');
    await end.fill(String(sv + 3));
    assert(!(await end.evaluate((el) => el.classList.contains('fx-field-err'))), '改對了紅框要消失');
    await p.click('.action-buttons button:has-text("入幣")');   // 收起面板
  });

  await check('刪除收合：按 ✕ 作廢，那一筆先往左滑出收起來，再重畫', async () => {
    await p.waitForFunction(() => document.querySelectorAll('.record-item').length >= 2, null, { timeout: 5000 });
    const before = await p.locator('.record-item').count();
    await p.locator('.record-item').nth(1).locator('button[title="作廢"]').click();
    await p.waitForFunction(() => {
      const r = document.querySelectorAll('.record-item')[1];
      return !!r && r.getAnimations().some((a) => a.constructor.name === 'Animation');
    }, null, { timeout: 8000 });
    await p.waitForTimeout(150);
    await shot('fx-app-05-void');
    await p.waitForFunction((n) => document.querySelectorAll('.record-item').length === n - 1, before, { timeout: 8000 });
  });

  await check('讀取中骨架（機台頁、報表）：沒有快取時先畫骨架（返回鈕照樣能按），資料到了再換上', async () => {
    await p.evaluate(() => { state.cache = {}; });
    // 回首頁會觸發背景預取（一次抓全部機台），先把它拖慢，不然它可能搶先把快取補好、就看不到骨架了
    N.delays.allMachineDetails = 4000;
    await p.click('button:has-text("← 返回主畫面")');
    await p.waitForSelector('.machine-card');
    N.delays.machineDetail = 1200;
    await p.locator('.machine-card').first().click();
    await p.waitForSelector('.fx-sk-view', { timeout: 3000 });
    assert(await p.locator('.detail-hero').count() === 0, '骨架不能冒充 .detail-hero');
    assert(await p.locator('.navbar button:has-text("← 返回主畫面")').count() === 1, '讀取中返回鈕要照樣在');
    await p.waitForSelector('.detail-hero', { timeout: 8000 });
    delete N.delays.machineDetail;
    assert((await p.getAttribute('.record-list', 'class')).includes('fx-fadein'), '紀錄要依序浮上來');

    N.delays.report = 1200;
    await p.click('button:has-text("📊 查詢報表")');
    await p.waitForSelector('.fx-sk-view', { timeout: 3000 });
    assert(await p.locator('.report-stats').count() === 0, '骨架不能冒充 .report-stats');
    await shot('fx-app-06-report-skeleton');
    await p.waitForSelector('.report-stats', { timeout: 8000 });
    delete N.delays.report;
    delete N.delays.allMachineDetails;
  });

  // 等長條用 state:'attached'：沒有紀錄的日子長條高度是 0，Playwright 會把它當成「看不見」一直等下去
  await check('報表長條圖：資料到了長條從中間的零線長出來', async () => {
    await p.waitForSelector('.chart rect', { state: 'attached' });
    const c = await p.evaluate(() => {
      const svg = document.querySelector('.chart');
      const bar = svg.querySelector('rect.bar-pos, rect.bar-neg');
      return { cls: svg.getAttribute('class'), anim: bar && getComputedStyle(bar).animationName };
    });
    assert(c.cls.includes('fx-grow') && c.anim === 'fxBarGrow', '長條要長出來 ' + JSON.stringify(c));
  });

  await check('分頁滑動（報表 今日／本週…）＋ 換區間後長條重新長出來', async () => {
    N.delays.report = 600;
    const r = await clickTab(p, '.seg', '本週');
    assert(r.moving && r.end && r.end.aligned, '膠囊要從「今日」滑到「本週」 ' + JSON.stringify(r.end));
    await shot('fx-app-09-report-tabs');
    await p.waitForSelector('.chart rect', { state: 'attached', timeout: 8000 });
    delete N.delays.report;
    await p.waitForTimeout(80);
    await shot('fx-app-10-chart');
    assert((await p.getAttribute('.chart', 'class')).includes('fx-grow'), '換區間、資料變了，長條要重新長出來');
  });

  await check('對話框：打開有滑入動畫；漏填帳號／密碼太短會標紅、不送出；取消有淡出', async () => {
    await p.click('button:has-text("← 返回")');
    await p.waitForSelector('.detail-hero, .machine-card');
    if (await p.locator('.detail-hero').count()) await p.click('button:has-text("← 返回主畫面")');
    await p.waitForSelector('.machine-card');
    await p.click('button:has-text("⚙ 系統管理")');
    await p.waitForSelector('.tabs');
    await p.click('button:has-text("＋ 新增帳號")');
    await p.waitForSelector('.dialog');
    const anims = await p.evaluate(() => document.querySelector('.dialog').getAnimations().length);
    assert(anims > 0, '對話框打開要有滑入動畫');
    const before = N.apiCalls.length;
    await p.click('.dialog-actions button:has-text("儲存")');
    const inputs = p.locator('.dialog input');
    assert(await inputs.nth(0).evaluate((el) => el.classList.contains('fx-field-err')), '沒填帳號要標紅帳號格');
    await inputs.nth(0).fill('fx_test');
    await p.locator('.dialog input[autocomplete="new-password"]').fill('123');
    await p.click('.dialog-actions button:has-text("儲存")');
    assert(await p.locator('.dialog input[autocomplete="new-password"]').evaluate((el) => el.classList.contains('fx-field-err')), '密碼太短要標紅密碼格');
    assert(N.apiCalls.length === before, '填錯時不該送到後端');
    await watchGhost(p);
    await p.click('.dialog-actions button:has-text("取消")');
    await p.waitForFunction(() => window.__fxGhostSeen === true, null, { timeout: 2000 });
    await p.waitForFunction(() => !document.querySelector('.fx-ghost') && !document.getElementById('dialog-backdrop'), null, { timeout: 2000 });
  });

  await check('分頁滑動（系統管理 帳號／機台／獎型／台主授權）：膠囊從沒選中的分頁上面滑過去', async () => {
    const r = await clickTab(p, '.tabs', '機台');
    assert(r.moving && r.end && r.end.aligned && r.end.active, '膠囊要滑到「機台」 ' + JSON.stringify(r.end));
    const inactiveBg = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.tabs button')).find((x) => !x.classList.contains('active'));
      return getComputedStyle(b, '::before').backgroundColor;
    });
    assert(inactiveBg === 'rgb(27, 34, 51)', '沒選中的分頁底色要跟原本一樣（--surface-2），實際 ' + inactiveBg);
  });

  await check('離線提示條：斷線時滑下來；恢復連線時滑回去，並跳「已恢復連線」', async () => {
    await N.context.setOffline(true);
    await p.waitForFunction(() => !document.getElementById('offline-bar').hidden, null, { timeout: 3000 });
    const inAnim = await p.evaluate(() => document.getElementById('offline-bar').getAnimations().length);
    assert(inAnim > 0, '離線提示條要滑下來');
    await p.waitForTimeout(350);
    await shot('fx-app-11-offline');
    await N.context.setOffline(false);
    await p.waitForFunction(() => document.getElementById('toast').textContent === '已恢復連線', null, { timeout: 3000 });
    const outAnim = await p.evaluate(() => document.getElementById('offline-bar').getAnimations().length);
    assert(outAnim > 0, '恢復連線時提示條要滑回去');
    await p.waitForFunction(() => document.getElementById('offline-bar').hidden, null, { timeout: 3000 });
  });

  await check('一般模式全程沒有 console 錯誤', async () => {
    assert(N.errors.length === 0, N.errors.slice(0, 3).join(' | '));
  });
  await N.context.close();

  // ════════ 手機開了「減少動態效果」 ════════
  const R = await openPhone(browser, 'reduce');
  const q = R.page;

  await check('減少動態效果：漏填照樣紅框＋游標跳過去，但不抖', async () => {
    await q.goto(BASE, { waitUntil: 'networkidle' });
    await q.waitForSelector('.login-wrap form');
    assert(await q.evaluate(() => window.fxReduced()) === true, '要偵測得到減少動態效果');
    await q.click('button[type="submit"]');
    const u = await q.evaluate(() => {
      const el = document.querySelector('input[autocomplete="username"]');
      return { err: el.classList.contains('fx-field-err'), focus: document.activeElement === el, anim: getComputedStyle(el).animationName };
    });
    assert(u.err && u.focus && u.anim === 'none', '紅框、焦點照樣有，但不抖 ' + JSON.stringify(u));
  });

  await check('減少動態效果：登入鈕照樣顯示「登入中…」、不能再按，但不轉圈', async () => {
    const b = await loginObserved(R);
    assert(b.text.includes('登入中…') && b.disabled && b.spin && !b.spinShown, '實際 ' + JSON.stringify(b));
  });

  await check('減少動態效果：開機骨架照樣有（它不是動畫），但不閃、卡片不浮現', async () => {
    R.delays.homeBootstrap = 1200;
    await q.reload({ waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.fx-sk-view .fx-sk-card', { timeout: 3000 });
    assert(await q.evaluate(() => getComputedStyle(document.querySelector('.fx-sk')).animationName) === 'none', '骨架不該閃');
    await q.waitForSelector('.machine-card', { timeout: 8000 });
    delete R.delays.homeBootstrap;
    assert(await q.evaluate(() => getComputedStyle(document.querySelector('.machine-card')).animationName) === 'none', '卡片不該浮現');
  });

  await check('減少動態效果：下拉更新這個功能照樣能用', async () => {
    const before = R.apiCalls.filter((a) => a === 'dashboard').length;
    await pull(R.cdp, 195, 250, 180);
    await q.waitForFunction(() => !document.querySelector('.fx-ptr').className.includes('fx-busy'), null, { timeout: 5000 });
    await q.waitForTimeout(300);
    assert(R.apiCalls.filter((a) => a === 'dashboard').length === before + 1, '應該重新讀一次首頁資料');
  });

  await check('減少動態效果：分頁膠囊直接跳到新的一顆，不滑', async () => {
    const r = await clickTab(q, '.home-sticky .seg', '電子');
    assert(!r.moving, '不該有滑動的過場');
    assert(r.end && r.end.aligned && r.end.active, '膠囊照樣要停在「電子」 ' + JSON.stringify(r.end));
    await clickTab(q, '.home-sticky .seg', '骰台');
    await q.waitForSelector('.machine-card');
  });

  await check('減少動態效果：沒有漣漪、面板不滑、沒有打勾、提示不滑入、數字不跳、新紀錄不亮，但送出本身照常', async () => {
    await openFirstMachine(q);
    const btn = q.locator('.action-buttons button:has-text("出幣")');
    const box = await btn.boundingBox();
    await q.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await q.mouse.down();
    const rip = await btn.evaluate((b) => !!b.querySelector('.fx-rip'));
    await q.mouse.up();
    assert(!rip, '不該有漣漪');
    await q.waitForSelector('.custom-amount input');
    assert(await q.evaluate(() => getComputedStyle(document.querySelector('.panel')).animationName) === 'none', '面板不該滑');
    const recordsBefore = await q.locator('.record-item').count();
    await startSampling(q, '.net-stat .stat-value');
    await q.fill('.custom-amount input', '30');
    await q.click('.custom-amount button:has-text("送出")');
    await q.waitForFunction((n) => document.querySelectorAll('.record-item').length > n || !!document.querySelector('.record-item.fx-flash'), recordsBefore, { timeout: 8000 });
    await q.waitForTimeout(700);
    const seen = await stopSampling(q);
    const s = await q.evaluate(() => {
      const first = document.querySelector('.record-item');
      return {
        success: !!document.querySelector('.fx-success'),
        toastAnims: document.getElementById('toast').getAnimations().length,
        toastHidden: document.getElementById('toast').hidden,
        flashAnim: first ? getComputedStyle(first).animationName : ''
      };
    });
    assert(!s.success, '不該畫打勾');
    assert(!s.toastHidden && s.toastAnims === 0, '提示照樣出現但不滑入 ' + JSON.stringify(s));
    assert(s.flashAnim === 'none', '新紀錄不該亮，實際 ' + s.flashAnim);
    assert(seen.length <= 2, '數字不該跳，應該直接從舊值變新值，實際 ' + JSON.stringify(seen));
    await q.click('.action-buttons button:has-text("出幣")');   // 收起面板
  });

  await check('減少動態效果：作廢直接重畫，不播收合', async () => {
    const before = await q.locator('.record-item').count();
    assert(before >= 2, '至少要有兩筆紀錄');
    await q.locator('.record-item').nth(1).locator('button[title="作廢"]').click();
    let sawAnim = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      const st = await q.evaluate(() => ({
        anims: Array.from(document.querySelectorAll('.record-item')).reduce((n, r) => n + r.getAnimations().length, 0),
        n: document.querySelectorAll('.record-item').length
      }));
      if (st.anims) sawAnim = true;
      if (st.n === before - 1) break;
      await q.waitForTimeout(30);
    }
    assert(!sawAnim, '不該有收合動畫');
    assert(await q.locator('.record-item').count() === before - 1, '作廢本身要照常');
  });

  await check('減少動態效果：報表長條圖不長動畫', async () => {
    await q.click('button:has-text("📊 查詢報表")');
    await q.waitForSelector('.chart rect', { state: 'attached', timeout: 8000 });
    const anim = await q.evaluate(() => getComputedStyle(document.querySelector('.chart rect.bar-pos, .chart rect.bar-neg')).animationName);
    assert(anim === 'none', '不該有長條動畫，實際 ' + anim);
    await q.click('button:has-text("← 返回")');
    await q.waitForSelector('.detail-hero');
  });

  await check('減少動態效果：對話框不滑入、關掉也不淡出', async () => {
    await q.click('button:has-text("← 返回主畫面")');
    await q.waitForSelector('.machine-card');
    await q.click('button:has-text("⚙ 系統管理")');
    await q.waitForSelector('.tabs');
    await q.click('button:has-text("＋ 新增帳號")');
    await q.waitForSelector('.dialog');
    const d = await q.evaluate(() => ({ anims: document.querySelector('.dialog').getAnimations().length, css: getComputedStyle(document.querySelector('.dialog')).animationName }));
    assert(d.anims === 0 && d.css === 'none', '對話框不該有動畫 ' + JSON.stringify(d));
    await watchGhost(q);
    await q.click('.dialog-actions button:has-text("取消")');
    await q.waitForTimeout(400);
    assert(await q.evaluate(() => window.__fxGhostSeen) === false, '關掉不該有淡出的複本');
    assert(await q.locator('#dialog-backdrop').count() === 0, '對話框要關掉');
  });

  await check('減少動態效果：離線提示條直接出現／消失（不滑），恢復時照樣跳「已恢復連線」', async () => {
    await R.context.setOffline(true);
    await q.waitForFunction(() => !document.getElementById('offline-bar').hidden, null, { timeout: 3000 });
    assert(await q.evaluate(() => document.getElementById('offline-bar').getAnimations().length) === 0, '不該滑下來');
    await R.context.setOffline(false);
    await q.waitForFunction(() => document.getElementById('toast').textContent === '已恢復連線', null, { timeout: 3000 });
    assert(await q.evaluate(() => document.getElementById('offline-bar').hidden), '恢復連線要直接收起來');
  });

  await check('減少動態效果全程沒有 console 錯誤', async () => {
    assert(R.errors.length === 0, R.errors.slice(0, 3).join(' | '));
  });
  await R.context.close();
  await browser.close();

  const failed = results.filter((r) => r.indexOf('❌') >= 0);
  console.log('動態效果 E2E 結果：' + (results.length - failed.length) + ' / ' + results.length + ' 通過（截圖在 ' + SHOTS + '）');
  console.log(results.join('\n'));
  console.log(failed.length ? '\n⚠️ 有項目未通過。' : '\n🎉 全部通過。');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E 執行失敗：', err);
  process.exit(1);
});
