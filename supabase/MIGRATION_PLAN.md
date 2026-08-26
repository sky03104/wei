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
      加上索引。
- [x] **Phase 2：Auth & 權限模型——已拍板，走「前端直連 + RLS」**（見下面
      單獨一節）。`profiles` 表＋`supabase/policies.sql` 的 helper function
      跟每張表的 policy 已經寫好，對照的是 `apps-script/Code.gs` 的
      `ACTION_ROLES` 跟 `Service.gs` 的 `canRecord()`／`isAdmin()`／
      `visibleMachineIds()`。還沒接上任何真的 Supabase 專案跑過，也還沒
      實作「新增帳號」「username 登入」這兩塊（policies.sql 底部有寫
      設計、註解掉的 SQL，等真的接專案時再拉出來套用＋測試）。
- [~] **Phase 3：業務邏輯搬進 Postgres function（`rpc()`），前端再改接**——
      決定：`Service.gs`／`Reports.gs` 裡不是單純 CRUD、需要「算出來」
      的邏輯（淨收益公式、跨夜營業日邊界、報表彙總、對帳表格線）搬成
      Postgres SQL/plpgsql function，前端用 Supabase client SDK 的
      `.rpc()` 呼叫，取代原本打 GAS `doPost` 的 `action`；純 CRUD（讀
      機台列表、寫一筆紀錄）才直接用 `.from(...).select()/.insert()`，
      不需要包一層 function。
      **已完成**（`supabase/functions.sql`）：`today_key()`／
      `open_biz_day()`／`current_business_date()`／
      `relevant_biz_day_for_today()`／`is_today_record()`——這是整個
      系統「跨夜營業日」邏輯的地基，其餘所有需要算「今日」「本週」的
      端點都靠這幾支；`resolve_week_range()` 對照 `resolveRange('week')`；
      `machine_today_and_week(machine_id)` 對照 `_buildMachineDetail()`，
      是第一個完整搬過去的「端點等級」function，示範這一整套模式怎麼用
      （SECURITY INVOKER，讓 RLS 照樣套用在裡面查的 `records`／
      `biz_days`；額外用 `can_see_machine()` 明確擋掉沒權限的呼叫，
      不是讓它默默算出全部是 0）。已經在本機 Postgres 用最小的
      `auth.users`/`auth.uid()` stub 實測過，包含模擬跨夜營業日、
      驗證 RLS 真的擋得住沒授權的台主、驗證有授權的台主透過真的 RLS
      （非 superuser）也能拿到正確數字。
      **也完成了**：`dashboard()` 對照 `getDashboard()`——回傳單一 jsonb，
      形狀刻意跟現有 GAS API 回傳的 JSON 一模一樣（`machines`／
      `todayTotal`／`diceTotal`／`electronicTotal`／`today432Count`／
      `month432Count`／`ledger`／`ledgerTotal`／`today`／`businessDay`），
      這樣 Phase 5 前端改接時，這支的呼叫端幾乎不用改動 `app.js` 讀取
      資料的那段程式碼，只要換掉呼叫方式。額外搬了幾支小的（
      `public_biz_day()`／`business_day_status()`／
      `daily_ledger_row_for_today()`／`ledger_items_or_legacy()`／
      `sum_ledger_items()`／`public_daily_ledger()`）當 `dashboard()`
      的積木，對照 GAS 同名函式。SECURITY INVOKER，`machines`／`records`
      兩張表靠呼叫者的 RLS 自動篩成「看得到的機台」，不用像 GAS 版本
      那樣自己先查一輪 `visibleMachineIds()`——這是走「前端直連＋RLS」
      比原本 GAS 架構單純的地方。已在本機 Postgres 用多機台（骰台＋
      電子）、多筆紀錄、每日手動帳目、跨夜營業日情境完整跑過一遍手算
      比對，也用非 superuser 角色驗證過 RLS：沒授權的台主看到
      `machines:[]`、有授權的台主只看到被授權的那台，數字都對得起來。
      **寫入端也完成了**：`start_business_day()`／`end_business_day()`／
      `save_daily_ledger()` 對照 GAS 同名函式。GAS 版本靠 `withLock()`
      這個全域鎖序列化「先查現況、再決定 insert 還是 update」這整段
      過程，Postgres 沒有等價的全域鎖，改成把不變量直接下放給資料庫：
      `schema.sql` 幫 `biz_days` 加了 `biz_days_single_open_idx`（常數
      expression 的 partial unique index，保證同一時間全表最多一筆
      `closed_at is null`），幫 `daily_ledger` 加了
      `daily_ledger_one_per_biz_day_idx`（`(business_date, coalesce(biz_id,''))`
      唯一），`save_daily_ledger()` 用 `INSERT ... ON CONFLICT DO UPDATE`
      吃這個索引，兩人同時儲存不會各自 insert 出兩列。金額驗證邏輯
      （`valid_signed_amount()`／`valid_outflow_amount()`／
      `sanitize_ledger_items()`）對照 `_validSignedAmount()`／
      `_validOutflowAmount()`／`_sanitizeLedgerItems()`，錯誤訊息文字都
      照抄。已在本機 Postgres 用 patrol 角色實測：開始→再按一次開始
      （驗證自動結掉前一個、`previousAutoClosed:true`）→存一次帳目→
      同一個 session 再存一次（驗證是覆蓋、`daily_ledger` 只有 1 列不是
      2 列）→結單，全部數字跟狀態都對；額外驗證過 unique index 真的擋
      得住「手動塞第二筆進行中的營業日」（丟 `duplicate key` 錯誤）；
      也驗證過 owner 角色打這三支全部被 `can_record()` 擋下來、負數
      金額被 `valid_outflow_amount()` 擋下來，錯誤訊息跟 GAS 版本一致。
      **`report()`／`ledger_grid()`／`activity_query()` 也完成了**，
      對照 `getReport()`／`_buildLedgerGrid()`／`getActivityQuery()`。
      三個重點：
      1. `resolve_range(preset, from, to)` 對照 `resolveRange()`——
         day/week/month 用 `current_business_date()` 當「今天」；
         custom/history 要求明確給 from/to 且 from<=to。GAS 版本這裡
         還有一大段「history 明確願意跨分頁合併查詢已封存資料、其餘
         preset 選到已封存區間要報錯」的邏輯（配合季度封存機制），
         Postgres 版本完全不需要——`records` 表本來就是索引查詢，
         不會隨資料量變慢，不需要季度封存，`history` 這裡直接等同
         `custom`，這是這次遷移唯一「主動刪掉一段邏輯，不是照搬」的
         地方，原因記在 `functions.sql` 的註解裡。
      2. `report_scope_machine_ids()` 取代 `_reportScope()`／
         `visibleMachineIds()`：machines 表已經被 RLS 篩過，這裡不用
         再自己查一輪權限，只需要在「有沒有給 machineId」「有沒有給
         category」這兩個分支上做文章。
      3. `ledger_grid()` 保留跟 GAS 版本一樣的介面設計：不管有沒有給
         machineId，回傳的都是「這個範圍」的一份格線，多機台（例如
         「全部骰台」一台一張截圖）的迴圈留在呼叫端做，這支本身不
         迴圈——跟現有 `exportLedgerXlsx()`／`exportLedgerGrids()` 呼叫
         `_buildLedgerGrid()` 的方式一致，Phase 5 前端改接時呼叫端的
         邏輯幾乎不用重新設計。
      已在本機 Postgres 造了跨 3 天的資料（含出幣兩筆、入幣一筆、432
      活動一筆），`report()`／`ledger_grid()` 的每日趨勢、五列小計、
      獎型統計、明細排序都手算比對過；也驗證過 RLS：台主指定沒授權的
      機台被 `can_see_machine()` 明確擋掉，指定「全部骰台」分類查詢時
      `machineCount`／`summary` 都只反映他被授權的那一台，另一台骰台
      的紀錄完全不會混進來。
      `docs/app.js` 的 `api()` 目前完全還沒開始改，等這批 function 搬得
      差不多、每支都跟 GAS 版本比對過數字再動前端，避免前端一半打新
      API、一半打舊 API 的過渡期混亂狀態。
      「新增帳號」這個動作是唯一確定要留一小塊後端的地方（見下面
      Auth & RLS 那節最後一小段），不算違反「前端直連」的大方向。
      **記帳寫入＋設定 CRUD 也搬完了**：`add_record()`／
      `add_meter_record()`／`add_prize_record()`／`void_record()`
      對照 `addRecord`／`addMeterRecord`／`addPrizeRecord`／`voidRecord`；
      `resolve_quick_amounts()`／`resolve_prizes()`／`resolve_meter_rate()`
      對照 `_scopedRows()` 那套「全局預設＋單台覆寫」規則；系統管理頁
      CRUD（`save_meter_rate`／`save_quick_amount`／`delete_quick_amount`／
      `fork_scope_to_machine`／`reset_scope_to_global`／`save_prize`／
      `delete_prize`／`admin_save_machine`／`admin_set_permission`）也都
      搬完，對照 `SCOPED_ID_FIELD` 那批同名 GAS function。
      過程中發現並修掉兩個 schema 問題：`prizes`／`quick_amounts` 原本
      的 `machine_id` 設了外鍵參照 `machines(machine_id)`，但空字串代表
      「全局設定」，不是真的機台，外鍵會直接擋掉這個設計——改成跟
      `meter_rates` 一樣不設外鍵；`records.client_token` 原本設成
      `not null unique`，但 `add_prize_record()` 一次登錄多個獎型時會
      用同一個 `client_token` 寫入好幾列（跟 GAS/Sheets 版本一致），
      `unique` 約束會讓第二列直接撞號失敗——改成不設 unique，去重邏輯
      改成跟 GAS 一樣在 function 裡「先查有沒有這個 token、有就直接
      回傳既有紀錄，不然才寫入」，`records` 表另外補一支非唯一索引
      幫這個查詢加速就好。
      已在本機 Postgres 用非 superuser 的 `authenticated` 角色測過：
      入幣/出幣/碼表/開獎的金額與型別驗證（骰台不能開分洗分、電子機台
      不能碼表入幣或開獎、碼表下班表要大於上班表）、`client_token` 重複
      送出正確回傳 `duplicated:true` 且不重複寫入、`void_record` 重複
      作廢正確回傳 `alreadyVoided:true`、巡邏人員打得動記帳但打不動
      `void_record`／`admin_save_machine`（被 `is_admin()` 擋下，錯誤
      訊息跟 GAS 一致）、台主對沒授權的機台被 RLS 直接擋到看不見（
      `select * from machines` 查不到該台，`add_record` 也被
      `can_see_machine()` 明確擋掉）、`schema.sql`／`policies.sql`／
      `functions.sql` 三個檔案重覆執行兩次都不報錯（`create or replace`／
      `drop policy if exists` 都是冪等的）。
      **剩下還沒搬的**：`exportLedgerXlsx()`（真的產生 .xlsx 檔案的部分，
      這需要一個能寫 Excel 檔案格式的地方，不是純 SQL 能做的——目前傾向
      前端直接用 `ledger_grid()` 拿到的格線資料，改用瀏覽器端的 xlsx
      產生套件現場組出檔案，不需要後端）；`machine_detail()`（完整的
      單台詳細頁：分頁紀錄清單＋今日/本週統計＋營業日狀態，對照
      `getMachineDetail()`/`_buildMachineDetail()`——`add_record()` 等
      寫入 function 目前也還沒像 GAS 版本那樣把這份資料一起回傳省一趟
      來回，等這支搬完再補上）；`adminBootstrap`（純聚合，前端可以直接
      分開打 `adminListUsers`/`adminListMachines`/... 對應的 4 條
      查詢，不一定需要包成一支 function）；`adminSaveUser`／
      `adminResetPassword`（建立新帳號、改密碼——需要 Supabase Auth
      Admin API 的 service role key，純 SQL function 做不到，要用
      Edge Function，見下面 Auth & RLS 那節）。
