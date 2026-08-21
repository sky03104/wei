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

  await check('登入密碼錯誤時會顯示明確的錯誤訊息，不會靜靜卡在登入頁什麼提示都沒有', async () => {
    // 後端密碼錯誤／帳號被鎖都是用 AUTH 這個錯誤代碼回傳，run() 預設會吃掉
    // AUTH 錯誤的 toast（那是為了「session 過期，靜靜跳回登入頁」設計的）——
    // 登入表單自己送出的帳密錯誤如果被同一條規則吃掉，使用者會看到轉圈圈轉完、
    // 什麼也沒發生，完全不知道是密碼打錯還是連線壞了。這裡驗證登入表單有蓋掉
    // 這個預設，真的會把錯誤顯示出來。
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('form');
    await page.fill('input[autocomplete="username"]', 'admin');
    await page.fill('input[type="password"]', 'definitely-the-wrong-password');
    await page.click('button[type="submit"]');
    await page.waitForSelector('#toast.error', { timeout: 8000 });
    const msg = await page.locator('#toast').textContent();
    assert(msg.indexOf('密碼') >= 0 || msg.indexOf('帳號') >= 0, '應該顯示帳號或密碼錯誤的提示，實際「' + msg + '」');
    assert(await page.locator('.login-wrap').count() === 1, '密碼錯誤時應該還停在登入頁');
  });

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
    // 背景預取現在是「一次網路來回」拿全部機台的詳細資料（allMachineDetails），
    // 不是每台機台各打一次 machineDetail。
    let allDetailsCalls = 0;
    let machineDetailCalls = 0;
    const trackPrefetch = (req) => {
      if (req.url().includes('/api') && req.method() === 'POST') {
        const body = decodeURIComponent(req.postData() || '');
        if (body.includes('"action":"allMachineDetails"')) allDetailsCalls++;
        if (body.includes('"action":"machineDetail"')) machineDetailCalls++;
      }
    };
    page.on('request', trackPrefetch);
    page.__prefetchCallCounters = () => ({ all: allDetailsCalls, single: machineDetailCalls });

    await login('admin', 'admin123', true);
  });

  await check('登入後背景會一次把全部機台的詳細資料抓好，不用等進去才抓、也不用每台各打一次', async () => {
    await page.waitForTimeout(1200); // 給背景預取一點時間跑完
    const counts = page.__prefetchCallCounters();
    page.removeAllListeners('request');
    assert(counts.all === 1, '背景預取應該只打 1 次 allMachineDetails，實際 ' + counts.all);
    assert(counts.single === 0, '背景預取不該再各別打 machineDetail，實際 ' + counts.single + ' 次');
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
    for (const label of ['入幣', '出幣', '🎁 活動']) {
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
    // 收尾要回到機台詳細頁：後面的測試（活動面板等）都預期還停在這一頁。
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

  await check('營業日：管理員能按開始/結單，狀態文字會跟著變', async () => {
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.bizday-bar');

    const before = await page.locator('.bizday-status').textContent();
    assert(before.indexOf('尚未開始') >= 0 || before.indexOf('營業中') >= 0, '應該有明確的營業狀態文字，實際「' + before + '」');

    await page.click('button:has-text("今日營業開始")');
    await page.waitForSelector('.bizday-status:has-text("營業中")', { timeout: 8000 });

    await page.click('button:has-text("今日營業結單")');
    await page.waitForSelector('.bizday-status:has-text("尚未開始")', { timeout: 8000 });

    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
  });

  await check('營業日：台主看不到「今日營業開始/結單」，因為他不能記帳', async () => {
    // 用同一個 page 切換角色，不要開新分頁——記住我的 token 存在
    // localStorage，同一個 context 的分頁會共用，開新分頁進來會直接
    // 用現有的 admin token 秒登入，永遠看不到登入表單。
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await logout();
    await login('owner1', 'owner123', false);
    assert(await page.locator('.bizday-bar').count() === 0, '台主是唯讀角色，不該看到營業日操作按鈕');

    await logout();
    await login('admin', 'admin123', true);
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
  });

  // 開發伺服器是長駐的，資料會一直累積，所以一律驗「差額」而不是絕對值
  const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
  const statValue = async (label) => {
    const all = await page.locator('.figures-panel .stat').allTextContents();
    return num(all.find((t) => t.indexOf(label) >= 0));
  };
  // 「今日開獎」卡片已經改成「今日432數量」（次數而非金額，只認獎型名稱剛好是
  // 「432」的紀錄），這裡的預設獎型（大娃／小娃）都不叫這個名字，所以不會再增加，
  // 改成直接比對淨收益的變化量，一樣能驗到「活動成本確實從淨收益扣掉」。
  let netBeforePrize = 0;

  await check('活動面板可以一次登錄多個獎型，合計正確', async () => {
    netBeforePrize = num(await page.locator('.net-stat .stat-value').textContent());
    await page.click('.action-buttons button:has-text("活動")');
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

  await check('活動確實被當成本扣掉淨收益', async () => {
    const netAfter = num(await page.locator('.net-stat .stat-value').textContent());
    assert(netBeforePrize - netAfter === 230,
      '活動成本應讓淨收益減少 230，實際從 ' + netBeforePrize + ' 變成 ' + netAfter);
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

  await check('快取還新鮮時進頁面不會多打一次背景重新整理，記帳之後一定會', async () => {
    // 使用者原本的抱怨：「數字馬上出現，但過一下子又跳一次」——
    // 快取秒開沒問題，問題是不管快不快都會再背景打一次 machineDetail，
    // 舊資料先閃一下再被新資料蓋掉，體感就是在等。
    // 快取夠新鮮（CACHE_FRESH_MS 之內）就不該再多打這一次。
    let calls = 0;
    const track = (req) => {
      if (req.url().includes('/api') && req.method() === 'POST') {
        const body = decodeURIComponent(req.postData() || '');
        if (body.includes('"action":"machineDetail"')) calls++;
      }
    };
    page.on('request', track);

    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
    await page.waitForTimeout(400);
    const afterEnter = calls;

    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
    await page.waitForTimeout(400);
    assert(calls === afterEnter, '快取還新鮮時，短時間內重新進同一台不該再多打一次 machineDetail（' + afterEnter + ' → ' + calls + '）');

    // 記帳是使用者自己的動作，不管快取新不新鮮都一定要拿到最新資料。
    await page.click('.action-buttons button:has-text("出幣")');
    await page.waitForSelector('.custom-amount input');
    await page.fill('.custom-amount input', '33');
    await page.click('.custom-amount button:has-text("送出")');
    // .record-item 從快取就有了，waitForSelector 對這個斷言沒有意義
    // （不會等到 addRecord → loadDetail 真的跑完）；改成直接輪詢 calls 變多，
    // 或等到逾時——逾時也沒關係，下面的斷言一樣會抓到「calls 沒變多」。
    for (let i = 0; i < 40 && calls <= afterEnter; i++) await page.waitForTimeout(200);
    assert(calls > afterEnter, '送出帳目之後一定要重新整理，不能沿用新鮮快取（' + afterEnter + ' → ' + calls + '）');

    page.removeAllListeners('request');
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

  await check('機台圖案：編輯機台可以選不同款式的像素圖，存檔後會記住', async () => {
    await page.click('.tabs button:has-text("機台")');
    await page.waitForSelector('.admin-item');
    await page.locator('.admin-item').first().locator('button:has-text("編輯")').click();
    await page.waitForSelector('.dialog');

    const iconLabels = await page.locator('.icon-swatches button').allTextContents();
    assert(['經典', '圓頂', '雙爪', '招牌', '骰子', '六點骰'].every((l) => iconLabels.some((t) => t.indexOf(l) >= 0)),
      '應該有經典/圓頂/雙爪/招牌/骰子/六點骰六種圖案可以選，實際 ' + JSON.stringify(iconLabels));
    assert(await page.locator('.icon-swatches button.active').count() === 1, '預設應該有剛好一款被標成選中');

    const previewBefore = await page.locator('.dialog svg.pixel-machine').first().getAttribute('viewBox');
    await page.locator('.icon-swatches button:has-text("圓頂")').click();
    assert((await page.locator('.icon-swatches button:has-text("圓頂")').getAttribute('class') || '').includes('active'),
      '點選「圓頂」後那顆應該變成選中狀態');
    const previewAfter = await page.locator('.dialog svg.pixel-machine').first().getAttribute('viewBox');
    assert(previewAfter !== previewBefore, '換款式後上面的大預覽圖應該跟著換，viewBox 應該不一樣（' + previewBefore + ' → ' + previewAfter + '）');

    await page.click('.dialog button:has-text("儲存")');
    await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 8000 });

    await page.locator('.admin-item').first().locator('button:has-text("編輯")').click();
    await page.waitForSelector('.dialog');
    assert((await page.locator('.icon-swatches button:has-text("圓頂")').getAttribute('class') || '').includes('active'),
      '重新打開編輯應該還記得剛存的「圓頂」，不是又跳回經典');
    await page.click('.dialog button:has-text("取消")');
    await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 8000 });
  });

  await check('首頁分頁籤（骰台／電子／加總）＋新增電子機台並記錄開分/洗分', async () => {
    await page.click('.tabs button:has-text("機台")');
    await page.waitForSelector('.admin-item');

    await page.click('button:has-text("＋ 新增電子機台")');
    await page.waitForSelector('.dialog');
    await page.fill('.dialog input[maxlength="30"]', '電子測試機');
    await page.click('.dialog button:has-text("儲存")');
    await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 8000 });

    const badge = await page.locator('.admin-item:has-text("電子測試機") .badge').textContent();
    assert(badge.trim() === '電子', '新增的機台應該標示「電子」分類，實際「' + badge + '」');

    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    assert(await page.locator('.home-sticky .seg button:has-text("骰台")').count() === 1, '首頁應該有骰台分頁籤');
    assert(await page.locator('.machine-card').count() === 3, '骰台分頁籤預設不該顯示電子機台');
    const diceLabels = await page.locator('.summary-strip .stat-label').allTextContents();
    assert(diceLabels.some((t) => t.indexOf('432數量') >= 0), '骰台分頁籤應該顯示今日432數量卡片，取代原本的今日開獎');

    await page.click('.home-sticky .seg button:has-text("電子")');
    await page.waitForSelector('.machine-card');
    assert(await page.locator('.machine-card').count() === 1, '電子分頁籤應該只顯示剛新增的那一台');
    await shot('14-home-electronic-tab');

    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');

    // 現在骰台跟電子機台都有了，機台切換籤該分成兩排，不是全部擠在同一排。
    await page.waitForSelector('.machine-switcher-group');
    const switcherRows = await page.locator('.machine-switcher[data-category]').all();
    assert(switcherRows.length === 2, '骰台跟電子都有機台時，切換籤應該分成兩排，實際 ' + switcherRows.length + ' 排');
    const rowLabels = await page.locator('.switcher-row-label').allTextContents();
    assert(rowLabels.includes('骰台') && rowLabels.includes('電子'), '兩排應該各自標示「骰台」「電子」，實際 ' + JSON.stringify(rowLabels));

    const actionLabels = await page.locator('.action-buttons button').allTextContents();
    assert(actionLabels.length === 2, '電子機台應該只有開分/洗分兩顆按鈕，實際 ' + actionLabels.length);
    assert(actionLabels.some((t) => t.indexOf('開分') >= 0), '應該有開分按鈕');
    assert(actionLabels.some((t) => t.indexOf('洗分') >= 0), '應該有洗分按鈕');
    assert(!actionLabels.some((t) => t.indexOf('活動') >= 0 || t === '入幣' || t === '出幣'),
      '電子機台不該出現入幣/出幣/活動按鈕');

    await page.click('.action-buttons button:has-text("開分")');
    await page.waitForSelector('.custom-amount input');
    await page.fill('.custom-amount input', '500');
    await page.click('.custom-amount button:has-text("送出")');
    await page.waitForSelector('.record-item', { timeout: 8000 });

    await page.click('.action-buttons button:has-text("洗分")');
    await page.waitForSelector('.custom-amount input');
    await page.fill('.custom-amount input', '200');
    await page.click('.custom-amount button:has-text("送出")');
    await page.waitForFunction(() => document.querySelectorAll('.record-item').length >= 2, null, { timeout: 8000 });

    const stats = await page.locator('.figures-panel .stat').allTextContents();
    const netText = stats.find((t) => t.indexOf('盈虧金額') >= 0);
    assert(netText && num(netText) === 300, '盈虧金額應該是開分500－洗分200＝300，實際「' + netText + '」');
    await shot('15-electronic-machine-detail');

    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await page.click('.home-sticky .seg button:has-text("加總")');
    await page.waitForSelector('.summary-strip');
    const totalLabels = await page.locator('.summary-strip .stat-label').allTextContents();
    assert(totalLabels.some((t) => t.indexOf('骰台淨收益') >= 0), '加總分頁應該有骰台淨收益卡片');
    assert(totalLabels.some((t) => t.indexOf('電子淨收益') >= 0), '加總分頁應該有電子淨收益卡片');
    assert(totalLabels.some((t) => t.indexOf('總淨收益') >= 0), '加總分頁應該有總淨收益卡片');
    assert(await page.locator('.machine-list').count() === 0, '加總分頁不該顯示機台清單，那裡改顯示現金結餘明細');
    await shot('16-home-total-tab');
  });

  await check('加總分頁顯示今日現金結餘明細（九行＋總結餘），且可以設定週轉金等五項數字', async () => {
    await page.waitForSelector('.ledger-row');
    const rowLabels = await page.locator('.ledger-row .ledger-label').allTextContents();
    for (const label of ['開銷+432獎', '入幣', '出幣', '週轉金', '運拿', '台主給', '電子贏', '台主領', '還內場', '總結餘']) {
      assert(rowLabels.indexOf(label) >= 0, '結餘明細缺少「' + label + '」這一行');
    }

    const totalBefore = num(await page.locator('.ledger-row.ledger-total .ledger-value').textContent());

    // 今天還沒設定過的話，週轉金要預先帶入常用的固定金額（省掉每次都要
    // 手動刪掉「0」再重打），其他四項則留白（不是「0」），這樣手動輸入時
    // 不用先清掉預設值。
    await page.click('button:has-text("✎ 設定今日數字")');
    await page.waitForSelector('.dialog');
    let inputs = page.locator('.dialog input');
    assert(await inputs.nth(0).inputValue() === '416000', '今天還沒設定過時，週轉金應該預帶 416000');
    for (let i = 1; i < 5; i++) {
      assert(await inputs.nth(i).inputValue() === '', '今天還沒設定過時，第 ' + (i + 1) + ' 個輸入框應該留白，不是 0');
    }
    await page.click('.dialog button:has-text("取消")');
    await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 8000 });

    await page.click('button:has-text("✎ 設定今日數字")');
    await page.waitForSelector('.dialog');
    inputs = page.locator('.dialog input');
    await inputs.nth(0).fill('100');
    await inputs.nth(1).fill('40'); // 運拿：輸入正數，系統會自動扣除
    await inputs.nth(2).fill('20');
    await inputs.nth(3).fill('15'); // 台主領：輸入正數，系統會自動扣除
    await inputs.nth(4).fill('5');
    await page.click('.dialog button:has-text("儲存")');
    await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 8000 });

    await page.waitForFunction((before) => {
      const el = document.querySelector('.ledger-row.ledger-total .ledger-value');
      return el && Number(el.textContent.replace(/[^0-9.-]/g, '')) !== before;
    }, totalBefore, { timeout: 8000 });

    const totalAfter = num(await page.locator('.ledger-row.ledger-total .ledger-value').textContent());
    assert(totalAfter - totalBefore === 70,
      '儲存週轉金100－運拿40＋台主給20－台主領15＋還內場5＝70 之後，總結餘應該增加 70，實際從 ' + totalBefore + ' 變成 ' + totalAfter);
    await shot('17-home-total-ledger');

    // 今天已經設定過了，再打開應該顯示剛剛存的真實值，不能被預設值蓋掉。
    await page.click('button:has-text("✎ 設定今日數字")');
    await page.waitForSelector('.dialog');
    const savedInputs = page.locator('.dialog input');
    const savedValues = [];
    for (let i = 0; i < 5; i++) savedValues.push(await savedInputs.nth(i).inputValue());
    assert(JSON.stringify(savedValues) === JSON.stringify(['100', '40', '20', '15', '5']),
      '今天已經設定過時，重新打開應該顯示剛存的實際值，不是預設值，實際 ' + JSON.stringify(savedValues));
    await page.click('.dialog button:has-text("取消")');
    await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 8000 });

    // 同一個營業日重複儲存應該是覆蓋，不是疊加——五項都改回 0，總結餘應該回到最初的值。
    await page.click('button:has-text("✎ 設定今日數字")');
    await page.waitForSelector('.dialog');
    inputs = page.locator('.dialog input');
    for (let i = 0; i < 5; i++) await inputs.nth(i).fill('0');
    await page.click('.dialog button:has-text("儲存")');
    await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 8000 });

    await page.waitForFunction((prev) => {
      const el = document.querySelector('.ledger-row.ledger-total .ledger-value');
      return el && Number(el.textContent.replace(/[^0-9.-]/g, '')) !== prev;
    }, totalAfter, { timeout: 8000 });

    const totalReset = num(await page.locator('.ledger-row.ledger-total .ledger-value').textContent());
    assert(totalReset === totalBefore,
      '五項都改回 0 之後，總結餘應該覆蓋回最初的值（不是疊加），實際 ' + totalReset + ' vs ' + totalBefore);

    // 收尾切回骰台分頁、進一台骰台機台，後面的測試（巡邏人員角色）預期
    // 停在一個有「← 返回主畫面」可以按的頁面，且首頁分頁籤要留在預設值。
    await page.click('.home-sticky .seg button:has-text("骰台")');
    await page.waitForSelector('.machine-card');
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
    const diceStatLabels = await page.locator('.figures-panel .stat-label').allTextContents();
    assert(diceStatLabels.some((t) => t.indexOf('432數量') >= 0), '骰台機台詳細頁也應該顯示今日432數量卡片');
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

    await page.click('.action-buttons button:has-text("活動")');
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

  await check('手動把機台切換籤滑到後面之後，背景重繪不會把捲動位置彈回去', async () => {
    // render() 每次都整個 replaceChildren 重建 DOM，切換籤原本每次重繪
    // 都會強制捲回「置中目前這台」，使用者手動滑到後面找機台，只要
    // 一遇到背景重新整理（送出帳目後的刷新、輪詢…）就會被彈回去，
    // 體感上像是「切著切著自己跳回上一台」。
    // 前一個測試（「勾了記住我」）結束時停在首頁，不是機台詳細頁，
    // 不能假設「← 返回主畫面」這顆按鈕現在看得到。
    await page.waitForSelector('.machine-card');
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.machine-switcher');

    await page.evaluate(() => { document.querySelector('.machine-switcher').scrollLeft = 300; });
    await page.waitForTimeout(50);
    const before = await page.evaluate(() => document.querySelector('.machine-switcher').scrollLeft);
    assert(before > 0, '手動滑動應該真的有捲動才對，實際 ' + before);

    // 送一筆出幣：送出後 submitAmount 會呼叫 loadDetail 背景重新整理、
    // 觸發一次跟輪詢/背景刷新同樣性質的重繪。
    await page.click('.action-buttons button:has-text("出幣")');
    await page.waitForSelector('.custom-amount input');
    await page.fill('.custom-amount input', '50');
    await page.click('.custom-amount button:has-text("送出")');
    await page.waitForSelector('.record-item', { timeout: 8000 });
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => document.querySelector('.machine-switcher').scrollLeft);
    assert(Math.abs(after - before) < 5, '背景重繪不該把手動捲動的位置改掉，捲動前 ' + before + '、之後 ' + after);
  });

  await check('桌機版：切換籤自動換行不影響水平捲動，但整頁的垂直捲動位置也不該被背景重繪彈掉', async () => {
    // 上一項測試只驗了切換籤自己的水平捲軸（手機版）。桌機版切換籤是自動
    // 換行、不會水平捲動，那個修法完全顧不到——但整個頁面本身的「垂直」
    // 捲動位置是另一回事，換行內容高度一變，一樣可能把使用者往下滑看
    // 到一半的畫面彈回去，這是原本那個修法沒蓋到的地方。
    const desktop = await context.newPage();
    await desktop.setViewportSize({ width: 1280, height: 900 });
    await desktop.goto(BASE, { waitUntil: 'networkidle' });
    await desktop.waitForSelector('.machine-card', { timeout: 8000 });
    await desktop.locator('.machine-card').first().click();
    await desktop.waitForSelector('.detail-hero');

    await desktop.evaluate(() => window.scrollTo(0, 400));
    await desktop.waitForTimeout(50);
    const before = await desktop.evaluate(() => window.scrollY);
    assert(before > 0, '桌機版應該真的能往下捲動才對，實際 ' + before);

    await desktop.click('.action-buttons button:has-text("出幣")');
    await desktop.waitForSelector('.custom-amount input');
    await desktop.fill('.custom-amount input', '30');
    await desktop.click('.custom-amount button:has-text("送出")');
    await desktop.waitForSelector('.record-item', { timeout: 8000 });
    await desktop.waitForTimeout(300);

    const after = await desktop.evaluate(() => window.scrollY);
    assert(Math.abs(after - before) < 5, '桌機版背景重繪不該把整頁的垂直捲動位置改掉，捲動前 ' + before + '、之後 ' + after);
    await desktop.close();
  });

  await check('電子機台頁面（內容比骰台頁面短）背景重繪也不該把整頁捲動位置彈回去', async () => {
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await page.click('.home-sticky .seg button:has-text("電子")');
    await page.waitForSelector('.machine-card');
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');

    // 電子機台頁面內容本來就比骰台頁面短（少一顆按鈕、沒有碼表相關內容），
    // 先灌幾筆紀錄把清單撐長，確保手機視窗高度下真的滑得動，不然這個測試
    // 本身就測不出東西。
    const token = await page.evaluate(() =>
      localStorage.getItem('claw_token') || sessionStorage.getItem('claw_token'));
    const elecMachineId = await page.evaluate(() => state.machineId);
    for (let i = 0; i < 8; i++) {
      const res = await page.request.post(BASE + '/api', {
        form: {
          payload: JSON.stringify({
            action: 'addRecord', token: token, machineId: elecMachineId,
            type: i % 2 === 0 ? 'chip_in' : 'chip_out', amount: 100 + i, clientToken: 'pad-elec-' + i
          })
        }
      });
      assert((await res.json()).ok, '灌測試紀錄失敗');
    }
    // 這幾筆是繞過前端直接打 API 加的，state.cache 裡這台機台的快取還是
    // 舊的（而且才剛進來過，還在 CACHE_FRESH_MS 新鮮期內，單純「離開再
    // 進來」不會觸發背景重新整理）。整頁 reload 才會讓 state.cache 重新
    // 歸零，逼前端真的重抓一次，灌進去的紀錄才會顯示出來。
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.machine-card', { timeout: 8000 });
    await page.click('.home-sticky .seg button:has-text("電子")');
    await page.waitForSelector('.machine-card');
    await page.locator('.machine-card').first().click();
    await page.waitForSelector('.detail-hero');
    await page.waitForFunction(() => document.querySelectorAll('.record-item').length >= 8, null, { timeout: 8000 });

    await page.evaluate(() => window.scrollTo(0, 200));
    await page.waitForTimeout(50);
    const before = await page.evaluate(() => window.scrollY);
    assert(before > 0, '電子機台頁面應該真的能往下捲動才對，實際 ' + before);

    await page.click('.action-buttons button:has-text("開分")');
    await page.waitForSelector('.custom-amount input');
    await page.fill('.custom-amount input', '10');
    await page.click('.custom-amount button:has-text("送出")');
    await page.waitForSelector('.record-item', { timeout: 8000 });
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => window.scrollY);
    assert(Math.abs(after - before) < 5, '電子機台背景重繪不該把整頁的捲動位置改掉，捲動前 ' + before + '、之後 ' + after);

    // 收尾切回骰台分頁，維持後面測試預期的預設分頁狀態。
    await page.click('button:has-text("← 返回主畫面")');
    await page.waitForSelector('.machine-card');
    await page.click('.home-sticky .seg button:has-text("骰台")');
    await page.waitForSelector('.machine-card');
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
