# Contributing to WeVote

Thanks for helping make WeVote easier to deploy, use, and maintain. Read the [README](README.md), [Code of Conduct](CODE_OF_CONDUCT.md), and [security policy](SECURITY.md) before contributing.

The repository is being prepared for public release. Access and publication are controlled by its owner; these instructions do not change its visibility.

## Discuss the change

Use an issue for a reproducible bug or a specific feature proposal. Explain the user task, current behavior, expected behavior, and any relevant constraints. For a large change, discuss the approach before implementation. Report security vulnerabilities privately through the process in [SECURITY.md](SECURITY.md).

Use synthetic examples. Do not attach real participant lists, private event content, production vote exports, admin keys, signed tickets, cookies, or Cloudflare tokens.

## Development

Use Node.js 22 or newer:

```bash
npm ci
npm run setup:dev
npm run dev
```

Use the generated `.dev.vars` for localhost development. Keep local credentials, account-specific Wrangler configuration, exports, and test fixtures out of Git. Deployment instructions are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Make a focused change

- Keep the public link and duplicate-vote behavior compatible, or explain the migration required.
- Enforce authorization and ballot state on the server. Hiding an admin control is not an access check.
- Preserve draft/publication boundaries, immutable active ballots, idempotent retries, and atomic vote/count writes.
- Treat input as data. Render user content safely and keep CSV formula protection intact.
- Keep the interface usable on mobile and with a keyboard. Preserve legible contrast and focus states.
- Use simple language in UI text; maintain existing Cantonese wording or explain a language change.
- Document behavior, configuration, and dependency changes. Preserve MIT and third-party notices.

## Verify the change

Run the self-contained checks:

```bash
npm test
```

This runs syntax, cache, offline setup/startup checks, and the local integration suites. It creates a disposable Worker with temporary storage and keys, then stops it and removes the fixture. No Cloudflare login or existing `.dev.vars` is used. Integration voting checks need outbound HTTPS to Turnstile's test verification service.

Use `npm run test:setup` for offline setup/deployment-helper verification, `npm run check` for syntax, and `npm run test:cache` for cache checks. With your own local dev server running, use the smoke checks relevant to a focused change:

```bash
npm run test:smoke -- http://localhost:8787
npm run test:admin -- http://localhost:8787
npm run test:drafts -- http://localhost:8787
```

These checks create local fixtures and must never target production. For auth, vote counting, lifecycle, or export changes, include meaningful verification of denied access, duplicates, boundaries, and failure cases. For visual changes, inspect desktop/mobile views and keyboard interaction; a screenshot may help review. Do not include visible keys or private content in screenshots.

## Submit a pull request

Describe the problem, resulting behavior, and how you verified it. Keep unrelated changes separate. Call out storage migrations, compatibility changes, configuration requirements, and remaining limitations. Include dependency provenance and licensing if you add a package or vendored code.

Maintainers review changes before merging. A deployment or repository publication is a separate maintainer action.
