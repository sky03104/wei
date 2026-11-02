-- supabase/expense_items.sql
-- 2026-11-02：「開銷」改成可自訂名稱＋金額的多筆明細（從 wei3 移植，跟台主給／台主領同一套做法）。
-- 只動 public schema（原本場地）。在 Supabase（wei 專案）SQL Editor 整段貼上執行，可重複執行。
-- 舊資料不會消失：沒有明細的舊紀錄，畫面上會顯示成一筆叫「開銷」的項目。
-- 這份跟 supabase/functions.sql 裡的同名函式內容一致；前提是 ledger_items_or_legacy／
-- sum_ledger_items／sanitize_ledger_items 已存在（原本就有）。

alter table daily_ledger
  add column if not exists manual_expense_items jsonb not null default '[]'::jsonb;

drop function if exists save_daily_ledger(numeric, numeric, numeric, numeric, jsonb, jsonb, numeric);

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
    'manualExpenseItems', ledger_items_or_legacy(p_row.manual_expense_items, p_row.manual_expense, '開銷'),
    'updatedAt', coalesce(p_row.updated_at::text, '')
  );
$$;

create or replace function save_daily_ledger(
  p_turnover numeric,
  p_manual_expense numeric,
  p_manual432 numeric,
  p_manual441 numeric,
  p_given_to_owner_items jsonb,
  p_taken_by_owner_items jsonb,
  p_returned_to_house numeric default 0,
  p_manual_expense_items jsonb default null
)
returns jsonb
language plpgsql
as $$
declare
  v_turnover numeric := valid_signed_amount(p_turnover);
  v_expense_items jsonb := case when p_manual_expense_items is null then null
    else sanitize_ledger_items(p_manual_expense_items, true, '開銷') end;
  v_manual_expense numeric := case when v_expense_items is null then valid_outflow_amount(p_manual_expense)
    else sum_ledger_items(v_expense_items) end;
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
    manual_expense, manual_expense_items, updated_by, updated_at
  ) values (
    new_id('ldg'), v_business_date, v_relevant.biz_id, v_turnover, 0, 0, 0,
    v_given, v_taken, v_returned, v_manual432, v_manual441,
    v_manual_expense, coalesce(v_expense_items, '[]'::jsonb), auth.uid(), now()
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
    manual_expense_items = excluded.manual_expense_items,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  return public_daily_ledger((select l from daily_ledger_row_for_today() l limit 1));
end;
$$;

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
    select distinct on (business_date) business_date, manual_expense,
      ledger_items_or_legacy(manual_expense_items, manual_expense, '開銷') as items
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
    'manualExpense', coalesce((select sum(manual_expense) from latest_ledger_per_day), 0),
    -- 每天的開銷明細（只列有開銷的日子，日期由舊到新）
    'manualExpenseDays', coalesce((
      select jsonb_agg(jsonb_build_object('date', business_date::text, 'items', items) order by business_date)
      from latest_ledger_per_day
      where jsonb_array_length(items) > 0
    ), '[]'::jsonb)
  );
$$;

grant execute on function save_daily_ledger(numeric, numeric, numeric, numeric, jsonb, jsonb, numeric, jsonb) to authenticated;
