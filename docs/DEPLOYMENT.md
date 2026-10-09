# Self-hosting on Cloudflare

This guide creates your own installation. The checked-in Wrangler files are local templates with a placeholder KV ID. Node.js 22 or newer and a Cloudflare account are required. Use `npm ci` to install the version of Wrangler in the lockfile.

## 1. Try it locally

```sh
npm ci
npm run setup:dev
npm run dev
```

Open `http://localhost:8787/admin.html`. In a local editor, read `ADMIN_DASHBOARD_KEY` from the generated `.dev.vars` and use it to sign in. The file contains local testing keys and is ignored by Git. `setup:dev` refuses to overwrite it. The demo poll lasts two hours; events created in the admin page have their own schedules.

```sh
npm test
npm run build:pages
```

The tests use disposable local storage. They do not use an existing installation or Cloudflare login. Integration vote checks need outbound HTTPS to Cloudflare's public Turnstile test Siteverify endpoint; `test:setup`, `test:startup`, `test:assets` and `test:cache` run offline. These checks verify functional behavior, permissions and caching; they are not a 50,000-user load test.

Local key login works without Google/Apple setup. Public provider sign-in requires a canonical HTTPS origin and optional provider credentials; the normal `http://localhost` setup leaves it disabled. Use an HTTPS staging installation with its own provider configuration to exercise a real sign-in flow. Trial SQL unit checks verify the 10,000-vote cap; they do not measure simultaneous voting capacity.

## 2. Select your account and create a KV namespace

```sh
npx wrangler login
npx wrangler whoami
```

Choose an account you control and copy its 32-character account ID. Set `CLOUDFLARE_ACCOUNT_ID` for the following provisioning commands. Replace the example value and choose your own namespace name:

```sh
export CLOUDFLARE_ACCOUNT_ID="your-32-character-account-id"
npx wrangler kv namespace create my-wevote-events --config wrangler.worker.jsonc --update-config false
```

Save the returned namespace ID. This command creates a Cloudflare resource. The `--update-config false` flag preserves the shared local template. KV stores the event catalog; Durable Objects store event configuration, accounts and votes. Do not reuse resources from someone else's deployment. [Wrangler KV commands](https://developers.cloudflare.com/workers/wrangler/commands/kv/)

## 3. Create a Turnstile widget and prepare configuration

