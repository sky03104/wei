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
- [x] **Phase 3：業務邏輯搬進 Postgres function（`rpc()`），前端再改接**——
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
      **機台詳細頁也搬完了**：`machine_detail(machineId, recordLimit)`
      對照 `getMachineDetail()`/`_buildMachineDetail()`（機台基本資料＋
      今日統計＋本週統計＋分頁紀錄清單＋快捷金額/獎型/碼表費率＋上次
      碼表讀數），直接借用先前搬好的 `machine_today_and_week()` 算
      today/本週兩組數字，不用重寫一次 `is_today_record()`/週範圍邏輯；
      `all_machine_details(recordLimit)` 對照 `getAllMachineDetails()`，
      用 machineId 當 key 一次算出這個帳號看得到的每一台。GAS 版本把
      這兩支合成一份 `_buildMachineDetail()` 主要是為了閃避「Sheets
      要跨執行讀 N 次」的效能問題，Postgres 這邊每台各自查一次 records
      本來就是索引查詢，不需要那種手工合併最佳化，`all_machine_details()`
      直接迴圈呼叫 `machine_detail()`，程式碼比 GAS 版本單純。
      `add_record()`／`add_meter_record()` 也補上了跟 GAS 一致的
      `result.detail = getMachineDetail(...)` 那個最佳化——回傳值裡
      多一個 `detail` 欄位，直接帶最新的機台詳細頁，前端寫入成功後
      不用再多打一次查詢（`add_prize_record()` 沒有這個欄位，因為
      GAS 原本的 `addPrizeRecord()` 就沒有）。已手動驗證：連續兩次
      入幣/出幣後 `detail.today`/`detail.total` 的累計數字正確、
      `detail.records` 依 `created_at desc, seq desc` 排序、
      `detail.lastMeterReading` 正確帶出最近一筆入幣紀錄的下班表讀數、
      `all_machine_details()` 回傳的 key 集合等於這個帳號看得到的
      機台集合。
      **系統管理頁查詢也搬完了**：`admin_list_users()`／
      `admin_list_machines()`／`admin_list_prizes()`／
      `admin_list_permissions()`／`admin_bootstrap()`，對照同名的
      `adminList*`／`adminBootstrap()`，形狀（欄位名稱、`roleLabel`
      中文標籤、`prizes.overrides` 覆寫筆數統計、`permissions.grants`
      用 userId 當 key）都跟 GAS 版本一致。已驗證：管理員能拿到完整
      四組資料、`overrides` 正確反映機台專屬獎型的筆數與名稱、巡邏
      人員打 `admin_bootstrap()` 被 `is_admin()` 擋下。
      **到此 Phase 3 的 SQL function 全部搬完**：`Service.gs`／
      `Reports.gs` 裡所有「需要算」的邏輯（dashboard、機台詳細頁、
      記帳寫入、報表、對帳表格線、全局預設/單台覆寫、系統管理 CRUD
      與查詢）都有對應的 Postgres function，每一支都在本機 Postgres
      用非 superuser 角色測過驗證邏輯、錯誤訊息、RLS 邊界。
      **刻意留到 Phase 3 以外的**：`exportLedgerXlsx()`（真的產生
      .xlsx 檔案，這需要能寫 Excel 檔案格式的地方，不是純 SQL 能做
      的——決定前端直接用 `ledger_grid()` 拿到的格線資料，改用瀏覽器端
      的 xlsx 產生套件現場組出檔案，不需要後端，屬於 Phase 5 前端
      改接時的工作）；`adminSaveUser`／`adminResetPassword`（建立新
      帳號、改密碼——需要 Supabase Auth Admin API 的 service role
      key，純 SQL function 做不到，要用 Edge Function，見下面
      Auth & RLS 那節，等真的接上 Supabase 專案才能實作+測試）。
