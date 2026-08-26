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

-- ── 首頁 dashboard ───────────────────────────────────────
--
-- 對照 apps-script/Service.gs 的 getDashboard()／businessDayStatus()／
-- _publicBizDay()／_dailyLedgerRow()／_publicDailyLedger()。回傳單一
-- jsonb（不是 table），刻意跟現有 GAS API 回傳的 JSON 形狀一模一樣
-- （machines/todayTotal/diceTotal/electronicTotal/today432Count/...），
-- Phase 5 前端改接的時候，這支的呼叫端幾乎不用改動 app.js 讀取資料的
-- 那段程式碼，只要換掉呼叫方式（api('dashboard') → rpc('dashboard')）。

-- 營業日的公開形狀（openedByName／closedByName 要 join profiles 換成
-- 顯示名稱，同一個道理也用在下面的 business_day_status()）。
create or replace function public_biz_day(p_biz biz_days)
returns jsonb
language sql
stable
as $$
  select case when p_biz is null then null else
    jsonb_build_object(
      'businessDate', p_biz.business_date::text,
      'openedAt', p_biz.opened_at,
      'openedByName', coalesce((select coalesce(nullif(display_name, ''), username) from profiles where id = p_biz.opened_by), ''),
      'closedAt', p_biz.closed_at,
      'closedByName', case when p_biz.closed_by is null then null
        else (select coalesce(nullif(display_name, ''), username) from profiles where id = p_biz.closed_by) end,
      'autoClosed', p_biz.auto_closed
    )
  end;
$$;

-- 首頁「今日營業開始／結單」按鈕狀態——刻意只看「目前進行中」的營業日
-- （open_biz_day()），不是 relevant_biz_day_for_today()：這兩個概念不
-- 一樣，結單後這裡要顯示「沒有進行中」，即使今日彙總（dashboard() 的
-- 'today' 那個邊界）還在沿用剛結束那個 session。
create or replace function business_day_status()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'open', exists(select 1 from open_biz_day()),
    'current', (select public_biz_day(b) from open_biz_day() b)
  );
$$;

-- 今天（相關營業日邊界）的每日手動帳目那一列，沒設定過就是零筆。
-- 對照 _dailyLedgerRow()：只認相關營業日 session 自己存的那一列（biz_id
-- 要對得上），沒有相關 session 才退回單純比對日期、取最新一列。
create or replace function daily_ledger_row_for_today()
returns setof daily_ledger
language sql
stable
as $$
  with today_ref as (
    select coalesce((select business_date from relevant_biz_day_for_today()), today_key()) as d
  ),
  relevant_biz as (
    select biz_id from relevant_biz_day_for_today()
  )
  select dl.*
  from daily_ledger dl, today_ref
  where dl.business_date = today_ref.d
    and (
      (exists (select 1 from relevant_biz) and dl.biz_id = (select biz_id from relevant_biz))
      or not exists (select 1 from relevant_biz)
    )
  order by dl.seq desc
  limit 1;
$$;

-- 台主給／台主領明細：新欄位（jsonb 陣列）沒有資料（或全是金額 0 的
-- 項目）時，退回舊欄位（單一數字）給一個預設名稱；金額 0 的項目一律
-- 濾掉，不用留著佔位子。對照 _parseLedgerItems()／_ledgerItemsOrLegacy()。
create or replace function ledger_items_or_legacy(p_items jsonb, p_legacy_amount numeric, p_legacy_name text)
returns jsonb
language sql
immutable
as $$
  with filtered as (
    select coalesce(jsonb_agg(elem), '[]'::jsonb) as arr
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) elem
    where coalesce((elem->>'amount')::numeric, 0) <> 0
  )
  select case
    when jsonb_array_length((select arr from filtered)) > 0 then (select arr from filtered)
    when coalesce(p_legacy_amount, 0) <> 0 then jsonb_build_array(jsonb_build_object('name', p_legacy_name, 'amount', p_legacy_amount))
    else '[]'::jsonb
  end;
$$;

create or replace function sum_ledger_items(p_items jsonb)
returns numeric
language sql
immutable
as $$
  select coalesce(sum((elem->>'amount')::numeric), 0)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) elem;
$$;

