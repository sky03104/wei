/**
 * tools/e2e.js — 用真的瀏覽器操作前端
 *
 *   node tools/dev-server.js &
 *   node tools/e2e.js
 *
 * 走完三種角色的主要流程，順便把每個畫面截圖下來。
 * 任何 console 錯誤或未攔截的例外都會讓測試失敗 —— 前端的破圖多半先在這裡出現。
 */

'use strict';

const path = require('path');
const { chromium } = require(process.env.PW_PATH || '/opt/node22/lib/node_modules/playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const SHOTS = process.env.SHOT_DIR || '/tmp/shots';

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push('  ✅ ' + name); })
    .catch((err) => { results.push('  ❌ ' + name + ' → ' + err.message); });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '斷言失敗');
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },   // iPhone 直式
    deviceScaleFactor: 2,
    locale: 'zh-TW'
  });

  const consoleErrors = [];
  let offlineOnPurpose = false;   // 離線測試期間的網路錯誤是預期中的，不算數
  context.on('page', (p) => {
    p.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (offlineOnPurpose) return;
      consoleErrors.push(m.text());
    });
    p.on('pageerror', (e) => { consoleErrors.push('pageerror: ' + e.message); });
  });

  const page = await context.newPage();
  // 有幾個動作（作廢、刪除快捷鍵/獎型、改回沿用全局）會跳原生 confirm()；
  // Playwright 預設是自動按「取消」，這裡改成自動按「確定」，
  // 因為測試點下去的意思本來就是「要繼續」。
  page.on('dialog', (d) => d.accept());
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });

  async function login(username, password, remember) {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('form');
    await page.fill('input[autocomplete="username"]', username);
    await page.fill('input[type="password"]', password);
    if (remember) await page.check('.checkbox input');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.machine-card, .card.empty', { timeout: 8000 });
  }

  async function logout() {
    await page.click('button:has-text("登出")');
    await page.waitForSelector('form', { timeout: 8000 });
  }

  // ── 管理員 ──
  await check('登入頁可以正常開啟並登入', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.login-wrap');
    assert(await page.locator('.pixel-machine').count() > 0, '登入頁應該有像素娃娃機');
    assert(await page.locator('.checkbox input').count() === 1, '應該有記住我勾選框');
    assert(!(await page.locator('#update-bar').isVisible()), '首次載入不該跳出「有新版本」提示');
    assert(!(await page.locator('#offline-bar').isVisible()), '連線正常時不該顯示離線提示');
    assert(/^v\d+$/.test((await page.locator('.login-wrap').textContent()).match(/v\d+/)?.[0] || ''),
      '登入頁應該顯示版本號（例如 v6），方便確認手機上是不是最新版');
    await shot('01-login');

    // 登入當下就掛上監聽，才不會錯過登入完成那一刻馬上觸發的背景預取——
    // 這個監聽故意留到下一個 check 才拆掉，給背景預取一點時間真的跑完。
    let machineDetailCalls = 0;
    const trackPrefetch = (req) => {
      if (req.url().includes('/api') && req.method() === 'POST') {
        const body = decodeURIComponent(req.postData() || '');
        if (body.includes('"action":"machineDetail"')) machineDetailCalls++;
      }
    };
    page.on('request', trackPrefetch);
    page.__machineDetailCallCounter = () => machineDetailCalls;

    await login('admin', 'admin123', true);
  });

  await check('登入後背景會先把全部機台的詳細資料抓好，不用等進去才抓', async () => {
    await page.waitForTimeout(1200); // 給背景預取一點時間跑完（3 台機台，併發 3，應該很快）
    const count = page.__machineDetailCallCounter();
    page.removeAllListeners('request');
    assert(count === 3, '應該背景打 3 次 machineDetail（對應 3 台機台），實際 ' + count);
  });

  await check('管理員首頁看得到全部 3 台機台', async () => {
    const n = await page.locator('.machine-card').count();
    assert(n === 3, '應有 3 台，實際 ' + n);
    assert(await page.locator('button:has-text("⚙ 系統管理")').count() === 1, '管理員應該看得到系統管理入口');
    await shot('02-home-admin');
  });

  await check('進入機台詳細頁，三顆記帳按鈕都在', async () => {
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
    for (const label of ['入幣', '出幣', '🎁 開獎']) {
      assert(await page.locator('.action-buttons button:has-text("' + label + '")').count() === 1, '缺少按鈕：' + label);
    }
    await shot('03-machine-detail');
  });

  // 開發伺服器是長駐的，一號機的示範資料本來就已經有一筆入幣了
  // （上班表會自動帶入，不是空的）；之後每跑一次這支 E2E 又會再疊加一筆。
  // 所以這裡一律讀「畫面當下實際帶入的值」往下接著記，不假設它是全新機台，
  // 也不寫死絕對值，只驗證差額與試算邏輯本身對不對。
  let lastMeterEnd = null;

  await check('入幣改用碼表登錄：(下班表－上班表)×費率，數字即時變動', async () => {
    await page.click('.action-buttons button:has-text("入幣")');
    await page.waitForSelector('.panel');
    await shot('04-panel-in');

    // 入幣不該再看到舊版的快捷金額格子
    assert(await page.locator('.quick-grid').count() === 0, '入幣面板不該再有快捷金額按鈕');

    const startInput = page.locator('.panel input').nth(0);
    const endInput = page.locator('.panel input').nth(1);
    const submitBtn = page.locator('.panel-total button:has-text("送出")');

    const prefilled = await startInput.inputValue();
    assert(await submitBtn.isDisabled(), '還沒填下班表之前送出鈕應該是不能按的');

    const start = prefilled === '' ? 0 : Number(prefilled);
    const end = start + 10;
    if (prefilled === '') await startInput.fill(String(start));
    await endInput.fill(String(end));
    await page.waitForTimeout(100);

    const preview = await page.locator('.panel-total .amount').textContent();
    assert(preview.replace(/[^0-9]/g, '') === '1000', '預設費率 100，差 10 格應該是 1000，實際 ' + preview);

    const before = await page.locator('.net-stat .stat-value').textContent();
    await submitBtn.click();
    await page.waitForFunction(
      (prev) => document.querySelector('.net-stat .stat-value').textContent !== prev,
      before, { timeout: 8000 }
    );
    assert(await page.locator('.record-item:has-text("上班表")').count() > 0, '紀錄清單應該顯示上班表/下班表明細');
    lastMeterEnd = end;
  });

  await check('入幣：下班表不能小於等於上班表', async () => {
    const startInput = page.locator('.panel input').nth(0);
    const endInput = page.locator('.panel input').nth(1);
    const submitBtn = page.locator('.panel-total button:has-text("送出")');

    await startInput.fill(String(lastMeterEnd));
    await endInput.fill(String(lastMeterEnd));
    await page.waitForTimeout(100);
    assert(await submitBtn.isDisabled(), '下班表等於上班表時不該能送出');
    assert(await page.locator('text=下班表必須大於上班表').count() > 0, '應該顯示錯誤提示');

    await endInput.fill(String(lastMeterEnd - 500));
    await page.waitForTimeout(100);
    assert(await submitBtn.isDisabled(), '下班表小於上班表時不該能送出');
  });

  await check('入幣：送出後上班表會自動帶入剛剛的下班表', async () => {
    // 上一個測試結束時輸入框裡還留著沒送出的無效值，重新關開面板，
    // 確認 detail 資料裡的 lastMeterReading（第一個測試送出的那筆）正確反映到畫面。
    await page.click('.action-buttons button:has-text("入幣")'); // 關
    await page.click('.action-buttons button:has-text("入幣")'); // 開
    await page.waitForSelector('.panel');
    const startVal = await page.locator('.panel input').nth(0).inputValue();
    assert(startVal === String(lastMeterEnd), '上班表應該自動帶入上一筆的下班表 ' + lastMeterEnd + '，實際 ' + startVal);
  });

  await check('入幣費率：管理員可以改成本台自訂、儲存新費率、改回沿用全局', async () => {
    // 用另一台乾淨的機台，不影響前面幾個測試已經在算的一號機。
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await page.locator('.machine-card').nth(2).click();
    await page.waitForSelector('.detail-hero');

    await page.click('.action-buttons button:has-text("入幣")');
    await page.waitForSelector('.panel');
    await page.click('.panel-head button:has-text("✎ 編輯")');
    await page.waitForSelector('.meter-rate-panel');
    assert(await page.locator('text=每格 $100（全局）').count() > 0, '一開始應該沿用全局費率 100');

    await page.click('button:has-text("改成本台自訂")');
    await page.waitForFunction(() => document.body.textContent.includes('目前是本台專屬設定'), { timeout: 8000 });

    await page.fill('.meter-rate-panel input', '250');
    await page.click('.meter-rate-panel button:has-text("儲存")');
    await page.waitForFunction(() => document.body.textContent.includes('每格 $250（本台自訂）'), { timeout: 8000 });

    await page.click('.panel-head button:has-text("完成")');
    await page.waitForSelector('.panel');
    await page.fill('.panel input >> nth=0', '0');
    await page.fill('.panel input >> nth=1', '10');
    await page.waitForTimeout(100);
    const preview = await page.locator('.panel-total .amount').textContent();
    assert(preview.replace(/[^0-9]/g, '') === '2500', '改成本台自訂費率 250 後，(10-0)×250 應該是 2500，實際 ' + preview);

    await page.click('.panel-head button:has-text("✎ 編輯")');
    await page.waitForSelector('.meter-rate-panel');
    await page.click('button:has-text("改回沿用全局")');
    await page.waitForFunction(() => document.body.textContent.includes('每格 $100（全局）'), { timeout: 8000 });

    await page.click('.panel-head button:has-text("完成")');
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
  });

  await check('首頁大額負淨收益不會被拆成兩行，也不會把頁面撐到橫向捲動', async () => {
    // 「-」是合法的斷行點，數字一長、欄位一窄，瀏覽器就會把負號自己斷成一行，
    // 上面孤零零一個「-」、下面接著 $30,230，看起來像壞掉。這裡記一筆很大的
    // 出幣重現這個情境，確認淨收益數字仍是單行、且沒有撐爆整個頁面版面。
    //
    // 收尾要回到機台詳細頁：後面的測試（開獎面板等）都預期還停在這一頁。
    await page.click('.action-buttons button:has-text("出幣")');
    await page.waitForSelector('.custom-amount input');
    await page.fill('.custom-amount input', '31000');
    await page.click('.custom-amount button:has-text("送出")');
    await page.waitForSelector('.record-item', { timeout: 8000 });

    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.summary-strip');

    await page.waitForFunction(() => {
      const stats = document.querySelectorAll('.summary-strip .stat');
      const el = stats[3] && stats[3].querySelector('.stat-value');
      return !!el && el.textContent.indexOf('$') >= 0;
    }, null, { timeout: 8000 });

    const netBox = page.locator('.summary-strip .stat').nth(3).locator('.stat-value');
    const height = (await netBox.boundingBox()).height;
    assert(height <= 26, '淨收益數字的高度看起來像被拆成兩行了：' + height + 'px');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 2, '頁面被數字撐出橫向捲動了，溢出 ' + overflow + 'px');

    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
  });

  await check('首頁的標題列與今日數字固定在畫面上方，不會跟著機台清單捲動', async () => {
    // 不在這裡多加測試機台——後面「巡邏人員應看得到 3 台」那個斷言
    // 假設機台總數固定是 3，加了會把那個測試弄壞。直接驗 CSS 本身的
    // sticky 設定就夠了，實際捲動的視覺效果已經用截圖人工核對過。
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.home-sticky');
    const style = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.home-sticky'));
      return { position: cs.position, top: cs.top };
    });
    assert(style.position === 'sticky', '.home-sticky 應該是 position:sticky，實際 ' + style.position);
    assert(style.top === '0px', '.home-sticky 應該貼齊視窗頂端（top:0），實際 ' + style.top);

    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
  });

  // 開發伺服器是長駐的，資料會一直累積，所以一律驗「差額」而不是絕對值
  const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
  const statValue = async (label) => {
    const all = await page.locator('.figures-panel .stat').allTextContents();
    return num(all.find((t) => t.indexOf(label) >= 0));
  };
  let prizeBefore = 0;

  await check('開獎面板可以一次登錄多個獎型，合計正確', async () => {
    prizeBefore = await statValue('今日開獎');
    await page.click('.action-buttons button:has-text("開獎")');
    await page.waitForSelector('.prize-row');
    const rows = await page.locator('.prize-row').count();
    assert(rows === 3, '應有 3 個預設獎型，實際 ' + rows);

    // 大娃 $150 ×1、小娃 $40 ×2 → 合計 $230
    await page.locator('.prize-row').nth(0).locator('button:has-text("＋")').click();
    await page.locator('.prize-row').nth(2).locator('button:has-text("＋")').click();
    await page.locator('.prize-row').nth(2).locator('button:has-text("＋")').click();

    const total = await page.locator('.panel-total .amount').textContent();
    assert(total.replace(/[^0-9]/g, '') === '230', '合計應為 230，實際 ' + total);
    await shot('05-panel-prize');

    await page.click('.panel-total button:has-text("送出")');
    await page.waitForSelector('.record-item .badge-prize', { timeout: 8000 });
    await shot('06-after-prize');
  });

  await check('開獎確實被當成本扣掉淨收益', async () => {
    const prizeAfter = await statValue('今日開獎');
    assert(prizeAfter - prizeBefore === 230,
      '今日開獎應增加 230，實際從 ' + prizeBefore + ' 變成 ' + prizeAfter);

    const net = num(await page.locator('.net-stat .stat-value').textContent());
    const inAmt = await statValue('今日入幣');
    const outAmt = await statValue('今日出幣');
    assert(net === inAmt - outAmt - prizeAfter,
      '淨收益應等於 入−出−開獎：' + net + ' vs ' + inAmt + '−' + outAmt + '−' + prizeAfter);
  });

  await check('報表頁可以切換區間並顯示獎型統計', async () => {
    await page.click('button:has-text("📊 查詢報表")');
    await page.waitForSelector('.report-stats');
    assert(await page.locator('.chart').count() === 1, '應該有趨勢圖');
    assert(await page.locator('text=獎型統計').count() === 1, '應該有獎型統計');
    await shot('07-report');

    await page.click('.seg button:has-text("本月")');
    await page.waitForSelector('.report-stats');
    await page.click('.seg button:has-text("自訂")');
    await page.waitForSelector('input[type="date"]');
    await shot('08-report-custom');
  });

  await check('背景預取：登入後就先把全部機台抓好，第一次進哪一台都秒開', async () => {
    await page.click('button:has-text("← 返回")');
    await page.waitForSelector('.detail-hero');
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');

    const cards = page.locator('.machine-card');
    const firstName = await cards.nth(0).locator('.name').textContent();
    const secondName = await cards.nth(1).locator('.name').textContent();

    // 登入的時候（本測試最前面）背景就該把全部機台的詳細資料預先抓好、
    // 存進快取，所以「第一次」點進第 2 台這種前面測試從沒碰過的機台，
    // 現在也該直接秒開，不會再看到轉圈圈——這是跟舊版行為的關鍵差異，
    // 專門測這一點才不會讓 prefetchMachineDetails 悄悄退化回原本要等的樣子。
    await cards.nth(1).click();
    assert((await page.locator('.boot').count()) === 0, '背景已經預取過，第一次進這台機台也該直接秒開，不該看到轉圈圈');
    assert((await page.locator('.detail-hero h2').textContent()) === secondName, '應該顯示第 2 台機台的資料');

    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');

    // 回訪第 1 台機台（前面測試已經進去看過）：一樣該秒開。
    await cards.nth(0).click();
    assert((await page.locator('.detail-hero').count()) > 0, '回訪已經看過的機台應該直接秒開，不該再看到轉圈圈');
    assert((await page.locator('.detail-hero h2').textContent()) === firstName, '秒開當下顯示的就該是正確的機台名稱');
  });

  await check('系統管理頁四個分頁都打得開，且第一次進頁面只打 1 次 API', async () => {
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');

    // goAdmin() 第一次進頁面：改成呼叫合併過的 adminBootstrap，
    // 應該只送出 1 個 /api 請求，不是原本分開的 4 個。
    let apiCalls = 0;
    const onRequest = (req) => { if (req.url().includes('/api')) apiCalls++; };
    page.on('request', onRequest);
    await page.click('button:has-text("⚙ 系統管理")');
    await page.waitForSelector('.admin-item');
    page.off('request', onRequest);
    assert(apiCalls === 1, '第一次進系統管理頁應該只打 1 次 API（adminBootstrap），實際打了 ' + apiCalls + ' 次');

    await shot('09-admin-users');

    for (const [tab, marker] of [['機台', '.admin-item'], ['獎型', '.admin-item'], ['台主授權', '.perm-note']]) {
      await page.click('.tabs button:has-text("' + tab + '")');
      await page.waitForSelector(marker, { timeout: 8000 });
    }
    await shot('10-admin-perms');
  });

  await check('系統管理頁切換分頁不會重打 API（純前端切換，秒開）', async () => {
    // goAdmin() 進頁面時已經一次把四個分頁的資料都抓回來放在 state.admin，
    // 切分頁只是換一下要渲染哪一段，不該再發任何網路請求。
    let apiCalls = 0;
    const onRequest = (req) => { if (req.url().includes('/api')) apiCalls++; };
    page.on('request', onRequest);

    await page.click('.tabs button:has-text("帳號")');
    await page.waitForSelector('.admin-item');
    await page.click('.tabs button:has-text("機台")');
    await page.waitForSelector('.admin-item');
    await page.click('.tabs button:has-text("獎型")');
    await page.waitForSelector('.admin-item');
    await page.click('.tabs button:has-text("台主授權")');
    await page.waitForSelector('.perm-note');

    page.off('request', onRequest);
    assert(apiCalls === 0, '切換系統管理分頁不該打任何 API，實際打了 ' + apiCalls + ' 次');
  });

  // ── 巡邏人員 ──
  await check('巡邏人員：看得到全部機台、能記帳、但沒有管理功能', async () => {
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await logout();
    await login('patrol1', 'patrol123', false);

    assert(await page.locator('.machine-card').count() === 3, '巡邏人員應看得到 3 台');
    assert(await page.locator('button:has-text("⚙ 系統管理")').count() === 0, '巡邏人員不該看到系統管理');
    await shot('11-home-patrol');

    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
    assert(await page.locator('.action-buttons button').count() === 3, '巡邏人員應該有三顆記帳按鈕');

    await page.click('.action-buttons button:has-text("入幣")');
    await page.waitForSelector('.panel');
    assert(await page.locator('button:has-text("✎ 編輯")').count() === 0, '巡邏人員不該看到入幣的費率編輯');

    await page.click('.action-buttons button:has-text("開獎")');
    await page.waitForSelector('.prize-row');
    assert(await page.locator('button:has-text("✎ 編輯")').count() === 0, '巡邏人員不該看到編輯獎型');
    assert(await page.locator('.record-item button:has-text("✕")').count() === 0, '巡邏人員不該看到作廢按鈕');
    await shot('12-patrol-detail');
  });

  // ── 台主 ──
  await check('台主：只看得到被授權的機台，且沒有任何記帳按鈕', async () => {
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await logout();
    await login('owner1', 'owner123', false);

    const n = await page.locator('.machine-card').count();
    assert(n === 1, '台主應只看得到 1 台，實際 ' + n);
    assert(await page.locator('button:has-text("⚙ 系統管理")').count() === 0, '台主不該看到系統管理');
    await shot('13-home-owner');

    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
    assert(await page.locator('.action-buttons').count() === 0, '台主不該有記帳按鈕區');
    assert(await page.locator('.record-item button:has-text("✕")').count() === 0, '台主不該看到作廢按鈕');
    assert(await page.locator('button:has-text("📊 查詢報表")').count() === 1, '台主仍應該能看報表');
    await shot('14-owner-detail');

    await page.click('button:has-text("📊 查詢報表")');
    await page.waitForSelector('.report-stats');
    await shot('15-owner-report');
  });

  // ── 記住我 ──
  await check('沒勾記住我：token 存在 sessionStorage 而非 localStorage', async () => {
    const store = await page.evaluate(() => ({
      local: localStorage.getItem('claw_token'),
      session: sessionStorage.getItem('claw_token')
    }));
    assert(!store.local, '沒勾記住我不該寫進 localStorage');
    assert(store.session, '應該寫進 sessionStorage');
  });

  await check('勾了記住我：重開分頁不用重新登入', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await login('admin', 'admin123', true);

    const fresh = await context.newPage();
    await fresh.goto(BASE, { waitUntil: 'networkidle' });
    await fresh.waitForSelector('.machine-card', { timeout: 8000 });
    assert(await fresh.locator('form input[type="password"]').count() === 0, '應該直接進首頁，不該再看到登入表單');
    await fresh.close();
  });

  // ── 桌機版面 ──
  await check('桌機寬度下詳細頁排成左圖／中面板／右按鈕三欄', async () => {
    const desktop = await context.newPage();
    await desktop.setViewportSize({ width: 1280, height: 900 });
    await desktop.goto(BASE, { waitUntil: 'networkidle' });
    await desktop.waitForSelector('.machine-card', { timeout: 8000 });
    await desktop.locator('.machine-card').first().click();
    await desktop.waitForSelector('.detail-top');

    const cols = await desktop.evaluate(() =>
      getComputedStyle(document.querySelector('.detail-top')).gridTemplateColumns);
    assert(cols.split(' ').length === 3, '桌機應為三欄，實際 ' + cols);
    await desktop.screenshot({ path: path.join(SHOTS, '16-desktop-detail.png'), fullPage: true });
    await desktop.close();
  });

  await check('機台切換籤機台一多不會把整頁撐出橫向捲動：手機版捲動、桌機版換行', async () => {
    // grid 子項目預設 min-width:auto 是這排籤第一次上線時真的踩過的坑——
    // 子項目會被內容撐開，橫向捲動看起來像失效、甚至把整頁撐寬。
    // 這裡直接灌 20 台機台重現，比較不會因為機台數不夠而測不出來。
    const token = await page.evaluate(() =>
      localStorage.getItem('claw_token') || sessionStorage.getItem('claw_token'));
    for (let i = 4; i <= 20; i++) {
      const res = await page.request.post(BASE + '/api', {
        form: { payload: JSON.stringify({ action: 'adminSaveMachine', token: token, name: '機台' + String(i).padStart(2, '0'), sortOrder: i }) }
      });
      assert((await res.json()).ok, '建立測試機台失敗');
    }

    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 393, height: 852 });
    await mobile.goto(BASE, { waitUntil: 'networkidle' });
    await mobile.waitForSelector('.machine-card', { timeout: 8000 });
    await mobile.locator('.machine-card').first().click();
    await mobile.waitForSelector('.machine-switcher');
    const mobileInfo = await mobile.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scrollable: document.querySelector('.machine-switcher').scrollWidth > document.querySelector('.machine-switcher').clientWidth
    }));
    assert(mobileInfo.overflow <= 2, '手機版不該把整頁撐出橫向捲動，實際多出 ' + mobileInfo.overflow + 'px');
    assert(mobileInfo.scrollable, '手機版機台切換籤應該可以在自己框裡橫向捲動');
    await mobile.close();

    const desktop = await context.newPage();
    await desktop.setViewportSize({ width: 1280, height: 900 });
    await desktop.goto(BASE, { waitUntil: 'networkidle' });
    await desktop.waitForSelector('.machine-card', { timeout: 8000 });
    await desktop.locator('.machine-card').first().click();
    await desktop.waitForSelector('.machine-switcher');
    const desktopInfo = await desktop.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rows: Array.from(document.querySelectorAll('.machine-chip'))
        .map((c) => c.getBoundingClientRect().top)
        .filter((v, i, a) => a.indexOf(v) === i).length
    }));
    assert(desktopInfo.overflow <= 2, '桌機版不該把整頁撐出橫向捲動，實際多出 ' + desktopInfo.overflow + 'px');
    assert(desktopInfo.rows > 1, '機台這麼多，桌機版應該自動換行成多列，實際只有 ' + desktopInfo.rows + ' 列');
    await desktop.close();
  });

  // ── PWA 本體 ──
  await check('manifest 設定正確（standalone、圖示齊全）', async () => {
    const res = await page.request.get(BASE + '/manifest.webmanifest');
    assert(res.ok(), 'manifest 應該讀得到');
    const m = await res.json();
    assert(m.display === 'standalone', 'display 必須是 standalone，否則會有網址列');
    assert(m.start_url && m.scope, 'start_url 與 scope 都要有');
    const purposes = m.icons.map((i) => i.purpose);
    assert(purposes.indexOf('maskable') >= 0, '缺少 maskable 圖示，Android 裁切後會很醜');
    assert(m.icons.some((i) => i.sizes === '512x512'), '缺少 512x512 圖示');

    const html = await (await page.request.get(BASE + '/index.html')).text();
    assert(html.indexOf('apple-mobile-web-app-capable') > 0, '缺少 iOS 全螢幕 meta');
    assert(html.indexOf('viewport-fit=cover') > 0, '缺少 viewport-fit=cover，瀏海機型會被切到');
    assert(html.indexOf('apple-touch-icon') > 0, '缺少 apple-touch-icon');
  });

  await check('離線時 App 仍開得起來，並顯示離線提示', async () => {
    const off = await context.newPage();
    await off.goto(BASE, { waitUntil: 'networkidle' });   // 先讓 Service Worker 裝好
    await off.waitForTimeout(600);

    offlineOnPurpose = true;
    await context.setOffline(true);
    await off.reload({ waitUntil: 'domcontentloaded' });
    await off.waitForSelector('.login-wrap, .machine-card, .boot', { timeout: 8000 });
    assert(await off.locator('#offline-bar').isVisible(), '離線時應該顯示離線提示條');

    await context.setOffline(false);
    await off.close();
    offlineOnPurpose = false;
  });

  await check('全程沒有 console 錯誤', async () => {
    assert(consoleErrors.length === 0, '出現 ' + consoleErrors.length + ' 個錯誤：' + consoleErrors.slice(0, 3).join(' | '));
  });

  await browser.close();

  const failed = results.filter((r) => r.indexOf('❌') >= 0);
  console.log('前端 E2E 結果：' + (results.length - failed.length) + ' / ' + results.length + ' 通過');
  console.log(results.join('\n'));
  console.log(failed.length ? '\n⚠️ 有項目未通過。' : '\n🎉 全部通過。');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E 執行失敗：', err);
  process.exit(1);
});
