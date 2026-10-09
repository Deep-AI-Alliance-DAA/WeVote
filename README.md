# WeVote

Create an event, share one voting link or QR code, and display the results. WeVote is a self-hosted voting application with a professional hand-drawn interface, an event dashboard, and CSV/PDF report tools.

[香港廣東話指南](docs/README.zh-HK.md) · [Deployment](docs/DEPLOYMENT.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

**Release status:** this repository is currently private and being prepared for public release. The MIT license and these documents do not change repository visibility.

## Features

- Independent events with 2–20 options, drafts, preview, publication, and scheduled opening/closing.
- Owner, administrator, and organizer roles; individual login keys and event assignments.
- Event content editing before voting begins; organizer text, HTTPS logo/cover images, and four color themes.
- A link and QR code for each event, downloadable QR artwork, and sharing tools for WhatsApp, Facebook, X, and Instagram workflows.
- Live results or results revealed after closing, charts, percentages, and fullscreen display.
- Summary CSV and browser print/save-to-PDF reports; authorized per-vote CSV export after closing.

| Page | Purpose |
| --- | --- |
| `/` | Home page, event-link entry, and admin entry |
| `/admin.html` | Accounts, event setup, sharing, appearance, and exports |
| `/vote.html?event=<id>` | Public event voting |
| `/results.html?event=<id>` | Results dashboard and reports |

The current interface uses Hong Kong Cantonese. Admin times are shown in Hong Kong time (UTC+8), and reports identify their timezone. Legacy event and signed-ticket links continue to redirect to the voting page.

## What counts as one vote

Public events issue an event-specific signed HttpOnly browser cookie and validate Cloudflare Turnstile on the server. The same browser identity is counted once; retrying the same choice is safe, and changing an already recorded choice is rejected.

**This does not establish one vote per person.** Clearing cookies, private browsing, using a different browser, or switching devices can create another identity. A web page cannot read a device MAC address. Turnstile reduces automated abuse; it does not verify a person's eligibility. This mode suits event interaction and opinion collection.

An optional legacy signed-ticket mode counts each valid ticket once. Organizers remain responsible for eligibility and distribution, and a ticket can be forwarded. See the [Cantonese guide](docs/README.zh-HK.md#可選舊式獨立票據) for the CLI workflow.

## Run locally

Requirements: Node.js 22 or newer and npm.

```bash
npm ci
npm run setup:dev
npm run dev
```

Open the URL printed by Wrangler, then visit `/admin.html`. Read the locally generated `ADMIN_DASHBOARD_KEY` from `.dev.vars` to log in as the owner. `setup:dev` creates random local keys and official Turnstile test keys, and does not overwrite an existing `.dev.vars`.

Local development uses emulated storage. Turnstile test keys are for local testing only. Set `PUBLIC_BASE_URL` to the local URL shown by Wrangler when testing generated links.

```bash
npm test
npm run test:setup  # Offline setup/deployment-helper checks only
npm run test:startup  # Offline test-runner startup/cleanup checks only
```

`npm test` runs syntax, cache, setup, startup, and integration checks. It starts and stops a disposable local Worker with temporary keys/storage, without using a Cloudflare login or your existing `.dev.vars`. Integration voting checks require outbound HTTPS to Turnstile's test verification service. These are functional checks, not a capacity test.

For targeted checks against your own local dev server:

```bash
# Keep npm run dev running for these localhost-only checks:
npm run test:smoke -- http://localhost:8787
npm run test:admin -- http://localhost:8787
npm run test:drafts -- http://localhost:8787
```

The smoke checks create test fixtures. Use synthetic names and options. Never point them at a production service. To preview the Pages wrapper, follow the [local Pages instructions](docs/DEPLOYMENT.md#local-pages-preview).

## Deploy on Cloudflare

WeVote runs on your own Cloudflare account. First sign in and create a separate KV namespace, then use the offline setup helper to write your account-specific configuration:

```bash
npx wrangler login
npx wrangler whoami
# Continue with the account ID, KV ID, project names, and Turnstile site key:
npm run setup:cloudflare -- --help
```

Follow [the deployment guide](docs/DEPLOYMENT.md) to create KV, supply the setup arguments, run `npm run deploy:api` and `npm run deploy:pages`, and attach your domain. The helper writes ignored `wrangler.worker.local.jsonc`, `.cloudflare/pages/wrangler.jsonc`, and a protected `.env.production.json`; it does not provision or deploy remote resources. Edit `.env.production.json` locally to add your real `TURNSTILE_SECRET_KEY` before deployment. Keep these files out of Git.

## Architecture

```text
Cloudflare Pages: static home, admin, voting, and results pages
  /api/* -> Pages Function -> private API Worker via Service Binding
    |-- AdminDirectory: accounts, sessions, roles, and event grants
    |-- EventCoordinator: event content/settings and shared result aggregation
    |-- 128 VoteShard instances per event: SQLite Durable Objects
    `-- EVENTS KV: eventually consistent event catalog
```

Static routes avoid Function execution. Public results use short caches at Pages and the coordinator, and concurrent readers share one aggregation across the shards. Event configuration is authoritative in the coordinator; catalog publishing retries with alarms. The API Worker has no public `workers.dev` endpoint in this configuration.

## Cost and capacity

Cloudflare's free Workers/Pages Functions allowance is 100,000 dynamic requests per day. Workers Paid starts at US$5 per month and includes monthly request/CPU allowances; Durable Objects and KV have their own metered usage and allowances. **US$5 is not a guaranteed total monthly bill.** Verify current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [KV](https://developers.cloudflare.com/kv/platform/pricing/) pricing for your account.

**A 50,000-user simultaneous voting event has not been validated by a production burst test.** Sharding and caching are design choices, not evidence of a capacity guarantee. Result polling, event duration, retries, cold starts, exports, and tests affect usage. For example, 50,000 viewers polling every three seconds for ten minutes produce about ten million result requests before identity and vote submissions.

Before a large event, measure burst entry and submission success, duplicate handling, p95 latency, cold starts, result lag, and actual platform usage. See [deployment verification](docs/DEPLOYMENT.md#verify-before-sharing-an-event).

## Privacy and administration

The application stores hashed browser/ticket identifiers, choices, and timestamps. Public results expose aggregates; authorized per-vote exports contain pseudonymous identifiers and timestamps and need a retention policy. Cloudflare handles hosting and verification traffic under its own service terms.

Share only the event URL or QR code. Keep owner and account login keys private. Admin sessions use HttpOnly cookies and expire after eight hours; disabling a named account or rotating its key revokes its sessions. Rotating the owner key does not invalidate existing owner sessions; they remain valid until their eight-hour expiry. Use one canonical public hostname so voting cookies are consistent.

## Credits and license

Credits: **[DAA.HK](https://daa.hk/), Hillman Tam and Keith Li**.

WeVote is licensed under the [MIT License](LICENSE). Retain its copyright and license notice when redistributing. The bundled QR generator's license is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The interface takes visual direction from [Streamline Freehand](https://www.streamlinehq.com/icons/freehand-sets). The project's illustration and SVG icons do not copy Streamline assets.
