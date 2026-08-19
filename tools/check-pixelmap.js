/**
 * tools/check-pixelmap.js — 確認像素圖案沒有走鐘
 *
 *   node tools/check-pixelmap.js
 *
 * 娃娃機圖案存在兩個地方：
 *   tools/pixel-machine.txt  給 make-icons.py 產 App 圖示用
 *   docs/app.js 的 PIXEL_MACHINE  給畫面上的 SVG 用
 *
 * 兩邊必須一致，App 圖示才會跟畫面裡的娃娃機長得一樣。
 * 只改一邊是很容易發生的事，所以用這支把它擋下來。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const canonical = fs.readFileSync(path.join(root, 'tools', 'pixel-machine.txt'), 'utf8')
  .split('\n')
  .map((l) => l.replace(/\r$/, ''))
  .filter((l) => l.trim() && !l.trimStart().startsWith('#'));

const appJs = fs.readFileSync(path.join(root, 'docs', 'app.js'), 'utf8');
const block = /const PIXEL_MACHINE = \[([\s\S]*?)\];/.exec(appJs);
if (!block) {
  console.error('❌ 在 docs/app.js 找不到 PIXEL_MACHINE');
  process.exit(1);
}
const inApp = (block[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));

const problems = [];

if (canonical.length !== inApp.length) {
  problems.push('列數不同：pixel-machine.txt 有 ' + canonical.length + ' 列，app.js 有 ' + inApp.length + ' 列');
} else {
  canonical.forEach((line, i) => {
    if (line !== inApp[i]) {
      problems.push('第 ' + (i + 1) + ' 列不同：\n    txt: ' + line + '\n    js : ' + inApp[i]);
    }
  });
}

const widths = new Set(canonical.map((l) => l.length));
if (widths.size !== 1) problems.push('每列寬度必須一致，實際有 ' + [...widths].join(', '));

if (problems.length) {
  console.error('❌ 像素圖案不一致：');
  problems.forEach((p) => console.error('  - ' + p));
  console.error('\n改完圖案後，記得兩邊都更新，並重跑 python3 tools/make-icons.py');
  process.exit(1);
}

console.log('✅ 像素圖案一致（' + canonical.length + ' × ' + canonical[0].length + '）');
