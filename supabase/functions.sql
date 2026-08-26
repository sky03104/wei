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
  ),
  -- 對照 getDashboard() 的 todayOpenedByName：加總分頁日期前面顯示的
  -- 「今日開始營業的人」暱稱，跟 public_biz_day() 的 openedByName 同一套
  -- 查法（優先顯示 display_name，沒填就用 username）。
  today_opener as (
    select coalesce(nullif(p.display_name, ''), p.username) as name
    from relevant_biz_day_for_today() b
    join profiles p on p.id = b.opened_by
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
    'todayOpenedByName', coalesce((select name from today_opener), ''),
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

-- ── 報表／活動查詢／逐日對帳表格線 ──────────────────────
--
-- 對照 apps-script/Reports.gs。這支檔案原本還有「歷史」preset 明確願意
-- 跨分頁合併查詢已封存資料、其餘 preset 選到已封存區間要報錯（見
-- _assertRangeNotArchived()）這一整套機制——那是配合季度封存
-- （apps-script/Archive.gs）存在的，Postgres 版本 records 表本來就是
-- 索引查詢、不會隨資料量變慢，不需要季度封存，這套機制整個不需要搬過
-- 來：這裡的 'history' preset 直接等同 'custom'（都只是要求明確給
-- from／to），沒有「選到已封存區間」這件事。

-- 對照 resolveRange()：day=今天、week=本週（週日起）、month=本月
-- （1號起）、custom/history=自己給的區間（一定要給 from／to，且
-- from<=to）。「今天」用 current_business_date()，跟報表頁的既有行為
-- 一致——有進行中的營業日，週/月的邊界也照營業日算。
create or replace function resolve_range(p_preset text, p_from date, p_to date)
returns table (range_from date, range_to date, preset text)
language plpgsql
stable
as $$
declare
  v_today date := current_business_date();
begin
  if p_preset = 'custom' or p_preset = 'history' then
    if p_from is null or p_to is null then
      raise exception '日期格式不正確';
    end if;
    if p_from > p_to then
      raise exception '起始日期不能晚於結束日期';
    end if;
    return query select p_from, p_to, p_preset;
    return;
  end if;

  if p_preset = 'week' then
    return query select w.week_from, w.week_to, 'week'::text from resolve_week_range() w;
    return;
  end if;

  if p_preset = 'month' then
    return query select date_trunc('month', v_today)::date, v_today, 'month'::text;
    return;
  end if;

  return query select v_today, v_today, 'day'::text;
end;
$$;

-- 報表要看哪些機台：指定單一機台就只有那一台（可見性另外在呼叫端用
-- can_see_machine() 明確擋），沒指定機台則是這個帳號看得到的全部
-- （machines 表本身已經被 RLS 篩過，這裡直接查就是「看得到的」），
-- p_category 有值時再篩出該分類。對照 _reportScope()。
create or replace function report_scope_machine_ids(p_machine_id text, p_category text)
returns setof text
language sql
stable
as $$
  select machine_id from machines
  where (p_machine_id is not null and machine_id = p_machine_id)
     or (p_machine_id is null and (coalesce(p_category, '') = '' or category = p_category));
$$;

-- 報表本體。對照 getReport()。SECURITY INVOKER，records/machines 兩張表
-- 靠 RLS 自動篩成看得到的範圍；指定單一機台時額外用 can_see_machine()
-- 明確擋沒有權限的呼叫（RLS 本身會讓沒權限的人查到空結果，這裡擋出
-- 明確錯誤訊息，跟 assertMachineAccess() 行為一致）。
create or replace function report(
  p_machine_id text default null,
  p_category text default null,
  p_preset text default 'day',
  p_from date default null,
  p_to date default null,
  p_type text default null,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_machine_id text := nullif(p_machine_id, '');
  v_category text;
  v_machine_name text;
  v_result jsonb;
begin
  if v_machine_id is not null then
    if not can_see_machine(v_machine_id) then
      raise exception '沒有這台機台的權限' using errcode = '42501';
    end if;
    select coalesce(name, ''), coalesce(category, '') into v_machine_name, v_category
    from machines where machine_id = v_machine_id;
  else
    v_category := case when p_category in ('dice', 'electronic') then p_category else '' end;
    v_machine_name := case v_category
      when 'electronic' then '全部電子機台'
      when 'dice' then '全部骰台'
      else ''
    end;
  end if;

  with range as (
    select * from resolve_range(p_preset, p_from, p_to)
  ),
  scope_ids as (
    select report_scope_machine_ids(v_machine_id, v_category) as machine_id
  ),
  rows as (
    select r.* from records r, range
    where r.machine_id in (select machine_id from scope_ids)
      and r.voided = false
      and r.business_date between range.range_from and range.range_to
      and (nullif(p_type, '') is null or r.type = p_type)
      and (p_user_id is null or r.user_id = p_user_id)
  ),
  summary as (
    select
      coalesce(sum(amount) filter (where type = 'in'), 0) as in_amt,
      coalesce(sum(amount) filter (where type = 'out'), 0) as out_amt,
      coalesce(sum(amount) filter (where type = 'prize'), 0) as prize_amt,
      coalesce(sum(amount) filter (where type = 'chip_in'), 0) as chip_in_amt,
      coalesce(sum(amount) filter (where type = 'chip_out'), 0) as chip_out_amt
    from rows
  ),
  days as (
    select generate_series((select range_from from range), (select range_to from range), interval '1 day')::date as d
  ),
  daily as (
    select
      days.d,
      coalesce(sum(rows.amount) filter (where rows.type = 'in'), 0) as in_amt,
      coalesce(sum(rows.amount) filter (where rows.type = 'out'), 0) as out_amt,
      coalesce(sum(rows.amount) filter (where rows.type = 'prize'), 0) as prize_amt,
      coalesce(sum(rows.amount) filter (where rows.type = 'chip_in'), 0) as chip_in_amt,
      coalesce(sum(rows.amount) filter (where rows.type = 'chip_out'), 0) as chip_out_amt
    from days
    left join rows on rows.business_date = days.d
    group by days.d
  ),
  trend_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'date', d::text, 'in', in_amt, 'out', out_amt, 'prize', prize_amt,
        'net', in_amt - out_amt - prize_amt,
        'chipIn', chip_in_amt, 'chipOut', chip_out_amt, 'chipNet', chip_in_amt - chip_out_amt
      ) order by d
    ), '[]'::jsonb) as val
    from daily
  ),
  prize_stats as (
    select coalesce(nullif(prize_name, ''), '(未命名獎型)') as label, sum(count) as cnt, sum(amount) as amt
    from rows
    where type = 'prize'
    group by coalesce(nullif(prize_name, ''), '(未命名獎型)')
  ),
  prize_stats_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object('name', label, 'count', coalesce(cnt, 0), 'amount', coalesce(amt, 0))
      order by amt desc
    ), '[]'::jsonb) as val
    from prize_stats
  ),
  records_ranked as (
    select r.*, row_number() over (order by r.created_at desc, r.seq desc) as rn
    from rows r
  ),
  records_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'recordId', record_id, 'machineId', machine_id, 'type', type, 'amount', amount,
        'prizeName', coalesce(prize_name, ''), 'unitAmount', unit_amount, 'count', count,
        'meterStart', meter_start, 'meterEnd', meter_end,
        'userName', (select coalesce(nullif(p.display_name, ''), p.username) from profiles p where p.id = records_ranked.user_id),
        'createdAt', created_at, 'businessDate', business_date::text, 'note', coalesce(note, '')
      ) order by created_at desc, seq desc
    ), '[]'::jsonb) as val
    from records_ranked
    where rn <= 500
  ),
  record_count as (
    select count(*) as n from rows
  ),
  operators_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object('userId', p.id::text, 'name', coalesce(nullif(p.display_name, ''), p.username))
      order by p.username
    ), '[]'::jsonb) as val
    from (select distinct user_id from rows) o
    join profiles p on p.id = o.user_id
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
      'from', (select range_from from range)::text, 'to', (select range_to from range)::text,
      'preset', (select preset from range)
    ),
    'scope', jsonb_build_object(
      'machineId', coalesce(v_machine_id, ''), 'machineName', v_machine_name,
      'machineCount', (select count(*) from scope_ids), 'category', v_category
    ),
    'summary', jsonb_build_object(
      'in', (select in_amt from summary), 'out', (select out_amt from summary), 'prize', (select prize_amt from summary),
      'net', (select in_amt from summary) - (select out_amt from summary) - (select prize_amt from summary),
      'chipIn', (select chip_in_amt from summary), 'chipOut', (select chip_out_amt from summary),
      'chipNet', (select chip_in_amt from summary) - (select chip_out_amt from summary)
    ),
    'trend', (select val from trend_json),
    'prizeStats', (select val from prize_stats_json),
    'records', (select val from records_json),
    'recordCount', (select n from record_count),
    'truncated', (select n from record_count) > 500,
    'operators', (select val from operators_json)
  ) into v_result;

  return v_result;
