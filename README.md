# WeVote

一個為大型活動設計嘅低成本即時投票系統。靜態頁面交畀 Cloudflare Workers Assets，投票寫入按票據雜湊分散到 128 個 SQLite-backed Durable Objects；結果以約 10 秒共用快取提供。投票期間顯示參與人數，截止後先顯示各選項票數。

## 第一版範圍

- 一題、2–6 個選項；每張經 HMAC 簽發嘅獨立連結最多記錄一票。
- Cloudflare Turnstile 必須喺伺服器驗證；票據不能取代對參加者身份嘅核實。
- 重試相同選項會回覆已記錄；同一票據改投另一選項會被拒絕。
- 主辦方喺截止後可按分區匯出匿名化票據 hash、選項與時間，供對數。

呢個版本係活動投票工具，**唔係法定選舉系統**。獨立連結可以被轉發；系統保證「一張有效票據只計一次」，唔能夠單靠程式保證「一個自然人只得一張票據」。正式 5 萬人活動要先做突發流量測試。

## 本地開發

需要 Node.js 22+。`setup:dev` 會建立本機兩小時示範投票及兩個隨機密鑰；唔會覆蓋現有 `.dev.vars`。範例 Turnstile 鑰匙係 Cloudflare 官方測試鑰匙，只准本地開發用。亦可以參考 `.dev.vars.example` 自行設定。

```bash
npm install
npm run setup:dev
npm run dev
```

前往 Wrangler 顯示嘅本地網址。產生本地測試投票連結：

```bash
set -a; source .dev.vars; set +a
npm run tickets -- \
  --count 5 --url http://localhost:8787/ --poll-id "$POLL_ID" \
  --expires "$POLL_CLOSES_AT" --output tickets-test.csv
```

`.dev.vars`、`tickets*.csv` 同 `.env*` 已加入 `.gitignore`。唔好將票據檔案放喺公開 repo。

## 部署

1. 開設 Cloudflare Workers Paid 帳戶，建立 Turnstile widget；設定正式網域。
2. 用 `npx wrangler secret put KEY` 分別設定 `POLL_ID`、`POLL_QUESTION`、`POLL_OPTIONS_JSON`、`POLL_OPENS_AT`、`POLL_CLOSES_AT`、`VOTE_SIGNING_KEY`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`ADMIN_EXPORT_KEY`。密鑰至少 32 字元；投票時間用 ISO 8601 UTC，例如 `2026-12-31T12:00:00Z`。
3. 執行 `npm run deploy`，檢查設定與正式網域，再派票。
4. 唔好喺正式環境用測試 Turnstile 鑰匙。

`wrangler login` 要喺有權使用該 Cloudflare 帳戶嘅電腦完成。正式網址、題目、選項同投票時間要喺簽票之前確定；修改已開始嘅投票設定可能令結果同票據對唔上。

票據：

```bash
VOTE_SIGNING_KEY='正式簽名密鑰' npm run tickets -- \
  --count 50000 --url https://vote.example.com/ --poll-id my-poll \
  --expires 2026-12-31T12:00:00Z --output tickets-event.csv
```

匯出：

```bash
ADMIN_EXPORT_KEY='正式匯出密鑰' node scripts/export-votes.mjs \
  --url https://vote.example.com/ --output votes-event.csv
```

## 成本與規模

Cloudflare Workers Paid 起步價係 US$5／月。假設 5 萬人留喺頁面 10 分鐘、每 10 秒讀一次結果，大約有 300 萬次結果請求，加 5 萬次收票請求，未計重試、監控及壓力測試。呢個係用量估算，**唔係 5 萬人高峰已獲驗證嘅保證**。正式活動前須量度提交成功率、重票、p95 延遲同結果更新延遲。

## 安全與資料

票據係 bearer token，收到條 link 嘅人就可以投。請用可信渠道單獨派發，唔好喺社交平台公開。票據原文唔會儲存喺後端；後端只儲存票據 ID 嘅 hash、所選選項同時間。匯出檔案仍係敏感資料，請限制存取與保存期。生產環境嘅密鑰必須放 Cloudflare Secrets，唔好放入 Git。

## 授權

MIT。可自由複製、修改及部署；請保留授權聲明。介面參考 [Streamline Freehand](https://www.streamlinehq.com/icons/freehand-sets) 嘅手繪方向；網站插畫及 SVG 圖示為本項目原創，冇複製 Streamline 圖示。
