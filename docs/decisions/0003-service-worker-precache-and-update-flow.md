# 0003 — Service worker: generated precache, cache-first shell, user-timed updates

Status: Accepted (by James, in chat, 2026-10-31) · Date: 2026-10-31 · Author: architect · Milestone: M1

## Context
`sw.js` precaches only `manifest.json`; HTML is fetched `no-store` with a fallback to an empty cache, so the app does not open offline (K1). Fonts come from Google Fonts. `install` calls `skipWaiting()`, so a new worker takes over immediately. index.html contains two overlapping update-banner implementations, polls `reg.update()` every 60 s, reloads on every `controllerchange`, and registers `sw.js?v=7` while the cache is `homebody-v11` and the comment says v8 (K4). Nothing stops an update reload during a live workout (principle 5).

## Options
- Strategy: (a) network-first HTML with timeout; (b) **cache-first precached shell, updated by SW version (recommended)**; (c) stale-while-revalidate per request. (a) is slow on gym wifi and mixes versions; (c) can serve an index.html from one release with modules from another.
- Tooling: (a) hand-maintained list + manual bump (status quo, already drifting); (b) Workbox build (needs a build step); (c) **a small Node script that generates the list and version (recommended)**.
- Update timing: (a) auto-activate (status quo); (b) **wait, then apply only at a safe moment the user picks (recommended)**; (c) apply on next cold start only.

## Recommendation
- `scripts/stamp-sw.mjs` walks the shell (`index.html`, `manifest.json`, icons, `src/**/*.js`, `fonts/*.woff2`), computes a SHA-256 over their contents, and rewrites a marked block in `sw.js`: `const VERSION = '<short-hash>'; const PRECACHE = [...]`. `stamp-sw --check` fails `verify` and CI if the block is stale. The cache version is therefore tied to content, never hand-bumped, and the CLAUDE.md "bump the cache name" guardrail is satisfied by running the script.
- Install: `cache.addAll(PRECACHE.map(u => new Request(u, {cache: 'reload'})))` (bypasses GitHub Pages' HTTP cache so one release never mixes files). No `skipWaiting()` on install.
- Fetch: same-origin navigations serve precached `index.html`; precached assets cache-first; anything else network as today. No runtime request to a third party remains once fonts are self-hosted.
- Activate: delete caches whose name is not `homebody-<VERSION>`; `clients.claim()`.
- Update UX: a waiting worker is announced only when no workout is active (`wmState` null and no `hb_active_workout`). During a workout the notice is held and shown after Finish/Discard. Tapping "Update" posts `{type: 'SKIP_WAITING'}`; the page reloads on `controllerchange` only if it asked for it. "Later" leaves the update to apply when all app windows close. Check for updates on launch and on `visibilitychange` to visible, not every 60 s.
- Keep accepting the legacy string message `'skipWaiting'`, because the first update arrives on pages still running the old banner code.
- Register `sw.js` (no query string) with `updateViaCache: 'none'`; consolidate the two banner implementations into one.
- Show the release `VERSION` in Profile → About for bug reports.
- Self-host Oswald and Inter as woff2 (SIL OFL 1.1; license files committed in `fonts/`), only the weights in use, with `font-display: swap`.

## Consequences
- + The app opens and runs offline after the first load; updates never interrupt a workout; versioning is automatic and checkable.
- + Cache-first is fast at launch.
- − Users see a new release one launch later unless they tap Update. Acceptable for a training log.
- − A broken release could be pinned in cache. Mitigation: the SW stays tiny and version-stamped, e2e tests cover install → update → activate, and a kill-switch procedure (publish a SW that clears caches and unregisters) is documented in docs/architecture.md.
- − The first update after M1 ships runs through the old page code (old banner, old registration URL). This path gets its own e2e test.
