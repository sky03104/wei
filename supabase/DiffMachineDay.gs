/**
 * 一次性診斷工具：指定機台名稱＋業務日期，把試算表跟 Supabase 兩邊
 * 的原始紀錄都抓出來，自動比對差異，不用肉眼看格子猜。
 *
 * 用法：貼進已經設定過 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 的
 * GAS 專案，改下面 MACHINE_NAME／TARGET_DATE，執行 diffMachineDay()，
 * 去執行記錄看結果。
 */
const MACHINE_NAME = '13展';
const TARGET_DATE = '2026-09-11';

function diffMachineDay() {
  const machine = dbReadAll('Machines').filter(function (m) { return String(m.name) === MACHINE_NAME; })[0];
  if (!machine) { Logger.log('❌ 試算表裡找不到機台名稱=' + MACHINE_NAME); return; }
  Logger.log('機台=' + MACHINE_NAME + '（machine_id=' + machine.machine_id + '）');

  const sheetRows = dbReadAll('Records').filter(function (r) {
    return String(r.machine_id) === String(machine.machine_id) && String(r.business_date) === TARGET_DATE;
  });
  const sheetById = {};
  sheetRows.forEach(function (r) { sheetById[r.record_id] = r; });
  Logger.log('試算表：' + sheetRows.length + ' 筆（' + TARGET_DATE + '）');

  const cfg = _sbPushConfig();
  const headers = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
  const url = cfg.url + '/rest/v1/records?select=record_id,type,amount,voided,voided_at,business_date,created_at'
    + '&machine_id=eq.' + encodeURIComponent(machine.machine_id)
    + '&business_date=eq.' + TARGET_DATE
    + '&order=created_at.asc';
  const resp = UrlFetchApp.fetch(url, { method: 'GET', headers: headers, muteHttpExceptions: true });
  if (resp.getResponseCode() >= 300) { Logger.log('查詢 Supabase 失敗：' + resp.getContentText()); return; }
  const sbRows = JSON.parse(resp.getContentText() || '[]');
  const sbById = {};
  sbRows.forEach(function (r) { sbById[r.record_id] = r; });
  Logger.log('Supabase：' + sbRows.length + ' 筆（' + TARGET_DATE + '）');

  const allIds = {};
  Object.keys(sheetById).forEach(function (id) { allIds[id] = true; });
  Object.keys(sbById).forEach(function (id) { allIds[id] = true; });

  Logger.log('── 逐筆比對 ──');
  Object.keys(allIds).forEach(function (id) {
    const s = sheetById[id];
    const b = sbById[id];
    if (s && !b) {
      Logger.log('⚠ 只在試算表：' + id + '｜' + s.type + '｜amount=' + s.amount + '｜voided=' + s.voided);
    } else if (!s && b) {
      Logger.log('⚠ 只在 Supabase：' + id + '｜' + b.type + '｜amount=' + b.amount + '｜voided=' + b.voided);
    } else {
      const sVoided = toBool(s.voided);
      const bVoided = !!b.voided;
      const amountMismatch = String(s.amount) !== String(b.amount);
      if (sVoided !== bVoided || amountMismatch) {
        Logger.log('⚠ 不一致：' + id + '｜type=' + s.type
          + '｜試算表 amount=' + s.amount + ' voided=' + sVoided
          + '｜Supabase amount=' + b.amount + ' voided=' + bVoided);
      }
    }
  });
  Logger.log('比對完成。');
}
