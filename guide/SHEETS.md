# 試算表欄位規格

執行一次 `setup` 之後，這 8 個分頁會自動建好。這份文件是給你「想直接開試算表看資料」時用的。

> ⚠️ **可以看，盡量不要手改。**
> 系統寫入時會做一致性檢查（金額、權限、快照），手動改容易改出對不起來的帳。
> 真的要改，先想清楚下面每一欄的意思。

---

## Users — 帳號

| 欄位 | 說明 |
|---|---|
| `user_id` | 系統產生，不要改 |
| `username` | 登入帳號，英數字與 `_ . -`，3~20 字 |
| `display_name` | 畫面上顯示的名字 |
| `password_hash` | 密碼雜湊（salt + pepper 迭代 SHA-256 一千次）。**看不出原始密碼，也改不回去** |
| `salt` | 每個帳號各自的隨機值 |
| `role` | `admin` 管理員／`patrol` 巡邏人員／`owner` 台主 |
| `status` | `active` 啟用／`disabled` 停用 |
| `created_at` / `last_login_at` | ISO 時間字串 |

改密碼請走系統管理頁，不要手動改這裡的欄位。

## Machines — 機台

| 欄位 | 說明 |
|---|---|
| `machine_id` | 系統產生，不要改 |
| `name` | 機台名稱 |
| `location` | 位置說明 |
| `status` | `running` 營運中／`maintenance` 維修中／`offline` 停機 |
| `color` | 機身顏色，`#RRGGBB` |
| `sort_order` | 首頁排序，數字小的在前 |
| `note` | 備註 |

## Records — 所有帳目（最重要的一張表）

| 欄位 | 說明 |
|---|---|
| `record_id` | 系統產生 |
| `machine_id` | 對應 Machines |
| `type` | `in` 入幣／`out` 出幣／`prize` 開獎 |
| `amount` | 金額。開獎的話 = `unit_amount × count` |
| `prize_id` | 開獎才有，對應 Prizes |
| `prize_name` | **開獎當下的獎型名稱快照** |
| `unit_amount` | **開獎當下的單價快照** |
| `count` | 開獎次數 |
| `user_id` | 誰記的 |
| `created_at` | ISO 時間字串 |
| `voided` | `TRUE` 表示已作廢，所有統計都會跳過 |
| `voided_by` / `voided_at` | 誰在什麼時候作廢的 |
| `client_token` | 防重複送出用；同一個 token 只會寫入一次 |

**為什麼要存快照？**
如果報表是即時去 Prizes 表查單價，那你哪天把「大娃」從 150 改成 200，
上個月的帳會跟著一起變，對帳就再也對不起來了。
存快照之後，改價只影響之後的紀錄，歷史帳永遠不動。

**收益怎麼算**
```
淨收益 = SUM(入幣) − SUM(出幣) − SUM(開獎)     （只算 voided 不是 TRUE 的）
```

**紀錄不會被刪除**，只會標記 `voided`。要查「誰在什麼時候作廢了什麼」，看這三欄。

## Prizes — 獎型

| 欄位 | 說明 |
|---|---|
| `prize_id` | 系統產生 |
| `machine_id` | **空白 = 全局**（所有機台共用）；填了機台 id = 那一台專屬 |
| `name` | 獎型名稱 |
| `amount` | 單價（成本） |
| `sort_order` | 開獎面板的排列順序 |
| `active` | `FALSE` 表示已停用，不再出現在開獎面板，但歷史帳仍算得出來 |

## QuickAmounts — 快捷金額

| 欄位 | 說明 |
|---|---|
| `qa_id` | 系統產生 |
| `machine_id` | **空白 = 全局**；填了 = 那一台專屬 |
| `type` | `in` 入幣／`out` 出幣 |
| `amount` | 金額 |
| `label` | 按鈕上的字，留空就顯示金額 |
| `sort_order` | 排列順序 |

### 「全局預設 + 單台覆寫」怎麼運作

`Prizes` 與 `QuickAmounts` 都用同一套規則：

```
要查某台機台的設定時：
  先找 machine_id = 那台機台 的資料列
    → 有的話，就用這些（完全取代全局，不會合併）
    → 一列都沒有，才回頭用 machine_id 空白的全局設定
```

所以「某台改成自訂」實際上就是把全局那幾列複製一份、把 `machine_id` 填上該機台；
「改回沿用全局」就是把那幾列刪掉。App 裡的按鈕就是在做這兩件事。

## Permissions — 台主授權

| 欄位 | 說明 |
|---|---|
| `user_id` | 台主的帳號 |
| `machine_id` | 授權他看的機台 |
| `granted_by` / `granted_at` | 誰在什麼時候授權的 |

**這張表只對台主有意義。** 管理員與巡邏人員一律看得到全部機台，
不會、也不需要在這裡有資料列。有一列 = 那位台主看得到那台。

## Sessions — 登入狀態

| 欄位 | 說明 |
|---|---|
| `token` | 登入權杖 |
| `user_id` | 屬於誰 |
| `created_at` | 登入時間 |
| `expires_at` | 到期時間。**這是唯一的判斷依據**，改前端的儲存內容沒有用 |
| `remember` | `TRUE` = 勾了記住我（7 天固定到期）／`FALSE` = 12 小時滑動延展 |

手機掉了想強制登出：把該帳號的列刪掉即可。

## Config — 系統設定

`key` / `value` 兩欄的雜項設定。目前系統本身沒有一定要用到的項目。

> 密碼用的 pepper **不在這裡**，存在 Apps Script 的「指令碼屬性」`PEPPER`。
> 不要動它——換掉的話所有現有密碼都會失效。
