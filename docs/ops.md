# Operations

Infrastructure changes are recorded here (devops-engineer). The app has no server and needs no secrets.

## Release identifier: the service-worker cache name

- `sw.js` carries a generated block between the stamp markers: `const VERSION = '<12 hex>'` and `const PRECACHE = [...]`. The cache name is `'homebody-' + VERSION`. See ADR 0003.
- `VERSION` is the first 12 hex characters of a SHA-256 over: `index.html`, `manifest.json`, `icon-*.png`, every regular file under `src/` and `fonts/` whatever its extension (symlinks are skipped), `sw.js` itself with the generated block removed, and the rendered `PRECACHE` list (as a pseudo-entry `stamp:precache`). Files are sorted by POSIX path in byte order; each contributes its path, a NUL, its byte length, a NUL and its raw bytes. Docs, tests, scripts and `node_modules` do not affect it.
- Top-level rule: only `index.html`, `manifest.json` and `icon-*.png` are hashed at the top level. Dotfiles and the explicit `NOT_SHIPPED` list in `scripts/stamp-sw.mjs` (`CLAUDE.md`, the eslint and playwright configs, `package.json`, `package-lock.json`) are ignored. Any other top-level file that looks like an asset (`.html`, `.json`, `.svg`, `.webp`, `.ico`, `.css`, images, `.js`/`.mjs`, fonts) makes `npm run stamp` and `stamp:check` exit 1 naming the file, instead of being silently left out of the hash. Put new shipped assets under `src/` or `fonts/`, or extend the lists in the script on purpose.
- `PRECACHE` entries are written with `JSON.stringify` and must match `^[A-Za-z0-9._/-]+$` with no `..` and no leading `/` (same-origin relative paths only); anything else throws.
- After changing any of those files, run `npm run stamp` and commit `sw.js`. `npm run stamp:check` (part of `npm run verify`, `npm test` and CI) fails with that instruction if it is stale, or if the markers are missing or duplicated. Re-stamping unchanged files writes nothing.
- `PRECACHE` is derived, not hand-kept: the shell file list filtered to runtime types (`.html .json .png .js .woff2`). Licences and `fonts/SOURCES.md` are hashed but not cached. The rendered list is part of the hash input, so changing the filter changes `VERSION`. Strategy: docs/offline.md.
- Hashing is over raw bytes, so a line-ending change in a shell file is a change. Do not enable CRLF conversion for these files.

## CI

`.github/workflows/ci.yml`: on every pull request and every push to `main`, on `ubuntu-24.04` with Node 22: `npm ci`, `npx --no-install playwright install --with-deps chromium webkit`, `npm run verify`. Token is `contents: read`; no secrets; no `pull_request_target`; a newer push to the same PR cancels the older run; 20 minute timeout.

- Actions are pinned by full commit SHA, resolved from GitHub's tag list on 2026-10-31: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/upload-artifact` v7.0.2. To update one, resolve the new tag's commit with `git ls-remote --tags https://github.com/actions/<name>` (use the `^{}` line for annotated tags), replace the SHA and the version comment together.
- On failure only, `test-results/` and `playwright-report/` (Playwright traces) are uploaded as artifact `playwright-failure`, kept 7 days.
- Privacy of failure artifacts: they are kept 7 days and may contain data derived from fixtures (traces, screenshots, DOM snapshots). Only sanitised fixtures may seed e2e tests, and nothing secret may ever be written to `test-results/` or `playwright-report/`. The app needs no secrets, so any found there is a bug.
- Making the `verify` job a required check is a repository setting only the owner can change (Settings, Branches, branch protection for `main`).

## Not done yet (separate ops tasks)

Deploy/Pages workflow and hosting headers, Dependabot, dependency review, secret scanning, uptime check, installability check.