- [x] **Phase 4：資料遷移腳本**——已經拿正式的 Sheets 資料跑過一次真的
      遷移，成功了。
      **匯出端**（`apps-script/Archive.gs` 的 `exportAllData()`，
      `apps-script/Code.gs` 註冊成管理員專用 action）：把現有 Sheets
      （目前這一季的 Records ＋所有「封存_YYYYQN」分頁）合併成一份
      JSON，欄位轉成跟系統其他 API 一致的 camelCase 形狀。Users 不帶
      `password_hash`／`salt`（下面會說明為什麼），Machines 不帶
      `carry_*`（封存前累計，Postgres 版本不需要季度封存，這幾欄沒
      意義）。這個 action 只給遷移用，遷移完成、確認新系統穩定後可以
      整段拿掉。已用 `tools/gas-env.js` 本機模擬環境驗證過：回傳欄位
      形狀正確、camelCase 命名跟其他 API 一致、`npm test` 全部通過。
      **寫入端**（`supabase/migrate-from-sheets.js`，Node 腳本）：讀
      `exportAllData()` 存下來的 JSON，用 `@supabase/supabase-js`
      的 service role key 依序寫入 Supabase Auth（建帳號）→
      `profiles` → `machines` → `prizes`/`quick_amounts`/
      `meter_rates` → `permissions` → `config` → `biz_days` →
      `daily_ledger` → `records`（分批 500 筆）。全程用 upsert，
      中途失敗重跑是安全的；`user_id` 從舊系統的字串 id 轉換成
      Supabase Auth 的 uuid（帳號密碼沒辦法遷移，見下段，腳本會現場
      建立隨機臨時密碼、存進本機的 `migration-credentials.txt`，
      這個檔案跟 `data-export.json` 都已經加進 `.gitignore`，不會
      進 git）。已經寫了一個假的 `@supabase/supabase-js` 替身（純
      記憶體，模擬 upsert／auth.admin.createUser）在本機跑過一輪完整
      流程，驗證過：欄位轉型正確（空字串轉 null、Sheets 存的 JSON
      字串正確 parse 回 jsonb）、找不到對應帳號的紀錄/授權會被跳過
      並印警告（不會讓整個遷移中斷）、日期/金額欄位型別轉換正確。
      沒辦法在這個環境驗證的部分：實際打 Supabase Auth Admin API、
      實際寫進雲端 Postgres（sandbox 網路連不到任意網域），這段要
      使用者自己在能連網的環境跑一次才能真正驗證到底。
      `supabase/verify-migration.sql`：遷移完成後在 SQL Editor 跑，
      核對每張表筆數、每台機台的全時間淨收益、有沒有孤兒紀錄（
      `user_id` 對不到任何 `profiles`）。
      日期／金額欄位的 Sheets「自動轉型」坑（`_fixTextColumnFormatting`／
      `_migrateRecordsMeterColumns` 修過的那幾類問題）不用擔心帶過去——
      `exportAllData()` 直接讀 `dbReadAll()` 已經修正過的乾淨資料，不是
      讀 Sheets 原始儲存格。
      **實跑結果**：用一個全新、獨立的 Apps Script 專案（不是正式站台
      那個，避免動到正式部署）貼上分支的 `Code.gs`，Script Property
      設 `SPREADSHEET_ID` 指到正式試算表，部署一個新的網頁應用程式
      網址，只給這次遷移用。過程中順手修了兩個問題：
      1. `migrate-from-sheets.js` 一開始沒濾掉「`records.machine_id`
         對不到任何一台已匯入機台」的紀錄，導致那 500 筆一批的整批
         upsert 因為外鍵限制 (`records_machine_id_fkey`) 全部失敗——
         改成跟「找不到對應帳號」一樣的處理方式，先濾掉、印警告，
         不讓整批卡住。
      2. Windows PowerShell 環境下用 `curl.exe` 打 API 踩了幾個
         Windows／PowerShell 特有的坑（跟遷移工具本身無關，記在這裡
         給以後在 Windows 上重跑的人參考）：GAS 的 302 轉址要嘛用
         瀏覽器、要嘛 curl 要加 `-L` 且不能同時指定 `-X POST`（會讓
         轉址後的請求也被強制用 POST，導致 411 錯誤）；PowerShell
         傳含雙引號的 JSON 字串給外部程式常會被弄壞，改用
         `--data-urlencode name@file` 讀檔案最穩；PowerShell 5.1 用
         `-Encoding utf8` 存檔會加隱形的 BOM，混進 JSON 開頭讓
         `JSON.parse` 直接失敗，含中文的檔案要用 .NET
         `UTF8Encoding($false)` 明確存成無 BOM 版本；PowerShell 讀取
         外部程式 stdout 預設用系統的舊版編碼（不是 UTF-8），中文
         內容會變亂碼，要嘛整個轉存檔案再用 `-Encoding UTF8` 讀回來，
         不要透過管線直接接 `ConvertFrom-Json`。
      **實測結果**：帳號 4、機台 25、獎型 6、快捷金額 43、費率 1、
      營業日 7、每日帳目 4、紀錄 215 筆裡 211 筆成功寫入（4 筆對不到
      機台被跳過，原始資料還在 Sheets，之後要不要處理再說）。
      `verify-migration.sql` 核對過：每張表筆數跟遷移腳本印出來的
      數字一致、`orphan_records` 是 0、每台機台的全時間淨收益數字經
      使用者親自核對跟原本 Sheets 上看到的一致。
      **一個已知的資料品質小問題**：Sheets 的 `Permissions` 分頁裡有
      2 筆授權紀錄指向一個現在已經不存在的帳號（`user_id` 對不到任何
      使用者），遷移腳本印警告跳過了，沒有寫進 `permissions` 表——如果
      之後發現「某個台主應該看得到某台機台但看不到」，用
      `admin_set_permission()` 重新手動授權一次就好。
      **收尾**：那個臨時用的 Apps Script 專案（獨立、沒動到正式部署）
      可以直接刪除或封存，不影響正式站台。
