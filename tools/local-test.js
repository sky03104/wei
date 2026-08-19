/**
 * tools/local-test.js — 在本機跑後端自我測試
 *
 *   node tools/local-test.js            用分開的原始檔（apps-script/*.gs）測試
 *   node tools/local-test.js --bundle   用合併後的單一檔案（apps-script/dist/Code.gs）測試
 *
 * 用 tools/gas-env.js 模擬 Apps Script 環境，執行 apps-script/Test.gs 的 runSelfTest()。
 * 改完後端先跑這支，確定邏輯沒破再貼到 GAS。
 *
 * 兩種模式都要能通過：分開檔案模式測的是你正在改的原始碼，
 * 合併檔案模式測的是實際會貼給使用者的那份成品——兩者理論上該完全等價
 * （GAS 本來就把同專案的所有檔案當同一個作用域執行），但直接測一次成品更放心。
 */

'use strict';

const path = require('path');
const { createGasSandbox } = require('./gas-env');

const useBundle = process.argv.includes('--bundle');
const opts = useBundle
  ? { bundlePath: path.join(__dirname, '..', 'apps-script', 'dist', 'Code.gs') }
  : {};

const gas = createGasSandbox(opts);
const report = gas.run('runSelfTest()');
console.log((useBundle ? '[合併檔案版本] ' : '[分開檔案版本] ') + '\n' + report);
process.exit(/❌/.test(report) ? 1 : 0);
