/**
 * tools/e2e-fx.js — 動態效果（docs/ui_fx.css／ui_fx.js）的瀏覽器測試
 *
 *   node tools/dev-server.js &
 *   node tools/e2e-fx.js
 *
 * 在真正的 App 上驗：讀取中骨架、送出成功打勾、漏填標紅、下拉更新、刪除收合，
 * 以及自動生效的按鈕漣漪、對話框／提示訊息進出場。
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
  const delays = {};   // action → 延遲毫秒，用來把「讀取中」拉長到看得到
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

async function login(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.login-wrap form');
  await page.fill('input[autocomplete="username"]', 'admin');
  await page.fill('input[type="password"]', 'admin123');
  await page.check('.checkbox input');   // 記住我：之後 reload 才會直接進首頁（測開機骨架用）
  await page.click('button[type="submit"]');
  await page.waitForSelector('.machine-card', { timeout: 8000 });
}

/** 對話框關掉時的淡出複本（.fx-ghost）只存在 0.2 秒：點之前先裝好觀察器，出現過就記下來。 */
async function watchGhost(page) {
  await page.evaluate(() => {
    window.__fxGhostSeen = false;
    new MutationObserver(() => { if (document.querySelector('.fx-ghost')) window.__fxGhostSeen = true; })
      .observe(document.body, { childList: true, subtree: true });
  });
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
      fns: ['fxSuccess', 'fxFieldError', 'fxPullToRefresh', 'fxRemoveThen', 'fxSkeletonCards'].every((f) => typeof window[f] === 'function'),
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

  await check('登入後進首頁', async () => { await login(p); });

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

  await check('送出成功打勾：出幣送出成功，畫面中間畫出綠色打勾，提示訊息滑入', async () => {
    const recordsBefore = await p.locator('.record-item').count();
    await p.fill('.custom-amount input', '50');
    await p.click('.custom-amount button:has-text("送出")');
    await p.waitForSelector('.fx-success svg', { timeout: 8000 });
    const s = await p.evaluate(() => ({
      draw: getComputedStyle(document.querySelector('.fx-success .fx-sc')).animationName,
      stroke: getComputedStyle(document.querySelector('.fx-success .fx-sk2')).stroke
    }));
    assert(s.draw === 'fxDraw' && s.stroke === 'rgb(74, 222, 128)', '要畫出成功綠的打勾 ' + JSON.stringify(s));
    await p.waitForTimeout(400);
    await shot('fx-app-04-success');
    const t = await p.evaluate(() => {
      const el = document.getElementById('toast');
      return { hidden: el.hidden, cls: el.className, anims: el.getAnimations().length, css: getComputedStyle(el).animationName };
    });
    assert(!t.hidden && t.cls.includes('success'), '要顯示成功提示');
    assert(t.css === 'none', 'styles.css 原本的 toast-in 要讓給 ui_fx（不然會滑兩次），實際 ' + t.css);
    await p.waitForFunction((n) => document.querySelectorAll('.record-item').length > n, recordsBefore, { timeout: 8000 });
    await p.waitForFunction(() => !document.querySelector('.fx-success'), null, { timeout: 3000 });
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
      return !!r && r.getAnimations().length > 0;
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
    await login(q);
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

  await check('減少動態效果：沒有漣漪、沒有打勾、提示訊息不滑入，但送出本身照常', async () => {
    await openFirstMachine(q);
    const btn = q.locator('.action-buttons button:has-text("出幣")');
    const box = await btn.boundingBox();
    await q.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await q.mouse.down();
    const rip = await btn.evaluate((b) => !!b.querySelector('.fx-rip'));
    await q.mouse.up();
    assert(!rip, '不該有漣漪');
    await q.waitForSelector('.custom-amount input');
    const recordsBefore = await q.locator('.record-item').count();
    await q.fill('.custom-amount input', '30');
    await q.click('.custom-amount button:has-text("送出")');
    await q.waitForFunction((n) => document.querySelectorAll('.record-item').length > n, recordsBefore, { timeout: 8000 });
    const s = await q.evaluate(() => ({ success: !!document.querySelector('.fx-success'), anims: document.getElementById('toast').getAnimations().length, hidden: document.getElementById('toast').hidden }));
    assert(!s.success, '不該畫打勾');
    assert(!s.hidden && s.anims === 0, '提示照樣出現但不滑入 ' + JSON.stringify(s));
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
