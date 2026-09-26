/* ══════════════════════════════════════════════════════════════
   娃娃機管理系統 · 共用 UI 動態效果（2026-09-26，移植自天鷹保全的 ui_fx）— 搭配 ui_fx.css
   提供：
   ・主要按鈕按下漣漪＋光澤（自動套用，不用改 app.js 的按鈕程式）
   ・iOS 的 :active 按壓回饋（Safari 預設不觸發，這裡補上）
   ・對話框／提示訊息的進出場動畫（自動套用）
   ・回到頂端鈕（自動套用）
   ・fxSkeletonCards(n, 提示)：機台卡片形狀的骨架畫面 HTML
   ・fxSuccess()：送出成功打勾
   ・fxFieldError(欄位)：漏填的欄位紅框＋抖一下＋捲過去
   ・fxPullToRefresh(fn)：下拉更新
   ・fxRemoveThen(fn)：刪除／作廢的那一列先收合淡出，再重畫
   ・fxCountFrom(元素, 舊數字, 新數字, 格式)／fxCountTo(…)：數字跳動
   ・fxButtonBusy(按鈕, '送出中…')：按鈕轉圈＋暫時不能再按，回傳還原用的函式
   ・fxMoveSlider(膠囊, 目標按鈕, 上一顆)：分頁滑動膠囊定位
   ・捲動離開最上面時在 <html> 加 fx-scrolled（首頁標題列的陰影用）
   ・fxReduced()：手機是否開了「減少動態效果」
   全部包在 try 裡，任何錯誤都不影響 App 本身運作；app.js 呼叫前也都會先確認函式存在，
   這支檔案沒載到（例如舊版快取）就維持原本的畫面。

   跟天鷹版的差別（移植時調整）：
   ・拿掉「從 APP 進來跳過開場光環」：這個 App 沒有開場光環，只有 index.html 的「載入中…」，
     已登入時改由 app.js 直接把它換成首頁骨架（見 app.js 的 boot）
   ・拿掉 iframe 內嵌的處理：這個 App 不會被別的頁面內嵌，body 本來就有 overscroll-behavior-y:none
   ・拿掉斷線提示條：index.html 本來就有 #offline-bar，不重複
   ・拿掉跨頁轉場（@view-transition）：這個 App 是單頁應用，沒有整頁跳轉
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // 手機是否開了「減少動態效果」
  function fxReduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }
  window.fxReduced = fxReduced;

  /* ── 主要按鈕：哪些按鈕要有漣漪。
     styles.css 的 .btn-primary（登入、儲存、新增…）＋記帳用的 .btn-in／.btn-out／.btn-prize
     （入幣／出幣／活動、開分／洗分、送出、出幣快捷金額）。
     其他按鈕要加的話在標籤上寫 data-fx="ripple" 即可 */
  var RIPPLE_SEL = '.btn-primary,.btn-in,.btn-out,.btn-prize,[data-fx~="ripple"]';

  function ripple(btn, x, y) {
    if (fxReduced()) return;
    var r = btn.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 按鈕是 static 定位時暫時改成 relative，讓效果層貼齊按鈕；多次連按用計數，最後一個效果結束才還原
    if (!btn._fxN) {
      if (getComputedStyle(btn).position === 'static') { btn.style.position = 'relative'; btn._fxPosSet = true; }
    }
    btn._fxN = (btn._fxN || 0) + 1;

    var size = Math.max(r.width, r.height) * 2.2;
    var wrap = document.createElement('span');
    wrap.className = 'fx-rip-wrap';
    var c = document.createElement('span');
    c.className = 'fx-rip';
    c.style.width = c.style.height = size + 'px';
    c.style.left = (x - r.left - size / 2) + 'px';
    c.style.top = (y - r.top - size / 2) + 'px';
    var s = document.createElement('span');
    s.className = 'fx-shine';
    wrap.appendChild(c);
    wrap.appendChild(s);
    btn.appendChild(wrap);

    setTimeout(function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      btn._fxN = Math.max(0, (btn._fxN || 1) - 1);
      if (!btn._fxN && btn._fxPosSet) { btn.style.position = ''; btn._fxPosSet = false; }
    }, 700);
  }

  document.addEventListener('pointerdown', function (ev) {
    try {
      if (ev.button !== undefined && ev.button !== 0) return; // 只理左鍵／手指
      var btn = ev.target && ev.target.closest && ev.target.closest(RIPPLE_SEL);
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
      ripple(btn, ev.clientX, ev.clientY);
    } catch (e) { /* 效果失敗不影響按鈕本身 */ }
  }, { passive: true });

  // iOS Safari 預設不觸發 :active，註冊一個空的 touchstart 就會生效（styles.css 的 .btn:active 按壓縮放靠它）
  document.addEventListener('touchstart', function () {}, { passive: true });

  /* ── 骨架畫面：n 張「機台卡片」形狀的骨架（外框跟首頁 .machine-card 一樣），回傳 HTML 字串。
     hint 是可選的一行小字（例如「正在讀取機台資料…」），會先跳脫再放進去 */
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  window.fxSkeletonCards = function (n, hint) {
    var one = '<div class="fx-sk-card">' +
      '<span class="fx-sk" style="width:58px;height:72px;border-radius:8px;flex:0 0 auto"></span>' +
      '<div class="fx-sk-info"><span class="fx-sk" style="width:62%;height:17px"></span>' +
      '<span class="fx-sk" style="width:40%;height:13px;margin-top:8px"></span></div>' +
      '<div class="fx-sk-fig"><span class="fx-sk" style="width:78px;height:24px"></span>' +
      '<span class="fx-sk" style="width:104px;height:12px;margin-top:8px"></span></div></div>';
    var html = '<div class="fx-sk-list" role="status" aria-busy="true" aria-label="讀取中">';
    if (hint) html += '<div class="fx-sk-hint">' + escHtml(hint) + '</div>';
    for (var i = 0; i < (n || 3); i++) html += one;
    return html + '</div>';
  };

  /* ── 滑動膠囊：把 slider 移到 target 的位置與大小。
     第一次定位不播動畫（不然會從左上角滑進來），之後才加 transition。
     from（可省略）：膠囊剛建立時先放在 from 那一顆，再滑到 target——這個 App 每次切換分頁
     都會整個重畫，膠囊是新的元素，要靠 from 告訴它「上一次選中的是哪一顆」才滑得起來 */
  function placeSlider(slider, target) {
    slider.style.width = target.offsetWidth + 'px';
    slider.style.height = target.offsetHeight + 'px';
    slider.style.transform = 'translate(' + target.offsetLeft + 'px,' + target.offsetTop + 'px)';
  }
  window.fxMoveSlider = function (slider, target, from) {
    try {
      if (!slider || !target) return;
      slider._fxTarget = target;
      if (from && from !== target && !slider.classList.contains('fx-on') && !fxReduced()) {
        placeSlider(slider, from);
        slider.classList.add('fx-on');
        void slider.offsetWidth;            // 先把「在 from 那一顆」畫定，下面的移動才會有過場
        slider.classList.add('fx-anim');
        requestAnimationFrame(function () { if (slider._fxTarget === target) placeSlider(slider, target); });
        return;
      }
      placeSlider(slider, target);
      if (!slider.classList.contains('fx-on')) {
        slider.classList.add('fx-on');
        requestAnimationFrame(function () { requestAnimationFrame(function () { slider.classList.add('fx-anim'); }); });
      }
    } catch (e) {}
  };
  // 螢幕旋轉／字型載入完成後寬度會變，重新對齊所有膠囊
  function realignAll() {
    var list = document.querySelectorAll('.fx-slider');
    for (var i = 0; i < list.length; i++) {
      if (list[i]._fxTarget && list[i]._fxTarget.isConnected) window.fxMoveSlider(list[i], list[i]._fxTarget);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     對話框、提示訊息、成功打勾、刪除收合、震動回饋
     做法：一個共用的 MutationObserver 盯著畫面，發現「對話框／提示訊息」出現或消失就播動畫，
     app.js 不用一個一個改。只用 Web Animations（element.animate），動畫結束不留任何樣式；
     位移用獨立的 translate/scale 屬性，不會蓋掉 .toast 原本用 transform 做的置中。
     ══════════════════════════════════════════════════════════════ */
  // app.js 的 openDialog() 產生 .dialog-backdrop（裡面的 .dialog 是面板）；提示訊息是 #toast
  var MODAL_SEL = '.dialog-backdrop,[role="dialog"]';
  var TOAST_SEL = '#toast,.toast';
  var SKIP_SEL  = '.fx-ghost,.fx-rip-wrap,.fx-slider,.fx-success,.fx-ptr,.fx-top';
  var SHOW_CLS  = ['show', 'open', 'on', 'active', 'visible'];

  function hasShowCls(el) { for (var i = 0; i < SHOW_CLS.length; i++) if (el.classList.contains(SHOW_CLS[i])) return true; return false; }
  // 目前看不看得到。有些視窗用 .show/.open 切換、用 opacity 過場，剛切換的瞬間 opacity 還是 0，
  // 所以「用過 show 類 class 的元素」一律以 class 判斷，不看 opacity。
  // opacity 只在「開機當下」拿來判斷（例如一直掛在畫面上、用 opacity:0 藏起來的提示框）；
  // 之後不看 opacity——很多提示框／視窗自己帶淡入動畫，剛出現那一瞬間 opacity 就是 0，會被誤判成看不到。
  // 這個 App 的 #toast 用 hidden 屬性切換（styles.css 的 [hidden]{display:none}），看 display 就對了
  function visibleNow(el, initial) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (hasShowCls(el)) { el._fxUsesShow = true; return true; }
    if (el._fxUsesShow) return false;
    return initial ? parseFloat(cs.opacity) > 0.01 : true;
  }
  // 直接用 inline style 寫的全螢幕遮罩（這個 App 目前沒有，留著給以後）
  function isInlineOverlay(el) {
    var st = el.getAttribute && el.getAttribute('style');
    return !!(st && st.indexOf('position: fixed') > -1 && /inset: 0/.test(st));
  }
  function kindOf(el) {
    if (!el || el.nodeType !== 1 || !el.matches) return '';
    if (el.matches(SKIP_SEL) || (el.closest && el.closest('.fx-ghost'))) return '';
    if (el.matches(TOAST_SEL)) return 'toast';
    if (el.matches(MODAL_SEL) || isInlineOverlay(el)) return 'modal';
    return '';
  }
  function isFullscreen(el) {
    var r = el.getBoundingClientRect();
    return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
  }
  function firstPanel(ov) {
    for (var c = ov.firstElementChild; c; c = c.nextElementSibling) {
      var cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.position === 'fixed') continue;
      var r = c.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) return c;
    }
    return null;
  }
  function panelIn(p) {
    var r = p.getBoundingClientRect();
    var sheet = r.bottom >= innerHeight - 4; // 貼齊底部＝手機版的底部抽屜，往上滑出；其他（桌機置中）＝中間彈出
    p.animate(sheet
      ? [{ translate: '0 48px', opacity: 0 }, { translate: '0 0', opacity: 1 }]
      : [{ scale: '.94', translate: '0 10px', opacity: 0 }, { scale: '1', translate: '0 0', opacity: 1 }],
      { duration: sheet ? 300 : 240, easing: 'cubic-bezier(.2,.9,.3,1)' });
  }
  function isOpaquePage(el) {
    var m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor || '');
    if (!m) return false;
    var parts = m[1].split(','); return parts.length < 4 || parseFloat(parts[3]) >= 0.9;
  }
  function modalIn(el) {
    if (el._fxPage) {
      el.animate([{ translate: '36px 0', opacity: 0 }, { translate: '0 0', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
    } else if (isFullscreen(el)) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      var p = firstPanel(el); if (p) panelIn(p);
    } else {
      panelIn(el);
    }
  }
  // 消失動畫：元素已經被移除或藏起來了，複製一份「剛才顯示時的樣子」蓋在原處淡出，0.2 秒後刪掉。
  // 複本拿掉所有 id（避免程式 getElementById 抓錯，例如 closeDialog() 找 #dialog-backdrop）、不能點；
  // 含 iframe/影片的不做（複製會重新載入）
  function ghostOut(el, parent, before) {
    try {
      // 注意：inline style 遮罩的 className 是空字串，不能用 !el._fxShownClass 判斷
      if (el._fxShownClass === undefined || el.querySelector('iframe,video')) return;
      if (!parent || !parent.isConnected) parent = document.body;
      var g = el.cloneNode(true);
      g.className = el._fxShownClass;
      g.classList.add('fx-ghost');
      g.removeAttribute('id');
      var ids = g.querySelectorAll('[id]'); for (var i = 0; i < ids.length; i++) ids[i].removeAttribute('id');
      var rips = g.querySelectorAll('.fx-rip-wrap'); for (var j = 0; j < rips.length; j++) rips[j].parentNode.removeChild(rips[j]); // 按鈕漣漪不要在複本裡重播
      g.style.setProperty('display', el._fxShownDisplay || 'block', 'important');
      g.style.pointerEvents = 'none';
      g.setAttribute('aria-hidden', 'true');
      parent.insertBefore(g, before && before.parentNode === parent ? before : null);
      var full = el._fxFull, a;
      if (el._fxPage) {
        a = g.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '36px 0' }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
      } else if (full) {
        a = g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
        var p = g.firstElementChild;
        if (p && p.animate) p.animate([{ translate: '0 0' }, { translate: '0 24px' }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
      } else {
        a = g.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 24px' }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
      }
      a.onfinish = function () { if (g.parentNode) g.parentNode.removeChild(g); };
      setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 600); // 保險
    } catch (e) {}
  }

  /* ── 震動回饋：只有 Android 有（iPhone 的瀏覽器不支援，會自動略過） ── */
  function haptic(type) {
    try { if (navigator.vibrate) navigator.vibrate(type === 'err' ? [40, 60, 40] : 15); } catch (e) {}
  }
  window.fxHaptic = haptic;

  /* ── 提示訊息：在下半部的從下往上滑、在上半部的從上往下滑；失敗的再左右抖一下 ──
     app.js 的 toast() 用 class 分：.toast.error／.toast.success */
  function toastTone(el) {
    var c = ' ' + el.className + ' ', t = (el.textContent || '').trim();
    if (/ (err|fail|error|t-err|toast-err) /.test(c) || /^(❌|✗|⚠)/.test(t)) return 'err';
    if (/ (ok|t-ok|toast-ok|success) /.test(c) || /^(✅|✓|🗑)/.test(t)) return 'ok';
    return '';
  }
  function toastIn(el) {
    var r = el.getBoundingClientRect();
    var fromTop = r.top < innerHeight / 2;
    var a = el.animate([{ translate: '0 ' + (fromTop ? -18 : 18) + 'px', opacity: 0 }, { translate: '0 0', opacity: 1 }],
      { duration: 320, easing: 'cubic-bezier(.2,1.3,.4,1)' });
    var tone = toastTone(el);
    if (tone === 'err') {
      a.onfinish = function () {
        el.animate([{ translate: '0 0' }, { translate: '-7px 0' }, { translate: '7px 0' }, { translate: '-5px 0' }, { translate: '5px 0' }, { translate: '0 0' }],
          { duration: 360, easing: 'ease-in-out' });
      };
    }
    if (tone) haptic(tone);
  }

  function rememberShown(el) {
    el._fxShownClass = el.className;
    el._fxShownDisplay = getComputedStyle(el).display;
    el._fxFull = isFullscreen(el);
    el._fxPage = el._fxFull && isOpaquePage(el);
  }
  function onShow(el, kind) {
    if (kind === 'toast') { toastIn(el); return; }
    rememberShown(el);
    modalIn(el);
  }

  // 檢查一個元素：狀態從看不到→看得到就播進場；從看得到→看不到就播退場
  function check(el) {
    var kind = kindOf(el); if (!kind) return;
    var vis = visibleNow(el, !ready);
    if (vis && !el._fxVis) { el._fxVis = true; if (!fxReduced() && ready) onShow(el, kind); else if (kind === 'modal') rememberShown(el); }
    else if (!vis && el._fxVis) { el._fxVis = false; if (kind === 'modal' && !fxReduced() && ready) ghostOut(el, el.parentNode, el.nextSibling); }
  }
  var ready = false;
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    check(root);
    if (root.querySelectorAll) {
      var list = root.querySelectorAll(MODAL_SEL + ',' + TOAST_SEL + ',[style*="position: fixed"]');
      for (var i = 0; i < list.length; i++) check(list[i]);
    }
  }
  function startObserver() {
    try {
      if (!window.MutationObserver || !Element.prototype.animate) return;
      // 從這裡開始進出場由這支檔案負責，ui_fx.css 看到 fx-anim 就把 styles.css 原本的進場動畫讓出來
      document.documentElement.classList.add('fx-anim');
      scan(document.body); // 開機時已經在畫面上的只記狀態、不播動畫
      ready = true;
      new MutationObserver(function (muts) {
        try {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (m.type === 'attributes') { if (m.target._fxVis !== undefined || kindOf(m.target)) check(m.target); continue; }
            for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]);
            for (var k = 0; k < m.removedNodes.length; k++) {
              var n = m.removedNodes[k];
              if (n.nodeType === 1 && n._fxVis && kindOf(n) === 'modal' && !fxReduced()) { n._fxVis = false; ghostOut(n, m.target, m.nextSibling); }
            }
          }
        } catch (e) {}
      // hidden 也要盯：#toast 是用 hidden 屬性顯示／隱藏的，只盯 class/style 會漏掉「藏起來」那一下，下一則提示就不會再播動畫
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver); else startObserver();

  /* ── 送出成功：畫面中央畫出綠色打勾，0.9 秒後自己消失（不擋操作） ── */
  window.fxSuccess = function () {
    try {
      haptic('ok');
      if (fxReduced()) return;
      var d = document.createElement('div');
      d.className = 'fx-success';
      d.setAttribute('aria-hidden', 'true');
      d.innerHTML = '<svg viewBox="0 0 52 52" width="92" height="92"><circle class="fx-sc" cx="26" cy="26" r="23"/>' +
                    '<path class="fx-sk2" d="M15 27 l7 7 l15 -16"/></svg>';
      document.body.appendChild(d);
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 1000);
    } catch (e) {}
  };

  /* ── 刪除收合：記住「按了刪除／作廢的那一列」，成功後先收合淡出，再重畫清單 ──
     用法（刪除成功後）：fxRemoveThen(function(){ 重新載入(); });
     找不到那一列（例如已經重畫過、超過 60 秒）就直接執行，不影響原本流程 */
  var lastDel = null, lastDelAt = 0;
  function listItemOf(btn) {
    // 往上找「跟兄弟長得一樣的那一層」＝清單裡的一列；在對話框裡按的（確認鈕）不算
    if (btn.closest(MODAL_SEL) || btn.closest('[style*="position: fixed"]')) return null;
    for (var el = btn; el && el !== document.body; el = el.parentElement) {
      var par = el.parentElement; if (!par || el === btn) continue;
      var hh = el.getBoundingClientRect().height;
      if (hh < 36) continue;
      if (hh > innerHeight * 0.6) return null; // 已經爬到大容器了（例如只剩一筆），寧可不做動畫也不能收合整塊畫面
      var same = 0;
      for (var c = par.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === el.tagName && c.className === el.className) same++;
      if (same >= 2) return el;
    }
    return null;
  }
  // 這個 App 的刪除鈕：紀錄的「✕」（title="作廢"）、快捷金額／獎型的「刪」、系統管理的「刪除」
  var DEL_RE = /刪|作廢|🗑|trash|del[A-Z(_]|delete|remove/i;
  document.addEventListener('click', function (ev) {
    try {
      var btn = ev.target && ev.target.closest && ev.target.closest('button,[onclick],a');
      if (!btn) return;
      var sig = (btn.textContent || '') + ' ' + (btn.className || '') + ' ' + (btn.title || '') + ' ' + (btn.getAttribute('onclick') || '');
      if (!DEL_RE.test(sig)) return;
      var row = listItemOf(btn);
      if (row) { lastDel = row; lastDelAt = Date.now(); }
    } catch (e) {}
  }, true);
  window.fxRemoveThen = function (done) {
    var row = lastDel; lastDel = null;
    if (!row || !row.isConnected || Date.now() - lastDelAt > 60000 || fxReduced() || !row.animate) { done(); return; }
    try {
      var h = row.getBoundingClientRect().height;
      row.style.overflow = 'hidden';
      var a = row.animate([
        { opacity: 1, translate: '0 0', height: h + 'px' },
        { opacity: 0, translate: '-40px 0', height: h + 'px', offset: .55 },
        { opacity: 0, translate: '-40px 0', height: '0px', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px' }
      ], { duration: 380, easing: 'ease-in-out', fill: 'forwards' });
      var fired = false, go = function () { if (!fired) { fired = true; done(); } };
      a.onfinish = go; setTimeout(go, 700);
    } catch (e) { done(); }
  };

  /* ══════════════════════════════════════════════════════════════
     欄位錯誤標示、回到頂端、下拉更新、數字跳動
     ══════════════════════════════════════════════════════════════ */

  /* ── 欄位漏填：那一格紅框＋抖一下＋捲過去（輸入框會順便把游標放進去）
     用法：fxFieldError(元素)；使用者一開始輸入／點它，紅框就消失 */
  window.fxFieldError = function (el) {
    try {
      if (!el) return;
      el.classList.remove('fx-field-err'); void el.offsetWidth; el.classList.add('fx-field-err');
      try { el.scrollIntoView({ block: 'center', behavior: fxReduced() ? 'auto' : 'smooth' }); } catch (e) {}
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { try { el.focus({ preventScroll: true }); } catch (e) {} }
      var clear = function () { el.classList.remove('fx-field-err'); el.removeEventListener('input', clear); el.removeEventListener('click', clear, true); };
      el.addEventListener('input', clear); el.addEventListener('click', clear, true);
      setTimeout(clear, 6000);
      haptic('err');
    } catch (e) {}
  };

  /* ── 按鈕送出中：按下去之後按鈕上轉圈＋換成「送出中…」這類字，暫時不能再按（避免連點）──
     用法：var done = fxButtonBusy(按鈕, '送出中…');  …後端回來之後  done();
     done() 會把按鈕原本的內容、能不能按都還原；按鈕在這之間被重畫掉也沒關係。
     按下去那一下的漣漪（.fx-rip-wrap）留著讓它播完，不算進「原本的內容」 */
  window.fxButtonBusy = function (btn, text) {
    var noop = function () {};
    try {
      if (!btn || btn._fxBusy) return noop;
      var kids = [];
      for (var c = btn.firstChild; c; c = c.nextSibling) {
        if (!(c.classList && c.classList.contains('fx-rip-wrap'))) kids.push(c);
      }
      var label = text || btn.textContent, wasDisabled = btn.disabled;
      var sp = document.createElement('span');
      sp.className = 'fx-btn-spin'; sp.setAttribute('aria-hidden', 'true');
      var tn = document.createTextNode(label);
      kids.forEach(function (k) { btn.removeChild(k); });
      btn.appendChild(sp); btn.appendChild(tn);
      btn._fxBusy = true;
      btn.disabled = true;
      btn.classList.add('fx-btn-busy');
      btn.setAttribute('aria-busy', 'true');
      return function () {
        try {
          if (!btn._fxBusy) return;
          btn._fxBusy = false;
          if (sp.parentNode === btn) btn.removeChild(sp);
          if (tn.parentNode === btn) btn.removeChild(tn);
          kids.forEach(function (k) { btn.appendChild(k); });
          btn.disabled = wasDisabled;
          btn.classList.remove('fx-btn-busy');
          btn.removeAttribute('aria-busy');
        } catch (e) {}
      };
    } catch (e) { return noop; }
  };

  /* ── 回到頂端：往下滑超過一個多畫面才出現（機台一多、報表明細一長時用得到）──
     同一個捲動監聽順便在 <html> 加 fx-scrolled（一離開最上面就加），給固定在上面的標題列畫陰影用 */
  function topInit() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'fx-top'; b.setAttribute('aria-label', '回到頂端'); b.textContent = '⬆';
    b.addEventListener('click', function () { try { window.scrollTo({ top: 0, behavior: fxReduced() ? 'auto' : 'smooth' }); } catch (e) { window.scrollTo(0, 0); } });
    document.body.appendChild(b);
    var on = false, scrolled = false, root = document.documentElement;
    var onScroll = function () {
      var show = window.scrollY > window.innerHeight * 1.2;
      if (show !== on) { on = show; b.classList.toggle('fx-on', show); }
      var s = window.scrollY > 4;
      if (s !== scrolled) { scrolled = s; root.classList.toggle('fx-scrolled', s); }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ── 下拉更新：在最上面往下拉，超過門檻放開就執行 fn（fn 可回傳 Promise，轉圈到它結束）──
     用法：fxPullToRefresh(function(){ return 重新載入(); }, { enabled: function(){ return 現在能不能拉; } })
     enabled 可省略；回傳 false 時手指放上去就不理（例如登入頁、記帳面板輸入到一半）。
     在對話框／輸入框上拉不觸發；同時關掉 Android Chrome 內建的下拉重新整理，避免整頁重載 */
  window.fxPullToRefresh = function (fn, opts) {
    try {
      if (!('ontouchstart' in window)) return;
      document.documentElement.style.overscrollBehaviorY = 'contain';
      var ind = document.createElement('div');
      ind.className = 'fx-ptr'; ind.innerHTML = '<span>↓</span>';
      ind.setAttribute('aria-hidden', 'true');
      document.body.appendChild(ind);
      var startY = null, dist = 0, busy = false, TH = 64;
      var set = function (d, cls) {
        ind.style.transform = 'translate(-50%,' + (d - 52) + 'px) rotate(' + (d * 4) + 'deg)';
        ind.style.opacity = Math.min(1, d / 40);
        ind.className = 'fx-ptr' + (cls ? ' ' + cls : '');
      };
      var reset = function () { startY = null; dist = 0; ind.style.transition = 'transform .25s, opacity .25s'; set(0, ''); setTimeout(function () { ind.style.transition = ''; }, 260); };
      window.addEventListener('touchstart', function (e) {
        if (busy || window.scrollY > 0 || e.touches.length !== 1) return;
        if (opts && typeof opts.enabled === 'function' && !opts.enabled()) return;
        var t = e.target;
        if (t && t.closest && t.closest('[style*="position: fixed"],' + MODAL_SEL + ',input,textarea,select')) return;
        startY = e.touches[0].clientY;
      }, { passive: true });
      window.addEventListener('touchmove', function (e) {
        if (startY === null) return;
        var dy = e.touches[0].clientY - startY;
        if (dy <= 0 || window.scrollY > 0) { if (dist) reset(); else startY = null; return; }
        dist = Math.min(dy * 0.5, 96);
        set(dist, dist >= TH ? 'fx-ready' : '');
      }, { passive: true });
      window.addEventListener('touchend', function () {
        if (startY === null) return;
        if (dist >= TH) {
          busy = true; startY = null; set(TH, 'fx-busy');
          var t0 = Date.now(), done = function () {
            setTimeout(function () { busy = false; reset(); }, Math.max(0, 600 - (Date.now() - t0))); // 至少轉 0.6 秒，看得出有更新
          };
          try { Promise.resolve(fn()).then(done, done); } catch (e) { done(); }
          haptic('ok');
        } else reset();
      }, { passive: true });
    } catch (e) {}
  };

  /* ── 數字跳動 ──
     fxCountFrom(元素, 起始數字, 目標數字, 格式化函式)：從指定的數字跳到目標，0.65 秒。
       app.js 自己記得「上次畫的是多少」，有變才叫這支（第一次出現不跳，直接顯示）。
     fxCountTo(元素, 目標數字, 記憶鍵, 前綴, 後綴)：天鷹版的用法，由這裡記住上次的值（第一次從 0 跳起）；
       第 4 個參數也可以直接給格式化函式，例如 fxCountTo(el, 1200, 'net', money) 會跳成「$1,200」。
     手機開了「減少動態效果」、或數字沒變時，都直接顯示結果。 */
  function countAnim(el, from, to, fmt) {
    if (from === to || fxReduced() || typeof to !== 'number' || typeof from !== 'number' || !isFinite(from)) { el.textContent = fmt(to); return; }
    var t0 = 0, step = function (t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / 650), e = 1 - Math.pow(1 - p, 3);
      // 最後一格用目標值本身（可能有小數），中途的值取整數就好
      el.textContent = p < 1 ? fmt(Math.round(from + (to - from) * e)) : fmt(to);
      if (p < 1) requestAnimationFrame(step);
    };
    el.textContent = fmt(from);
    requestAnimationFrame(step);
  }
  window.fxCountFrom = function (el, from, to, fmt) {
    fmt = fmt || String;
    try { countAnim(el, from, to, fmt); } catch (e) { el.textContent = fmt(to); }
  };
  var countMem = {};
  window.fxCountTo = function (el, to, key, pre, suf) {
    var fmt = typeof pre === 'function' ? pre : function (n) { return (pre || '') + n + (suf || ''); };
    try {
      var from = key && countMem[key] !== undefined ? countMem[key] : (el._fxLast !== undefined ? el._fxLast : 0);
      if (key) countMem[key] = to; el._fxLast = to;
      countAnim(el, from, to, fmt);
    } catch (e) { el.textContent = fmt(to); }
  };
  // 容器內所有 [data-fx-count] 一起跳
  window.fxCountUpIn = function (root, prefix) {
    try {
      var list = (root || document).querySelectorAll('[data-fx-count]');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        window.fxCountTo(el, Number(el.getAttribute('data-fx-count')), (prefix || '') + (el.getAttribute('data-fx-key') || i));
      }
    } catch (e) {}
  };

  function lateInit() { try { topInit(); } catch (e) {} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', lateInit); else lateInit();

  window.addEventListener('resize', realignAll);
  window.addEventListener('load', realignAll);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(realignAll);
})();
