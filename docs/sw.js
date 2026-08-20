/**
 * Service Worker
 *
 * 兩條規則，分得很清楚：
 *   1. App 本身的檔案（HTML/CSS/JS/圖示）→ 快取優先，所以離線也開得起來、開啟速度快。
 *   2. 打去 GAS 的 API → 一律直接連網，永不快取。
 *      帳目數字吃到快取會看到假的收益，這條線不能跨。
 *
 * 改版流程：每次前端有異動就把 CACHE_VERSION 加一，
 * 使用者的 App 會偵測到新版並跳出「有新版本」提示。
 */

const CACHE_VERSION = 'v6';
const CACHE_NAME = 'claw-shell-' + CACHE_VERSION;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 跨網域的一律不碰（含 GAS API）
  if (url.origin !== self.location.origin) return;

  // config.js 走網路優先，換後端網址時不用等快取過期
  if (url.pathname.endsWith('/config.js')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // 導覽請求離線時退回 App 外殼，至少畫面開得起來
          if (req.mode === 'navigate') return caches.match('./index.html');
          throw new Error('offline');
        });
    })
  );
});
