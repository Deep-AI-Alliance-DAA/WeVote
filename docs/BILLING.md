# Paid event credits with Stripe

WeVote keeps the free trial: one lifetime event per self-registered organizer,
including drafts, with up to 10,000 recorded ballots and a voting window of up
to 24 hours. A paid event credit permits one additional event with up to 10,000
recorded ballots and a voting window of up to 7 days (168 hours). A ballot with several selected options still counts
once against its event limit. Existing staff and administrator accounts remain
unlimited.

Billing is optional. An installation without the complete Stripe configuration
keeps organizer registration and the free trial available, with paid checkout
disabled. The repository does not set a selling price: the operator must approve
and configure the amount and a corresponding Stripe Price before enabling
checkout. The approved DAA offer is HK$99 per additional event,
configured as 9900 HKD minor units and a matching Stripe Price; this is runtime
configuration, not a price hardcoded into the open-source application. This is
a one-time purchase, not a subscription. Describing this offer does not confirm
that a particular deployment has enabled live payments.

## Configuration

Add these fields privately to the ignored `.env.production.json`. Never commit
the file, paste it into chat, put its values in browser code, or pass credentials
as command-line arguments.

| Field | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Backend API key for the selected Stripe account and test/live mode. Restricted `rk_test_` / `rk_live_` keys are supported, as are `sk_test_` / `sk_live_` keys. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this deployment's Stripe webhook destination. This differs from the API key and from a Stripe CLI listener's signing secret. |
| `STRIPE_PRICE_ID` | One-time Stripe Price for exactly one additional event credit. The browser cannot choose a Price or amount. |
| `STRIPE_PRICE_AMOUNT` | Approved positive integer amount in the currency's minor units. For HKD, HK$1 is 100 minor units. It must match the configured Stripe Price. |
| `STRIPE_PRICE_CURRENCY` | Set `hkd`, matching the configured HKD Price. The initial organizer checkout UI supports HKD only. |
| `STRIPE_TEST_ORGANIZER_IDS` | Comma-separated organizer account IDs permitted to use test checkout. Required in test mode; empty or absent in live mode. |

Use the same Stripe account, mode and Price for all fields. Changing test/live
mode does not convert test purchases into live paid credits. Test checkout must
be limited to explicitly listed organizer IDs; a public user cannot use test
card details to unlock a normal paid event. Keep billing disabled if the price
or credential setup has not been completed.

### Test and live modes

Both modes are supported by the application; the backend derives the mode from
the configured API key and verifies the Stripe Price and payment records.
The organizer dashboard obtains its price and mode from the backend. It marks
test checkout as **測試模式**; a live checkout charges real money.

| Mode | Required configuration |
| --- | --- |
| Test/sandbox | Test API key, test Price, that mode's webhook signing secret, and a nonempty explicit organizer allowlist. Test credits are usable only in test mode. |
| Live | Live API key, live Price and live webhook signing secret, with `STRIPE_TEST_ORGANIZER_IDS` empty or removed. Eligible self-registered organizers can purchase after using their free event. |

When switching an existing test deployment to live, clear its deployed
`STRIPE_TEST_ORGANIZER_IDS` value as well as the local configuration. Leaving a
nonempty test allowlist disables live billing. Omitting the field from a later
secrets upload does not remove an existing Worker secret. Switching mode never
converts test credits into live credits or resets the free trial.

The deployment helper validates the complete group before invoking Wrangler and
uploads the ignored file using `--secrets-file`. It reports configuration field
names, never their contents. A dry run validates syntax and configuration; it
does not prove that Stripe credentials or a webhook destination work.

```sh
npm run deploy:api -- --dry-run
```

Stripe recommends restricted keys. Grant only the API permissions required for
creating and reading Checkout Sessions, reading the configured Price and reading
Payment Intents and Charges for payment and refund reconciliation. The
application does not need payout, refund, dispute or account-management access.
See Stripe's [restricted-key documentation](https://docs.stripe.com/keys/restricted-api-keys).

