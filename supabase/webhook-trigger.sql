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

drop trigger if exists records_notify_gas on records;
create trigger records_notify_gas
  after insert or update on records
  for each row execute function public.notify_gas_webhook();

drop trigger if exists daily_ledger_notify_gas on daily_ledger;
create trigger daily_ledger_notify_gas
  after insert or update on daily_ledger
  for each row execute function public.notify_gas_webhook();

drop trigger if exists biz_days_notify_gas on biz_days;
create trigger biz_days_notify_gas
  after insert or update on biz_days
  for each row execute function public.notify_gas_webhook();

-- 想暫停/移除即時推送，用這幾行（定期同步 syncFromSupabase 不受影響，
-- 繼續正常運作）：
--   drop trigger if exists records_notify_gas on records;
--   drop trigger if exists daily_ledger_notify_gas on daily_ledger;
--   drop trigger if exists biz_days_notify_gas on biz_days;
