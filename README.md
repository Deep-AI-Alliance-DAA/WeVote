# WeVote

Create an event, share one voting link or QR code, and display the results. WeVote is a self-hosted voting application with a professional hand-drawn interface, an event dashboard, and CSV/PDF report tools.

**Project credits: [DAA.HK](https://daa.hk/), Hillman Tam and Keith Li.**

**Hosted installation:** [vote.daa.hk](https://vote.daa.hk/), running on Cloudflare Pages and a private API Worker.

**Public source:** [Deep-AI-Alliance-DAA/WeVote](https://github.com/Deep-AI-Alliance-DAA/WeVote).

[香港廣東話指南](docs/README.zh-HK.md) · [Deployment](docs/DEPLOYMENT.md) · [Organizer sign-in](docs/ORGANIZER_AUTH.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

The source is licensed under [MIT](LICENSE).

## Inspiration: “Keith Li's US$5 theory”

WeVote takes inspiration from Keith Li's emphasis on shared caching and reducing repeated work. His [HK Traffic Intelligence](https://github.com/keithligh/hk-traffic-intelligence) describes serving many viewers from a shared feed copy and refreshing it when due.

[Cloudflare Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) starts at US$5 per month. WeVote's actual total bill depends on requests, CPU, Durable Objects, KV, and other usage; the cost and capacity limits are explained below.

## Features

- Independent events with 2–20 options, drafts, preview, publication, and scheduled opening/closing.
- Owner, administrator, and organizer roles; individual login keys and event assignments.
- Optional public organizer registration through Google or Apple, with a bounded trial event.
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

## Public organizer trial

When an operator configures Google or Apple sign-in, a visitor can register from the home/admin page and manage their own event. Each self-registered organizer account receives **one lifetime event, including a draft**, **up to 10,000 recorded valid votes**, and a **maximum 24-hour voting period**. Creating a draft consumes the event allowance; publication, closing, logout, and repeat sign-in do not reset it. The server enforces creation reservations, duration, and the atomic vote cap. Retrying an already recorded choice remains safe at the cap.

| Account | Event creation | Vote storage |
| --- | --- | --- |
| Public Google/Apple organizer | One lifetime event, including a draft; up to 24 hours | Up to 10,000 valid votes in its EventCoordinator |
| Owner, admin, or existing key-based organizer | No public-trial creation quota; normal permissions and event validation apply | Existing 128-shard storage; no trial vote cap |

Google and Apple are independently configured and unavailable until their credentials are installed. See [organizer sign-in setup](docs/ORGANIZER_AUTH.md). Provider identities are separate app accounts; the app does not merge accounts by email or establish one account per person. Voters still use the public voting link and Turnstile.

The 10,000-vote allowance is a storage limit. Simultaneous 10,000-person voting capacity has not been established by a burst test. Operator hosting costs still depend on platform usage. Payments, subscriptions, and Stripe integration are not implemented.

## What counts as one vote

Public events issue an event-specific signed HttpOnly browser cookie and validate Cloudflare Turnstile on the server. The same browser identity is counted once; retrying the same choice is safe, and changing an already recorded choice is rejected.

**This does not establish one vote per person.** Clearing cookies, private browsing, using a different browser, or switching devices can create another identity. A web page cannot read a device MAC address. Turnstile reduces automated abuse; it does not verify a person's eligibility. This mode suits event interaction and opinion collection.

An optional legacy signed-ticket mode counts each valid ticket once. Organizers remain responsible for eligibility and distribution, and a ticket can be forwarded. See the [Cantonese guide](docs/README.zh-HK.md#可選舊式獨立票據) for the CLI workflow.

## Run locally

Requirements: Node.js 22 or newer and npm.

```bash
git clone https://github.com/Deep-AI-Alliance-DAA/WeVote.git
cd WeVote
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

`npm test` runs syntax, cache, setup, asset, startup, and integration checks. It starts and stops a disposable local Worker with temporary keys/storage, without using a Cloudflare login or your existing `.dev.vars`. Integration voting checks require outbound HTTPS to Turnstile's test verification service. The trial ballot unit suite uses real SQLite to check the actual 10,000-vote boundary, transaction rollback, durable retries, and exports. These are functional checks; burst capacity requires separate measurement.

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

### Event posters and private deployment assets

Deployment-specific posters and organizer images belong in the ignored `private-assets/` directory. Create `private-assets/manifest.json` listing the images to include; for example:

```json
{ "version": 1, "files": ["event-poster.jpg"] }
```

Place each listed image in that directory, then explicitly include it when deploying:

```bash
npm run deploy:pages -- --with-private-assets
```

The normal public build contains the reusable project artwork. The explicit flag adds only the manifest's listed images to the hosted bundle. Set the event's cover-image URL to its deployed HTTPS address. Keep the manifest/images out of Git and obtain any required permission to host them; their rights are governed separately from the source license.

## Architecture

```text
Cloudflare Pages: static home, admin, voting, and results pages
  /api/* -> Pages Function -> private API Worker via Service Binding
    |-- AdminDirectory: accounts, OAuth identities/flows, sessions, roles, grants, and trial creation reservations
    |-- EventCoordinator: authoritative content/settings and shared results
    |     `-- Public trial: local SQLite votes/counters with an atomic 10,000-vote cap
    |-- Staff/key-created events: 128 VoteShard instances per event
    `-- EVENTS KV: eventually consistent event catalog
```

Static routes avoid Function execution. Public results use short caches at Pages and the coordinator. Staff-event readers share one aggregation across the vote shards. Trial results read counters in the event coordinator, so polling a trial does not fan out to 128 vote shards. Trial exports preserve the existing partition/cursor API. Event configuration is authoritative in the coordinator; catalog publishing retries with alarms. The API Worker has no public `workers.dev` endpoint in this configuration.

While an event is open, the voting page and results dashboard request updates approximately every second. The backend shares a result snapshot for approximately one second. Cache expiry, request duration, and network delay can still delay a new vote's appearance; this is not an instant delivery guarantee.

## Cost and capacity

Cloudflare's free Workers/Pages Functions allowance is 100,000 dynamic requests per day. Workers Paid starts at US$5 per month and includes monthly request/CPU allowances; Durable Objects and KV have their own metered usage and allowances. These allowances are shared with the account's other applications. **US$5 is not a guaranteed total monthly bill.** Verify current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [KV](https://developers.cloudflare.com/kv/platform/pricing/) pricing for your account.

Durable Objects Free also has a separate **100,000-request daily limit**, shared across the account. A full staff-event result aggregation can read all 128 vote shards; one result request is not one Durable Object request. Trial ballots use local coordinator counters, reducing this fan-out, while account creation, identities, submissions, result reads, SQL writes, and exports still consume platform resources. Continuous dashboards can exhaust free allowances. Use Workers Paid for sustained live voting. When an allowance is exhausted, storage-backed voting/admin APIs can return 503 until its reset or the account is upgraded. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

**A 50,000-user simultaneous voting event has not been validated by a production burst test.** The trial's 10,000-vote cap is a storage limit, not proof of 10,000 simultaneous voters. Sharding and caching are design choices, not evidence of a capacity guarantee. Result polling, event duration, retries, cold starts, exports, and tests affect usage. For example, 50,000 viewers polling every second for ten minutes produce about 30 million result requests before identity and vote submissions, approximately 11 times the requests of an 11-second interval. Shared snapshots reduce aggregation work; they do not eliminate incoming result requests.

Before a large event, measure burst entry and submission success, duplicate handling, p95 latency, cold starts, result lag, and actual platform usage. See [deployment verification](docs/DEPLOYMENT.md#verify-before-sharing-an-event).

## Privacy and administration

The application stores hashed browser/ticket identifiers, choices, and timestamps. Organizer registration additionally stores the provider and its stable subject identifier, display name, role, and quota reservation. Provider passwords are never collected, and provider access/refresh tokens are not retained. Public results expose aggregates; authorized per-vote exports contain pseudonymous identifiers and timestamps and need a retention policy. Cloudflare and enabled identity providers handle their respective traffic under their service terms.

Share only the event URL or QR code. Keep owner and account login keys private. Admin sessions use HttpOnly cookies and expire after eight hours; disabling a named account or rotating its key revokes its sessions. Rotating the owner key does not invalidate existing owner sessions; they remain valid until their eight-hour expiry. Use one canonical public hostname so voting cookies are consistent.

## Credits, acknowledgements and license

The WeVote project credits are **[DAA.HK](https://daa.hk/), Hillman Tam and Keith Li**, as acknowledged by the project owner. The following acknowledgements explain the technical and visual references and the bundled third-party code:

- **Technical inspiration:** [Keith Li's HK Traffic Intelligence](https://github.com/keithligh/hk-traffic-intelligence) documents serving shared, cached feed copies on Cloudflare and refreshing them at intervals. This informed WeVote's emphasis on shared caching and economical operation.
- **QR generation:** `qrcode-generator` 2.0.4 by Kazuhiko Arase is bundled under MIT. Preserve the complete upstream notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **JWT/JWK cryptography:** `jose` 6.2.12 by Filip Skokan is used for organizer OAuth verification and Apple client assertions under MIT; its complete license is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Visual inspiration:** [Streamline Freehand](https://www.streamlinehq.com/icons/freehand-sets) informed the hand-drawn direction. WeVote's AI-assisted illustration and project SVG drawings are distributed under MIT; no Streamline assets were copied or vendored.

WeVote is licensed under the [MIT License](LICENSE). Retain its copyright and license notice when redistributing. Event posters and organizer logos supplied for a deployment retain their respective rights and permissions.