- [x] **Phase 5：雙軌驗證**——前端改接的部分寫好了，也已經拿真的
      Supabase 專案在瀏覽器裡實測過一輪，通過。
      **架構決定：加一支後端開關，不是直接砍掉 GAS 路徑**——
      `docs/config.js` 新增 `BACKEND`（預設 `'gas'`，行為跟現在完全
      一樣）跟 `SUPABASE_URL`／`SUPABASE_ANON_KEY`；`docs/app.js` 原本
      的 `api(action, payload)` 改成薄薄一層分派：`BACKEND==='gas'`
      走原本的實作（改名 `apiGas()`，程式碼一行都沒變），
      `BACKEND==='supabase'` 走新的 `supabaseApi()`。這正是這一節
      標題「雙軌驗證」原本設想的做法——两條路徑可以同時存在同一份
      程式碼裡，之後真的要驗證兩邊算出來的數字一不一致時，直接切
      這個開關重新整理就能切換，不用維護兩個分支。
      **`supabaseApi()` 做的事**：28 個 `api()` action 裡，好幾個是
      單純的「一個 action 對一支 Postgres function」（用一份
      `RPC_MAP` 對照表做參數改名，例如 `machineId`→`p_machine_id`），
      其餘幾個是 GAS 版本本來就會組合好幾支邏輯回傳一份資料的，前端
      改成組合好幾次 Supabase 呼叫達到同樣效果：
      - `login`：`resolve_username_email()` 換出合成 email → 
        `signInWithPassword()` → 查 `profiles` → 呼叫 `dashboard()`，
        組成跟 GAS `login()` 一樣的 `{token, remember, user, dashboard}`。
      - `logout`：`sb.auth.signOut()`。
      - `homeBootstrap`：查目前使用者的 `profiles` ＋數看得到幾台
        機台（`machines` 本身已經被 RLS 篩過，直接 count）＋
        `dashboard()`。
      - `exportLedgerGrids`：查該分類看得到的機台清單，一台一台各自
        呼叫 `ledger_grid()`，組成跟 GAS 版本一樣的 `{range, machines[]}`。
      - `exportLedgerXlsx`：刻意沒接，丟出明確的「這個後端還沒支援」
        錯誤——真的產生 .xlsx 檔案這件事還沒決定要不要做、什麼時候做
        （見 Phase 3 那節的決定：前端用瀏覽器端套件現場組出檔案）。
      - `adminSaveUser`／`adminResetPassword`：刻意沒接，丟出明確的
        「需要 Edge Function」錯誤（見下面 Auth & RLS 那節）。
      **同時啟用了 `resolve_username_email()`**（`supabase/policies.sql`
      原本是註解掉的設計草稿，現在轉正）：帳號不存在或被停用都回傳
      null，錯誤訊息前端統一顯示成「帳號或密碼錯誤」，不會讓人從
      回應內容猜出帳號存不存在。已用本機 Postgres＋`anon` 角色測過：
      查得到 active 帳號的 email、查不到／帳號被停用都回傳 null。
      **Session／「記住我」**：Supabase Auth 自己管 session（JWT +
      refresh token），不是原本 GAS 版本手刻的 token／Sessions 表，所以
      沒辦法直接沿用 `saveSession()`/`loadSession()`。改用一個自訂
      `storage` adapter 接給 supabase-js（`_sbStorageAdapter`），依
      `state.remember` 決定寫 localStorage（跨關閉瀏覽器仍有效）還是
      sessionStorage（分頁關閉即失效）——效果跟原本規則一致，只是
      換一套機制達成。Token 過期或被撤銷會讓 SDK 觸發 `SIGNED_OUT`，
      監聽這個事件、比照 GAS 版本 `AUTH` 錯誤碼的效果，靜靜清掉狀態
      退回登入頁。
      **測試方式**：因為要有真的 Supabase 專案（或至少一個能跑
      PostgREST 的環境）才能整合測試，這個 sandbox 環境做不到——改用
      `vm` 模組把 `docs/app.js` 整份載進一個模擬瀏覽器環境（假的
      `window`/`document`/`localStorage`），再用一個記錄呼叫內容、
      回傳固定值的假 `supabaseClient()` 取代真正的實作，驗證了：
      全部 28 個 action 各自對到正確的 RPC 名稱與參數改名、`login`／
      `homeBootstrap`／`exportLedgerGrids` 這幾個組合流程回傳的形狀
      正確、`exportLedgerXlsx`／`adminSaveUser` 正確丟出「還沒支援」
      而不是靜默失敗、`api()` 本身依 `BACKEND` 正確分派。`npm test`
      （GAS 那邊的自我測試）全部通過，確認 `BACKEND` 預設 `'gas'` 時
      GAS 路徑一行邏輯都沒被動到。
      **真的在瀏覽器裡測過了**：`docs/config.js` 設成
      `BACKEND: 'supabase'`（`SUPABASE_URL`／`SUPABASE_ANON_KEY` 直接
      填實際值提交進 repo——anon key 設計上就是公開安全的,權限控管在
      RLS,跟 `GAS_API_URL` 一樣不算敏感資訊）,用 `tools/dev-server.js`
      跑本機靜態伺服器（改了一下：原本它會把 `/config.js` 整個覆寫成
      指向本機模擬後端,只在 `BACKEND` 不是 `'supabase'` 時才這樣做,
      是 `'supabase'` 就照原樣把真正的 `docs/config.js` 送給瀏覽器,
      讓瀏覽器直接打真的 Supabase 專案）,拿 Phase 4 遷移出來的其中一個
      帳號（用遷移腳本產生的臨時密碼,不是舊系統的密碼）登入,實際點過
      首頁、機台詳細頁、記一筆帳、報表頁、匯出截圖、系統管理頁,全部
      正常。
      **測試中抓到一個真的 bug（不是遷移造成的，是原本就有的）**：
      「📷 匯出截圖」在機台數量多、圖檔總大小超過瀏覽器分享面板上限時，
      `navigator.canShare({files})` 檢查會過，但實際呼叫
      `navigator.share({files})` 會被系統拒絕（Chrome 主控台看到
      「Share too large」），原本的程式碼用 `.catch(function(){})` 把
      這個失敗整個吞掉、直接 `return`，使用者會看到按鈕按下去完全沒
      反應。改成失敗時退回原本就有的「一張一張各自觸發下載」流程，
      不會再靜默失敗。同一支檔案裡單台截圖（`exportLedgerImage`）的
      分享面板也有一樣的邏輯漏洞，一併修掉，用 `.catch(downloadFallback)`
      而不是 `await/try`（保留原本「share() 必須在點擊當下同步呼叫，
      不能等非同步流程之後才呼叫」的手機 Safari 相容性設計，這支沒有
      改成 async）。
      **測試中還抓到（測試流程本身的坑，不是程式的 bug）**：Windows
      PowerShell 執行原則預設擋掉 `npm.ps1`，要用 `npm.cmd` 才行；
      Service Worker 快取會讓瀏覽器抓不到剛推上去的新版前端，測試時
      要嘛用無痕視窗、要嘛確認有真的觸發更新流程。
      到這裡 Phase 5 的雙軌驗證算完成了——GAS/Sheets（`main` 分支的
      正式系統）跟 Supabase（這個分支）兩條後端路徑並存在同一份
      `docs/app.js` 裡，切 `BACKEND` 這個開關就能切換，兩邊都實測
      跑得動。