end;
$$;

-- 「活動查詢」：自訂日期範圍內的432/441支數＋每天手動填的開銷加總，
-- 不特定看哪一台機台，是這個帳號看得到的全部機台合併算。對照
-- getActivityQuery()／_sumManualExpenseInRange()。
create or replace function activity_query(p_from date, p_to date)
returns jsonb
language sql
stable
as $$
  with range as (
    select * from resolve_range('custom', p_from, p_to)
  ),
  rows as (
    select r.* from records r, range
    where r.voided = false
      and r.type = 'prize'
      and r.business_date between range.range_from and range.range_to
      -- machines 已經被 RLS 篩過，這裡直接 join 現在看得到的機台即可，
      -- 不用像 GAS 版本那樣自己先查一輪 visibleMachineIds()。
      and r.machine_id in (select machine_id from machines)
  ),
  counts as (
    select
      coalesce(sum(count) filter (where prize_name = '432'), 0) as count432,
      coalesce(sum(count) filter (where prize_name = '441'), 0) as count441
    from rows
  ),
  -- 逐天取那一天 daily_ledger 最新（seq 最大）的一列，同一天可能因為忘記
  -- 結單又重開之類的情況存過好幾列，只算最後那列，其餘視為被覆蓋。
  latest_ledger_per_day as (
    select distinct on (business_date) business_date, manual_expense
    from daily_ledger
    where business_date between (select range_from from range) and (select range_to from range)
    order by business_date, seq desc
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
      'from', (select range_from from range)::text, 'to', (select range_to from range)::text,
      'preset', (select preset from range)
    ),
    'count432', (select count432 from counts),
    'count441', (select count441 from counts),
    'manualExpense', coalesce((select sum(manual_expense) from latest_ledger_per_day), 0)
  );
$$;