-- 轉成前端要的形狀，沒設定過的營業日（p_row 是 null）各項都當 0／空
-- 清單，不是回傳 null 讓前端自己判斷。對照 _publicDailyLedger()。
create or replace function public_daily_ledger(p_row daily_ledger)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'turnover', coalesce(p_row.turnover, 0),
    'transport', coalesce(p_row.transport, 0),
    'givenToOwnerItems', ledger_items_or_legacy(p_row.given_to_owner_items, p_row.given_to_owner, '台主給'),
    'givenToOwner', sum_ledger_items(ledger_items_or_legacy(p_row.given_to_owner_items, p_row.given_to_owner, '台主給')),
    'takenByOwnerItems', ledger_items_or_legacy(p_row.taken_by_owner_items, p_row.taken_by_owner, '台主領'),
    'takenByOwner', sum_ledger_items(ledger_items_or_legacy(p_row.taken_by_owner_items, p_row.taken_by_owner, '台主領')),
    'returnedToHouse', coalesce(p_row.returned_to_house, 0),
    'manual432', coalesce(p_row.manual_432, 0),
    'manual441', coalesce(p_row.manual_441, 0),
    'manualExpense', coalesce(p_row.manual_expense, 0),
    'updatedAt', coalesce(p_row.updated_at::text, '')
  );
$$;