- [ ] **Phase 4：資料遷移腳本**——把現有 Sheets（含已經封存到別的分頁的
      舊資料）讀出來，寫進新的 Postgres 表；日期／金額欄位要注意 Sheets
      那些「自動轉型」的坑（`apps-script/Db.gs` 的 `_fixTextColumnFormatting`／
      `_migrateRecordsMeterColumns` 修過的那幾類問題）不要帶過去；帳號
      資料要另外處理——舊系統的 `password_hash`／`salt` 沒辦法直接匯入
      Supabase Auth（雜湊演算法不同），現有帳號要嘛請每個人在新系統
      重新設一次密碼，要嘛用「忘記密碼」流程重發驗證信，兩種都要事先
      跟使用者說清楚，不是純資料庫層面能解決的事。
- [ ] **Phase 5：雙軌驗證＋切換**——新舊系統並行一段時間（兩邊都寫入，
      只從舊系統讀，比對兩邊算出來的數字），確認一致才正式切過去；
      切換之後 Sheets 資料保留一段時間當備份，不要立刻刪。

## Auth & RLS——已拍板：前端直連 + RLS

現有系統是**自製**帳密登入＋session token（`apps-script/Auth.gs`），
不是 Supabase Auth。決定走「前端直連＋RLS」之後，這兩塊都要換成
Supabase 原生的東西：

