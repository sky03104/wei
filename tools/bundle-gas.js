/**
 * tools/bundle-gas.js — 把 apps-script/*.gs 合併成一份可以整包貼上的檔案
 *
 *   node tools/bundle-gas.js
 *
 * apps-script/ 底下維持 6 個分開的檔案是給你（或我）方便閱讀維護用的；
 * GAS 執行時本來就會把同一個專案裡的所有 .gs 檔案當成同一個共用作用域，
 * 分不分檔案對執行結果完全沒差——所以合併成一份不會改變任何行為，
 * 純粹是省去「開六次『+ 新增指令碼』」這個部署步驟。
 *
 * 這份輸出檔（apps-script/dist/Code.gs）是自動產生的，不要手動編輯：
 * 改動請一律改 apps-script/*.gs 這 6 個原始檔，再重跑這支腳本。
 * `npm test` 會檢查合併檔案是不是最新版本，忘記重跑會直接測試失敗。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'apps-script');
const OUT_DIR = path.join(SRC_DIR, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'Code.gs');

// 執行順序不影響結果（GAS 是共用作用域），這裡照「資料層 → 邏輯層 → 進入點 → 測試」排，
// 純粹是讓人讀合併後的檔案時比較順。
const FILES = ['Db.gs', 'Auth.gs', 'Service.gs', 'SupabasePush.gs', 'SupabaseWebhook.gs', 'Reports.gs', 'Archive.gs', 'Code.gs', 'Test.gs'];

function divider(name) {
  const bar = '// ' + '─'.repeat(60);
  return bar + '\n// ' + name + '\n' + bar;
}

function bundle() {
  const parts = [
    '/**',
    ' * 娃娃機管理系統 — 後端（自動合併版）',
    ' *',
    ' * 這份檔案是自動產生的，請勿手動編輯。',
    ' * 原始碼分成 6 個檔案維護：apps-script/Db.gs, Auth.gs, Service.gs,',
    ' * Reports.gs, Code.gs, Test.gs —— 需要改動時請改那 6 個檔案，',
    ' * 再執行 `node tools/bundle-gas.js`（或 `npm run bundle`）重新產生這份檔案。',
    ' *',
    ' * 部署方式：把這份檔案的內容整個貼進 GAS 專案唯一的 Code.gs，',
    ' * 詳細步驟見 guide/DEPLOY.md。',
    ' */',
    ''
  ];

  FILES.forEach((name) => {
    const content = fs.readFileSync(path.join(SRC_DIR, name), 'utf8').replace(/\s+$/, '');
    parts.push(divider(name));
    parts.push(content);
    parts.push('');
  });

  return parts.join('\n') + '\n';
}

function main() {
  const output = bundle();

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
    if (current !== output) {
      console.error('❌ apps-script/dist/Code.gs 不是最新的。');
      console.error('   改了 apps-script/*.gs 之後，記得執行 npm run bundle 重新產生合併檔案。');
      process.exit(1);
    }
    console.log('✅ apps-script/dist/Code.gs 是最新的');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, output);
  console.log('已產生 ' + path.relative(path.join(__dirname, '..'), OUT_FILE)
    + '（' + output.split('\n').length + ' 行）');
}

main();