-- 首頁本體。SECURITY INVOKER（預設）：records/machines 兩張表都靠呼叫者
-- 的 RLS 自動篩成「看得到的機台」，不用像 GAS 版本那樣自己先查一輪
-- visibleMachineIds() 再逐一比對——這是走「前端直連＋RLS」比原本 GAS
-- 架構單純的地方，篩選權限的程式碼完全不用在這裡重複一次。
create or replace function dashboard()
returns jsonb
language sql
stable
as $$
  with ctx as (
    select
      today_key() as calendar_today,
      coalesce((select business_date from relevant_biz_day_for_today()), today_key()) as today_ref,
      (select opened_at from relevant_biz_day_for_today()) as biz_opened_at,
      (select business_date from relevant_biz_day_for_today()) as biz_business_date
  ),
  rec as (
    select
      r.*,
      is_today_record(
        r.business_date, r.created_at,
        (select today_ref from ctx),
        (select calendar_today from ctx),
        (select biz_business_date from ctx),
        (select biz_opened_at from ctx)
      ) as is_today,
      date_trunc('month', r.business_date) = date_trunc('month', (select today_ref from ctx)) as is_this_month
    from records r
    where r.voided = false
      -- RLS 已經把看不到的機台的紀錄濾掉；這裡不用再另外 join machines
      -- 限一次範圍，records 表自己的 policy 就是 can_see_machine()。
  ),
  per_machine_today as (
    select
      machine_id,
      coalesce(sum(amount) filter (where type = 'in'), 0) as in_amt,
      coalesce(sum(amount) filter (where type = 'out'), 0) as out_amt,
      coalesce(sum(amount) filter (where type = 'prize'), 0) as prize_amt,
      coalesce(sum(amount) filter (where type = 'chip_in'), 0) as chip_in_amt,
      coalesce(sum(amount) filter (where type = 'chip_out'), 0) as chip_out_amt
    from rec
    where is_today
    group by machine_id
  ),
  per_machine_total as (
    select
      machine_id,
      coalesce(sum(amount) filter (where type = 'in'), 0) as in_amt,
      coalesce(sum(amount) filter (where type = 'out'), 0) as out_amt,
      coalesce(sum(amount) filter (where type = 'prize'), 0) as prize_amt,
      coalesce(sum(amount) filter (where type = 'chip_in'), 0) as chip_in_amt,
      coalesce(sum(amount) filter (where type = 'chip_out'), 0) as chip_out_amt
    from rec
    group by machine_id
  ),
  machine_list as (
    select
      m.machine_id, m.name, m.location, m.status, m.color, m.sort_order, m.category, m.icon,
      coalesce(t.in_amt, 0) as today_in, coalesce(t.out_amt, 0) as today_out, coalesce(t.prize_amt, 0) as today_prize,
      coalesce(t.chip_in_amt, 0) as today_chip_in, coalesce(t.chip_out_amt, 0) as today_chip_out,
      jsonb_build_object(
        'in', coalesce(t.in_amt, 0), 'out', coalesce(t.out_amt, 0), 'prize', coalesce(t.prize_amt, 0),
        'net', coalesce(t.in_amt, 0) - coalesce(t.out_amt, 0) - coalesce(t.prize_amt, 0),
        'chipIn', coalesce(t.chip_in_amt, 0), 'chipOut', coalesce(t.chip_out_amt, 0),
        'chipNet', coalesce(t.chip_in_amt, 0) - coalesce(t.chip_out_amt, 0)
      ) as today_json,
      jsonb_build_object(
        'in', m.carry_in + coalesce(a.in_amt, 0), 'out', m.carry_out + coalesce(a.out_amt, 0),
        'prize', m.carry_prize + coalesce(a.prize_amt, 0),
        'net', (m.carry_in + coalesce(a.in_amt, 0)) - (m.carry_out + coalesce(a.out_amt, 0)) - (m.carry_prize + coalesce(a.prize_amt, 0)),
        'chipIn', m.carry_chip_in + coalesce(a.chip_in_amt, 0), 'chipOut', m.carry_chip_out + coalesce(a.chip_out_amt, 0),
        'chipNet', (m.carry_chip_in + coalesce(a.chip_in_amt, 0)) - (m.carry_chip_out + coalesce(a.chip_out_amt, 0))
      ) as total_json
    from machines m
    left join per_machine_today t on t.machine_id = m.machine_id
    left join per_machine_total a on a.machine_id = m.machine_id
  ),
  machines_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'machineId', machine_id, 'name', name, 'location', location, 'status', status,
        'color', color, 'sortOrder', sort_order, 'category', category, 'icon', icon,
        'today', today_json, 'total', total_json
      ) order by sort_order, name
    ), '[]'::jsonb) as val
    from machine_list
  ),
  dice_total as (
    select
      coalesce(sum(today_in) filter (where category <> 'electronic'), 0) as in_amt,
      coalesce(sum(today_out) filter (where category <> 'electronic'), 0) as out_amt,
      coalesce(sum(today_prize) filter (where category <> 'electronic'), 0) as prize_amt
    from machine_list
  ),
  electronic_total as (
    select
      coalesce(sum(today_chip_in) filter (where category = 'electronic'), 0) as chip_in_amt,
      coalesce(sum(today_chip_out) filter (where category = 'electronic'), 0) as chip_out_amt
    from machine_list
  ),
  today_prize_stats as (
    select
      coalesce(sum(count) filter (where type = 'prize' and is_today and prize_name = '432'), 0) as count432,
      coalesce(sum(amount) filter (where type = 'prize' and is_today and prize_name = '432'), 0) as amount432,
      coalesce(sum(count) filter (where type = 'prize' and is_today and prize_name = '441'), 0) as count441,
      coalesce(count(*) filter (where type = 'out' and is_today), 0) as out_count
    from rec
  ),
  month_prize_stats as (
    select
      coalesce(sum(count) filter (where type = 'prize' and is_this_month and prize_name = '432'), 0) as count432,
      coalesce(sum(count) filter (where type = 'prize' and is_this_month and prize_name = '441'), 0) as count441
    from rec
  ),
  ledger_json as (
    select public_daily_ledger((select l from daily_ledger_row_for_today() l limit 1)) as val
  )
  select jsonb_build_object(
    'machines', (select val from machines_json),
    'todayTotal', jsonb_build_object(
      'in', (select in_amt from dice_total), 'out', (select out_amt from dice_total),
      'prize', (select prize_amt from dice_total),
      'net', (select in_amt from dice_total) - (select out_amt from dice_total) - (select prize_amt from dice_total),
      'chipIn', (select chip_in_amt from electronic_total), 'chipOut', (select chip_out_amt from electronic_total),
      'chipNet', (select chip_in_amt from electronic_total) - (select chip_out_amt from electronic_total)
    ),
    'diceTotal', jsonb_build_object(
      'in', (select in_amt from dice_total), 'out', (select out_amt from dice_total),
      'prize', (select prize_amt from dice_total),
      'net', (select in_amt from dice_total) - (select out_amt from dice_total) - (select prize_amt from dice_total),
      'chipIn', 0, 'chipOut', 0, 'chipNet', 0
    ),
    'electronicTotal', jsonb_build_object(
      'in', 0, 'out', 0, 'prize', 0, 'net', 0,
      'chipIn', (select chip_in_amt from electronic_total), 'chipOut', (select chip_out_amt from electronic_total),
      'chipNet', (select chip_in_amt from electronic_total) - (select chip_out_amt from electronic_total)
    ),
    'today432Count', (select count432 from today_prize_stats),
    'today432Amount', (select amount432 from today_prize_stats),
    'today441Count', (select count441 from today_prize_stats),
    'todayOutCount', (select out_count from today_prize_stats),
    'month432Count', (select count432 from month_prize_stats),
    'month441Count', (select count441 from month_prize_stats),
    'ledger', (select val from ledger_json),
    'ledgerTotal', round((
      (select in_amt from dice_total) - (select out_amt from dice_total)
      - coalesce(((select val from ledger_json) ->> 'manual432')::numeric, 0)
      - coalesce(((select val from ledger_json) ->> 'manual441')::numeric, 0)
      - coalesce(((select val from ledger_json) ->> 'manualExpense')::numeric, 0)
      + coalesce(((select val from ledger_json) ->> 'turnover')::numeric, 0)
      + coalesce(((select val from ledger_json) ->> 'givenToOwner')::numeric, 0)
      + ((select chip_in_amt from electronic_total) - (select chip_out_amt from electronic_total))
      - coalesce(((select val from ledger_json) ->> 'takenByOwner')::numeric, 0)
      + coalesce(((select val from ledger_json) ->> 'returnedToHouse')::numeric, 0)
    )::numeric, 2),
    'today', (select today_ref from ctx)::text,
    'businessDay', business_day_status()
  );
