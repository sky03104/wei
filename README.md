# 娃娃機機台管理系統

手機上像 App 一樣操作的娃娃機營運管理工具。加到主畫面後沒有網址列，
現場巡機時開起來就能記帳。

```
┌─────────────────┐        ┌──────────────────┐        ┌─────────────────┐
│  GitHub Pages   │ ─────▶ │  Apps Script     │ ─────▶ │  Google 試算表   │
│  前端 PWA        │  JSON  │  只回 JSON 的 API │        │  10 個分頁        │
│  docs/          │        │  apps-script/    │        │                 │
└─────────────────┘        └──────────────────┘        └─────────────────┘
```

**前端為什麼不放在 Apps Script？** GAS 的 `/exec` 會把頁面塞進 Google 的 iframe 沙箱，
裡面的 `manifest.json`、`apple-mobile-web-app-capable`、Service Worker 通通無效，
做不出「加到主畫面沒有網址列」的效果。要有自己的網域才行，所以前端放 GitHub Pages。

跨網域是用 `application/x-www-form-urlencoded` 的 POST 過的——這屬於 CORS simple request，
瀏覽器不會先發 preflight，而 GAS 沒辦法回應 preflight。換成 `application/json` 會直接壞掉。

---

## 功能

**三種角色**

| 角色 | 看得到哪些機台 | 記帳 | 報表 | 管理功能 |
|---|---|---|---|---|
| 管理員 | 全部 | ✅ | 全部 | ✅ 帳號、機台、獎型、快捷鍵、授權、作廢 |
| 巡邏人員 | 全部 | ✅ | 全部 | ❌ |
| 台主 | 僅被授權的 | ❌ 唯讀 | 僅自己的 | ❌ |

**主要畫面**
- **首頁**：每台機台一張卡片，左邊像素風娃娃機，右邊今日淨收益，每 20 秒自動更新
- **詳細頁**：收益面板 + 入幣／出幣／🎁 開獎三顆按鈕 + 本機台紀錄
- **報表**：日／週／月／自訂區間、趨勢圖、獎型統計、明細篩選、匯出 CSV
- **系統管理**：帳號、機台、獎型、台主授權

**記帳方式**
- 入幣：登錄上班表／下班表兩個碼表讀數，金額 = `(下班表 − 上班表) × 每格金額`，
  上班表會自動帶入上一次的下班表
- 出幣：按快捷金額，或輸入自訂金額
- 開獎：列出各獎型，右邊填次數，一次可登錄多種
- 入幣費率、快捷金額、獎型都支援「全局預設 + 單台可覆寫」

**營業日**
首頁預設「今日」是凌晨 0 點自動換日；開到隔天凌晨的店家可以在首頁按
「今日營業開始／今日營業結單」，改成手動控制邊界——按下開始之後，
記帳一律算進開始那一天，直到按結單為止，不受凌晨 0 點影響。
沒按過的話行為完全不變。管理員與巡邏人員都能操作，忘記結單、
隔天又按開始，系統會自動幫忙結掉前一個再開新的。

**收益怎麼算**
```
淨收益 = 入幣 − 出幣 − 開獎成本
```

---

## 安裝

看 **[guide/DEPLOY.md](guide/DEPLOY.md)**，從建試算表到裝進手機，一步一步照著做。
後端只需要貼 `apps-script/dist/Code.gs` 這一份合併檔案，不用開六次「新增指令碼」。

試算表每一欄的意思在 **[guide/SHEETS.md](guide/SHEETS.md)**。

---

## 檔案結構