-- 逐日對帳表格線（「匯出 Excel」「匯出截圖」共用的資料來源）。對照
-- _buildLedgerGrid()：橫向一欄一天，直向把當天每一筆出幣依發生順序
-- 列出來，底下再接出幣/432/441/入幣/+/- 五列小計，最右邊兩欄是整個
-- 區間的總計。純資料，不含任何樣式（粗體/底色/紅字是前端畫 Excel／
-- canvas 時才套的，見 docs/app.js 的 exportLedgerXlsx／
-- drawLedgerGridCanvas 之後接上這支時要做的事）。
--
-- 跟 GAS 版本一樣是「不管給不給 machineId 都是同一份邏輯」：要匯出
-- 「全部骰台」那種一台一張圖的情境，呼叫端自己對每台機台各呼叫一次
-- （傳不同的 p_machine_id），不是這支自己迴圈——完全對應現有
-- exportLedgerXlsx()／exportLedgerGrids() 呼叫 _buildLedgerGrid() 的
-- 方式，只是迴圈本身搬到前端做。
create or replace function ledger_grid(
  p_machine_id text default null,
  p_category text default null,
  p_preset text default 'day',
  p_from date default null,
  p_to date default null,
  p_type text default null,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_machine_id text := nullif(p_machine_id, '');
  v_category text;
  v_machine_name text;
  v_label text;
  v_result jsonb;
begin
  if v_machine_id is not null then
    if not can_see_machine(v_machine_id) then
      raise exception '沒有這台機台的權限' using errcode = '42501';
    end if;
    select coalesce(name, ''), coalesce(category, '') into v_machine_name, v_category
    from machines where machine_id = v_machine_id;
  else
    v_category := case when p_category in ('dice', 'electronic') then p_category else '' end;
    v_machine_name := case v_category
      when 'electronic' then '全部電子機台'
      when 'dice' then '全部骰台'
      else ''
    end;
  end if;
  v_label := nullif(v_machine_name, '');
  if v_label is null then
    v_label := '全部機台';
  end if;

  with range as (
    select * from resolve_range(p_preset, p_from, p_to)
  ),
  scope_ids as (
    select report_scope_machine_ids(v_machine_id, v_category) as machine_id
  ),
  days as (
    select generate_series((select range_from from range), (select range_to from range), interval '1 day')::date as d
  ),
  rows as (
    select r.* from records r, range
    where r.machine_id in (select machine_id from scope_ids)
      and r.voided = false
      and r.business_date between range.range_from and range.range_to
      and (nullif(p_type, '') is null or r.type = p_type)
      and (p_user_id is null or r.user_id = p_user_id)
  ),
  out_rows_ranked as (
    select
      business_date, amount,
      row_number() over (partition by business_date order by created_at asc, seq asc) as rn
    from rows
    where type = 'out'
  ),
  max_outs as (
    select coalesce(max(rn), 0) as n from out_rows_ranked
  ),
  day_agg as (
    select
      d.d,
      coalesce(sum(r.amount) filter (where r.type = 'in'), 0) as in_total,
      coalesce(sum(r.count) filter (where r.type = 'prize' and r.prize_name = '432'), 0) as count432,
      coalesce(sum(r.amount) filter (where r.type = 'prize' and r.prize_name = '432'), 0) as amount432,
      coalesce(sum(r.count) filter (where r.type = 'prize' and r.prize_name = '441'), 0) as count441,
      coalesce(sum(r.amount) filter (where r.type = 'prize' and r.prize_name = '441'), 0) as amount441,
      coalesce(sum(r.amount) filter (where r.type = 'out'), 0) as out_total
    from days d
    left join rows r on r.business_date = d.d
    group by d.d
  ),
  header_row as (
    select
      jsonb_build_array('圖數')
      || coalesce(jsonb_agg((extract(month from d)::int || '月' || extract(day from d)::int || '日') order by d), '[]'::jsonb)
      || jsonb_build_array('', '')
      as val
    from days
  ),
  out_grid_rows as (
    select coalesce(jsonb_agg(row_arr order by rn), '[]'::jsonb) as val
    from (
      select
        gs.rn,
        jsonb_build_array(gs.rn::text)
        || jsonb_agg(coalesce(to_jsonb(oo.amount), '""'::jsonb) order by d.d)
        || jsonb_build_array('', '')
        as row_arr
      from generate_series(1, (select n from max_outs)) as gs(rn)
      cross join days d
      left join out_rows_ranked oo on oo.business_date = d.d and oo.rn = gs.rn
      group by gs.rn
    ) t
  ),
  summary_days as (
    select
      coalesce(jsonb_agg(out_total order by d), '[]'::jsonb) as out_by_day,
      coalesce(jsonb_agg(count432 order by d), '[]'::jsonb) as c432_by_day,
      coalesce(jsonb_agg(count441 order by d), '[]'::jsonb) as c441_by_day,
      coalesce(jsonb_agg(in_total order by d), '[]'::jsonb) as in_by_day,
      coalesce(jsonb_agg(in_total - out_total - amount432 - amount441 order by d), '[]'::jsonb) as net_by_day,
      coalesce(sum(out_total), 0) as grand_out,
      coalesce(sum(count432), 0) as grand_432,
      coalesce(sum(count441), 0) as grand_441,
      coalesce(sum(in_total), 0) as grand_in,
      coalesce(sum(in_total - out_total - amount432 - amount441), 0) as grand_net
    from day_agg
  ),
  summary_rows as (
    select jsonb_build_array(
      jsonb_build_array('出幣') || out_by_day || jsonb_build_array('總出幣', grand_out),
      jsonb_build_array('432') || c432_by_day || jsonb_build_array('432', grand_432),
      jsonb_build_array('441') || c441_by_day || jsonb_build_array('441', grand_441),
      jsonb_build_array('入幣') || in_by_day || jsonb_build_array('總入幣', grand_in),
      jsonb_build_array('+/-') || net_by_day || jsonb_build_array('+/-', grand_net)
    ) as val
    from summary_days
  ),
  row_count as (
    select count(*) as n from rows
  )
  select jsonb_build_object(
    'filenameBase', '娃娃機對帳表_' || v_label || '_' || (select range_from from range)::text || '_' || (select range_to from range)::text,
    'rowCount', (select n from row_count),
    'colCount', jsonb_array_length((select val from header_row)),
    'headerRow', (select val from header_row),
    'outRows', (select val from out_grid_rows),
    'summaryRows', (select val from summary_rows)
  ) into v_result;

  return v_result;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 記帳寫入 + 全局預設/單台覆寫設定 + 系統管理 CRUD
-- 對照 apps-script/Service.gs 的 addRecord/addMeterRecord/addPrizeRecord/
-- voidRecord、_scopedRows() 系列、以及系統管理頁那一批 admin* 動作。
-- 全部 SECURITY INVOKER：寫入型的表本身也有對應的 RLS policy
-- （can_record()/is_admin()），這裡的檢查是為了給出跟 GAS 一致的錯誤訊息，
-- RLS 是最後一道防線，不是唯一一道。
-- ═══════════════════════════════════════════════════════════════════════

-- 對照 _validAmount()：正數、四捨五入到分、有上限。
create or replace function valid_amount(p_raw numeric)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_raw is null or p_raw <= 0 then
    raise exception '金額必須是大於 0 的數字';
  end if;
  if p_raw > 10000000 then
    raise exception '金額超出上限';
  end if;
  return round(p_raw, 2);
end;
$$;

-- 對照 _validMeterReading()：非負整數，機械式計數器不會有小數或負數。
create or replace function valid_meter_reading(p_raw numeric)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_raw is null then
    raise exception '碼表讀數必須是數字';
  end if;
  if p_raw < 0 then
    raise exception '碼表讀數不能是負數';
  end if;
  if p_raw <> floor(p_raw) then
    raise exception '碼表讀數必須是整數';
  end if;
  if p_raw > 99999999 then
    raise exception '碼表讀數超出上限';
  end if;
  return p_raw;
end;
$$;

-- 對照 _validCount()：開獎次數，非負整數。
create or replace function valid_count(p_raw numeric)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_raw is null then
    raise exception '次數必須是數字';
  end if;
  if p_raw < 0 then
    raise exception '次數不能是負數';
  end if;
  if p_raw <> floor(p_raw) then
    raise exception '次數必須是整數';
  end if;
  if p_raw > 9999 then
    raise exception '次數超出上限';
  end if;
  return p_raw;
end;
$$;

-- 單筆紀錄的公開形狀，對照 _publicRecord()。
create or replace function public_record(p_row records)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'recordId', p_row.record_id,
    'machineId', p_row.machine_id,
    'type', p_row.type,
    'amount', p_row.amount,
    'prizeName', coalesce(p_row.prize_name, ''),
    'unitAmount', p_row.unit_amount,
    'count', p_row.count,
    'meterStart', p_row.meter_start,
    'meterEnd', p_row.meter_end,
    'userName', (select coalesce(nullif(display_name, ''), username) from profiles where id = p_row.user_id),
    'createdAt', p_row.created_at,
    'businessDate', p_row.business_date,
    'note', coalesce(p_row.note, '')
  );
$$;

-- ── 全局預設 + 單台覆寫（快捷金額／獎型／碼表費率）────────────
-- 共用規則：該機台有自己的設定就用它，完全沒有才落回全局（machine_id=''）。
-- 對照 _scopedRows()。這三張表各自欄位形狀不同，分開寫成三支而不是共用
-- 一支動態 SQL，圖個型別安全、也跟 GAS 版本一樣一支只管一種設定。