- [ ] **Phase 6：正式切換**——把 Supabase 從「測試用的分支」變成
      「真的在用的正式後端」，細節見下面「Phase 6 詳細步驟」那節。
      還沒開始，時程跟切換方式（一次到位 vs 分階段）需要使用者先
      決定，不是純技術問題。

## Phase 6 詳細步驟（正式切換）

還沒開始執行，這裡先把整個切換過程需要做的事、順序、風險都列清楚，
供決定時程時參考。

### 切換前必須先補上的缺口

這幾件事在切換之前一定要處理，不然切過去當天就會有人卡住：

1. **帳號密碼**：現在 Supabase 那邊每個帳號都是遷移腳本產生的隨機
   臨時密碼，不能讓使用者長期用這組。切換前要嘛（a）每個人在切換
   當天／前一天自己用臨時密碼登入一次、立刻改成自己的密碼（前端
   目前沒有「登入後強制改密碼」這個流程，需要另外提醒，或者花一點
   工再把這個流程做出來），要嘛（b）管理員在 Supabase Auth 後台
   （Authentication → Users）幫每個人重設一次密碼、口頭／私訊告知，
   兩種都要事先想好怎麼通知，不是資料庫層面能解決的事。
2. **新增帳號的 Edge Function**：`adminSaveUser`／`adminResetPassword`
   目前在 `supabaseApi()` 裡是刻意丟出「還沒支援」的錯誤（見 Phase 5
   那節）。如果切換後短期內不會有新增帳號的需求，這個可以延後補；
   如果會（例如快要有新台主要加入），要先把這支 Edge Function 做出來
   再切換，不然系統管理頁那半個功能等於是壞的。
