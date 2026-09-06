/**
 * 一次性診斷工具：找出 BizDays 分頁裡 biz_id 重複的列。
 *
 * migrateToSupabase() 執行到 biz_days 這一段時，如果同一批要 upsert 的
 * 資料裡有兩列 biz_id 完全一樣，Postgres 會直接報錯
 * 「ON CONFLICT DO UPDATE command cannot affect row a second time」，
 * 整批（包含後面的 daily_ledger、records）都不會寫入。
 *
 * 用法：
 * 1. 貼進「娃娃機資料庫版GAS」專案（跟其他幾份放一起）
 * 2. 執行 diagnoseDuplicateBizDays()（唯讀，不會改資料）
 * 3. 到執行記錄看結果：印出重複的 biz_id、各自在第幾列、
 *    business_date／opened_at／closed_at，方便判斷哪一列是誤存的重複、
 *    哪一列才是真正要保留的
 *
 * 故意不附自動刪除的函式：BizDays 不像 Records 那樣「刪掉多的、留最早
 * 那筆」一定安全——重複的兩列如果 closed_at 不一樣（例如一列有結單、
 * 一列沒有），代表的可能是真實的操作歷史，得看過內容再決定刪哪一列，
 * 不能無腦自動處理。
 */

function diagnoseDuplicateBizDays() {
  const rows = dbReadAll('BizDays');
  const byId = {};
  rows.forEach(function (r) {
    (byId[r.biz_id] = byId[r.biz_id] || []).push(r);
  });

  const dupIds = Object.keys(byId).filter(function (id) { return byId[id].length > 1; });

  Logger.log('BizDays 目前總列數：' + rows.length);
  Logger.log('重複的 biz_id 數量：' + dupIds.length);

  dupIds.forEach(function (id) {
    Logger.log('── biz_id=' + id + '（出現 ' + byId[id].length + ' 次）──');
    byId[id].forEach(function (r) {
      Logger.log(
        '  第 ' + r._row + ' 列：business_date=' + r.business_date +
        '、opened_at=' + r.opened_at + '、opened_by=' + r.opened_by +
        '、closed_at=' + (r.closed_at || '（進行中）') +
        '、closed_by=' + (r.closed_by || '') +
        '、auto_closed=' + r.auto_closed
      );
    });
  });

  if (!dupIds.length) {
    Logger.log('沒有發現重複的 biz_id。');
  }
}