create or replace function resolve_quick_amounts(p_machine_id text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_scope text;
  v_pick_machine text;
  v_in jsonb;
  v_out jsonb;
begin
  v_scope := case when exists(select 1 from quick_amounts where machine_id = p_machine_id) then 'machine' else 'global' end;
  v_pick_machine := case when v_scope = 'machine' then p_machine_id else '' end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'qaId', qa_id, 'machineId', machine_id, 'type', type, 'amount', amount,
    'label', coalesce(nullif(label, ''), '$' || amount::text), 'sortOrder', sort_order
  ) order by sort_order, amount), '[]'::jsonb)
  into v_in
  from quick_amounts where machine_id = v_pick_machine and type = 'in';

  select coalesce(jsonb_agg(jsonb_build_object(
    'qaId', qa_id, 'machineId', machine_id, 'type', type, 'amount', amount,
    'label', coalesce(nullif(label, ''), '$' || amount::text), 'sortOrder', sort_order
  ) order by sort_order, amount), '[]'::jsonb)
  into v_out
  from quick_amounts where machine_id = v_pick_machine and type = 'out';

  return jsonb_build_object('scope', v_scope, 'in', v_in, 'out', v_out);
end;
$$;

create or replace function resolve_prizes(p_machine_id text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_scope text;
  v_pick_machine text;
  v_prizes jsonb;
begin
  v_scope := case when exists(select 1 from prizes where machine_id = p_machine_id) then 'machine' else 'global' end;
  v_pick_machine := case when v_scope = 'machine' then p_machine_id else '' end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'prizeId', prize_id, 'machineId', machine_id, 'name', name, 'amount', amount,
    'sortOrder', sort_order, 'scope', v_scope
  ) order by sort_order, amount), '[]'::jsonb)
  into v_prizes
  from prizes where machine_id = v_pick_machine and active;

  return jsonb_build_object('scope', v_scope, 'prizes', v_prizes);
end;
$$;