$$;

-- ── 寫入端：營業日開始／結單、每日手動帳目 ──────────────
--
-- 對照 apps-script/Service.gs 的 startBusinessDay()／endBusinessDay()／
-- saveDailyLedger()。這三個動作都要保「同一時間最多一組」的不變量
-- （最多一筆進行中的營業日；每個 session 的每日帳目只存一組），GAS
-- 版本靠 withLock() 這個全域鎖序列化「先查現況、再決定要 insert 還是
-- update」這整段過程；這裡改成兩件事一起做：schema.sql 加了對應的
-- unique index，把不變量直接下放給資料庫保證，寫入端則用
-- INSERT ... ON CONFLICT DO UPDATE（save_daily_ledger）或先關舊的再開
-- 新的（start_business_day）處理，單一 function 呼叫在 Postgres 裡
-- 天生是同一個交易，不需要另外顯式開 transaction。
-- 全部 SECURITY INVOKER，can_record() 明確擋權限，訊息跟 GAS 版本一致。

-- 對照 apps-script/Db.gs 的 newId(prefix)：前綴 + 16 個十六進位字元。
create or replace function new_id(p_prefix text)
returns text
language sql
volatile
as $$
  select p_prefix || '_' || left(replace(gen_random_uuid()::text, '-', ''), 16);
$$;

-- 對照 apps-script/Service.gs 的 _validSignedAmount()：允許負數（沖正用），
-- 只限制金額大小；缺值當 0（比 GAS 版本寬鬆一點點，GAS 那支其實沒有
-- `|| 0` 保底、缺值會直接丟錯——這個不一致在 GAS 原始碼裡看起來是沒
-- 特別設計過的副作用，這裡統一成「缺值當 0」，跟 _validOutflowAmount()
-- 一致，也比較貼近前端一定會送出明確數字的實際使用情境）。
create or replace function valid_signed_amount(p_raw numeric)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_raw is null then return 0; end if;
  if abs(p_raw) > 10000000 then
    raise exception '金額超出上限';
  end if;
  return round(p_raw, 2);
end;
$$;

-- 對照 _validOutflowAmount()：這幾項一律是現金流出，只能輸入正數，
-- 系統加總時自動扣除。
create or replace function valid_outflow_amount(p_raw numeric)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_raw is null then return 0; end if;
  if p_raw < 0 then
    raise exception '這項請輸入正數金額，系統會自動從總結餘扣除';
  end if;
  if p_raw > 10000000 then
    raise exception '金額超出上限';
  end if;
  return round(p_raw, 2);
end;
$$;

