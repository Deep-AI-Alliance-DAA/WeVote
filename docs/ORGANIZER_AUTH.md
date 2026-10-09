# Google and Apple organizer registration

WeVote can let visitors register as organizers through Google or Apple. Each provider is optional and disabled until its complete configuration is installed. This guide configures your own installation; it does not activate a provider for the hosted DAA.HK service.

## Trial scope

| Setting | Server behavior |
| --- | --- |
| Event allowance | One lifetime event per self-registered organizer account; saving a draft consumes it |
| Voting period | At most 24 hours between `opensAt` and `closesAt`, including draft schedule edits |
| Valid votes | At most 10,000 recorded browser identities; same-choice retries do not add a vote |
| Management | Continue editing/publishing the same event within its phase restrictions and viewing/exporting its results |

Publication, closing, logout, and repeat sign-in preserve the creation reservation. An interrupted creation can recover the same reserved event. Owner/admin and existing key-based organizers have no public-trial event quota; normal permissions and validation apply. A trial event retains its trial settings when managed by another administrator.

Trial votes, counts, and the global cap are stored in the event's EventCoordinator. Its synchronous SQLite transaction checks duplicates, checks the cap, and records the vote/counters atomically; success waits for storage confirmation. Trial results read local counters. Staff/key-created events continue using the existing 128-shard ballot path. The export API still provides 128 partitions and 500-row cursor pages.

The cap bounds stored votes. A single coordinator's capacity for 10,000 simultaneous voters has not been established by a burst test. While voting is open, public pages poll approximately every second and share a backend snapshot for approximately one second; caching and network delay can still delay visible updates. Platform requests, SQL operations, storage, and verification traffic still have costs and account-wide quotas. Payments, subscriptions, and Stripe integration are not implemented.

## Canonical HTTPS hostname

Set `PUBLIC_BASE_URL` in the private API Worker configuration to your one public HTTPS origin, such as `https://vote.example.org`, with no path, query, or fragment. Keep the existing private `VOTE_SIGNING_KEY`. Sign-in must start and finish on that exact origin. Register callbacks using the same hostname, including its subdomain; a `pages.dev` hostname and a custom hostname are different origins.

| Provider | Complete environment group | Callback |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | GET `https://<canonical-host>/api/auth/google/callback` |
| Apple | `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | POST `https://<canonical-host>/api/auth/apple/callback` |

`GET /api/auth/providers` exposes availability booleans and trial limits, never credentials. An unavailable provider cannot start registration. The standard local HTTP setup leaves provider sign-in disabled; use a configured HTTPS staging hostname for provider testing.

## Google web application

1. In your Google project, configure the OAuth consent screen/audience and create an OAuth client of type **Web application**.
2. Add the exact authorized redirect URI: `https://<canonical-host>/api/auth/google/callback`. Scheme, hostname, path, and trailing slash must match the registered URI. Use the callback shown here without a trailing slash.
3. Copy the client ID into `GOOGLE_CLIENT_ID` and the client secret into `GOOGLE_CLIENT_SECRET`. Use Google test users while your consent configuration is in testing mode; follow Google's publishing/verification requirements before a public rollout. [Google web-server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)

WeVote requests `openid email profile`, uses an authorization-code flow with PKCE, and verifies Google's signed identity token, audience, issuer, expiry, and nonce. The callback is handled on the server. No browser SDK client-secret configuration is needed.

## Apple website / Services ID

Apple's web setup requires a **Services ID** associated with an existing primary native **App ID** that has Sign in with Apple enabled. Configure the primary App ID and related website association in your Apple Developer account; a Google web client ID cannot replace these prerequisites. Register the canonical domain/subdomain and return URL `https://<canonical-host>/api/auth/apple/callback`. Follow Apple's current web setup requirements. [Configure Sign in with Apple for the web](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/)

Create a Sign in with Apple private key associated with the primary App ID and download its `.p8` file. Obtain the key identifier and your developer team identifier. [Create a Sign in with Apple private key](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key/), [download and protect a private key](https://developer.apple.com/help/account/keys/create-a-private-key/)

| Variable | Value |
| --- | --- |
| `APPLE_SERVICE_ID` | The web Services ID / OAuth client ID |
| `APPLE_TEAM_ID` | Your Apple Developer team identifier |
| `APPLE_KEY_ID` | Identifier of the downloaded Sign in with Apple key |
| `APPLE_PRIVATE_KEY` | Full private PKCS#8 PEM contents of the `.p8` file |

WeVote signs a short-lived ES256 client assertion from that key. It requests `response_mode=form_post`, and accepts Apple's callback as `application/x-www-form-urlencoded` **POST**. Keep this route reachable through Pages and the `/api/*` service binding; do not replace it with a GET-only redirect. The flow cookie uses `Secure`, `HttpOnly`, and `SameSite=None` for that cross-site POST; the issued admin session uses the existing session policy.

## Install the credentials

1. Complete [deployment setup](DEPLOYMENT.md) and keep the generated ignored `.env.production.json` with private file permissions.
2. In a local editor, add the complete Google and/or Apple group to that existing JSON object. Retain the existing signing/admin/Turnstile properties. For `APPLE_PRIVATE_KEY`, encode PEM line breaks as `\n` inside the JSON string. Protect the original `.p8` file separately.
3. Run `npm run deploy:api -- --dry-run` to validate the selected account, Worker, base configuration, and configured credential groups. Then deploy with `npm run deploy:api` when ready. The helper uses `--secrets-file`; credentials become private Worker Secrets and are not command-line arguments.
4. On the canonical hostname, check provider availability, complete a fresh sign-in, and verify access to `/admin.html`. Test cancellation and retry from a fresh login link. Keep Google/Apple credentials out of `public/`, `private-assets/`, tracked configuration, logs, screenshots, and Git.

`setup:cloudflare` creates the hosting configuration and base secrets; it does not create Google clients, Apple identifiers, or identity-provider keys. Provider credential groups can be left absent. Removing properties from a local JSON file does not itself delete already deployed Worker Secrets; remove the relevant deployed credentials when disabling a provider.

## Accounts and privacy

The account identity is the verified `(provider, subject)` pair. Google and Apple sign-ins are separate accounts even if their email addresses match; there is no automatic email linking. Social signup creates an organizer, not an owner/admin, and does not issue a usable login key. Voters continue using browser-cookie identity and Turnstile, independently of organizer authentication.

WeVote stores the provider subject, display name, role, session state, and lifetime creation reservation. It does not collect provider passwords or retain provider access/refresh tokens. OAuth state is short-lived, single-use, and tied to a secure cookie and verified nonce. Disabling an organizer account blocks its future sign-ins and revokes its sessions. Sign-in verifies control of a provider identity; it does not establish one natural person per app account.

For `redirect_uri_mismatch` or an Apple return-URL error, compare the canonical hostname and exact callback path with your provider configuration. For an unavailable provider, check that the complete environment group and canonical HTTPS origin are installed. If flow verification expires, restart sign-in from the canonical site. Review safe Worker error logs; never log authorization codes, JWTs, provider response bodies, or private credentials.