create or replace function resolve_meter_rate(p_machine_id text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_scope text;
  v_row meter_rates;
begin
  v_scope := case when exists(select 1 from meter_rates where machine_id = p_machine_id) then 'machine' else 'global' end;
  select * into v_row from meter_rates
  where machine_id = (case when v_scope = 'machine' then p_machine_id else '' end)
  limit 1;
  return jsonb_build_object('scope', v_scope, 'rate', coalesce(v_row.rate, 100));
end;
$$;

-- ── 記帳（入幣／出幣／碼表／開獎）───────────────────────────

-- 對照 addRecord()：連同最新的機台詳細頁資料（machine_detail()）一起
-- 回傳，前端寫入成功後不用再多打一次查詢，對照 GAS 的
-- result.detail = getMachineDetail(...)。
create or replace function add_record(
  p_machine_id text, p_type text, p_amount numeric, p_note text, p_client_token text
)
returns jsonb
language plpgsql
as $$
declare
  v_category text;
  v_amount numeric;
  v_token text := coalesce(p_client_token, '');
  v_dup records;
  v_rec records;
begin
  if not can_record() then
    raise exception '你的帳號沒有記帳權限' using errcode = '42501';
  end if;
  if not can_see_machine(p_machine_id) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;

  select category into v_category from machines where machine_id = p_machine_id;
  if v_category is null then
    raise exception '找不到這台機台';
  end if;
  if v_category = 'electronic' and p_type not in ('chip_in', 'chip_out') then
    raise exception '電子機台只能記錄開分或洗分';
  end if;
  if v_category <> 'electronic' and p_type not in ('in', 'out') then
    raise exception '骰台機台不能記錄開分或洗分';
  end if;

  v_amount := valid_amount(p_amount);

  if v_token <> '' then
    select * into v_dup from records where client_token = v_token limit 1;
    if found then
      return jsonb_build_object('duplicated', true, 'records', jsonb_build_array(public_record(v_dup)), 'detail', machine_detail(p_machine_id));
    end if;
  end if;

  insert into records (
    record_id, machine_id, type, amount, user_id, created_at, note, client_token, business_date
  ) values (
    new_id('rec'), p_machine_id, p_type, v_amount, auth.uid(), now(),
    left(coalesce(p_note, ''), 200), v_token, current_business_date()
  ) returning * into v_rec;

  -- 前端送出後一定緊接著重新整理機台詳細頁，一起回傳省一趟來回，
  -- 對照 GAS 的 result.detail = getMachineDetail(...)。
  return jsonb_build_object('duplicated', false, 'records', jsonb_build_array(public_record(v_rec)), 'detail', machine_detail(p_machine_id));
end;
$$;

-- 對照 addMeterRecord()：入幣金額 = (下班表 − 上班表) × 費率（_resolveMeterRate）。
create or replace function add_meter_record(
  p_machine_id text, p_meter_start numeric, p_meter_end numeric, p_note text, p_client_token text
)
returns jsonb
language plpgsql
as $$
declare
  v_category text;
  v_meter_start numeric;
  v_meter_end numeric;
  v_rate numeric;
  v_amount numeric;
  v_token text := coalesce(p_client_token, '');
  v_dup records;
  v_rec records;
begin
  if not can_record() then
    raise exception '你的帳號沒有記帳權限' using errcode = '42501';
  end if;
  if not can_see_machine(p_machine_id) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;

  select category into v_category from machines where machine_id = p_machine_id;
  if v_category is null then
    raise exception '找不到這台機台';
  end if;
  if v_category = 'electronic' then
    raise exception '電子機台不能用碼表入幣，請用開分/洗分';
  end if;

  v_meter_start := valid_meter_reading(p_meter_start);
  v_meter_end := valid_meter_reading(p_meter_end);
  if v_meter_end <= v_meter_start then
    raise exception '下班表必須大於上班表';
  end if;

  v_rate := (resolve_meter_rate(p_machine_id) ->> 'rate')::numeric;
  v_amount := valid_amount((v_meter_end - v_meter_start) * v_rate);

  if v_token <> '' then
    select * into v_dup from records where client_token = v_token limit 1;
    if found then
      return jsonb_build_object('duplicated', true, 'records', jsonb_build_array(public_record(v_dup)), 'detail', machine_detail(p_machine_id));
    end if;
  end if;

  insert into records (
    record_id, machine_id, type, amount, meter_start, meter_end,
    user_id, created_at, note, client_token, business_date
  ) values (
    new_id('rec'), p_machine_id, 'in', v_amount, v_meter_start, v_meter_end,
    auth.uid(), now(), left(coalesce(p_note, ''), 200), v_token, current_business_date()
  ) returning * into v_rec;

  return jsonb_build_object('duplicated', false, 'records', jsonb_build_array(public_record(v_rec)), 'detail', machine_detail(p_machine_id));
end;
$$;

-- 對照 addPrizeRecord()：一次登錄多個獎型，單價/名稱一律從 Prizes 表
-- 快照，不採信前端傳來的金額。整支函式在同一個 statement 裡執行，
-- 中途 raise exception 會讓 Postgres 自動把這個 statement 已經寫入的
-- 所有列一起復原，等同 GAS 版本「先驗證全部、再一次寫入」的效果。
create or replace function add_prize_record(
  p_machine_id text, p_items jsonb, p_note text, p_client_token text
)
returns jsonb
language plpgsql
as $$
declare
  v_category text;
  v_token text := coalesce(p_client_token, '');
  v_dup records;
  v_item jsonb;
  v_count numeric;
  v_prize prizes;
  v_note text := left(coalesce(p_note, ''), 200);
  v_business_date date := current_business_date();
  v_rec records;
  v_rows jsonb := '[]'::jsonb;
  v_sum numeric := 0;
  v_any boolean := false;
begin
  if not can_record() then
    raise exception '你的帳號沒有記帳權限' using errcode = '42501';
  end if;
  if not can_see_machine(p_machine_id) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;

  select category into v_category from machines where machine_id = p_machine_id;
  if v_category is null then
    raise exception '找不到這台機台';
  end if;
  if v_category = 'electronic' then
    raise exception '電子機台沒有活動登錄';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception '請至少輸入一個獎型的次數';
  end if;

  if v_token <> '' then
    select * into v_dup from records where client_token = v_token limit 1;
    if found then
      return jsonb_build_object('duplicated', true, 'records', jsonb_build_array(public_record(v_dup)));
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := valid_count((v_item ->> 'count')::numeric);
    if v_count = 0 then
      continue;
    end if;

    select * into v_prize from prizes
    where prize_id = (v_item ->> 'prizeId')
      and (machine_id = p_machine_id or machine_id = '')
      and active
    order by (machine_id = p_machine_id) desc
    limit 1;
    if not found then
      raise exception '獎型不存在或已停用，請重新整理後再試';
    end if;

    insert into records (
      record_id, machine_id, type, amount, prize_id, prize_name, unit_amount, count,
      user_id, created_at, note, client_token, business_date
    ) values (
      new_id('rec'), p_machine_id, 'prize', round(v_prize.amount * v_count, 2),
      v_prize.prize_id, v_prize.name, v_prize.amount, v_count,
      auth.uid(), now(), v_note, v_token, v_business_date
    ) returning * into v_rec;

    v_any := true;
    v_sum := v_sum + v_rec.amount;
    v_rows := v_rows || jsonb_build_array(public_record(v_rec));
  end loop;

  if not v_any then
    raise exception '請至少輸入一個獎型的次數';
  end if;

  return jsonb_build_object('duplicated', false, 'total', v_sum, 'records', v_rows);
end;
$$;

-- 對照 voidRecord()：只有管理員能作廢，不是真的刪列。
create or replace function void_record(p_record_id text)
returns jsonb
language plpgsql
as $$
declare
  v_row records;
begin
  if not is_admin() then
    raise exception '只有管理員能作廢紀錄' using errcode = '42501';
  end if;
  select * into v_row from records where record_id = p_record_id;
  if not found then
    raise exception '找不到這筆紀錄';
  end if;
  if v_row.voided then
    return jsonb_build_object('alreadyVoided', true);
  end if;
  update records set voided = true, voided_by = auth.uid(), voided_at = now()
  where record_id = p_record_id;
  return jsonb_build_object('alreadyVoided', false);
end;
$$;

-- ── 系統管理頁 CRUD ──────────────────────────────────────────
-- adminSaveUser/adminResetPassword 沒有搬過來：那兩支要建立/改
-- Supabase Auth 帳號，得用 service role 的 Auth Admin API，純 SQL
-- function 做不到，要用 Edge Function（見 MIGRATION_PLAN.md）。

create or replace function save_meter_rate(p_machine_id text, p_rate numeric)
returns jsonb
language plpgsql
as $$
declare
  v_scope text := coalesce(p_machine_id, '');
  v_rate numeric;
  v_existing meter_rates;
  v_new_id text;
begin
  if not is_admin() then
    raise exception '只有管理員能設定費率' using errcode = '42501';
  end if;
  if v_scope <> '' and not can_see_machine(v_scope) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;
  v_rate := valid_amount(p_rate);

  select * into v_existing from meter_rates where machine_id = v_scope limit 1;
  if found then
    update meter_rates set rate = v_rate where rate_id = v_existing.rate_id;
    return jsonb_build_object('rateId', v_existing.rate_id, 'rate', v_rate);
  end if;

  insert into meter_rates (rate_id, machine_id, rate)
  values (new_id('mr'), v_scope, v_rate)
  returning rate_id into v_new_id;
  return jsonb_build_object('rateId', v_new_id, 'rate', v_rate);
end;
$$;

create or replace function save_quick_amount(
  p_qa_id text, p_machine_id text, p_type text, p_amount numeric, p_label text, p_sort_order numeric
)
returns jsonb
language plpgsql
as $$
declare
  v_scope text := coalesce(p_machine_id, '');
  v_amount numeric;
  v_row quick_amounts;
  v_new_id text;
begin
  if not is_admin() then
    raise exception '只有管理員能設定快捷金額' using errcode = '42501';
  end if;
  if v_scope <> '' and not can_see_machine(v_scope) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;
  if p_type not in ('in', 'out') then
    raise exception '快捷鍵類型只能是入幣或出幣';
  end if;
  v_amount := valid_amount(p_amount);

  if p_qa_id is not null and p_qa_id <> '' then
    select * into v_row from quick_amounts where qa_id = p_qa_id;
    if not found then
      raise exception '找不到這個快捷鍵';
    end if;
    update quick_amounts
    set amount = v_amount, label = left(coalesce(p_label, ''), 20), sort_order = coalesce(p_sort_order, 0)
    where qa_id = p_qa_id;
    return jsonb_build_object('qaId', p_qa_id);
  end if;

  insert into quick_amounts (qa_id, machine_id, type, amount, label, sort_order)
  values (new_id('qa'), v_scope, p_type, v_amount, left(coalesce(p_label, ''), 20), coalesce(p_sort_order, 0))
  returning qa_id into v_new_id;
  return jsonb_build_object('qaId', v_new_id);
end;
$$;

create or replace function delete_quick_amount(p_qa_id text)
returns jsonb
language plpgsql
as $$
begin
  if not is_admin() then
    raise exception '只有管理員能刪除快捷鍵' using errcode = '42501';
  end if;
  if not exists(select 1 from quick_amounts where qa_id = p_qa_id) then
    raise exception '找不到這個快捷鍵';
  end if;
  delete from quick_amounts where qa_id = p_qa_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- 對照 forkScopeToMachine()：把全局設定複製一份成這台機台的專屬設定。
-- p_table 限定白名單（quick_amounts/prizes/meter_rates），不接受任意字串，
-- 避免動態 SQL 被用來打其他表。
create or replace function fork_scope_to_machine(p_table text, p_machine_id text)
returns jsonb
language plpgsql
as $$
declare
  v_created int := 0;
begin
  if not is_admin() then
    raise exception '只有管理員能操作' using errcode = '42501';
  end if;
  if not can_see_machine(p_machine_id) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;
  if p_table not in ('quick_amounts', 'prizes', 'meter_rates') then
    raise exception '不支援的設定類型';
  end if;

  if p_table = 'quick_amounts' then
    if exists(select 1 from quick_amounts where machine_id = p_machine_id) then
      return jsonb_build_object('scope', 'machine', 'created', 0);
    end if;
    if not exists(select 1 from quick_amounts where machine_id = '') then
      raise exception '全局設定是空的，沒有東西可以複製';
    end if;
    insert into quick_amounts (qa_id, machine_id, type, amount, label, sort_order)
    select new_id('qa'), p_machine_id, type, amount, label, sort_order
    from quick_amounts where machine_id = '';
    get diagnostics v_created = row_count;
  elsif p_table = 'prizes' then
    if exists(select 1 from prizes where machine_id = p_machine_id) then
      return jsonb_build_object('scope', 'machine', 'created', 0);
    end if;
    if not exists(select 1 from prizes where machine_id = '') then
      raise exception '全局設定是空的，沒有東西可以複製';
    end if;
    insert into prizes (prize_id, machine_id, name, amount, sort_order, active)
    select new_id('prz'), p_machine_id, name, amount, sort_order, active
    from prizes where machine_id = '';
    get diagnostics v_created = row_count;
  else
    if exists(select 1 from meter_rates where machine_id = p_machine_id) then
      return jsonb_build_object('scope', 'machine', 'created', 0);
    end if;
    if not exists(select 1 from meter_rates where machine_id = '') then
      raise exception '全局設定是空的，沒有東西可以複製';
    end if;
    insert into meter_rates (rate_id, machine_id, rate)
    select new_id('mr'), p_machine_id, rate
    from meter_rates where machine_id = '';
    get diagnostics v_created = row_count;
  end if;

  return jsonb_build_object('scope', 'machine', 'created', v_created);
end;
$$;

-- 對照 resetScopeToGlobal()：刪掉這台的專屬設定，回頭沿用全局。
create or replace function reset_scope_to_global(p_table text, p_machine_id text)
returns jsonb
language plpgsql
as $$
declare
  v_removed int := 0;
begin
  if not is_admin() then
    raise exception '只有管理員能操作' using errcode = '42501';
  end if;
  if not can_see_machine(p_machine_id) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;

  if p_table = 'quick_amounts' then
    delete from quick_amounts where machine_id = p_machine_id;
  elsif p_table = 'prizes' then
    delete from prizes where machine_id = p_machine_id;
  elsif p_table = 'meter_rates' then
    delete from meter_rates where machine_id = p_machine_id;
  else
    raise exception '不支援的設定類型';
  end if;
  get diagnostics v_removed = row_count;

  return jsonb_build_object('scope', 'global', 'removed', v_removed);
end;
$$;

create or replace function save_prize(
  p_prize_id text, p_machine_id text, p_name text, p_amount numeric, p_sort_order numeric, p_active boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_scope text := coalesce(p_machine_id, '');
  v_name text := trim(both from coalesce(p_name, ''));
  v_amount numeric;
  v_row prizes;
  v_new_id text;
begin
  if not is_admin() then
    raise exception '只有管理員能設定獎型' using errcode = '42501';
  end if;
  if v_scope <> '' and not can_see_machine(v_scope) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception '請輸入獎型名稱';
  end if;
  if length(v_name) > 30 then
    raise exception '獎型名稱請在 30 字以內';
  end if;
  v_amount := valid_amount(p_amount);

  if p_prize_id is not null and p_prize_id <> '' then
    select * into v_row from prizes where prize_id = p_prize_id;
    if not found then
      raise exception '找不到這個獎型';
    end if;
    update prizes
    set name = v_name, amount = v_amount, sort_order = coalesce(p_sort_order, 0),
        active = coalesce(p_active, v_row.active)
    where prize_id = p_prize_id;
    return jsonb_build_object('prizeId', p_prize_id);
  end if;

  insert into prizes (prize_id, machine_id, name, amount, sort_order, active)
  values (new_id('prz'), v_scope, v_name, v_amount, coalesce(p_sort_order, 0), true)
  returning prize_id into v_new_id;
  return jsonb_build_object('prizeId', v_new_id);
end;
$$;

-- 對照 deletePrize()：刪除＝停用，歷史帳仍算得出來。
create or replace function delete_prize(p_prize_id text)
returns jsonb
language plpgsql
as $$
begin
  if not is_admin() then
    raise exception '只有管理員能刪除獎型' using errcode = '42501';
  end if;
  if not exists(select 1 from prizes where prize_id = p_prize_id) then
    raise exception '找不到這個獎型';
  end if;
  update prizes set active = false where prize_id = p_prize_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- 對照 adminSaveMachine()：分類（骰台／電子）只在新增當下決定，
-- 更新分支完全不動 category，換分類會讓歷史紀錄的型別對不上。
create or replace function admin_save_machine(
  p_machine_id text, p_name text, p_location text, p_status text, p_color text,
  p_sort_order numeric, p_note text, p_icon text, p_category text
)
returns jsonb
language plpgsql
as $$
declare
  v_name text := trim(both from coalesce(p_name, ''));
  v_status text := coalesce(p_status, 'running');
  v_color text := coalesce(p_color, '#4F7BE8');
  v_icon text := case when p_icon = any(array['classic','round','twin','tall','dice','sixdice']) then p_icon else 'classic' end;
  v_category text;
  v_row machines;
  v_new_id text;
begin
  if not is_admin() then
    raise exception '只有管理員能設定機台' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception '請輸入機台名稱';
  end if;
  if length(v_name) > 30 then
    raise exception '機台名稱請在 30 字以內';
  end if;
  if v_status not in ('running', 'maintenance', 'offline') then
    raise exception '機台狀態不正確';
  end if;
  if v_color !~ '^#[0-9a-fA-F]{6}$' then
    v_color := '#4F7BE8';
  end if;

  if p_machine_id is not null and p_machine_id <> '' then
    select * into v_row from machines where machine_id = p_machine_id;
    if not found then
      raise exception '找不到這台機台';
    end if;
    update machines
    set name = v_name, location = left(coalesce(p_location, ''), 50), status = v_status,
        color = v_color, sort_order = coalesce(p_sort_order, 0), note = left(coalesce(p_note, ''), 200),
        icon = v_icon
    where machine_id = p_machine_id;
    return jsonb_build_object('machineId', p_machine_id);
  end if;

  v_category := case when p_category = 'electronic' then 'electronic' else 'dice' end;
  insert into machines (machine_id, name, location, status, color, sort_order, note, created_at, category, icon)
  values (new_id('mch'), v_name, left(coalesce(p_location, ''), 50), v_status, v_color,
    coalesce(p_sort_order, 0), left(coalesce(p_note, ''), 200), now(), v_category, v_icon)
  returning machine_id into v_new_id;
  return jsonb_build_object('machineId', v_new_id);
end;
$$;

-- 對照 adminSetPermission()：只有台主需要逐台授權。
create or replace function admin_set_permission(p_user_id uuid, p_machine_id text, p_granted boolean)
returns jsonb
language plpgsql
as $$
declare
  v_target profiles;
begin
  if not is_admin() then
    raise exception '只有管理員能設定授權' using errcode = '42501';
  end if;
  if not can_see_machine(p_machine_id) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;

  select * into v_target from profiles where id = p_user_id;
  if not found then
    raise exception '找不到這個帳號';
  end if;
  if v_target.role <> 'owner' then
    raise exception '只有台主需要逐台授權，管理員與巡邏人員本來就看得到全部機台';
  end if;

  if p_granted then
    insert into permissions (user_id, machine_id, granted_by, granted_at)
    values (p_user_id, p_machine_id, auth.uid(), now())
    on conflict (user_id, machine_id) do nothing;
  else
    delete from permissions where user_id = p_user_id and machine_id = p_machine_id;
  end if;

  return jsonb_build_object('userId', p_user_id, 'machineId', p_machine_id, 'granted', p_granted);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 機台詳細頁
-- 對照 apps-script/Service.gs 的 _buildMachineDetail()/getMachineDetail()/
-- getAllMachineDetails()。GAS 版本把兩支函式的組裝邏輯合成一份
-- _buildMachineDetail() 主要是為了避免「Sheets 要讀 N 次」的效能問題；
-- Postgres 這邊每台機台各自查一次 records 本來就是索引查詢，不需要
-- 那種手工合併最佳化，所以 all_machine_details() 直接迴圈呼叫
-- machine_detail()，程式碼比 GAS 版本單純。
-- ═══════════════════════════════════════════════════════════════════════

-- 對照 getMachineDetail()/_buildMachineDetail()。today/total(=本週) 兩組
-- 統計直接借用 machine_today_and_week()，不用再自己重算一次
-- is_today_record()/週範圍那套邏輯。
create or replace function machine_detail(p_machine_id text, p_record_limit int default 50)
returns jsonb
language plpgsql
stable
as $$
declare
  v_machine machines;
  v_agg record;
  v_limit int := coalesce(p_record_limit, 50);
  v_total_count int;
  v_records jsonb;
begin
  if not can_see_machine(p_machine_id) then
    raise exception '沒有這台機台的權限' using errcode = '42501';
  end if;

  select * into v_machine from machines where machine_id = p_machine_id;
  if not found then
    raise exception '找不到這台機台';
  end if;

  select * into v_agg from machine_today_and_week(p_machine_id);

  select count(*) into v_total_count
  from records where machine_id = p_machine_id and voided = false;

  select coalesce(jsonb_agg(public_record(r) order by r.created_at desc, r.seq desc), '[]'::jsonb)
  into v_records
  from (
    select * from records
    where machine_id = p_machine_id and voided = false
    order by created_at desc, seq desc
    limit v_limit
  ) r;

  return jsonb_build_object(
    'machine', jsonb_build_object(
      'machineId', v_machine.machine_id,
      'name', v_machine.name,
      'location', coalesce(v_machine.location, ''),
      'status', coalesce(v_machine.status, 'running'),
      'color', coalesce(v_machine.color, '#4F7BE8'),
      'note', coalesce(v_machine.note, ''),
      'category', coalesce(v_machine.category, 'dice'),
      'icon', coalesce(v_machine.icon, 'classic')
    ),
    'today', jsonb_build_object(
      'in', v_agg.today_in, 'out', v_agg.today_out, 'prize', v_agg.today_prize, 'net', v_agg.today_net,
      'chipIn', v_agg.today_chip_in, 'chipOut', v_agg.today_chip_out, 'chipNet', v_agg.today_chip_net
    ),
    'today432Count', v_agg.today_432_count,
    'total', jsonb_build_object(
      'in', v_agg.week_in, 'out', v_agg.week_out, 'prize', v_agg.week_prize, 'net', v_agg.week_net,
      'chipIn', v_agg.week_chip_in, 'chipOut', v_agg.week_chip_out, 'chipNet', v_agg.week_chip_net
    ),
    'records', v_records,
    'hasMore', v_total_count > v_limit,
    'quickAmounts', resolve_quick_amounts(p_machine_id),
    -- 對照 _buildMachineDetail() 的 prizes: _resolvePrizes(machineId)：
    -- 這裡要放純陣列，不是 resolve_prizes() 給 listPrizes() 用的
    -- {scope, prizes:[...]} 包裝形狀——每個獎型項目自己就帶了 scope
    -- 欄位（resolve_prizes() 裡每個 jsonb_build_object 都有寫），
    -- 不需要再包一層，前端 prizePanel() 是直接 d.prizes.map(...)。
    'prizes', resolve_prizes(p_machine_id) -> 'prizes',
    'meterRate', resolve_meter_rate(p_machine_id),
    'lastMeterReading', v_agg.last_meter_reading
  );
end;
$$;

-- 對照 getAllMachineDetails()：一次算出這個帳號看得到的每一台機台的
-- 完整詳細頁資料，用 machineId 當 key，前端登入後背景預取全部機台時
-- 一次呼叫就夠，不用每台各打一次。machines 表本身已經被 RLS 篩過，
-- 這裡查到的就是「看得到的」那些。
create or replace function all_machine_details(p_record_limit int default 50)
returns jsonb
language plpgsql
stable
as $$
declare
  v_limit int := coalesce(p_record_limit, 50);
  v_result jsonb := '{}'::jsonb;
  v_mid text;
begin
  for v_mid in select machine_id from machines order by sort_order loop
    v_result := v_result || jsonb_build_object(v_mid, machine_detail(v_mid, v_limit));
  end loop;
  return v_result;
end;
$$;

-- ── 系統管理頁查詢 ───────────────────────────────────────────
-- 對照 adminListUsers/adminListMachines/adminListPrizes/adminListPermissions/
-- adminBootstrap。全部 SECURITY INVOKER，靠 is_admin() 明確擋（RLS 本身
-- 對 profiles/permissions 這幾張表也會篩，這裡的檢查一樣是為了跟 GAS
-- 一致的錯誤訊息，不是唯一防線）。

create or replace function admin_list_users()
returns jsonb
language plpgsql
stable
as $$
begin
  if not is_admin() then
    raise exception '只有管理員能查看帳號列表' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId', id,
      'username', username,
      'displayName', coalesce(nullif(display_name, ''), username),
      'role', role,
      'roleLabel', case role when 'admin' then '管理員' when 'patrol' then '巡邏人員' when 'owner' then '台主' else role end,
      'status', status,
      'lastLoginAt', coalesce(last_login_at::text, ''),
      'createdAt', coalesce(created_at::text, '')
    ))
    from profiles
  ), '[]'::jsonb);