```
docs/                  GitHub Pages 發佈目錄（前端 PWA）
  index.html           外殼與 PWA meta
  app.js               全部前端邏輯
  styles.css           全部樣式
  config.js            ← 唯一需要你手動填的檔案（GAS 網址）
  sw.js                Service Worker
  manifest.webmanifest
  icons/               App 圖示

apps-script/            後端（Google Apps Script）
  dist/Code.gs          ← 部署時貼這一份就好（自動合併，見下方「開發」）
  Code.gs                doPost 進入點、API 路由、setup()
  Db.gs                  試算表存取層
  Auth.gs                密碼、Session、角色與機台權限
  Service.gs             機台、紀錄、開獎、獎型、快捷金額、入幣費率、帳號
  Reports.gs              報表彙總與 CSV
  Test.gs                 自我測試（含在合併檔案裡）

tools/                 開發工具，不會被部署
guide/                 部署與資料說明
```

---

## 開發

不需要 `npm install`，沒有任何相依套件。

```bash
npm run dev          # 本機開起整個 App（含假的後端）→ http://localhost:8080
npm run bundle       # 把 apps-script/*.gs 合併成 apps-script/dist/Code.gs（部署要貼的那份）
npm test             # 語法檢查 + 像素圖一致性 + 合併檔案是否最新 + 後端自我測試（分開檔案版與合併檔案版都跑）
npm run test:e2e     # 用真的瀏覽器跑流程測試（需要先開著 npm run dev）
npm run icons        # 重新產生 App 圖示
```

**後端的維護方式**：實際會改的原始碼是 `apps-script/` 底下 7 個分開的檔案
（`Db.gs` 資料層、`Auth.gs` 認證、`Service.gs` 業務邏輯、`Reports.gs` 報表、
`Archive.gs` 按季自動封存、`Code.gs` 路由、`Test.gs` 測試）。改完執行 `npm run bundle` 重新產生
`apps-script/dist/Code.gs`——這份合併檔案才是要貼進 GAS 的東西。
`npm test` 會檢查合併檔案是不是最新版本，忘記重跑會直接測試失敗，
不會有「原始碼改了、貼上去的版本卻沒跟著改」這種事。

`npm run dev` 會用記憶體模擬一套 Apps Script 環境（`tools/gas-env.js`），
直接執行 `apps-script/*.gs` 的真實程式碼，並附上示範資料：

| 帳號 | 密碼 | 角色 |
|---|---|---|
| `admin` | `admin123` | 管理員 |
| `patrol1` | `patrol123` | 巡邏人員 |
| `owner1` | `owner123` | 台主（只授權一號機） |

改完 GAS 程式碼先跑 `npm test`，改完前端先跑 `npm run test:e2e`，再貼上去／push。

> 本機測試不能取代在 GAS 上實跑——配額、授權、真實試算表的行為仍要在正式環境確認一次。
> 但它能在幾秒內抓出絕大多數迴歸。

---

## 安全性

- **權限一律在伺服器端把關。** 台主看不到的機台，資料根本不會送到前端；
  直接偽造機台 id 呼叫 API 也會被擋。前端隱藏按鈕只是體驗，不是防護。
- **開獎金額、入幣金額都由後端算。** 前端只送獎型 id/次數，或碼表讀數；
  單價／費率一律從試算表查，前端算的數字只是給人看的即時試算，不會被採信。
- **獎型改價不影響歷史帳。** 名稱與單價會快照進每一筆紀錄。
- **密碼**用每個帳號各自的 salt + 全站 pepper（存在指令碼屬性，不進 repo）
  迭代 SHA-256 一千次。GAS 沒有 bcrypt，這是平台限制下的合理強度——
  所以**試算表本身千萬不要開共用連結**。
- **沒有自助改密碼的路徑。** 新增帳號與改密碼只有管理員的 API 做得到。
- **改密碼會踢掉該帳號所有裝置**的登入狀態。
- **記帳帶 clientToken 做冪等**，連點兩下或網路重試都只會寫入一筆。
- 前端原始碼是公開的（GitHub Pages 需要 public repo），裡面只有 GAS 的網址——
  沒有帳號密碼就拿不到任何資料。試算表 ID 與 pepper 都只存在 GAS 端。