3. **匯出 Excel**：`exportLedgerXlsx` 一樣是「還沒支援」，改用
   「📷 匯出截圖」代替目前堪用，要不要在切換前補上瀏覽器端產生
   .xlsx 檔案這個功能，看使用習慣上有多依賴匯出 Excel 這個功能決定。
4. **孤兒資料**：Phase 4 遷移時發現的 2 筆授權紀錄、4 筆紀錄的
   `machine_id` 對不到現有機台，切換前建議先花點時間回頭到 Sheets
   查一下這幾筆到底是什麼（很久以前的測試資料？被誤刪的機台？），
   確認不是重要資料被漏掉，再決定要不要手動補進 Supabase。

### 切換流程本身

因為這是單一店家、操作人數不多的系統，不需要做到「雙寫＋即時比對」
那種大型系統等級的無痛切換（工程成本跟系統規模不成比例），用「選一個
低流量時段、切一次、保留回退能力」這種比較務實的做法就夠：

1. **選時段**：挑一個沒有人在記帳的空檔（例如打烊後、開店前，或跟
   系統本身「跨夜營業日」的交接時間點錯開，避免切換當下剛好卡在一個
   還沒結單的營業日中間）。
2. **凍結寫入**：切換前跟所有會用系統的人說一聲，這段時間先不要
   記帳（時間不用長，遷移腳本跑完通常一兩分鐘）。