end;
$$;

-- 對照 adminListMachines()：跟 machines 表的公開形狀一致，直接查表就是。
create or replace function admin_list_machines()
returns jsonb
language plpgsql
stable
as $$
begin
  if not is_admin() then
    raise exception '只有管理員能查看機台列表' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'machineId', machine_id, 'name', name, 'location', coalesce(location, ''),
      'status', coalesce(status, 'running'), 'color', coalesce(color, '#4F7BE8'),
      'sortOrder', sort_order, 'note', coalesce(note, ''),
      'category', coalesce(category, 'dice'), 'icon', coalesce(icon, 'classic')
    ) order by sort_order)
    from machines
  ), '[]'::jsonb);
end;
$$;

-- 對照 adminListPrizes()：回傳全局獎型本身，另外附上哪些機台設了專屬
-- 獎型（覆寫筆數），讓管理員一眼看出改全局會不會影響到某幾台。
create or replace function admin_list_prizes()
returns jsonb
language plpgsql
stable
as $$
declare
  v_global jsonb;
  v_overrides jsonb;
begin
  if not is_admin() then
    raise exception '只有管理員能查看獎型列表' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'prizeId', prize_id, 'name', name, 'amount', amount, 'sortOrder', sort_order
  ) order by sort_order, amount), '[]'::jsonb)
  into v_global
  from prizes where machine_id = '' and active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'machineId', o.machine_id, 'name', coalesce(m.name, o.machine_id), 'count', o.cnt
  )), '[]'::jsonb)
  into v_overrides
  from (
    select machine_id, count(*) as cnt from prizes
    where machine_id <> '' and active
    group by machine_id
  ) o
  left join machines m on m.machine_id = o.machine_id;

  return jsonb_build_object('global', v_global, 'overrides', v_overrides);
