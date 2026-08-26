-- supabase/policies.sql
--
-- Row Level Security policies for the tables in supabase/schema.sql.
-- Run schema.sql first. This file assumes the "前端直連 + RLS" decision
-- (see MIGRATION_PLAN.md「Auth & RLS」): there is no backend API layer for
-- normal reads/writes — the frontend calls Supabase directly with the
-- signed-in user's JWT, and these policies are the only thing standing
-- between one user's data and another's. Get this file right before
-- pointing any real frontend code at a project using it.
--
-- Role model carried over 1:1 from apps-script/Code.gs's ACTION_ROLES /
-- apps-script/Service.gs's canRecord()/isAdmin()/visibleMachineIds():
--   admin   — sees and manages everything.
--   patrol  — sees and records against every machine, but can't manage
--             machines/prizes/quick-amounts/meter-rates/users/permissions
--             and can't void a record (that stays admin-only).
--   owner   — read-only, and only for machines explicitly granted via the
--             `permissions` table.

-- ── helper functions ────────────────────────────────────
--
-- security definer + fixed search_path so these can read `profiles` (which
-- itself has RLS enabled) without recursing into the RLS check they exist
-- to serve, and without being hijackable by a caller-controlled search_path.

-- 對照 GAS 的 validateSession()：帳號被停用之後，這個 session 剩下的
-- 有效期內也不該還能做任何事——GAS 版本每次 validateSession() 都會
-- 明確檢查 status，這裡對照的做法是讓 status 不是 active 時直接查不到
-- 任何 role（回傳 null），is_admin()/can_record()/can_see_machine()
-- 這些全部靠 current_role_name() 判斷的檢查就會自動全部擋下來，
-- 不用每個地方各自重複檢查一次 status。
create or replace function current_role_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid() and status = 'active';
$$;

-- coalesce(..., false) 是必要的，不是保險而已：帳號被停用時
-- current_role_name() 回傳 null，而 SQL 的 `null = 'admin'`／
-- `null in (...)` 算出來也是 null，不是 false。這些 helper function
-- 幾乎全部被拿去寫成 `if not is_admin() then raise ...` 這種 plpgsql
-- 判斷式，`if not null` 在 plpgsql 裡是 null、當成不成立處理，等於
-- 直接跳過那個檢查，沒有真的擋下來（RLS 本身用 `using (...)` 的
-- null 語意沒有這個問題，null 一樣不算通過，但這些 function 不是只
-- 用在 RLS policy，還被明確拿來當 plpgsql 的守門判斷用，兩邊語意
-- 不一樣，要用 coalesce 統一成真正的 boolean）。
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_role_name() = 'admin', false);
$$;

create or replace function can_record()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_role_name() in ('admin', 'patrol'), false);
$$;

-- 「看得到某台機台」＝管理員／巡邏人員一律看得到；台主要 permissions
-- 表裡有這一筆授權才算。跟 apps-script/Service.gs 的 visibleMachineIds()／
-- assertMachineAccess() 是同一套規則。
create or replace function can_see_machine(p_machine_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    current_role_name() in ('admin', 'patrol')
    or exists (
      select 1 from permissions
      where permissions.machine_id = p_machine_id
        and permissions.user_id = auth.uid()
    ),
    false
  );
$$;

-- ── profiles ────────────────────────────────────────────

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles
  for select using (id = auth.uid() or is_admin());

-- 新增/停用帳號、改角色都是管理員的事（對照 adminSaveUser: [ROLE_ADMIN]）。
-- 帳號本身（email/密碼）是 auth.users 的事，不歸這裡管——新建帳號的流程
-- 見下面「新使用者要怎麼進系統」的說明，不是單純一筆 insert 就能做完。
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles
  for update using (is_admin());

-- ── machines ────────────────────────────────────────────

drop policy if exists machines_select on machines;
create policy machines_select on machines
  for select using (can_see_machine(machine_id));

drop policy if exists machines_write on machines;
create policy machines_write on machines
  for all using (is_admin()) with check (is_admin());

-- ── records ─────────────────────────────────────────────

drop policy if exists records_select on records;
create policy records_select on records
  for select using (can_see_machine(machine_id));

