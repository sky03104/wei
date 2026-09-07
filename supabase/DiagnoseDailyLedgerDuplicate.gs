/**
 * 一次性診斷工具：找出 DailyLedger 分頁裡 ledger_id 重複的列。
 *
 * 跟 DiagnoseBizDaysDuplicate.gs 同一個成因：多個地方（即時推送、定期
 * 安全網、手動搬遷腳本…）沒互相協調、各自判斷「這筆還不存在」而各自
 * 插入一次，造成同一個 ledger_id 出現兩列以上。
 *
 * 用法：
 * 1. 貼進「娃娃機資料庫版GAS」專案（跟其他幾份放一起）
 * 2. 執行 diagnoseDuplicateDailyLedger()（唯讀，不會改資料）
 * 3. 到執行記錄看結果：印出重複的 ledger_id、各自在第幾列、
 *    business_date／週轉金／台主給／台主領／更新時間，方便判斷哪一列
 *    才是最新、正確的那份
 *
 * 故意不附自動刪除的函式：DailyLedger 每一列代表「當時設定的今日數字」，
 * 兩列如果金額不一樣，代表的可能是先後兩次不同的輸入，得看內容判斷
 * 該留哪一列（通常是 updated_at 比較新的那筆），不能無腦自動處理。
 */

function diagnoseDuplicateDailyLedger() {
  const rows = dbReadAll('DailyLedger');
  const byId = {};
  rows.forEach(function (r) {
    (byId[r.ledger_id] = byId[r.ledger_id] || []).push(r);
  });

  const dupIds = Object.keys(byId).filter(function (id) { return byId[id].length > 1; });

  Logger.log('DailyLedger 目前總列數：' + rows.length);
  Logger.log('重複的 ledger_id 數量：' + dupIds.length);

  dupIds.forEach(function (id) {
    Logger.log('── ledger_id=' + id + '（出現 ' + byId[id].length + ' 次）──');
    byId[id].forEach(function (r) {
      Logger.log(
        '  第 ' + r._row + ' 列：business_date=' + r.business_date +
        '、週轉金=' + r.turnover + '、台主給(舊)=' + r.given_to_owner + '、台主領(舊)=' + r.taken_by_owner +
        '、432=' + r.manual_432 + '、441=' + r.manual_441 + '、活動支出=' + r.manual_expense +
        '、更新人=' + r.updated_by + '、更新時間=' + r.updated_at
      );
    });
  });

  if (!dupIds.length) {
    Logger.log('沒有發現重複的 ledger_id。');
  }
}