end;
$$;

-- 對照 adminListPermissions()：每個台主帳號 + 授權到的機台清單。
create or replace function admin_list_permissions()
returns jsonb
language plpgsql
stable
as $$
declare
  v_owners jsonb;
  v_grants jsonb;
begin
  if not is_admin() then
    raise exception '只有管理員能查看授權列表' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', id, 'username', username, 'displayName', coalesce(nullif(display_name, ''), username), 'status', status
  )), '[]'::jsonb)
  into v_owners
  from profiles where role = 'owner';

  select coalesce(jsonb_object_agg(o.id::text, coalesce(g.machine_ids, '[]'::jsonb)), '{}'::jsonb)
  into v_grants
  from profiles o
  left join (
    select user_id, jsonb_agg(machine_id) as machine_ids
    from permissions
    group by user_id
  ) g on g.user_id = o.id
  where o.role = 'owner';

  return jsonb_build_object('owners', v_owners, 'machines', admin_list_machines(), 'grants', v_grants);
end;
$$;

-- 對照 adminBootstrap()：系統管理頁一次進頁面需要的四組資料，合併成
-- 一次呼叫，省掉分開打 4 次 API 各自要付的固定成本。
create or replace function admin_bootstrap()
returns jsonb
language plpgsql
stable
as $$
begin
  if not is_admin() then
    raise exception '只有管理員能進入系統管理頁' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users', admin_list_users(),
    'machines', admin_list_machines(),
    'prizes', admin_list_prizes(),
    'perms', admin_list_permissions()
  );
