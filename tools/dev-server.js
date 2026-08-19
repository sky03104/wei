/**
 * tools/dev-server.js — 本機開發／測試伺服器
 *
 *   node tools/dev-server.js [port]
 *
 * 做兩件事：
 *   1. 把 docs/ 當靜態網站服務（也就是 GitHub Pages 上會跑的那份前端）
 *   2. 在 /api 提供一個假的 GAS 後端，直接呼叫 apps-script/*.gs 的 handleApi()
 *
 * config.js 會被動態換掉，把 GAS_API_URL 指到 /api，
 * 所以不用改任何檔案就能在本機看到完整的 App。
 *
 * 這是開發工具，不會被部署到 GitHub Pages（Pages 只吃 docs/）。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGasSandbox } = require('./gas-env');

const PORT = Number(process.argv[2]) || 8080;
const DOCS = path.join(__dirname, '..', 'docs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const gas = createGasSandbox({ spreadsheetName: '本機開發資料' });

// 建好分頁、管理員帳號與預設快捷金額／獎型
gas.sandbox.__setupProps = null;
gas.run("PropertiesService.getScriptProperties().setProperty('INITIAL_ADMIN_USERNAME', 'admin')");
gas.run("PropertiesService.getScriptProperties().setProperty('INITIAL_ADMIN_PASSWORD', 'admin123')");
console.log(gas.run('setup()'));

// 準備一組示範資料，方便一開啟就有東西看
function seed() {
  const login = gas.call('handleApi', { action: 'login', username: 'admin', password: 'admin123', remember: true });
  const token = login.data.token;
  const call = (payload) => gas.call('handleApi', Object.assign({ token }, payload));

  const a = call({ action: 'adminSaveMachine', name: '一號機（吊臂）', location: '門口左側', color: '#4F7BE8', sortOrder: 1 }).data.machineId;
  const b = call({ action: 'adminSaveMachine', name: '二號機（娃娃）', location: '門口右側', color: '#E8574F', sortOrder: 2 }).data.machineId;
  call({ action: 'adminSaveMachine', name: '三號機（維修）', location: '角落', color: '#FBBF24', status: 'maintenance', sortOrder: 3 });

  call({ action: 'addRecord', machineId: a, type: 'in', amount: 500, clientToken: 'seed1' });
  call({ action: 'addRecord', machineId: a, type: 'out', amount: 50, clientToken: 'seed2' });
  call({ action: 'addRecord', machineId: b, type: 'in', amount: 320, clientToken: 'seed3' });

  call({ action: 'adminSaveUser', username: 'patrol1', displayName: '阿明（巡邏）', role: 'patrol', password: 'patrol123' });
  const owner = call({ action: 'adminSaveUser', username: 'owner1', displayName: '林老闆（台主）', role: 'owner', password: 'owner123' }).data.userId;
  call({ action: 'adminSetPermission', userId: owner, machineId: a, granted: true });

  console.log('示範帳號：admin/admin123（管理員）、patrol1/patrol123（巡邏）、owner1/owner123（台主，只授權一號機）');
}
seed();

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api') {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let result;
      try {
        const params = new URLSearchParams(raw);
        result = gas.call('handleApi', JSON.parse(params.get('payload') || '{}'));
      } catch (err) {
        result = { ok: false, error: err.message, code: 'ERROR' };
      }
      send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
    });
    return;
  }

  // 把後端網址指到本機，不用改動 repo 裡的 config.js
  if (url.pathname === '/config.js') {
    return send(res, 200, "window.APP_CONFIG = { GAS_API_URL: '/api' };\n", MIME['.js']);
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(DOCS, rel);
  if (!file.startsWith(DOCS)) return send(res, 403, 'forbidden');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log('開發伺服器：http://localhost:' + PORT);
});
