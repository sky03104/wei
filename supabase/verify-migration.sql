-- Phase 4 遷移後的核對用查詢。
--
-- 用法：跑完 migrate-from-sheets.js 之後，在 Supabase SQL Editor
-- 執行這份檔案，把每張表的筆數跟 migrate-from-sheets.js 執行時印出來的
-- 「匯出檔案裡的筆數」（腳本一開始就會印：「帳號 X、機台 Y、紀錄 Z 筆」，
-- 其餘表的筆數要回頭看 exportAllData() 回傳的 JSON 各陣列長度）互相比對，
-- 對不起來代表遷移過程中有資料被跳過（腳本會印警告，例如「找不到對應
-- 帳號」），要回頭查警告訊息、手動補齊。

select 'profiles' as table_name, count(*) as row_count from profiles
union all select 'machines', count(*) from machines
union all select 'records', count(*) from records
union all select 'prizes', count(*) from prizes
union all select 'quick_amounts', count(*) from quick_amounts
union all select 'meter_rates', count(*) from meter_rates
union all select 'permissions', count(*) from permissions
union all select 'config', count(*) from config
union all select 'biz_days', count(*) from biz_days
union all select 'daily_ledger', count(*) from daily_ledger
order by table_name;

-- 金額對帳：每台機台的「全部歷史」淨收益（骰台用 in/out/prize，
-- 電子機台用 chip_in/chip_out），拿去跟 Sheets 版本機台詳細頁的舊
-- 「累計淨收益」（改版前是全時間；如果你手邊還留著改版前的畫面截圖
-- 或匯出，可以對一下這個數字）或直接用 Sheets 原始資料手算比對。
select
  m.machine_id,
  m.name,
  m.category,
  coalesce(sum(r.amount) filter (where r.type = 'in' and not r.voided), 0)
    - coalesce(sum(r.amount) filter (where r.type = 'out' and not r.voided), 0)
    - coalesce(sum(r.amount) filter (where r.type = 'prize' and not r.voided), 0) as dice_net_all_time,
  coalesce(sum(r.amount) filter (where r.type = 'chip_in' and not r.voided), 0)
    - coalesce(sum(r.amount) filter (where r.type = 'chip_out' and not r.voided), 0) as chip_net_all_time,
  count(*) filter (where r.voided) as voided_count
from machines m
left join records r on r.machine_id = m.machine_id
group by m.machine_id, m.name, m.category
order by m.sort_order;

-- 有沒有紀錄的 user_id 沒對應到任何 profiles（理論上不該有，
-- migrate-from-sheets.js 已經在寫入前濾掉找不到對照的紀錄，這裡是
-- 雙重確認、抓外鍵沒設好或漏改的狀況）。
select count(*) as orphan_records
from records r
where not exists (select 1 from profiles p where p.id = r.user_id);
