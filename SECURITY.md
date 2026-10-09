# Security policy

## Reporting a vulnerability

Do not post credentials, participant data, private events, vote exports, or a working exploit against a live deployment in a public issue.

If GitHub's **Report a vulnerability** option is enabled in the repository's Security tab, use it to send a private report. Its availability depends on repository settings. If it is unavailable, ask the maintainers for a private reporting channel without including exploit details or identifying affected people in the request. This project does not publish a security contact email or promise a response deadline.

A useful private report includes the affected commit/version, a synthetic reproduction, the impact, and a suggested mitigation if available. Test only on systems you own or are authorized to test. Use a local instance wherever possible.

## Project status

WeVote is an early project preparing for public release. The latest default-branch version is the development baseline; there is no promise of security backports for older versions. Hosts are responsible for tracking fixes and verifying their own deployment.

## Relevant boundaries

- A public voting link plus an event cookie and Turnstile reduces repeat voting and automated abuse. It does not establish one vote per person or verify eligibility.
- The optional signed-ticket mode counts a valid ticket once, but tickets can be forwarded and their distribution must be controlled.
- Admin and organizer permissions are checked server-side, including event ownership and explicit grants. Public sharing links must not include admin credentials.
- Login keys are generated credentials, not user-chosen passwords. Individual keys are shown only when created/rotated; account credential hashes and session hashes remain server-side.
- Secure deployments use HTTPS and HttpOnly admin cookies. Use one canonical voting hostname and real Turnstile keys configured for that hostname.
- Per-vote CSV files contain pseudonymous identifiers and timestamps. Restrict access, define retention, and verify exports before publishing aggregate reports.

## Host responsibilities

Keep secrets and account-specific files out of version control. Use Cloudflare Secrets for production keys and protect local credential files. Configure account billing limits/alerts and test traffic bursts before an event. Do not run development smoke checks against production or assume an untested 50,000-user capacity.

If credentials are exposed, rotate them. Disabling a named account or rotating its key revokes that account's sessions. **Rotating the owner secret does not invalidate existing owner sessions; those remain valid until their eight-hour expiry.** Review access grants and restrict retained exports after an incident.
