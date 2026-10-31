# Operations

Infrastructure changes are recorded here (devops-engineer). The app has no server and needs no secrets.

## Release identifier: the service-worker cache name

- `sw.js` carries a generated block between the stamp markers: `const VERSION = '<12 hex>'` and `const PRECACHE = [...]`. The cache name is `'homebody-' + VERSION`. See ADR 0003.
- `VERSION` is the first 12 hex characters of a SHA-256 over: `index.html`, `manifest.json`, `icon-*.png`, `src/**/*.js`, `fonts/*.woff2` (those that exist), and `sw.js` itself with the generated block removed. Files are sorted by POSIX path in byte order; each contributes its path, a NUL, its byte length, a NUL and its raw bytes. Docs, tests, scripts and `node_modules` do not affect it.
- After changing any of those files, run `npm run stamp` and commit `sw.js`. `npm run stamp:check` (part of `npm run verify`, `npm test` and CI) fails with that instruction if it is stale, or if the markers are missing or duplicated. Re-stamping unchanged files writes nothing.
- `PRECACHE` is a fixed list in `scripts/stamp-sw.mjs` (`manifest.json` only for now; T3 widens it).
- Hashing is over raw bytes, so a line-ending change in a shell file is a change. Do not enable CRLF conversion for these files.

## CI

`.github/workflows/ci.yml`: on every pull request and every push to `main`, on `ubuntu-24.04` with Node 22: `npm ci`, `npx --no-install playwright install --with-deps chromium webkit`, `npm run verify`. Token is `contents: read`; no secrets; no `pull_request_target`; a newer push to the same PR cancels the older run; 20 minute timeout.

- Actions are pinned by full commit SHA, resolved from GitHub's tag list on 2026-10-31: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/upload-artifact` v7.0.2. To update one, resolve the new tag's commit with `git ls-remote --tags https://github.com/actions/<name>` (use the `^{}` line for annotated tags), replace the SHA and the version comment together.
- On failure only, `test-results/` and `playwright-report/` (Playwright traces) are uploaded as artifact `playwright-failure`, kept 7 days.
- Making the `verify` job a required check is a repository setting only the owner can change (Settings, Branches, branch protection for `main`).

## Not done yet (separate ops tasks)

Deploy/Pages workflow and hosting headers, Dependabot, dependency review, secret scanning, uptime check, installability check.