- **帳密／session** → Supabase Auth（`auth.users`）。舊的 `users` 表
  拿掉，改成 `profiles` 表（`id uuid references auth.users(id)`）只存
  app 自己的欄位（username／display_name／role／status）；`sessions`
  表整個拿掉，Supabase Auth 自己發、自己驗 JWT。
- **權限判斷** → Row Level Security。管理員／巡邏／台主三種角色、
  「台主只看得到被授權的機台」這條規則，寫成 `supabase/policies.sql`
  的 policy＋三個 helper function（`is_admin()`／`can_record()`／
  `can_see_machine()`），對照的是現有 `Service.gs` 的同名邏輯。

**這個決定唯一留下的例外**：建立新帳號這個動作，不能完全靠前端＋RLS
完成。Supabase Auth 的 `auth.admin.createUser()` 只能用 service role
key 呼叫，這把 key 絕對不能出現在前端——所以「管理員新增帳號」還是
需要一小塊有 service role 權限的後端（一支 Edge Function 就夠，不需要
整套後端）。除此之外（機台、紀錄、獎型、報表這些）都可以是純前端＋
RLS，不需要後端轉發。

`policies.sql` 檔案最後兩節（新使用者怎麼進系統／username 怎麼換成
email 登入）先寫成註解掉的 SQL 草稿，設計想法都寫在註解裡，等真的接上
一個 Supabase 專案時要拉出來實測——這兩塊碰到 `auth.users`／service
role，沒有真的專案沒辦法完整驗證。