-- 新增紀錄：對照 addRecord/addPrizeRecord/addMeterRecord: [ROLE_ADMIN, ROLE_PATROL]。
-- 這兩個角色本來就看得到全部機台（can_see_machine 對他們一律回 true），
-- 這裡不用再另外判斷 machine_id。
drop policy if exists records_insert on records;
create policy records_insert on records
  for insert with check (can_record());

-- 作廢紀錄：對照 voidRecord: [ROLE_ADMIN]，只能改 voided/voided_by/voided_at
-- 這幾欄——實際「只能改這幾欄」要靠前端/應用層自律或另外寫 trigger 擋，
-- RLS 的 with check 管不到「只准改哪幾欄」，只能管「這一列准不准被改」。
drop policy if exists records_update on records;
create policy records_update on records
  for update using (is_admin()) with check (is_admin());

-- 沒有 delete policy：現有系統本來就沒有刪除紀錄的動作（作廢是 update
-- voided=true，不是真的刪列），RLS 預設擋掉，行為跟現在一致。

-- ── prizes／quick_amounts／meter_rates ──────────────────
--
-- 三張表同一種規則：machine_id 是空字串代表「全局預設」，任何登入的人
-- 都看得到（不含機台專屬資訊，看到也沒差）；有指定機台的話照
-- can_see_machine() 判斷。寫入（新增/改價/停用/刪除/複製全局到單台）
-- 一律管理員專屬，對照 savePrize/deletePrize/saveQuickAmount/
-- deleteQuickAmount/saveMeterRate/forkScope/resetScope: [ROLE_ADMIN]。

drop policy if exists prizes_select on prizes;
create policy prizes_select on prizes
  for select using (machine_id = '' or can_see_machine(machine_id));
drop policy if exists prizes_write on prizes;
create policy prizes_write on prizes
  for all using (is_admin()) with check (is_admin());

drop policy if exists quick_amounts_select on quick_amounts;
create policy quick_amounts_select on quick_amounts
  for select using (machine_id = '' or can_see_machine(machine_id));
drop policy if exists quick_amounts_write on quick_amounts;
create policy quick_amounts_write on quick_amounts
  for all using (is_admin()) with check (is_admin());

drop policy if exists meter_rates_select on meter_rates;
create policy meter_rates_select on meter_rates
  for select using (machine_id = '' or can_see_machine(machine_id));
drop policy if exists meter_rates_write on meter_rates;
create policy meter_rates_write on meter_rates
  for all using (is_admin()) with check (is_admin());

-- ── permissions ─────────────────────────────────────────
--
-- 對照 adminListPermissions／adminSetPermission: [ROLE_ADMIN]——現在的
-- 系統裡台主自己看不到「台主授權」這份清單本身（他只是被這份清單決定
-- 看不看得到某台機台），所以這裡完全不開放給非管理員。

drop policy if exists permissions_all on permissions;
create policy permissions_all on permissions
  for all using (is_admin()) with check (is_admin());

-- ── biz_days（今日營業開始／結單）────────────────────────
--
-- 讀取：dashboard 三種角色都會顯示營業日狀態，所以只要有登入就給讀。
-- 寫入：對照 startBusinessDay／endBusinessDay: [ROLE_ADMIN, ROLE_PATROL]。

drop policy if exists biz_days_select on biz_days;
create policy biz_days_select on biz_days
  for select using (auth.uid() is not null);
drop policy if exists biz_days_write on biz_days;
create policy biz_days_write on biz_days
  for all using (can_record()) with check (can_record());

-- ── daily_ledger（加總分頁的今日現金結餘明細）───────────
--
-- 讀取：dashboard 三種角色都看得到這份明細，所以只要有登入就給讀。
-- 寫入：對照 saveDailyLedger: [ROLE_ADMIN, ROLE_PATROL]。

drop policy if exists daily_ledger_select on daily_ledger;
create policy daily_ledger_select on daily_ledger
  for select using (auth.uid() is not null);
drop policy if exists daily_ledger_write on daily_ledger;
create policy daily_ledger_write on daily_ledger
  for all using (can_record()) with check (can_record());

-- ── config ──────────────────────────────────────────────
--
-- 舊系統存這裡的兩個鍵（last_archived_quarter／last_archived_at）是季度
-- 封存機制專用，這套機制在 Postgres 架構下不需要了（見 schema.sql／
-- MIGRATION_PLAN.md 的說明），這張表遷移過去很可能整個用不到。先鎖成
-- 管理員專屬，不開放給前端一般讀寫，之後真的確定用不到再考慮拿掉整張表。