-- 整理台主給／台主領的清單：每筆驗證金額、名稱沒填就用預設名稱頂著、
-- 金額是 0（含沒填）的那幾筆直接丟掉。對照 _sanitizeLedgerItems()。
create or replace function sanitize_ledger_items(p_raw jsonb, p_outflow boolean, p_default_name text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_result jsonb := '[]'::jsonb;
  v_elem jsonb;
  v_amount numeric;
  v_name text;
begin
  if p_raw is null then return '[]'::jsonb; end if;
  if jsonb_typeof(p_raw) <> 'array' then
    raise exception '清單格式不正確';
  end if;
  if jsonb_array_length(p_raw) > 30 then
    raise exception '筆數超出上限';
  end if;

  for v_elem in select * from jsonb_array_elements(p_raw)
  loop
    if p_outflow then
      v_amount := valid_outflow_amount((v_elem ->> 'amount')::numeric);
    else
      v_amount := valid_signed_amount((v_elem ->> 'amount')::numeric);
    end if;
    if v_amount = 0 then
      continue;
    end if;
    v_name := coalesce(nullif(trim(both from coalesce(v_elem ->> 'name', '')), ''), p_default_name);
    v_name := left(v_name, 30);
    v_result := v_result || jsonb_build_array(jsonb_build_object('name', v_name, 'amount', v_amount));
  end loop;

  return v_result;
end;
$$;

-- 按下「今日營業開始」：如果前一個營業日忘記結單，直接幫忙結掉
-- （auto_closed=true），不會卡住不讓開新的。
create or replace function start_business_day()
returns jsonb
language plpgsql
as $$
declare
  v_open biz_days;
  v_now timestamptz := now();
  v_biz_id text := new_id('biz');
  v_previous_auto_closed boolean := false;
begin
  if not can_record() then
    raise exception '你的帳號沒有這個權限' using errcode = '42501';
  end if;

  select * into v_open from open_biz_day();
  if found then
    update biz_days
    set closed_at = v_now, closed_by = auth.uid(), auto_closed = true
    where biz_id = v_open.biz_id;
    v_previous_auto_closed := true;
  end if;

  insert into biz_days (biz_id, business_date, opened_at, opened_by, auto_closed)
  values (v_biz_id, today_key(), v_now, auth.uid(), false);

  return jsonb_build_object(
    'open', true,
    'current', (select public_biz_day(b) from biz_days b where biz_id = v_biz_id),
    'previousAutoClosed', v_previous_auto_closed
  );
end;
$$;

-- 按下「今日營業結單」。沒有進行中的營業日就明確報錯，不要默默沒反應。
create or replace function end_business_day()
returns jsonb
language plpgsql
as $$
declare
  v_open biz_days;
begin
  if not can_record() then
    raise exception '你的帳號沒有這個權限' using errcode = '42501';
  end if;

  select * into v_open from open_biz_day();
  if not found then
    raise exception '目前沒有進行中的營業日，請先按「今日營業開始」';
  end if;

  update biz_days
  set closed_at = now(), closed_by = auth.uid(), auto_closed = false
  where biz_id = v_open.biz_id;

  return jsonb_build_object(
    'open', false,
    'current', (select public_biz_day(b) from biz_days b where biz_id = v_open.biz_id)
  );
end;
$$;

-- 設定今天（相關營業日）的週轉金／台主給／台主領／手動活動支出432/441／
-- 開銷。同一個 session 裡重複儲存是覆蓋，不是疊加（INSERT ... ON CONFLICT
-- DO UPDATE，衝突鍵是 schema.sql 的 daily_ledger_one_per_biz_day_idx）。
-- p_returned_to_house 對應「還內場」——前端已經不會再送這個欄位（見
-- docs/app.js 的異動紀錄），這裡繼續接受、預設 0，只是為了不讓還沒
-- 更新的舊前端呼叫直接壞掉，不代表這個功能要復活。
create or replace function save_daily_ledger(
  p_turnover numeric,
  p_manual_expense numeric,
  p_manual432 numeric,
  p_manual441 numeric,
  p_given_to_owner_items jsonb,
  p_taken_by_owner_items jsonb,
  p_returned_to_house numeric default 0
)
returns jsonb
language plpgsql
as $$
declare
  v_turnover numeric := valid_signed_amount(p_turnover);
  v_manual_expense numeric := valid_outflow_amount(p_manual_expense);
  v_manual432 numeric := valid_outflow_amount(p_manual432);
  v_manual441 numeric := valid_outflow_amount(p_manual441);
  v_given jsonb := sanitize_ledger_items(p_given_to_owner_items, false, '台主給');
  v_taken jsonb := sanitize_ledger_items(p_taken_by_owner_items, true, '台主領');
  v_returned numeric := valid_signed_amount(p_returned_to_house);
  v_relevant biz_days;
  v_business_date date;
begin
  if not can_record() then
    raise exception '你的帳號沒有這個權限' using errcode = '42501';
  end if;

  select * into v_relevant from relevant_biz_day_for_today();
  v_business_date := coalesce(v_relevant.business_date, today_key());

  insert into daily_ledger (
    ledger_id, business_date, biz_id, turnover, transport, given_to_owner, taken_by_owner,
    given_to_owner_items, taken_by_owner_items, returned_to_house, manual_432, manual_441,
    manual_expense, updated_by, updated_at
  ) values (
    new_id('ldg'), v_business_date, v_relevant.biz_id, v_turnover, 0, 0, 0,
    v_given, v_taken, v_returned, v_manual432, v_manual441,
    v_manual_expense, auth.uid(), now()
  )
  on conflict (business_date, (coalesce(biz_id, '')))
  do update set
    turnover = excluded.turnover,
    transport = 0,
    given_to_owner = 0,
    taken_by_owner = 0,
    given_to_owner_items = excluded.given_to_owner_items,
    taken_by_owner_items = excluded.taken_by_owner_items,
    returned_to_house = excluded.returned_to_house,
    manual_432 = excluded.manual_432,
    manual_441 = excluded.manual_441,
    manual_expense = excluded.manual_expense,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  return public_daily_ledger((select l from daily_ledger_row_for_today() l limit 1));
end;
$$;
