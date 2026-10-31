# 0002 — Storage: IndexedDB with versioned migrations, snapshots and a localStorage mirror

Status: Accepted (by James, in chat, 2026-10-31) · Date: 2026-10-31 · Author: architect · Milestone: M1

## Context
All user history lives in one localStorage JSON blob, `vaultfit_v1` (K2). `persistSave()` swallows every error, so a quota or private-mode failure loses data silently. `persistLoad()` copies legacy keys (`homebody_v1`, `homebody_v0`, `vaultfit_v0`) into `vaultfit_v1` and deletes them, with no version tag and no backup. Import (`mConfirmImport`) overwrites state with no snapshot and no undo. Other keys: `hb_active_workout` (live workout, written every 10 s), `hb_milestones`, `hb_theme`, `hb_seen_tutorial`, `hb_seen_guide`.

The real-shape fixture (tests/fixtures/legacy/vaultfit_v1_export.sanitized.json) is 260 KB for 7 months: 149 workouts in three record shapes, 1,377 entries, mixed side encodings (K17). Quota is not the urgent problem (~450 KB/year); silent failure, eviction, lack of versioning and lack of a way back are.

## Options
1. **Keep localStorage, add a version envelope.** Smallest change. Still synchronous whole-blob rewrites, ~5 MB ceiling, and a pre-migration snapshot doubles usage in the same small quota. No home for future photos.
2. **IndexedDB, one record holding the whole state.** Atomic, larger quota, simple. Still rewrites everything; no room to grow into per-workout writes.
3. **IndexedDB with a few object stores (recommended)**, written by our own ~100-line promise wrapper (no `idb` dependency; no build step to vendor it through).

## Recommendation (option 3)
- Database `homebody`, stores:
  - `workouts` (keyPath `id`), `records` (singletons keyed by name: `profile`, `personalRecords`, `bodyMetrics`, `userPlans`, `favourites`),
  - `meta` (`schemaVersion`, `migratedFrom`, `migratedAt`, `lastBackupAt`, `workoutsAtLastBackup`, `persisted`),
  - `snapshots` (auto-increment: `{reason, createdAt, schemaVersion, payload}`), written before every migration and every import; keep the last 5 plus the very first pre-IndexedDB snapshot until the user deletes it.
- M1 keeps the whole-state save semantics: `HB.storage.save(state)` writes all stores in one transaction. Incremental writes are a later optimisation.
- **Schema versions** (integers, in `meta.schemaVersion`; exports carry `_version` = schema version):
  - 1 — shipped format: `vaultfit_v1` blob and `.vaultfit` export `_version: 1`. Legacy keys are treated as 1 until real samples prove otherwise (synthetic fixtures until then, labelled as such).
  - 2 — same record shapes, stored in IndexedDB (T6).
  - 3 — adds `exerciseId` and normalised `side` to entries; names untouched (T10, ADR 0004).
  - 4 — names become plain labels (suffix removed), PRs keyed by `exerciseId` (T11).
- **Migrations** are pure functions in `src/storage/migrations/NNN-slug.js` exporting `{from, to, migrate(doc)}`; no I/O, no `Date.now()` (time passed in). One runner applies them in order on load **and on import**, so a v1 file imported in a v4 app follows the same tested path. Unknown fields are preserved.
- **Rollback mirror:** through M1 the app also writes a best-effort v1 projection (`projectToV1(state)`, suffixes restored) to `vaultfit_v1`, so reverting a release never shows stale or unreadable data. Mirror failures are logged, not surfaced; IndexedDB is the source of truth. Removing the mirror needs a later ADR.
- **Legacy keys** are no longer deleted on migration; they are snapshotted and left in place until the user clears them.
- `hb_active_workout` and the UI-preference keys stay in localStorage in M1 (synchronous writes survive a killed tab). `hb_active_workout` gets a reader that accepts the pre-M1 shape (see ADR 0004).
- **Durability:** request `navigator.storage.persist()` after the first successful workout save (a user gesture, so Firefox can show its prompt); show persisted/not-persisted and `storage.estimate()` in Profile → Data. On iOS outside standalone mode, recommend Add to Home Screen.
- **Write failures:** `save()` returns a promise. On failure, retry once, then show a sticky, non-dismissable-until-resolved banner with Retry and Export. The in-progress workout stays in memory and in `hb_active_workout`.
- **Fallback:** if IndexedDB cannot open (some private modes), use a localStorage engine behind the same interface and say so in Profile → Data.

## Consequences
- + Atomic multi-store writes, room for photos later, a tested way back (snapshots, mirror), visible failures.
- + One migration path for stored data and imported files.
- − Async boot (ADR 0001) and a second engine to test. Both engines run the same contract tests.
- − Dual storage during M1 uses about twice the space (~0.5 MB today). Acceptable.
- − Multi-tab: an old tab holding the DB blocks a version upgrade. `onversionchange` closes the DB in the old tab and asks for a reload, except during an active workout, where it waits and shows "finish your workout in the other tab".
