-- 資料庫 → 試算表即時化：records／daily_ledger／biz_days 三張表
-- 異動時，用 pg_net 打一次 HTTP POST 通知 GAS，讓 apps-script/SupabaseWebhook.gs
-- 立刻把這筆異動寫回試算表，不用再等 5 分鐘的 syncFromSupabase 定期同步。
--
-- 使用方式：
-- 1. 把下面 webhook_url 裡的兩個佔位字串換成實際值：
--      YOUR_GAS_WEB_APP_URL   你的 GAS Web App /exec 網址
--      YOUR_WEBHOOK_SECRET    一段你自己產生的隨機字串，長一點、隨機一點
--    這段 secret 要跟 GAS 那邊「指令碼屬性」的 SUPABASE_WEBHOOK_SECRET
--    設成完全一樣的值，兩邊對不起來會被 GAS 直接拒絕（回 403）。
-- 2. 整份貼到 Supabase 的 SQL Editor 執行一次。
-- 3. 重複執行是安全的：function 用 create or replace，trigger 用
--    drop if exists 再 create，不會疊加出重複的 trigger。
--
-- ── 一個真的發生過的重要教訓（INSERT／UPDATE 一定要分開兩個 trigger）──
--
-- 早期版本把 INSERT 跟 UPDATE 合在同一個 trigger、沒有任何篩選條件，
-- 結果：Postgres 的 trigger 預設「值有沒有真的變」都會觸發，而
-- supabase/migrate-from-sheets.js／MigrateToSupabase.gs 那套「試算表→
-- 資料庫」的定期整批同步，每 5 分鐘會把試算表全部的紀錄重新 upsert
-- 一次，即使內容完全沒變一樣算一次 UPDATE——等於每 5 分鐘、幾百筆
-- 紀錄全部各打一次 webhook，一天下來幾十萬次呼叫，把 Supabase 內部
-- 記錄呼叫結果的 `net._http_response` 表撐到 500+ MB，直接把免費方案
-- 的資料庫容量用滿（真實案例：0.5GB 額度被這張日誌表吃到 116%，
-- 業務資料 records/biz_days/daily_ledger 加起來還不到 1MB）。
--
-- 修正：INSERT 用一個獨立的 trigger（不需要條件，新增一定要通知）；
-- UPDATE 用另一個獨立的 trigger，加上 `when (OLD IS DISTINCT FROM NEW)`
-- ——這個條件沒辦法放在合併 INSERT+UPDATE 的單一 trigger 裡（Postgres
-- 會直接報錯：INSERT trigger's WHEN condition cannot reference OLD
-- values，因為 INSERT 事件本來就沒有 OLD），所以一定要拆成兩個。
-- 如果日誌表又不小心長大，直接 `truncate table net._http_response;`
-- 清掉即可，這張表只是呼叫記錄，不是業務資料，清空不影響任何功能。

create extension if not exists pg_net;

create or replace function public.notify_gas_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  webhook_url text := 'YOUR_GAS_WEB_APP_URL?webhookSecret=YOUR_WEBHOOK_SECRET';
  payload jsonb;
begin
  payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', to_jsonb(NEW),
    'old_record', case when TG_OP = 'DELETE' then to_jsonb(OLD) else null end
  );
  -- pg_net 是非同步、不等回應的（不會拖慢原本的 insert/update），
  -- 失敗也不會讓觸發這個 trigger 的那筆寫入跟著失敗或重試。
  perform net.http_post(
    url := webhook_url,
    body := payload,
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return NEW;
end;
$$;

-- records
drop trigger if exists records_notify_gas on records;
drop trigger if exists records_notify_gas_insert on records;
drop trigger if exists records_notify_gas_update on records;
create trigger records_notify_gas_insert
  after insert on records
  for each row execute function public.notify_gas_webhook();
create trigger records_notify_gas_update
  after update on records
  for each row
  when (OLD IS DISTINCT FROM NEW)
  execute function public.notify_gas_webhook();

-- daily_ledger
drop trigger if exists daily_ledger_notify_gas on daily_ledger;
drop trigger if exists daily_ledger_notify_gas_insert on daily_ledger;
drop trigger if exists daily_ledger_notify_gas_update on daily_ledger;
create trigger daily_ledger_notify_gas_insert
  after insert on daily_ledger
  for each row execute function public.notify_gas_webhook();
create trigger daily_ledger_notify_gas_update
  after update on daily_ledger
  for each row
  when (OLD IS DISTINCT FROM NEW)
  execute function public.notify_gas_webhook();

-- biz_days
drop trigger if exists biz_days_notify_gas on biz_days;
drop trigger if exists biz_days_notify_gas_insert on biz_days;
drop trigger if exists biz_days_notify_gas_update on biz_days;
create trigger biz_days_notify_gas_insert
  after insert on biz_days
  for each row execute function public.notify_gas_webhook();
create trigger biz_days_notify_gas_update
  after update on biz_days
  for each row
  when (OLD IS DISTINCT FROM NEW)
  execute function public.notify_gas_webhook();

-- 想暫停/移除即時推送，用這幾行（定期同步 syncFromSupabase 不受影響，
-- 繼續正常運作）：
--   drop trigger if exists records_notify_gas_insert on records;
--   drop trigger if exists records_notify_gas_update on records;
--   drop trigger if exists daily_ledger_notify_gas_insert on daily_ledger;
--   drop trigger if exists daily_ledger_notify_gas_update on daily_ledger;
--   drop trigger if exists biz_days_notify_gas_insert on biz_days;
--   drop trigger if exists biz_days_notify_gas_update on biz_days;
--
-- 如果 `net._http_response` 又不小心長大（用量頁面看到資料庫暴增），
-- 清掉就好，不影響任何業務資料：
--   truncate table net._http_response;