## 目前風險與待決定事項

- **Phase 3 是接下來最大的一塊**：`dashboard`／`report`／對帳表格線這幾個
  端點還沒搬，工作量大，逐一對照 GAS 版本搬，不要跳過中間驗證步驟。
- `resolve_week_range()`／`machine_today_and_week()` 照搬了 GAS
  `resolveRange('week')` 一個容易忽略的細節：本週範圍用
  `current_business_date()`，不是行事曆今天——這代表如果「現在有進行中
  的跨夜營業日，business_date 是昨天」，那麼今天已經記的帳（business_date
  是今天）會落在這個週範圍之外，因為週範圍的 `to` 是「昨天」不是「今
  天」。這不是這次搬過來才有的新 bug，是 GAS 原本就有的行為（已經在
  本機測過、行為一致），只是移植過程中特別容易被「順手修掉」，寫在這
  裡提醒之後改這塊的人：不要在沒有明確決定的情況下悄悄改掉這個行為。
- 「新增帳號」的 Edge Function、「username 登入」的 `resolve_username_email()`
  都還沒實測——這兩個碰到 `auth.users`／service role key，是`policies.sql`
  裡最需要在真的 Supabase 專案上小心驗證的部分，不要直接照抄貼到
  正式環境用。
- 舊帳號的密碼沒辦法遷移（雜湊方式不同），Phase 4 要先想好怎麼跟
  使用者溝通「這次要重設密碼」。
- `records.client_token` 沒有設資料庫層的 `unique` 約束（設計原因見
  上面「記帳寫入」那段），去重完全靠 `add_record()`/`add_meter_record()`/
  `add_prize_record()` 裡「先查再寫」的 app 層邏輯，跟 GAS/Sheets 版本
  是同一套機制、同一種弱點：兩個請求幾乎同時打進來、都還沒查到對方寫的
  那筆時，理論上還是有極小機率兩邊都判定「沒有重複」而各自寫入一筆。
  GAS 版本靠 `withLock()`（Sheets 的 LockService）杜絕這個競態；
  Postgres 版本目前還沒有對應的鎖，如果之後要補，可以在 function 裡
  對同一個 `client_token` 做 `select ... for update` 或用 advisory lock。
- 季度封存機制（`封存_2026Q1` 這種額外分頁）在新架構完全不需要，
  `carry_in`/`carry_out`/... 這幾欄只是遷移過渡用，新資料寫入不會
  再往上加——遷移完成後要不要整個拿掉這幾欄，等 Phase 4 資料遷移
  跑完、確認新系統穩定運作一段時間後再決定。
- 目前 `supabase/` 底下還沒有實際連上任何 Supabase 專案（沒有
  `.env`、沒有 project ref、沒有跑過 `supabase db push`）——Phase 1／2
  只是把 schema 跟 policy 設計寫好，還沒真的建立任何雲端資源，也還
  沒實測過任何一條 policy 真的擋不擋得住。
