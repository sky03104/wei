/**
 * 一次性診斷工具：查指定的 record_id 清單，在試算表的「紀錄」分頁裡
 * voided 欄位是不是也已經同步成 TRUE。
 *
 * 用法：
 * 1. 貼進要查的那個 GAS 專案（main 或「娃娃機資料庫版GAS」都可以，
 *    兩邊讀的是同一份試算表）
 * 2. 把下面 RECORD_IDS 換成從 Supabase 查到、要核對的 record_id 清單
 * 3. 執行 checkRecordsVoidedSync()，去執行記錄看結果
 */

const RECORD_IDS_TO_CHECK = [
  'rec_35274048a8314138',
  'rec_ca7febc1c3dc4ea6',
  'rec_44c1134e393b433e',
  'rec_2558495f96474ca9',
  'rec_bea6604c7b66491f',
  'rec_970cb4d6f2c44097',
  'rec_2890ac09973e4d9c'
];

function checkRecordsVoidedSync() {
  const rows = dbReadAll('Records');
  const byId = {};
  rows.forEach(function (r) { byId[r.record_id] = r; });

  RECORD_IDS_TO_CHECK.forEach(function (id) {
    const r = byId[id];
    if (!r) {
      Logger.log('❌ ' + id + '：試算表裡根本找不到這筆紀錄');
      return;
    }
    const status = toBool(r.voided) ? '✅ 已作廢' : '⚠️ 還沒作廢（沒同步到）';
    Logger.log(id + '（第 ' + r._row + ' 列，機台=' + r.machine_id + '）：' + status);
  });
}