drop policy if exists config_admin_only on config;
create policy config_admin_only on config
  for all using (is_admin()) with check (is_admin());

-- ── 新使用者要怎麼進系統（還沒實作，先記下來）────────────
--
-- 前端直連＋RLS 代表沒有一個像現在 adminSaveUser 那樣的後端 API 可以
-- 「建立帳號」——建立 Supabase Auth 使用者（auth.users）必須用
-- service role key 呼叫 Admin API（supabase.auth.admin.createUser()），
-- 這把 key 絕對不能出現在前端，代表「管理員新增帳號」這個動作勢必要
-- 一個小小的、有 service role 權限的後端（Edge Function 或其他伺服器）
-- 來做，不能是純前端直連——這是整個「前端直連＋RLS」方案裡唯一還是
-- 需要一小塊後端程式碼的地方，其餘的讀寫都可以純前端＋RLS 搞定。
--
-- 建議流程：
--   1. Edge Function（僅限 is_admin() 的呼叫者）用 service role 呼叫
--      auth.admin.createUser({ email: synthesizeEmail(username), password })。
--   2. 下面這個 trigger 在 auth.users 新增一列的當下，自動在 profiles
--      插入對應的一列（role/username 從 createUser() 的 user_metadata 帶過去），
--      管理員不用另外再手動呼叫一次 insert profiles。
--
-- create or replace function handle_new_user()
-- returns trigger
-- language plpgsql
-- security definer
-- set search_path = public
-- as $$
-- begin
--   insert into profiles (id, username, display_name, role)
--   values (
--     new.id,
--     new.raw_user_meta_data->>'username',
--     coalesce(new.raw_user_meta_data->>'display_name', ''),
--     coalesce(new.raw_user_meta_data->>'role', 'owner')
--   );
--   return new;
-- end;
-- $$;
--
-- create trigger on_auth_user_created
--   after insert on auth.users
--   for each row execute function handle_new_user();

-- ── username 登入怎麼接（還沒實作，先記下來）─────────────
--
-- Supabase Auth 認的是 email，現有系統的登入畫面是打帳號（username）+
-- 密碼，不是 email。做法：帳號建立時（見上面的 handle_new_user）幫每個
-- 使用者合成一個內部用、使用者自己不會看到也不用記得的 email，例如
-- `<username>@clawapp.internal`；登入畫面收到 username 之後，先用下面
-- 這支「未登入也能呼叫」的函式換回對應的 email，再拿 email+密碼呼叫
-- Supabase Auth 的 signInWithPassword()——多一次查詢，但使用者體感上
-- 感覺不出來（前端幫忙做這兩步，介面上維持「打帳號登入」不變）。
--
-- security definer 是必要的：呼叫這支函式的當下使用者根本還沒登入
-- （anon role），profiles／auth.users 的 RLS／權限一定擋得住 anon 直接
-- 查表，只能靠這支函式繞過去，但只回傳 email 這一個欄位，不會洩漏
-- 其他使用者資料。
--
-- Phase 5（docs/app.js 改接）已經要用到「打帳號登入」了，所以這支從
-- 草稿轉正、實際啟用（下面幾行不再是註解）。帳號不存在或帳號被停用都
-- 回傳 null（跟查得到但密碼打錯，前端看到的錯誤訊息要一樣，不能讓人
-- 從錯誤訊息猜出「這個帳號存不存在」）。
create or replace function resolve_username_email(p_username text)
returns text
language sql
security definer
set search_path = public, auth
as $$
  select au.email
  from profiles p
  join auth.users au on au.id = p.id
  where p.username = p_username
    and p.status = 'active';
$$;

grant execute on function resolve_username_email(text) to anon, authenticated;

-- 這支函式讀得到 auth.users，代表建立它的角色要有這個 schema 的存取
-- 權限——在 Supabase SQL editor 用專案自己的管理連線跑就沒問題，用一般
-- migration CLI 跑之前先確認權限，這塊在不同 Supabase 專案設定下偶爾
-- 會卡權限，值得先在測試專案跑一次確認沒問題再套用到別的環境。
