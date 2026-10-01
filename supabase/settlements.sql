-- 原本場地（public schema）：骰台匯出「總額」結算區的存檔表（2026-10-01 已套用）。
-- 前端 docs/app.js 的 _applySettlement() 寫入、下期匯出勾「前期」時讀取。
-- 第二個場地 wei3 有一份一樣的表，建在 wei3 schema。

create table if not exists public.settlements (
  settlement_id  bigint generated always as identity primary key,
  machine_id     text not null references public.machines(machine_id),
  range_from     date not null,
  range_to       date not null,
  current_amt    numeric not null default 0, -- 本期（= 該區間 +/- 總計）
  prev_amt       numeric not null default 0, -- 前期（沒勾就是 0）
  rent_name      text,                        -- 租金名稱（沒扣租金是 null）
  rent_amt       numeric not null default 0, -- 租金金額（正數，計算時扣掉）
  fee_amt        numeric not null default 0, -- 入幣*5%（正數，計算時扣掉）
  total          numeric not null default 0, -- 總額 = 本期 + 前期 - 租金 - 入幣*5%
  created_by     uuid references public.profiles(id) default auth.uid(),
  created_at     timestamptz not null default now()
);

create unique index if not exists settlements_machine_range_idx
  on public.settlements (machine_id, range_from, range_to);
create index if not exists settlements_machine_to_idx
  on public.settlements (machine_id, range_to desc);

alter table public.settlements enable row level security;

drop policy if exists settlements_select on public.settlements;
create policy settlements_select on public.settlements
  for select using (public.can_see_machine(machine_id));
drop policy if exists settlements_write on public.settlements;
create policy settlements_write on public.settlements
  for all using (public.can_record() and public.can_see_machine(machine_id))
  with check (public.can_record() and public.can_see_machine(machine_id));

grant all on public.settlements to anon, authenticated, service_role;
