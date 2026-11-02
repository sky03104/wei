-- supabase/past_date_ledger.sql
-- 2026-11-02：「今日營業開始」選過去的日期（例如 10/23）時，那天原本手動設定的
-- 週轉金／台主給／台主領／開銷／432／441 也要一起顯示，不是只顯示當天的帳。
-- 在 Supabase SQL Editor 整段貼上執行即可，可以重複執行。前端不用改、不用換版。

-- 今天（相關營業日邊界）的每日手動帳目那一列，沒設定過就是零筆。
-- 對照 _dailyLedgerRow()：只認相關營業日 session 自己存的那一列（biz_id
-- 要對得上），沒有相關 session 才退回單純比對日期、取最新一列。
-- 2026-11-02：營業日期選的是「過去的日期」（補開以前的營業日）時，這個新
-- session 自己還沒存過東西，就退回該日期最新的一列——那天原本手動設定的
-- 週轉金／台主給／台主領／開銷／432／441 才會一起顯示出來。選的是今天
-- 的話維持原本行為：重新按開始就是歸零重來。
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
      not exists (select 1 from relevant_biz)
      or dl.biz_id = (select biz_id from relevant_biz)
      or (
        today_ref.d < today_key()
        and not exists (
          select 1 from daily_ledger own
          where own.business_date = today_ref.d
            and own.biz_id = (select biz_id from relevant_biz)
        )
      )
    )
  order by (dl.biz_id is not distinct from (select biz_id from relevant_biz)) desc, dl.seq desc
  limit 1;
$$;
