-- supabase/functions.sql
--
-- Phase 3 of the migration: the "computed" logic that lived in
-- apps-script/Service.gs / Reports.gs has to live somewhere now that the
-- frontend talks to Postgres directly (see MIGRATION_PLAN.md — "前端直連 +
-- RLS" means there is no Node/Deno backend process for these to run in).
-- Postgres SQL functions, called from the frontend via Supabase's rpc(),
-- are that place: they run with SECURITY INVOKER (the default — deliberately
-- NOT overridden here, unlike the helper functions in policies.sql), so
-- every query inside still goes through the caller's RLS policies. A user
-- who can't see a machine gets the same empty/zeroed-out result a plain
-- `select` would give them; can_see_machine() is used as a belt-and-braces
-- explicit check so the caller gets a clear error instead of a silently
-- empty response.
--
-- This file ports the single most load-bearing piece of business logic in
-- the whole system: business-day resolution (handling overnight sessions —
-- "跨夜") and the week/today net-profit aggregation for a machine. Every
-- other read endpoint (dashboard, report, exportLedgerGrids-equivalent)
-- needs the same today_key()/current_business_date()/relevant_biz_day_for_today()
-- foundation, so this is deliberately the first piece done, not a random
-- pick — see MIGRATION_PLAN.md「Phase 3 進度」for what's left.
--
-- Run after schema.sql + policies.sql.

-- ── 今天／營業日邊界 ──────────────────────────────────────
--
-- 逐一對照 apps-script/Service.gs：
--   today_key()                 ↔ todayKey()
--   open_biz_day()               ↔ _openBizDay()
--   current_business_date()      ↔ _currentBusinessDate()
--   relevant_biz_day_for_today() ↔ _relevantBizDayForToday()
--   is_today_record()            ↔ _isTodayRecord()
-- 時區寫死 Asia/Taipei，跟 apps-script/Service.gs 的 _tz()（預設也是
-- Asia/Taipei）一致——不用 Postgres session 的 timezone 設定，那個值
-- 可能因為連線方式不同而不一樣，寫死才不會讓「今天」在不同地方算出
-- 不同答案。

create or replace function today_key()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Taipei')::date;
$$;

-- 目前進行中的營業日（closed_at 是 null），同一時間最多一筆；用 seq
-- （插入順序，見 schema.sql 的說明）決勝，理論上用不到，防禦性寫法跟
-- GAS 版本一致。回傳 setof 而不是單一 composite，好讓「沒有進行中的
-- 營業日」乾淨地變成零筆，不用另外處理 composite 全 null 的情況。
create or replace function open_biz_day()
returns setof biz_days
language sql
stable
as $$
  select * from biz_days
  where closed_at is null
  order by seq desc
  limit 1;
$$;

-- 記帳當下該算進哪一天：有進行中的營業日就用它，沒有就退回今天的
-- 行事曆日期。
create or replace function current_business_date()
returns date
language sql
stable
as $$
  select coalesce((select business_date from open_biz_day()), today_key());
$$;

-- 「今日」數字要照哪一個營業日 session 的邊界算：優先用進行中的；沒有
-- 進行中的（已經結單）就退回找「今天結束的最後一個」，讓「今日」數字
-- 繼續維持那個 session 重置後的邊界，不會結單那一刻就跳回去跟結單前
-- 的舊帳混在一起。今天完全沒有相關的營業日紀錄才真的回傳零筆，退回
-- 沒有邊界的行為。
create or replace function relevant_biz_day_for_today()
returns setof biz_days
language sql
stable
as $$
  with open_row as (
    select * from open_biz_day()
  ),
  fallback as (
    select * from biz_days
    where closed_at is not null
      and (closed_at at time zone 'Asia/Taipei')::date = today_key()
    order by seq desc
    limit 1
  )
  select * from open_row
  union all
  select * from fallback where not exists (select 1 from open_row);
$$;

-- 某一筆紀錄算不算「今日」。純函式（所有跟時間有關的輸入都由呼叫端
-- 算好傳進來），immutable、好單元測試，不用每次呼叫都重新查表。
--
-- p_today：這次「今日」判定要用的參考日期——relevant_biz_day_for_today()
--          有結果就用它的 business_date，否則用行事曆今天。
-- p_calendar_today：today_key()，永遠是行事曆今天，跟 p_today 是兩回事
--          （結單後那段時間兩者會不一樣，見下面第二個分支的說明）。
-- p_biz_business_date / p_biz_opened_at：relevant_biz_day_for_today() 的
--          business_date／opened_at，沒有相關營業日就傳 null。
--
-- 兩種情況算「今日」：
--   ① 紀錄的日期跟 p_today 對得上，而且是在這個 session 開始之後記的
--      （負責「按開始歸零」跟「結單後維持邊界」）。
--   ② p_today 其實是「昨天」（跨夜營業日結單後的顯示日期），但這筆
--      紀錄剛好是「今天的行事曆日期」——結單後沒開新 session 又繼續
--      記的帳，不管什麼時候記的都算，不然這些新紀錄會被①排除在
--      「今日」之外。
create or replace function is_today_record(
  p_business_date date,
  p_created_at timestamptz,
  p_today date,
  p_calendar_today date,
  p_biz_business_date date,
  p_biz_opened_at timestamptz
)
returns boolean
language sql
immutable
as $$
  select
    case
      when p_business_date = p_today then
        (p_biz_opened_at is null or p_created_at >= p_biz_opened_at)
      when p_biz_business_date is not null
        and p_biz_business_date <> p_calendar_today
        and p_business_date = p_calendar_today
      then true
      else false
    end;
$$;

-- ── 本週範圍（週日起）────────────────────────────────────
--
-- 對照 apps-script/Reports.gs 的 resolveRange('week')：今天照
-- current_business_date() 算（不是 relevant_biz_day_for_today()，這是
-- 報表跟機台詳細頁「本週淨收益」刻意共用的邊界，見那支函式上面的
-- 註解）。extract(dow from date) 回傳 0=週日…6=週六，跟 JS 的
-- getUTCDay() 同一套數字，週日當第一天只要往前推 dow 天。
create or replace function resolve_week_range()
returns table (week_from date, week_to date)
language sql
stable
as $$
  select
    current_business_date() - extract(dow from current_business_date())::int,
    current_business_date();
$$;

-- ── 機台的「今日」跟「本週淨收益」──────────────────────────
--
-- 對照 apps-script/Service.gs 的 _buildMachineDetail()——今日彙總跟本週
-- 淨收益（改成本週的來龍去脈見 apps-script/Archive.gs 的說明）算法完全
-- 照搬，加減乘除一個字元都對得上。骰台跟電子機台的欄位都算（一律回傳
-- 全部欄位，是骰台就 chip_* 系列是 0，是電子機台 in/out/prize 系列是
-- 0，前端自己依 machines.category 決定要顯示哪一組——跟現有 GAS API
-- 回傳的形狀一致）。
--
-- plpgsql（不是純 sql）是為了 can_see_machine() 這個明確擋權限的
-- if——RLS 本身已經會讓沒權限的人查 records 查到空的（算出來全部是
-- 0），但那樣使用者分不出「這台機台今天真的是 0」還是「我根本沒有
-- 權限看」，明確擋掉、丟出錯誤訊息，跟現有 assertMachineAccess() 的
-- 行為一致。
create or replace function machine_today_and_week(p_machine_id text)
returns table (
  today_in numeric, today_out numeric, today_prize numeric, today_net numeric,
  today_chip_in numeric, today_chip_out numeric, today_chip_net numeric,
  today_432_count numeric,
  week_in numeric, week_out numeric, week_prize numeric, week_net numeric,
  week_chip_in numeric, week_chip_out numeric, week_chip_net numeric,
  last_meter_reading numeric
)
language plpgsql
stable
as $$
begin
  if not can_see_machine(p_machine_id) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;

  return query
  with ctx as (
    select today_key() as calendar_today, current_business_date() as ref_today
  ),
  biz as (
    select business_date, opened_at from relevant_biz_day_for_today()
  ),
  week_range as (
    select week_from, week_to from resolve_week_range()
  ),
  base as (
    select
      r.*,
      is_today_record(
        r.business_date, r.created_at,
        coalesce(biz.business_date, ctx.calendar_today),
        ctx.calendar_today,
        biz.business_date,
        biz.opened_at
      ) as is_today,
      (r.business_date between week_range.week_from and week_range.week_to) as in_week
    from records r
    cross join ctx
    left join biz on true
    cross join week_range
    where r.machine_id = p_machine_id and r.voided = false
  )
  select
    coalesce(sum(amount) filter (where type = 'in' and is_today), 0),
    coalesce(sum(amount) filter (where type = 'out' and is_today), 0),
    coalesce(sum(amount) filter (where type = 'prize' and is_today), 0),
    coalesce(sum(amount) filter (where type = 'in' and is_today), 0)
      - coalesce(sum(amount) filter (where type = 'out' and is_today), 0)
      - coalesce(sum(amount) filter (where type = 'prize' and is_today), 0),
    coalesce(sum(amount) filter (where type = 'chip_in' and is_today), 0),
    coalesce(sum(amount) filter (where type = 'chip_out' and is_today), 0),
    coalesce(sum(amount) filter (where type = 'chip_in' and is_today), 0)
      - coalesce(sum(amount) filter (where type = 'chip_out' and is_today), 0),
    coalesce(sum(count) filter (where type = 'prize' and is_today and prize_name = '432'), 0),
    coalesce(sum(amount) filter (where type = 'in' and in_week), 0),
    coalesce(sum(amount) filter (where type = 'out' and in_week), 0),
    coalesce(sum(amount) filter (where type = 'prize' and in_week), 0),
    coalesce(sum(amount) filter (where type = 'in' and in_week), 0)
      - coalesce(sum(amount) filter (where type = 'out' and in_week), 0)
      - coalesce(sum(amount) filter (where type = 'prize' and in_week), 0),
    coalesce(sum(amount) filter (where type = 'chip_in' and in_week), 0),
    coalesce(sum(amount) filter (where type = 'chip_out' and in_week), 0),
    coalesce(sum(amount) filter (where type = 'chip_in' and in_week), 0)
      - coalesce(sum(amount) filter (where type = 'chip_out' and in_week), 0),
    (select meter_end from base where type = 'in' and meter_end is not null order by seq desc limit 1)
  from base;
end;
$$;