Create a **Managed** Turnstile widget for your public hostname (for example, `my-wevote.pages.dev` and your intended custom domain). Copy its public site key and private secret key. Production deployment requires real keys; the local testing keys are rejected by the deployment helper. [Turnstile setup](https://developers.cloudflare.com/turnstile/get-started/)

Replace every capitalized placeholder below. Worker and Pages names must be lowercase letters, digits and hyphens. Choose unique names in your account:

```sh
npm run setup:cloudflare -- \
  --account-id YOUR_ACCOUNT_ID \
  --kv-id YOUR_KV_NAMESPACE_ID \
  --worker my-wevote-api \
  --pages my-wevote \
  --url https://my-wevote.pages.dev \
  --site-key YOUR_PUBLIC_TURNSTILE_SITE_KEY
```

This command runs offline and creates three ignored files:

| File | Purpose |
| --- | --- |
| `wrangler.worker.local.jsonc` | Your account, API Worker, KV binding and public URL |
| `.cloudflare/pages/wrangler.jsonc` | Your Pages project and service binding to that Worker |
| `.env.production.json` | Fresh random signing/admin keys, public site key and an empty private Turnstile secret |

Open `.env.production.json` in a local editor and fill in `TURNSTILE_SECRET_KEY`. Store its `ADMIN_DASHBOARD_KEY` in your password manager; it is the system owner's login key. The generated files have private file permissions on systems that support them. Setup refuses to overwrite existing files. **Do not commit or share this secrets file.**

The API Worker has `workers_dev: false` and `preview_urls: false`; Pages accesses it through `WEVOTE_API`. Preserve the Durable Object binding/class names and migration history when upgrading an existing installation.

Pages configuration does not accept `account_id`. The deployment helper selects the account for both API and Pages commands by setting `CLOUDFLARE_ACCOUNT_ID` from the validated Worker configuration, overriding any inherited account selection.

## 4. Deploy the API and Pages

First compile and validate locally:

```sh
npm run deploy:api -- --dry-run
```

Review the generated configurations and the account/Worker names printed by the helper. Then deploy the API, including secrets from the protected file:

```sh
npm run deploy:api
```

The helper uses Wrangler's `--secrets-file` option so secret values are not passed as command arguments. [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)

Create your Pages project once, matching `--pages` from step 3:

```sh
npx wrangler pages project create my-wevote --production-branch main --force
npm run deploy:pages
```

`--force` requests creation of a Pages project with the Wrangler version in this repository. For an existing Pages project, skip creation. `deploy:pages` builds the static site and `_worker.js`, then runs Pages deployment beside the generated Pages configuration. Pages deployment does not support `--config`; this helper selects the file by working directory. The deployment uses the production branch `main`. [Pages configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/), [Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)

This is a Direct Upload workflow. The supplied GitHub Actions validate code and do not deploy it.

### Updating an existing installation

Keep your existing `wrangler.worker.local.jsonc`, `.cloudflare/pages/wrangler.jsonc` and `.env.production.json` when pulling source updates. Do not run first-time setup again or generate new signing/admin keys. If an older checkout used production IDs in the tracked Wrangler files, copy that deployment configuration into the ignored local files before replacing it with the shared templates. The Pages configuration lives two directories below the project root, so its schema and build paths must use `../../node_modules/wrangler/config-schema.json` and `../../pages/dist` respectively.

Compare the account, Worker name, Pages name, KV namespace, service binding and all Durable Object bindings/migrations with the existing deployment. Keeping these identifiers preserves access to your existing events, accounts and votes. Run the dry run before deploying. A source update does not require recreating Cloudflare resources.

### Event posters and private deployment assets

Event-specific posters are not part of the source license. To keep an authorized poster available at an existing `/assets/...` URL, place it in the ignored `private-assets/` directory and explicitly list it in `private-assets/manifest.json`:

```json
{
  "version": 1,
  "files": ["event-poster.jpg"]
}
```

Only local JPEG, PNG and WebP files with safe filenames are accepted. The build rejects missing files, symlinks, path traversal and invalid image signatures before replacing the current build. Files are published under `/assets/` and can be downloaded by visitors; this directory is private **in the source checkout**, not private on the website.

```sh
# Review the site bundle, including the listed poster(s).
npm run build:pages -- --with-private-assets

# Build and deploy the same assets to your configured Pages project.
npm run deploy:pages -- --with-private-assets
```

For an installation whose events use these assets, include this flag on every Pages deployment. The default build/deploy excludes `private-assets/`, and a deployment without the flag removes those files from the site. Keep a separate backup of the assets and manifest; Git and the source release ZIP do not contain them. Other self-hosters can use their own artwork or an authorized external HTTPS cover URL through the admin editor.

## 5. Add a custom domain (optional)

In your Pages project's **Custom domains**, add the intended hostname first. For a subdomain managed by another DNS provider, add its CNAME pointing to `my-wevote.pages.dev`; nameserver changes are not required for a subdomain. An apex domain has different requirements. Wait for domain activation and TLS before sharing links. [Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)

Add the custom hostname to your Turnstile widget and update `vars.PUBLIC_BASE_URL` in `wrangler.worker.local.jsonc` to the HTTPS origin, then redeploy the API. This controls generated event/QR links. Use the same canonical hostname throughout a vote: browser identity cookies belong to a hostname.

## 6. Enable public organizer registration (optional)

Follow [Google/Apple organizer sign-in setup](ORGANIZER_AUTH.md) after your canonical HTTPS hostname is active. Set exact return URLs under that hostname:

| Provider | Return URL | Callback method |
| --- | --- | --- |
| Google web application | `https://<canonical-host>/api/auth/google/callback` | GET |
| Apple Services ID | `https://<canonical-host>/api/auth/apple/callback` | POST, `application/x-www-form-urlencoded` |

Add the complete chosen provider group to the existing ignored `.env.production.json` in a local editor. Retain the signing, admin, and Turnstile values. Google uses `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; Apple uses `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` (the private PKCS#8 `.p8` contents encoded as a JSON string). Provider settings are independent; leave an unconfigured group absent. Deployment validation rejects incomplete configured groups. Redeploy the API through the helper so these values become Worker Secrets, then test sign-in on the canonical hostname. No Google/Apple developer resources are provisioned by `setup:cloudflare`.

Publicly registered organizers receive one lifetime event, including a draft, a maximum 24-hour voting period, and up to 10,000 valid recorded votes. The server reserves the creation allowance and stores trial votes/counters in that event's coordinator with an atomic cap. Staff/key-created events continue using 128 vote shards and have no public-trial quota. These settings do not enable payments or Stripe.

Changing the canonical hostname also requires updating provider return URLs. Existing login/session and voting cookies belong to their original hostname.

## Verify before sharing an event

1. Open the public homepage and `/admin`, and sign in with your owner key.
2. Create a disposable event, publish it, and verify its start/end times.
3. Open its public link on another browser; verify Turnstile and submit one vote.
4. Confirm results and charts request updates approximately every second while voting is open and result visibility permits it.
5. Check the QR destination, CSV summary and print/PDF report.
6. Wait until the disposable event's scheduled closing time, then verify voting stops and authorized raw CSV export works.
7. Create organizer accounts and explicitly assign their events. Test their access before distributing keys.
8. If public signup is enabled, test a provider login and one draft on staging: the draft uses the account's event allowance, a second creation is denied, and a period longer than 24 hours is denied. Use the isolated trial tests for the 10,000-vote boundary rather than filling a real event.

The voting page and dashboard poll approximately every second while voting is open. Results use a shared snapshot of approximately one second; cache expiry, request duration, and network delay can still delay a successful vote's appearance. Public results follow the event's visibility setting.

## Local Pages preview

The direct Worker dev server serves the full app and is the simplest local workflow. To additionally test the Pages service-binding layer, build the assets, keep the API Worker dev server running in one terminal, and run this in another:

```sh
npm run build:pages
npx wrangler pages dev pages/dist
```

The checked-in Pages template binds to `wevote-local-api`, the checked-in Worker dev name. Set your local `PUBLIC_BASE_URL` to the Pages dev origin if testing its share links. A local Pages preview does not reproduce production CDN caching or distributed load.

## Operating your installation

### Storage-backed APIs return 503

Inspect the API Worker's `request_failed` logs before changing configuration. If the message is `Exceeded allowed volume of requests in Durable Objects free tier.`, the account's free daily Durable Object request allowance is exhausted. Wait for the daily reset at 00:00 UTC (08:00 Hong Kong time), or enable Workers Paid on the same account. Do not recreate namespaces, events, accounts or keys to address this error. Staff-event result aggregation can read 128 shards. Trial results use coordinator counters; they still incur requests and SQL usage. Budget for backend operations and Pages traffic. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

After the quota is available, verify an existing event's results and admin access, and monitor usage before inviting participants.

### Routine operation

- Monitor trial signups and creation/vote limits. A trial account's draft consumes its lifetime event allowance; closing the event does not release that allowance. Provider subjects are separate identities, and multiple provider accounts can belong to one person.
- Keep production secrets and exported votes private; issue individual admin/organizer keys rather than sharing the owner key.
- Back up important data with an appropriate Cloudflare storage procedure and the app's authorized exports before an upgrade. A Git source ZIP contains no votes or accounts.
- Monitor Workers, Durable Objects and KV usage. Measure your event's expected concurrency and request rate before relying on capacity or cost claims. Current pricing links are in the README.
- Rotate a lost account key from the owner account. Disabling or rotating a named account revokes its sessions. Owner-key rotation does not automatically revoke existing owner sessions, which expire after eight hours.
- A public link uses a browser cookie and Turnstile to discourage repeat voting. It cannot establish a person's identity; use an appropriate identity process for votes requiring strict eligibility.
