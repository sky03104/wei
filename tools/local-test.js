/**
 * tools/local-test.js — 在本機跑後端自我測試
 *
 *   node tools/local-test.js
 *
 * 用 tools/gas-env.js 模擬 Apps Script 環境，執行 apps-script/Test.gs 的 runSelfTest()。
 * 改完後端先跑這支，確定邏輯沒破再貼到 GAS。
 */

'use strict';

const { createGasSandbox } = require('./gas-env');

const gas = createGasSandbox();
const report = gas.run('runSelfTest()');
console.log(report);
process.exit(/❌/.test(report) ? 1 : 0);