API requests explicitly use `Stripe-Version: 2026-09-30.endive`. Configure the
snapshot webhook destination to use the same API version. See Stripe's
[versioning documentation](https://docs.stripe.com/api/versioning).

## Checkout and fulfillment

The organizer must have an authenticated, eligible account. The server creates
hosted Stripe Checkout for the configured offer, with a fixed return URL at the
installation's canonical `PUBLIC_BASE_URL`. It records an order and uses an
idempotency key so an uncertain network response can be retried without starting
another purchase. A canceled or unpaid checkout does not grant credit.
Each request explicitly sets `managed_payments[enabled]=false`: this
installation's operator remains the merchant of record, and WeVote uses
standard merchant Checkout with card payments. This request setting prevents
an account's Managed Payments default from changing the checkout integration;
it does not change the Stripe account's settings. See Stripe's
[Managed Payments integration documentation](https://docs.stripe.com/payments/managed-payments/update-checkout).
Reloading after an uncertain response also recovers the original order when the
dashboard checks its status. Distinct requests that reopen a pending checkout
retain their original order binding after payment. Additional request aliases
are bounded at 32 per order; accepted requests remain retryable at that bound.

A verified Session-creation HTTP 400 with `invalid_request_error` makes an
unbound order terminally `failed`, except for idempotency, conflict, lock or
timeout errors. This includes a stored Stripe replay of a definitive 400.
The dashboard can then start a new order with a new request UUID; replaying
the original UUID or an accepted alias continues to return the failed order.
Network failures, HTTP 500 responses and idempotency conflicts remain uncertain
and retain the original Stripe key. The server never replaces an uncertain
purchase with a fresh key. Existing order records are preserved by the SQLite
schema migration that adds the failed state.

For an order created by the earlier release, Stripe can reject the added
`managed_payments[enabled]=false` field as an idempotency parameter mismatch.
WeVote then retries exactly once with only that field removed, retaining the
same immutable order and Stripe key. This recovers the original cached
rejection or existing Session. A second mismatch, network failure or provider
error stays uncertain; it never causes a fresh purchase key.

The browser's return URL is a status hint. A `success` query parameter or
Checkout Session ID by itself does not prove payment. The server verifies the
session against its own order and the configured offer before granting an
event credit. Stripe requires webhook fulfillment because a customer may pay
and never load the return page.
[Stripe fulfillment documentation](https://docs.stripe.com/checkout/fulfillment)

Register the snapshot webhook destination at:

```text
https://YOUR_PUBLIC_HOST/api/billing/webhook
```

Subscribe only to the Checkout event types handled by this implementation:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`

The endpoint verifies the `Stripe-Signature` header against the original request
body, using HMAC-SHA256 and a bounded timestamp tolerance. It checks the
Checkout Session's payment status, account/order identity, mode, Price,
currency, amount and quantity. One Session grants at most one event credit even
if Stripe delivers the same event repeatedly or sends separate completed and
asynchronous-success events. Unsupported, correctly signed events are
acknowledged without changing a balance.
[Stripe webhook documentation](https://docs.stripe.com/webhooks)

A Stripe account can serve other applications. Correctly signed notifications
for unknown Checkout orders or refunded payments are acknowledged without
creating local credits or refund records. Refunds received before payment
fulfillment are linked through server-set PaymentIntent order metadata so a
later payment notification cannot restore the refunded credit.

A positive refund revokes an unspent event credit for that payment. A credit
already spent on an event keeps its reservation and event data; the operator
must resolve the refund's service consequences manually. Disputes also require
manual review in this first version; the application does not issue refunds or
perform dispute actions.

An event reservation spends credit and stores the original event configuration
atomically. Retrying the same request recovers that reservation and does not
spend another credit. Creating a draft consumes its event credit. Editing or
publishing the saved draft does not consume another one. Paid events retain
their server-enforced 10,000-ballot and 7-day limits. A browser-supplied
entitlement or duration setting cannot upgrade a free trial.

## API surface

All organizer endpoints use the existing protected administrator session.
Responses do not expose Stripe API keys or webhook secrets.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/billing` | Available offer, eligibility, remaining paid credits and latest checkout status. |
| `POST /api/admin/billing/checkout` | Create or retry the current order. Use a UUID `Idempotency-Key` and an empty JSON object. |
| `POST /api/admin/billing/reconcile` | Check one `{ "orderId": ... }` or `{ "sessionId": ... }` against the authenticated organizer's order. |
| `POST /api/billing/webhook` | Public Stripe receiver, authenticated by the webhook signature instead of an organizer cookie. |

## Verification before enabling purchases

1. Run the automated test suite. Billing tests use generated fixture credentials,
   mock Stripe responses and disposable SQLite; they also execute the real
   helper inside workerd with every outbound request intercepted. They never
   contact Stripe or make a payment. The runtime checks verify that provider
   redirects are rejected before any credentials can be forwarded.
2. Configure a Stripe sandbox/test Price and its matching webhook secret, with
   only the operator's organizer ID in `STRIPE_TEST_ORGANIZER_IDS`.
3. Complete a test checkout and confirm one test credit, one event reservation,
   retry behavior and webhook redelivery. Verify a non-listed account cannot
   initiate test checkout. Never enter real card details in test mode.
4. Confirm the selling price and the merchant's customer-facing contact and
   policies. Configure a separate live Price, restricted live key and live
   webhook signing secret; clear the deployed test allowlist. Verify webhook
   delivery before exposing live checkout to organizers. The included
   [customer service page](../public/service.html) describes event limits,
   payment verification, refund enquiries and data handling. If self-hosting,
   replace the DAA support contact and review the page against your own
   service and data-handling practices.

```sh
npm run test:billing
npm test
```

The automated tests verify failure handling and accounting behavior. A passing
offline test is not proof of a working merchant account, completed live
payment, production webhook delivery or concurrent voting capacity.

If billing is disabled after deployment, remove the Stripe secret fields in
Cloudflare as well as from the local file. Omitting a value on a later deploy
does not revoke an already-installed Worker secret. Preserve existing orders
and event reservations for reconciliation and export.
