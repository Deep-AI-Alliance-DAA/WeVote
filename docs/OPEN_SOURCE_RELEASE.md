# Open-source release

The release source ZIP is a snapshot of the reviewed, committed source tree. It does not contain Git history or change the visibility of any repository.

## Prepare the snapshot

1. Review the tracked files in the release checkout. Keep deployment configuration as reusable examples. Exclude real credentials, event records, account files, ticket or vote exports, runtime databases, and the competition poster.
2. Preserve `LICENSE` and `THIRD_PARTY_NOTICES.md`. The vendored QR code library requires its MIT notice. Deployment-specific posters, logos, and other supplied images need their own redistribution permission.
3. Run `npm ci`, `npm test`, and `npm run build:pages`.
4. Commit the reviewed release changes. `git archive HEAD` uses the committed tree; uncommitted removals or documentation changes are not included. The release command requires clean tracked files.
5. Run `npm run release:source`. It writes `releases/wevote-source-0.1.0-<shortsha>.zip` and a SHA-256 checksum. The ZIP contains a `wevote/` directory. Release output is ignored by Git.
6. Inspect the ZIP file list and verify its checksum before distributing it. Confirm that the poster, credentials, exports, runtime state, and `.git` are absent.

`git archive` excludes untracked and ignored files, but it includes tracked files. It does not automatically remove sensitive content that someone has committed. Repeat the source review when preparing later releases.

## Publish a fresh repository

The preferred publication route is to create a new repository from the reviewed ZIP:

1. Extract the ZIP into a new directory outside the production checkout.
2. Initialize a new Git repository there and create its initial source commit.
3. Verify the new repository contains the expected source and notices only, then publish it.

Do not copy the original `.git` directory into the new repository. Keep the production checkout, its local credentials, and its deployed configuration separate from the release source.

## Existing private history

The existing private repository history contains a competition poster that is excluded from this release snapshot. Removing the file from the latest commit or adding an ignore rule leaves earlier versions in Git history.

A clean source ZIP is therefore not evidence that the existing repository is ready for a public visibility change. Before publishing that history, obtain permission that covers redistribution of the retained asset, or perform an explicitly approved history cleanup and audit the resulting history. Publishing a fresh repository from the clean ZIP avoids carrying those historical files into the public release.

The release command packages local source only. It does not deploy the application, upload the ZIP, rewrite history, or make a repository public.
