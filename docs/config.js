/**
 * 唯一需要你手動填的地方。
 *
 * 貼上 Google Apps Script 部署後拿到的 Web App 網址（結尾是 /exec）。
 * 例：https://script.google.com/macros/s/AKfycbx..................../exec
 *
 * 這個網址是公開的沒關係 —— 沒有帳號密碼就拿不到任何資料。
 * 反過來說，試算表 ID、密碼、任何金鑰都不要寫在這個檔案裡。
 */
window.APP_CONFIG = {
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycbwSs43_EcQjZSrNqHjq1OF0dMPYNTj_MTrvjgQTgx1gDHq6A8wgWCWpKS4NnGMbNaw29A/exec',

  // ── Phase 5 雙軌驗證（supabase/MIGRATION_PLAN.md）───────
  // BACKEND 保持 'gas' 就跟現在完全一樣，走原本的 GAS/Sheets 路徑。
  // 要切去測試 Supabase 後端時改成 'supabase'，並填好下面兩個值
  // （Supabase 專案的 Settings → API Keys：Project URL／anon public
  // key，anon key 是公開的沒關係，真正的權限控管在資料庫的 RLS）。
  BACKEND: 'gas',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: ''
};
