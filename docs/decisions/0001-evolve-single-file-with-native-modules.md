# 0001 — Evolve the single file by extracting native ES modules, no bundler

Status: Accepted (by James, in chat, 2026-10-31) · Date: 2026-10-31 · Author: architect · Milestone: M1

## Context
`index.html` is ~670 KB / 7,802 lines: CSS, an exercise library, plans, instructions and ~all logic in one classic `<script>` with global functions called from inline `onclick` handlers (K14). There are no tests and no toolchain. M1 must add a real service worker, a storage layer with versioned migrations and stable exercise IDs, and every step must ship. Migrations and training logic must be pure and testable without a browser (CLAUDE.md principles 1, 6). Hosting is static (GitHub Pages).

Facts that shape the choice:
- Startup is one `DOMContentLoaded` handler (`mLoadTheme`, `persistLoad`, `mRenderHome`, `mRenderProgress`, `wmRestoreIfActive`, index.html ~line 7264). Everything else is function definitions.
- `persistSave()` has 17 call sites; exercise lookups by name (`EXERCISES.find(x => x.name === …)`) appear at ~20 sites.
- Any move to IndexedDB makes loading asynchronous, so the boot sequence has to change anyway.

## Options
1. **Keep everything in index.html.** No tooling. Pure code stays untestable outside a browser; migrations cannot be unit-tested; diff noise stays high. Fails principle 6.
2. **Rewrite as a framework app with a bundler (Vite/TS).** Clean end-state, but a big-bang cutover, a build step on Pages, SW-manifest plugins, and high regression risk for a single user's history. Fails "ships after every step".
3. **Strangler extraction into native ES modules, no build step (recommended).** New and extracted code lives in `src/` as plain `.js` ES modules loaded by the browser directly and imported by Node tests. The legacy inline script keeps working and shrinks over time.

## Recommendation (option 3)
- Layout: `src/boot.js` (entry module), `src/storage/` (engines, migrations, import/export), `src/core/` (pure logic: exercise resolution, later training rules), `src/data/` (exercise IDs, aliases), `scripts/` (Node dev scripts), `tests/unit/` (node:test), `tests/e2e/` (Playwright), `fonts/`.
- Bridge: `index.html` gains one `<script type="module" src="src/boot.js">`. The classic inline script keeps defining globals; its `DOMContentLoaded` body moves into `window.hbStart()`. `boot.js` imports storage/core, publishes the narrow surface the legacy code needs on `window.HB` (e.g. `HB.storage.save(state)`, `HB.exercises.resolve(name)`), awaits storage load, then calls `hbStart()`. Legacy functions like `persistSave()` become thin shims over `HB.*`, so the 17 call sites do not change.
- Tooling (dev-only, nothing shipped to users, exact versions pinned, lockfile committed):
  - `node --test` (built into Node 22) for unit, migration and data-integrity tests. Zero dependencies.
  - `@playwright/test` for characterisation, offline and SW-update tests. Earns its place: K1/K4 cannot be verified without a real browser with offline control and service workers.
  - `eslint` + `@eslint/js` and `prettier` on `src/`, `scripts/`, `tests/`, `sw.js` only. `index.html` stays excluded (see CLAUDE.md guardrail).
  - `scripts/serve.mjs`: ~30-line zero-dependency static server used by Playwright and for local runs (replaces `python3 -m http.server` for tests, which can't set headers per test).
  - `npm run verify` = lint + format:check + unit + e2e + `stamp-sw --check` (ADR 0003).
- No transpile, no TypeScript, no bundler in M1. JSDoc types are welcome; `tsc --noEmit` type-checking may be proposed later by ADR.

## Consequences
- + Every step ships; the app keeps working from the repo root with any static server.
- + Pure modules are tested in Node with no DOM; migrations get fast, exhaustive fixture tests.
- + Only dev dependencies; users download nothing new except our own modules (cached by the SW).
- − Two worlds coexist for a while (globals + modules). Mitigation: the `window.HB` surface is listed in docs/architecture.md and only grows by plan.
- − Module scripts are deferred, so boot becomes async; first paint must not regress (accessibility-performance-reviewer checks start-up).
- − More files to precache; handled by the generated precache list (ADR 0003).
- Revisit when `src/` passes ~25 modules, or TypeScript or a UI framework is wanted.

## Amendment, 2026-11-01: shipped code under `src/` is classic scripts, not ES modules (T5a)
Measured in T5a, median of 9 interleaved runs against the pre-T5a commit: an ES-module boot (`<script type="module">`, with or without top-level await or the `hb-booting` flag) put the first visible frame at 230 to 240 ms against 120 to 140 ms; the same code as a classic `<script src>` measured at baseline. The cause is the module path, not the storage logic. Decision (James, in chat): storage and boot ship as one classic IIFE file, `src/hb-storage.js`, attaching a namespace (`HBStorage`) and `window.HB`; Node tests import the same file through a helper, so there is still no build step. The "native ES modules" and `src/boot.js` layout above stands for later code only if a new measurement shows no first-paint cost; until then new shipped code under `src/` follows the classic-script pattern.
