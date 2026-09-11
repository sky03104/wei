/**
 * 一次性診斷工具：自動比對「今天營業日開始之後」試算表跟 Supabase 的
 * record_id 清單，直接印出差異（哪邊有、哪邊沒有），不用肉眼比對。
 *
 * 用法：貼進已經設定過 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 的
 * GAS 專案，執行 diffTodayRecords()，去執行記錄看結果。
 */
function diffTodayRecords() {
  const bizRows = dbReadAll('BizDays');
  const last = bizRows.reduce(function (a, b) { return (b._row || 0) > (a._row || 0) ? b : a; });
  Logger.log('目前營業日 opened_at=' + last.opened_at + '（biz_id=' + last.biz_id + '）');

  const sheetIds = {};
  dbReadAll('Records').forEach(function (r) {
    if (String(r.created_at) >= String(last.opened_at)) sheetIds[r.record_id] = r;
  });
  Logger.log('試算表：' + Object.keys(sheetIds).length + ' 筆');

  const cfg = _sbPushConfig();
  const headers = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
  const url = cfg.url + '/rest/v1/records?select=record_id,machine_id,type,prize_name,amount,voided,created_at'
    + '&created_at=gte.' + encodeURIComponent(last.opened_at) + '&order=created_at.asc';
  const resp = UrlFetchApp.fetch(url, { method: 'GET', headers: headers, muteHttpExceptions: true });
  if (resp.getResponseCode() >= 300) {
    Logger.log('查詢 Supabase 失敗：' + resp.getContentText());
    return;
  }
  const sbRows = JSON.parse(resp.getContentText() || '[]');
  const sbIds = {};
  sbRows.forEach(function (r) { sbIds[r.record_id] = r; });
  Logger.log('Supabase：' + sbRows.length + ' 筆');

  const onlyInSheet = Object.keys(sheetIds).filter(function (id) { return !sbIds[id]; });
  const onlyInSb = Object.keys(sbIds).filter(function (id) { return !sheetIds[id]; });

  Logger.log('── 只在試算表、Supabase 沒有的（' + onlyInSheet.length + ' 筆）──');
  onlyInSheet.forEach(function (id) {
    const r = sheetIds[id];
    Logger.log(id + '｜' + r.machine_id + '｜' + r.type + '｜' + (r.prize_name || '') + '｜' + r.amount + '｜voided=' + r.voided + '｜created_at=' + r.created_at);
  });

  Logger.log('── 只在 Supabase、試算表沒有的（' + onlyInSb.length + ' 筆）──');
  onlyInSb.forEach(function (id) {
    const r = sbIds[id];
    Logger.log(id + '｜' + r.machine_id + '｜' + r.type + '｜' + (r.prize_name || '') + '｜' + r.amount + '｜voided=' + r.voided + '｜created_at=' + r.created_at);
  });

  // 兩邊都有、但內容（作廢狀態）不一致的，也一起列出來，方便一次抓完。
  Logger.log('── 兩邊都有、但 voided 狀態不一致的 ──');
  Object.keys(sheetIds).forEach(function (id) {
    const sbR = sbIds[id];
    if (!sbR) return;
    const sheetVoided = toBool(sheetIds[id].voided);
    const sbVoided = !!sbR.voided;
    if (sheetVoided !== sbVoided) {
      Logger.log(id + '：試算表 voided=' + sheetVoided + '，Supabase voided=' + sbVoided);
    }
  });
}