3. **最後一次乾淨遷移**：重跑一次 `exportAllData` → `migrate-from-sheets.js`
   → `verify-migration.sql`，把 Sheets 最新的資料（含凍結寫入前的
   最後幾筆帳）完整同步過去，覆蓋掉這次測試階段留下的測試紀錄
   （遷移腳本全程用 upsert，重跑是安全的，舊的測試紀錄如果 `record_id`
   衝突會被覆蓋，不衝突的孤兒測試紀錄需要额外手動清一次，見下面
   「測試資料清理」）。
4. **切換設定**：把 `docs/config.js` 的 `BACKEND` 從 `'gas'` 改成
   `'supabase'`，這個改動走一般的 PR 流程（開 PR → 確認沒問題 → 合併
   進 `main`），GitHub Pages 部署完就是全站切過去。
5. **驗證**：切完立刻找一兩個人實際登入、記一筆帳、看報表，確認
   一輪正常再宣布「已切換」。
6. **恢復寫入**：確認沒問題後跟大家說可以正常使用了。

### 回退計畫

**這個切換方向是不對稱的**：GAS/Sheets 在切換過程中完全沒被動過
（只是不再是 `BACKEND` 指的那條路），隨時把 `docs/config.js` 的
`BACKEND` 改回 `'gas'` 就能立刻退回舊系統——但退回去之後，切換期間
寫進 Supabase 的新紀錄不會自動出現在 Sheets 上。以這個系統的規模
（單店、記帳筆數不多）來說，「切壞了就退回 GAS，當天切換之後到
發現問題之間的那幾筆帳手動抄回 Sheets」是可以接受的回退成本，不需要
為了這個再另外做一套反向同步機制。切換後建議觀察一段時間（例如
1~2 週）確認穩定，再考慮要不要把 GAS 那個 Web App 部署下架（保留
Sheets 資料本身當長期備份，不要真的刪除）。

### 測試資料清理

Phase 5 瀏覽器測試時留在 Supabase 裡的幾筆測試紀錄，會在「最後一次
乾淨遷移」時大部分被覆蓋掉（`record_id` 是遷移時從 Sheets 產生的，
測試時手動按的那幾筆是前端自己產生的新 `record_id`，不會被覆蓋），
正式切換前建議額外手動下這段 SQL 清掉（金額打得很小、備註「測試」的
那幾筆，實際跑之前先用 `select` 確認筆數對不對再 `delete`）：

```sql
select * from records where note like '%測試%' order by created_at desc;
-- 確認筆數、內容都是測試資料之後再執行：
-- delete from records where note like '%測試%';
```

## 追趕 main 分支的進度

這個分支是從 `main` 某個時間點切出來的，`main` 上正式系統會持續有新的
修 bug、新功能——**這個分支不會自動跟著更新**，要定期手動把 `main`
合併進來，確認 `main` 上任何動到業務邏輯的改動也同步搬進對應的
Postgres function，不然這個分支的 Supabase 版本會漸漸跟正式系統的
行為兜不起來。

第一次追趕（合併 `main` 到這個分支，涵蓋 5 個 commit）：
- 兩個純 GAS/前端的改動不需要搬：跨執行快取排除 `Records` 表（純
  Sheets 效能優化，Postgres 版本本來就不需要這種快取）；`saveDailyLedger`
  的版號規則變動說明。
- 一個業務邏輯修正**不需要額外動作，因為早就對齊了**：GAS 修正
  `_validSignedAmount()` 對缺席欄位（`transport`／`returnedToHouse`
  這兩個已棄用欄位）從「當非法輸入丟錯」改成「當 0」——這支對應的
  Postgres `valid_signed_amount()` 從 Phase 3 寫的時候就已經是「缺值當
  0」（見該 function 上面的註解，寫的時候就注意到 GAS 原本這個行為
  可能是沒設計過的副作用，一開始就直接寫成比較合理的版本），這次
  GAS 修的正好補齊了跟 Postgres 版本的行為差異，不用再改 Postgres
  那邊。
