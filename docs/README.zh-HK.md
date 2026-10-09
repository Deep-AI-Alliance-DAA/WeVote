# WeVote

低成本嘅活動投票工具：管理員開 event，分享同一條公開連結或 QR code，參加者直接投票。採用專業手繪介面，支援多個獨立活動、結果頁同報告匯出。

**Project credits：[DAA.HK](https://daa.hk/), Hillman Tam and Keith Li。**

**現有服務：[vote.daa.hk](https://vote.daa.hk/)**，寄存喺 Cloudflare Pages 同私有 API Worker。

呢份係香港廣東話使用指南。[English README](../README.md) · [部署到自己 Cloudflare 帳戶](DEPLOYMENT.md)。源碼採用 MIT 授權；GitHub repo 目前係私人，由擁有人管理存取權限。

## 功能同頁面

| 頁面 | 用途 |
| --- | --- |
| `/` | 主頁、活動連結／編號輸入、管理員入口 |
| `/admin.html` | 獨立帳戶登入、分配權限／活動、編輯、分享、截止後匯出逐票 CSV |
| `/vote.html?event=<id>` | 每個活動獨立投票頁，2–20 個選項及自動開始／截止 |
| `/results.html?event=<id>` | 即時票數 Dashboard、長條圖／百分比、摘要 CSV、列印／另存 PDF、全屏展示 |

- 管理員設定活動名稱、題目、選項同香港時間；可以先儲存草稿，核對後再發佈。草稿只供預覽，唔會自動開始或接受投票；內容同預定時間可以修改。發佈後按預定時間開始／截止，未開始可編輯內容，開始後鎖定題目／選項。
- Logo、活動封面海報嘅 HTTPS 圖片網址、四款色調、主辦方及介紹可以隨時更新。
- 每個活動產生獨立連結及 QR code，可複製連結、下載／分享 QR 圖，或開啟 WhatsApp、Facebook、X 分享。
- Instagram 用下載 QR 圖再上載 Story／貼文；Story 可自行加入活動連結貼紙。
- 每個活動可選即時公開各選項結果，或截止後先公開；投票頁及 Dashboard 約每 3 秒自動刷新，後端共享快取約 2 秒，新票數可能有數秒延遲。結果頁可全屏展示；未截止報告會標示即時結果。
- 舊 `/?event=<id>` 同 `/#ticket=<token>` 連結會自動轉到投票頁。

## 管理員帳戶同權限

系統擁有人用原有 `ADMIN_DASHBOARD_KEY` 登入，可新增最多 100 個命名帳戶：

- **全站管理員（admin）**：管理全部活動。
- **活動管理員（organizer）**：只管理自己建立或擁有人指派嘅活動。
- **系統擁有人（owner）**：管理全部活動、開帳戶、改權限、停用帳戶、更新密鑰及分配活動。

每個帳戶用獨立隨機 256-bit 登入密鑰，建立／更換時只顯示一次，需私下派發；伺服器只保存 hash。密鑰唔係人手設定密碼，冇公開註冊或電郵發送。登入後以 HttpOnly、Secure、SameSite=Strict cookie 維持八小時；管理密鑰唔再存喺 sessionStorage。停用／更換命名帳戶密鑰會立即撤銷該帳戶 session；登出會撤銷當前 session。**更換擁有人主密鑰唔會撤銷已簽發嘅 owner session，佢哋會維持有效直到八小時到期。** 帳戶及活動權限由伺服器檢查，唔靠前端隱藏。主密鑰屬系統擁有人，請勿分發畀其他管理員。

草稿及未開始活動可以改名稱、題目同選項，分享連結維持不變；開始後鎖定。草稿可以改香港開始／截止時間；發佈前必須確保截止時間仍然有效。已發佈活動嘅時間固定。分區會固定開始後嘅權威投票版本，拒絕持有舊選項設定嘅請求。切換公開結果模式可短暫受快取影響；曾公開嘅資料唔能夠收回。

## 公開連結同防重複限制

預設係同一條公開 link／QR：伺服器簽發每個活動嘅 HttpOnly 瀏覽器 cookie，配合伺服器驗證 Cloudflare Turnstile；同一識別只計一票。重試相同選項唔會重複計票，改投另一選項會被拒絕。

**清除 cookie、用無痕模式或轉裝置仍可能再次投票。** 呢個模式適合活動互動同意見收集，唔能夠保證「一個自然人一票」。網頁讀唔到裝置 MAC。Turnstile 係機械人驗證，唔係身份核實。

另保留可選嘅 HMAC 獨立票據模式；保證每張有效票據最多記錄一次，主辦方仍須自行核實資格及控制派票。票據可以被轉發，唔應公開分享。

## 架構

```text
Cloudflare Pages：靜態主頁／管理頁／投票頁／結果頁
  /api/* → Service Binding → 私有 API Worker（無公開 workers.dev）
    ├─ AdminDirectory：帳戶、session、角色及活動分配（只處理管理流量）
    ├─ EventCoordinator：每個活動嘅權威內容／外觀、合併並發結果讀取
    ├─ 128 個 VoteShard／活動：SQLite Durable Objects，儲存選票及計數
    └─ EVENTS KV：管理員活動目錄（最終一致，可短暫延遲）
```

Pages Function 快取公開結果，EventCoordinator 共用一次分區彙總，減少多人同時讀結果帶來嘅重複工作。新活動先持久儲存喺 Coordinator，再寫入 KV 目錄；目錄更新失敗會以 alarm 重試。靜態頁面由 `_routes.json` 排除 Function 執行。

## 本地開發

需要 Node.js 22+。

```bash
npm ci
npm run setup:dev
npm run dev
```

`setup:dev` 建立 `.dev.vars`，包含兩小時舊式示範投票、隨機 `VOTE_SIGNING_KEY`、`ADMIN_DASHBOARD_KEY` 同 `ADMIN_EXPORT_KEY`，以及 Cloudflare 官方 Turnstile 測試鑰匙；唔會覆蓋已有檔案。

喺 `.dev.vars` 設定 `PUBLIC_BASE_URL="http://localhost:8787"`（按 Wrangler 實際埠號調整），本地分享連結就會指向本地。已有 `.dev.vars` 要自行加入隨機、至少 32 字元嘅 `ADMIN_DASHBOARD_KEY`；可參考 `.dev.vars.example`。喺本地 `/admin.html` 輸入呢條密鑰，就可以開測試活動。

預覽完整 Pages + Service Binding：另開終端保持 `npm run dev` 運作，再執行：

```bash
npm run build:pages
npx wrangler pages dev pages/dist
```

如要喺 Pages 本地埠號測分享，請相應更新 `PUBLIC_BASE_URL`。

```bash
npm test
npm run test:setup  # 只檢查離線 setup／部署 helper
npm run test:startup  # 只檢查測試啟動重試／清理
```

`npm test` 自行開一個暫時本地 Worker，使用獨立密鑰同儲存，跑語法、快取、離線 helper、啟動／清理、API、帳戶／權限及草稿／發佈檢查，完成後停止 Worker 同刪除測試資料。唔會用已有 `.dev.vars` 或 Cloudflare 登入。投票檢查需要對 Turnstile 測試驗證服務發出 HTTPS 請求；呢啲係功能檢查，唔係五萬人壓力測試。

針對自己本地 dev server 可以分別跑：

```bash
# 保持 npm run dev 運作，只准本地執行：
npm run test:smoke -- http://localhost:8787
npm run test:admin -- http://localhost:8787
npm run test:drafts -- http://localhost:8787
```

以上 smoke checks 會建立測試活動。亦可獨立跑 `npm run check` 同 `npm run test:cache`。`.dev.vars`、`.env*`、`tickets*.csv` 已忽略；唔好提交密鑰、選票匯出或票據。

## 部署到自己 Cloudflare 帳戶

跟住 [部署指南](DEPLOYMENT.md) 先登入自己 Cloudflare 帳戶、建立獨立 KV，再將帳戶 ID、KV ID、Worker／Pages 名稱、正式網址及 Turnstile site key 傳畀 `npm run setup:cloudflare`。呢個離線 helper 只產生已忽略嘅 `wrangler.worker.local.jsonc`、`.cloudflare/pages/wrangler.jsonc` 同受檔案權限保護嘅 `.env.production.json`，唔會自行開雲端資源或部署。

填好真實 Turnstile secret 後，用 `npm run deploy:api` 同 `npm run deploy:pages` 部署；唔好將自己帳戶設定、密鑰或匯出資料提交到 Git。唔好用本地 Turnstile 測試 key 部署正式服務。

投票子網域可以用原 DNS 供應商加 CNAME 指向自己嘅 Pages hostname，毋須搬走原有網站／電郵或轉 nameserver。先喺 Pages 加 Custom domain，再按介面顯示嘅目標設定 DNS，等待 HTTPS Active。[官方設定方法](https://developers.cloudflare.com/pages/configuration/custom-domains/)

登入 session 最長八小時；用完請登出。分享出去嘅 link／QR 只包含公開活動 ID，唔包含管理密鑰。正式使用統一 hostname，避免不同網域 cookie 各自獨立。

### 活動海報同私人部署圖片

特定活動嘅海報及主辦方圖片放喺已忽略嘅 `private-assets/`。喺 `private-assets/manifest.json` 列出要部署嘅圖片，例如：

```json
{ "version": 1, "files": ["event-poster.jpg"] }
```

將列出嘅圖片放喺同一個目錄，再明確啟用私人圖片部署：

```bash
npm run deploy:pages -- --with-private-assets
```

正常公開 build 包含項目通用插畫；加呢個 flag 先會將 manifest 列出嘅圖片加入寄存檔案。活動封面填返部署後嘅 HTTPS 圖片網址。Manifest 同圖片唔好提交到 Git；部署前要有圖片所需使用權，佢哋有各自嘅權利及授權。

## 可選：舊式獨立票據

舊模式係一個以 secrets 設定嘅固定投票：`POLL_ID`、`POLL_QUESTION`、`POLL_OPTIONS_JSON`、`POLL_OPENS_AT`、`POLL_CLOSES_AT`，時間用 ISO 8601 UTC。票據會用 `VOTE_SIGNING_KEY` 簽名；開始派票後唔好更改該投票設定。

本地簽五張票（只會將測試密鑰載入本機 shell）：

```bash
set -a
source .dev.vars
set +a
npm run tickets -- --count 5 --url http://localhost:8787/vote.html \
  --poll-id "$POLL_ID" --expires "$POLL_CLOSES_AT" --output tickets-test.csv
```

截止後可用 `scripts/export-votes.mjs`，透過本機環境變數提供 `ADMIN_EXPORT_KEY`，再指定 `--url https://your-vote-domain.example/ --output votes.csv`。新式多活動逐票匯出用管理頁，唔用呢條舊式 CLI。

## 成本同規模

Workers／Pages Functions Free 每日共用 10 萬次動態請求，唔適合 5 萬人持續讀取即時結果。Workers Paid **最低 US$5／月**，包含每月 1,000 萬次請求及 3,000 萬 CPU milliseconds；超額用量另計。[Workers 定價](https://developers.cloudflare.com/workers/platform/pricing/)

Durable Objects 另有請求、執行時間、SQLite 讀寫及儲存用量；KV 亦有各自配額。**US$5 唔係固定總成本保證**，要計埋活動長度、更新頻率、重試、冷啟動、監控、測試同帳戶其他專案用量。[Durable Objects 定價](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [KV 定價](https://developers.cloudflare.com/kv/platform/pricing/)

Durable Objects Free 另外有**每日 10 萬次請求**上限，整個帳戶共用。一次完整票數彙總可以讀晒 128 個 vote shards，所以一次結果查詢唔等於一次 Durable Object 請求。即使睇 Dashboard 嘅人唔多，持續每三秒更新都可能用盡免費額度；持續即時投票建議用 Workers Paid。額度用盡時投票／管理 API 可以回傳 503，要等每日 UTC 00:00（香港時間 08:00）重置，或升級帳戶。

例：5 萬人留喺頁面 10 分鐘、每 3 秒讀一次，大約有 1,000 萬次結果請求，另加識別、收票及其他請求。相比每 11 秒刷新，結果查詢次數約為 3.7 倍。快取減少後端彙總，唔會消除所有入口請求費用。

**未完成 5 萬人同時投票嘅正式壓力測試。** 活動前要測突發進入／提交成功率、重票處理、p95 延遲、冷啟動同結果更新延遲；同時核對 Free／Paid 配額。分區數目唔係容量證明。

## 資料同授權

應用層儲存瀏覽器／票據 ID 嘅 hash、選項同時間；公開結果按活動設定顯示總票數及選項彙總，唔會公開逐票識別。管理員逐票 CSV 包含 hash 同時間，仍須限制存取及保存期。正式密鑰放 Cloudflare Secrets；HTTPS 同每個 hostname 嘅 cookie 各自獨立，所以正式派一個統一網域嘅連結。

## Credits、參考同授權

WeVote 項目嘅 credits 按擁有人要求，列出 **[DAA.HK](https://daa.hk/), Hillman Tam and Keith Li**。以下再交代技術／設計參考及第三方程式嘅來源：

- **技術靈感：**[Keith Li 嘅 HK Traffic Intelligence](https://github.com/keithligh/hk-traffic-intelligence) README 講解喺 Cloudflare 共用快取資料、副本按時間更新嘅方法，係 WeVote 重視共享快取同節省資源嘅參考。
- **QR 元件：**Kazuhiko Arase 嘅 `qrcode-generator` 2.0.4 採用 MIT，完整第三方版權及授權聲明保留喺 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- **視覺靈感：**[Streamline Freehand](https://www.streamlinehq.com/icons/freehand-sets) 提供手繪方向。本項目 AI 輔助插畫同原創 SVG 圖示採用 MIT，冇複製或打包 Streamline 圖示。

本項目源碼採用 [MIT License](../LICENSE)，再分發時須保留版權及授權聲明。特定活動嘅海報、Logo 及其他供應圖片，使用權由各自權利人授權。
