# WeVote

低成本嘅活動投票工具：管理員開 event，分享同一條公開連結或 QR code，參加者直接投票。採用專業手繪介面，支援多個獨立活動、結果頁同報告匯出。

目前部署：[vote.daa.hk](https://vote.daa.hk/) · [wevote.pages.dev](https://wevote.pages.dev/)。應用寄存喺 **Cloudflare**；DAA.HK 嘅主網域及原有 Hosting Speed 服務獨立運作。

## 功能同頁面

| 頁面 | 用途 |
| --- | --- |
| `/` | 主頁、活動連結／編號輸入、管理員入口 |
| `/admin.html` | 用管理密鑰登入、開活動、分享、截止後匯出逐票 CSV |
| `/vote.html?event=<id>` | 每個活動獨立投票頁，2–6 個選項及自動開始／截止 |
| `/results.html?event=<id>` | 參與人數、截止後嘅選項票數／百分比、摘要 CSV、列印／另存 PDF |

- 管理員設定活動名稱、題目、選項同香港時間；活動建立後嘅設定固定。
- 每個活動產生獨立連結及 QR code，可複製連結、下載／分享 QR 圖，或開啟 WhatsApp、Facebook、X 分享。
- Instagram 用下載 QR 圖再上載 Story／貼文；Story 可自行加入活動連結貼紙。
- 公開結果喺進行期間只顯示總票數，截止後公開各選項票數；投票頁約每 11 秒讀取資料，後端另有短時間快取。
- 舊 `/?event=<id>` 同 `/#ticket=<token>` 連結會自動轉到投票頁。

## 公開連結同防重複限制

預設係同一條公開 link／QR：伺服器簽發每個活動嘅 HttpOnly 瀏覽器 cookie，配合伺服器驗證 Cloudflare Turnstile；同一識別只計一票。重試相同選項唔會重複計票，改投另一選項會被拒絕。

**清除 cookie、用無痕模式或轉裝置仍可能再次投票。** 呢個模式適合活動互動同意見收集，唔能夠保證「一個自然人一票」。網頁讀唔到裝置 MAC。Turnstile 係機械人驗證，唔係身份核實。

另保留可選嘅 HMAC 獨立票據模式；保證每張有效票據最多記錄一次，主辦方仍須自行核實資格及控制派票。票據可以被轉發，唔應公開分享。

## 架構

```text
Cloudflare Pages：靜態主頁／管理頁／投票頁／結果頁
  /api/* → Service Binding → 私有 wevote-api Worker（無公開 workers.dev）
    ├─ EventCoordinator：每個活動嘅權威設定、合併並發結果讀取
    ├─ 128 個 VoteShard／活動：SQLite Durable Objects，儲存選票及計數
    └─ EVENTS KV：管理員活動目錄（最終一致，可短暫延遲）
```

Pages Function 快取公開結果，EventCoordinator 共用一次分區彙總，減少多人同時讀結果帶來嘅重複工作。新活動先持久儲存喺 Coordinator，再寫入 KV 目錄；目錄更新失敗會以 alarm 重試。靜態頁面由 `_routes.json` 排除 Function 執行。

## 本地開發

需要 Node.js 22+。

```bash
npm install
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

如要喺 Pages 本地埠號測分享，請相應更新 `PUBLIC_BASE_URL`。檢查程式：`npm run check`。本地 API 流程檢查：`npm run test:smoke -- http://localhost:8787`，只准本地執行，會建立測試活動。`.dev.vars`、`.env*`、`tickets*.csv` 已忽略；唔好提交密鑰、選票匯出或票據。

## 部署到自己 Cloudflare 帳戶

1. `npx wrangler login`，確認使用自己有權管理嘅帳戶。
2. `npx wrangler kv namespace create EVENTS --config wrangler.worker.jsonc`，將返回嘅 namespace ID 寫入 `wrangler.worker.jsonc`；**唔好沿用本 repo 帳戶嘅 ID**。
3. 按自己專案更改 Worker `name`、Pages `name` 及 Pages Service Binding 嘅 `service`，三者要對應。將 Worker `vars.PUBLIC_BASE_URL` 改成自己正式網址。保留 `VOTE_SHARD`、`EVENT_COORDINATOR` binding、class name 同既有 migration 歷史。
4. 建立正式 Turnstile widget，加入所有實際使用嘅 hostname，例如正式網域及自己嘅 `*.pages.dev` hostname。
5. 用下列形式逐項上傳 Worker secrets；正式環境唔可以使用測試 Turnstile 鑰匙：

```bash
npx wrangler secret put ADMIN_DASHBOARD_KEY --config wrangler.worker.jsonc
# 同樣設定 VOTE_SIGNING_KEY、TURNSTILE_SITE_KEY、TURNSTILE_SECRET_KEY
```

`ADMIN_DASHBOARD_KEY` 同 `VOTE_SIGNING_KEY` 要分開產生、至少 32 字元。前者可以建立及匯出所有活動；只交畀管理員。舊票據模式另需 `ADMIN_EXPORT_KEY` 同下節嘅 `POLL_*` 設定。

6. `npm run deploy` 部署私有 API Worker。首次喺自己帳戶建立傳統 Pages 專案可用 `npx wrangler pages project create <project-name> --production-branch main --force`；之後 `npm run deploy:pages`。
7. 喺 Pages Custom domains 加投票子網域。DNS 由原供應商管理時，揀 **My DNS provider**，加 `vote` CNAME 指向自己嘅 `<project-name>.pages.dev`。本項目係 `vote.daa.hk → wevote.pages.dev`，**毋須轉 daa.hk nameserver**。[官方設定方法](https://developers.cloudflare.com/pages/configuration/custom-domains/)
8. 等待網域／TLS Active，核對首頁、管理登入、活動 link、QR、Turnstile、截止結果及匯出，再做正式活動突發流量測試。

管理密鑰只喺瀏覽器分頁暫存；用完請登出。分享出去嘅連結同 QR 只包含公開活動 ID，唔包含管理密鑰。

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

例：5 萬人留喺頁面 10 分鐘、每 11 秒讀一次，大約有 273 萬次結果請求，另加識別、收票及其他請求。快取減少後端彙總，唔會消除所有入口請求費用。

**未完成 5 萬人同時投票嘅正式壓力測試。** 活動前要測突發進入／提交成功率、重票處理、p95 延遲、冷啟動同結果更新延遲；同時核對 Free／Paid 配額。分區數目唔係容量證明。

## 資料同授權

應用層儲存瀏覽器／票據 ID 嘅 hash、選項同時間；公開結果只顯示總票數。管理員逐票 CSV 包含 hash 同時間，仍須限制存取及保存期。正式密鑰放 Cloudflare Secrets；HTTPS 同每個 hostname 嘅 cookie 各自獨立，所以正式派一個統一網域嘅連結。

Credits: **[DAA.HK](https://daa.hk/), Hillman Tam and Keith Li**。

本項目採用 [MIT License](LICENSE)，第三方 QR 元件聲明見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。已提供開源所需授權；GitHub repo 可見性仍由擁有人自行管理，授權檔案唔會自動將私人 repo 公開。

介面參考 [Streamline Freehand](https://www.streamlinehq.com/icons/freehand-sets) 手繪方向；本項目插畫及 SVG 圖示冇複製 Streamline 圖示。