end;
$$;

-- ── 帳號管理：修改已存在的帳號 ──────────────────────────────
--
-- 對照 adminSaveUser() 裡「有帶 userId」的分支（改角色/狀態/顯示名稱）。
-- 「建立全新帳號」跟「重設密碼」這兩件事需要 Supabase Auth Admin API
-- 的 service role key，純 SQL function 做不到，走另外部署的 Edge
-- Function（見 supabase/functions/admin-users/），這支只處理不需要
-- service role 的部分。
--
-- 沒有對照 GAS 的 invalidateUserSessions()——這裡不需要：
-- is_admin()/can_record()/can_see_machine() 全部是每次請求都直接查
-- 當下的 profiles.role/status（見 current_role_name()），不是讀取
-- session 建立當下快取的舊角色，把這裡的 role/status 改掉，下一個
-- 請求立刻就會反映新權限，效果跟「踢掉舊 session」一樣，不用另外做。
create or replace function admin_update_user(
  p_user_id uuid, p_display_name text, p_role text, p_status text
)
returns jsonb
language plpgsql
as $$
declare
  v_row profiles;
  v_status text := coalesce(p_status, 'active');
  v_losing_admin boolean;
  v_other_active_admins int;
begin
  if not is_admin() then
    raise exception '只有管理員能設定帳號' using errcode = '42501';
  end if;
  if p_role not in ('admin', 'patrol', 'owner') then
    raise exception '角色不正確';
  end if;
  if v_status not in ('active', 'disabled') then
    raise exception '帳號狀態不正確';
  end if;

  select * into v_row from profiles where id = p_user_id;
  if not found then
    raise exception '找不到這個帳號';
  end if;

  -- 不能把最後一個可用的管理員降級或停用，否則沒人進得了系統管理頁。
  v_losing_admin := (v_row.role = 'admin') and (p_role <> 'admin' or v_status <> 'active');
  if v_losing_admin then
    select count(*) into v_other_active_admins from profiles
    where role = 'admin' and status = 'active' and id <> p_user_id;
    if v_other_active_admins = 0 then
      raise exception '至少要保留一個啟用中的管理員帳號';
    end if;
  end if;

  update profiles
  set display_name = left(coalesce(nullif(trim(both from coalesce(p_display_name, '')), ''), v_row.display_name), 30),
      role = p_role,
      status = v_status
  where id = p_user_id;

  return jsonb_build_object('userId', p_user_id);
end;
$$;