- 一個真的要搬的欄位：`getDashboard()` 新增 `todayOpenedByName`（加總
  分頁日期前面顯示「今日開始營業的人」暱稱），`dashboard()` 這支
  Postgres function 補上對應的 `today_opener` CTE，查法跟
  `public_biz_day()` 的 `openedByName` 一致（優先顯示 `display_name`，
  沒填用 `username`）。已用本機 Postgres 測過：還沒開始營業日時是
  空字串，`start_business_day()` 之後正確顯示開帳的人。
- `docs/app.js`／`docs/sw.js` 合併時只有版本號那一行衝突（`ledgerRows`／
  `exportLedgerImage` 那幾處改動跟這個分支自己在 Phase 5 加的
  `supabaseApi()` 段落完全不重疊，自動合併成功），版本號手動接續成
  `v47`（這個分支自己也有前端改動，不是單純接 `main` 的 `v46.1`）。

**以後每次要追趕 main 時的流程**：`git fetch origin main`、看
`git log feature/supabase-migration..origin/main` 有哪些新 commit、
逐一看有沒有動到 `apps-script/Service.gs`／`Reports.gs`／`Auth.gs`
這些業務邏輯檔案（動到才需要比對搬進 Postgres function），`git merge
origin/main`，衝突通常只會在版本號那幾行（兩個分支各自都有前端改動時），
合併完重新 `npm run bundle`、`npm test`，Postgres 那邊有對應變動的話
在本機 Postgres 測過再 push。

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

`policies.sql` 檔案最後一節「username 怎麼換成 email 登入」
（`resolve_username_email()`）已經在 Phase 5 轉正、實際啟用了——
`docs/app.js` 的登入流程用得到，已用本機 Postgres＋`anon` 角色測過。
「新使用者怎麼進系統」（`handle_new_user()` trigger）還是註解掉的
草稿，設計想法寫在註解裡，等真的要做 Phase 3 提到的那支 Edge Function
（`adminSaveUser`）時再拉出來套用——這塊碰到 `auth.users`／service
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
- 「新增帳號」的 Edge Function 還沒實作也還沒實測——這個碰到 service
  role key，是還沒解決的一塊（見上面 Phase 3／Auth & RLS 那兩節）。
  `resolve_username_email()` 已經在真的 Supabase 專案上實測過，登入
  流程也已經整個跑通。
- 舊帳號的密碼沒辦法遷移（雜湊方式不同）——已經照這個設計跑過一次
  真的遷移：每個帳號拿到一組隨機臨時密碼，存在遷移執行者本機的
  `migration-credentials.txt`（不進 git），要發給對應的人自己登入後
  改密碼。
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
- 已經建立真的 Supabase 專案（`ap-southeast-1`，Singapore），
  `schema.sql`／`policies.sql`／`functions.sql` 都套用過，Phase 4
  資料遷移也跑過一次真的、確認過數字正確。**目前 Supabase 那份資料
  是遷移當時的快照，之後正式站台（GAS/Sheets）如果繼續有新的記帳、
  新增機台等等，Supabase 那份會愈來愈舊**——這是「雙軌驗證」階段的
  正常現象（正式流量仍然完全走 `main` 分支的 GAS/Sheets，這個分支的
  Supabase 只是拿來測試），真的要切換上線前，需要再跑一次遷移把最新
  資料同步過去（或改成寫入雙軌並行一段時間再切）。
- Phase 5 瀏覽器測試時在 Supabase 那份資料裡留了幾筆測試用的記帳
  紀錄（金額很小、備註「測試」）——不影響 Sheets 正式資料，但如果之後
  真的要拿 Supabase 這份資料上線，記得先清掉或用一次乾淨的重新遷移
  覆蓋掉。
