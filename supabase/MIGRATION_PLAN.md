# Supabase 遷移計畫

這份文件記錄「把資料庫從 Google Sheets（GAS 後端）換成 Supabase（Postgres）」
這件事怎麼分階段做、目前做到哪、每一步要注意什麼。跟 main 分支完全獨立
開發，遷移完成、驗證過確定沒問題之前，main 上的 GAS + Sheets 系統照常
運作，不受影響。

## 為什麼要換

現在的架構（`docs/app.js` → GAS `doPost` → Google Sheets）在讀取效能上
有一個結構性限制：`dbReadAll()`（`apps-script/Db.gs`）每次都是把整張分頁
讀進記憶體再用 JS 篩選，不是資料庫的索引查詢——效能是跟著「分頁累計
筆數」變慢，不是跟著「查詢區間大小」。現有系統靠兩招緩解：

1. **季度封存**（`apps-script/Archive.gs`）：把上一季以前的紀錄搬到獨立
   分頁，讓「紀錄」分頁只留最近一季。
2. **跨執行快取**（`apps-script/Db.gs` 的 `CacheService` 那層，2026-08
   加的）：短時間內重複的讀取直接吃快取，不用每次都真的打 Sheets API。

這兩招都是「繞開」限制，不是解決限制本身。換成真正的資料庫（Postgres）
之後，`records` 表用 `(machine_id, business_date)` 索引，查詢只掃需要的
那幾筆，資料量再大也不會變慢，季度封存這套機制可以整個拿掉。

## 階段規劃

- [x] **Phase 1：Schema 設計**（`supabase/schema.sql`）——把 `apps-script/Db.gs`
      的 `SCHEMA` 逐表翻譯成 Postgres 表，欄位型別對應好，`records` 表
      加上索引。目前完成，還沒接上任何真的 Supabase 專案。
- [ ] **Phase 2：Auth & 權限模型定案**——這是整個遷移風險最高的一塊，見
      下面單獨一節，要先想清楚再往下做，不然後面的 API 層會做兩次。
- [ ] **Phase 3：後端邏輯搬家**——把 `Service.gs`／`Reports.gs`／`Archive.gs`
      裡的商業邏輯（權限檢查、淨收益公式、營業日邊界、報表彙總、
      對帳表格線）重寫成 Supabase Edge Functions（TypeScript/Deno）。
      逐一對照每一支 `action`（見 `apps-script/Code.gs` 的 `ACTION_ROLES`／
      `_dispatch`），確保新舊兩邊算出來的數字一致。
- [ ] **Phase 4：資料遷移腳本**——把現有 Sheets（含已經封存到別的分頁的
      舊資料）讀出來，寫進新的 Postgres 表；日期／金額欄位要注意 Sheets
      那些「自動轉型」的坑（`apps-script/Db.gs` 的 `_fixTextColumnFormatting`／
      `_migrateRecordsMeterColumns` 修過的那幾類問題）不要帶過去。
- [ ] **Phase 5：前端改接**——`docs/app.js` 的 `api()` 目前是打 GAS 的
      `doPost`（form-urlencoded），換成打 Supabase 的 REST/RPC 或 Edge
      Function，每個 `action` 對應關係盡量不變，把改動範圍限制在
      `api()` 這一支函式，其餘畫面邏輯不用跟著大改。
- [ ] **Phase 6：雙軌驗證＋切換**——新舊系統並行一段時間（兩邊都寫入，
      只從舊系統讀，比對兩邊算出來的數字），確認一致才正式切過去；
      切換之後 Sheets 資料保留一段時間當備份，不要立刻刪。

## Auth & RLS——先想清楚再做

現有系統是**自製**帳密登入＋session token（`apps-script/Auth.gs`），
不是 Supabase Auth（`auth.users`／`auth.uid()`）。這代表 `supabase/schema.sql`
裡雖然每張表都開了 Row Level Security，但**目前故意沒有寫任何 policy**——
在決定怎麼處理 auth 之前先寫死 policy，遷移到一半很可能要整套重寫。

兩條路可以選，要先決定：

1. **繼續自製 auth，權限檢查留在後端（Edge Function）**：前端不直接碰
   Supabase 資料庫，一律透過 Edge Function（用 service role key），跟
   現在 GAS 的角色一樣，只是換一個執行環境。RLS policy 可以留空或設成
   「只有 service role 能碰」，權限邏輯（`assertMachineAccess`／
   `visibleMachineIds` 這些）原封不動搬過去。**風險最低、跟現有邏輯最
   接近**，是目前建議的方向。
2. **改用 Supabase Auth，前端直連資料庫，靠 RLS 做權限控管**：能讓前端
   讀取直接打資料庫、省掉一層 API 轉發，讀取會更快，但要把「管理員／
   巡邏／台主」這套角色＋「台主只看得到被授權的機台」這種需要 JOIN
   `permissions` 表的權限邏輯，整個改寫成 RLS policy（用 Postgres 的
   `current_setting`／自訂 JWT claims），還要把現有帳號的密碼／session
   遷移到 Supabase Auth。**改動範圍最大，但長期效能最好**。

## 目前風險與待決定事項

- **Phase 2 還沒定案**：走哪一條 auth 路線會決定 Edge Function 怎麼寫、
  RLS policy 怎麼寫，是接下來第一件要拍板的事。
- `records.client_token` 設了 `unique` 約束，直接對應 `addRecord` 的
  冪等去重邏輯（同一個 clientToken 送兩次只寫一筆）——比原本 Sheets
  版本（程式手動查重）更省事，但要確認前端每次送出真的都帶新的
  clientToken，不然合法的兩筆不同紀錄可能撞號被擋。
- 季度封存機制（`封存_2026Q1` 這種額外分頁）在新架構完全不需要，
  `carry_in`/`carry_out`/... 這幾欄只是遷移過渡用，新資料寫入不會
  再往上加——遷移完成後要不要整個拿掉這幾欄，等 Phase 4 資料遷移
  跑完、確認新系統穩定運作一段時間後再決定。
- 目前 `supabase/` 底下還沒有實際連上任何 Supabase 專案（沒有
  `.env`、沒有 project ref、沒有跑過 `supabase db push`）——Phase 1
  只是把 schema 設計寫好，還沒真的建立任何雲端資源。
