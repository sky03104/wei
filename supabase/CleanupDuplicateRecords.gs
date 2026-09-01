/**
 * 一次性清理工具：修正 SyncFromSupabase.gs 早期版本的 bug 造成的
 * Records 分頁重複列（同一個 record_id 出現兩次以上）。
 *
 * 用法：
 * 1. 貼進「娃娃機資料庫版GAS」專案（跟其他幾份放一起）
 * 2. 先執行 diagnoseDuplicateRecords()（唯讀，不會改資料），看執行記錄
 *    確認重複的規模
 * 3. 確認後執行 cleanupDuplicateRecords()，把多出來的重複列刪掉
 *    （保留每個 record_id 最早出現的那一列——也就是原本就在試算表裡
 *    的那一份，刪掉後來被誤插入的重複份）
 * 4. 清理完成後，這份檔案可以整個刪掉，不影響正式功能
 */

function diagnoseDuplicateRecords() {
  const rows = dbReadAll('Records');
  const seen = {};
  const dupExtra = {};
  rows.forEach(function (r) {
    if (seen[r.record_id]) {
      dupExtra[r.record_id] = (dupExtra[r.record_id] || 1) + 1;
    } else {
      seen[r.record_id] = true;
    }
  });
  const dupIdCount = Object.keys(dupExtra).length;
  let extraRows = 0;
  Object.keys(dupExtra).forEach(function (id) { extraRows += dupExtra[id] - 1; });

  Logger.log('Records 目前總列數：' + rows.length);
  Logger.log('有重複的 record_id 數量：' + dupIdCount);
  Logger.log('多出來的重複列數（清理時會被刪掉）：' + extraRows);
  Logger.log('清理後預期剩下：' + (rows.length - extraRows) + ' 列');
}

function cleanupDuplicateRecords() {
  const rows = dbReadAll('Records');
  const firstSeenRow = {};
  const rowsToDelete = [];
  rows.forEach(function (r) {
    if (firstSeenRow[r.record_id] === undefined) {
      firstSeenRow[r.record_id] = r._row;
    } else {
      rowsToDelete.push(r._row);
    }
  });

  if (!rowsToDelete.length) {
    Logger.log('沒有發現重複的紀錄，不用清理。');
    return;
  }

  Logger.log('準備刪除 ' + rowsToDelete.length + ' 列重複紀錄（保留每個 record_id 最早出現的那一列）...');
  dbDeleteRows('Records', rowsToDelete);
  Logger.log('✓ 清理完成，刪除了 ' + rowsToDelete.length + ' 列。');
  Logger.log('建議接著重新執行一次 diagnoseDuplicateRecords() 確認結果是 0。');
}
