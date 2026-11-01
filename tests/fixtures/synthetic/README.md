# Synthetic fixtures

Derived from the code, not from a person's data. Every file here is labelled synthetic; replace it (in `tests/fixtures/legacy/`, which is append-only) when a real sample turns up. Each file is exactly the JSON string that the named `localStorage` key would hold.

- `homebody_v1.json`: derived from `persistSave()` in `index.html` (keys `workouts`, `personalRecords`, `bodyMetrics`, `userPlans`, `profile`, `favourites`). The code treats `homebody_v1` identically to `vaultfit_v1` (`LEGACY_STORAGE_KEYS` in `persistLoad`), so the shape is the same. Two workouts, one with an L/R pair, one time-based entry, one orphan name (`DB Curl`), three PRs, one body row with nulls.
- `homebody_v0.json`: same derivation and shape as above; the code does not distinguish it from `vaultfit_v1`. One workout also carries a deliberately unknown field (`legacyFlag`) so the harness can check that unknown fields are kept.
- `vaultfit_v0.json`: same derivation and shape as `homebody_v1.json`.
- `hb_active_workout.json`: derived from `wmPersist()` (keys `name`, `planName`, `dayName`, `exercises`, `startTime`, `elapsed`, `rpe`, `planCtx`), with exercise and set shapes taken from `mStartWorkoutMode`. Includes a bilateral exercise (`done`) and a unilateral exercise (`DB Single-Arm Row`) with `doneL`/`doneR`, one set half done. `startTime` is a fixed epoch-ms value.

Real older formats may differ (earlier builds may have lacked fields such as `rpe` or `notes`); that is unknown until real samples exist. Tolerant readers and the "unknown fields kept" invariant cover the gap.

## Added in T6 (schema 2 and the v1 mirror)

Both derived by running migration 001 (`HBStorage.MIGRATIONS`) over `tests/fixtures/legacy/vaultfit_v1_export.sanitized.json` (header fields stripped, as `persistSave` would have stored it); nothing in `legacy/` was edited. They carry real-shape data, so they are the largest files here.

- `schema2/store_dump.json` (in a sub-folder on purpose: the schema 1 helpers and the migration harness load every top-level file here as a version 1 document, and this one is already version 2): what the schema 2 IndexedDB stores hold, reassembled as one document: the six record sets plus `schemaVersion: 2` and the commit counter `seq: 1` (the `meta` store). Migration invariants hold on it (a no-op: it is already version 2).
- `vaultfit_v1_mirror.json`: the `vaultfit_v1` text after an IndexedDB commit: exactly the six-key v1 blob in `persistSave` order plus the one extra key `hbSeq: 1`. A pre-M1 build ignores `hbSeq` and drops it on its next save, which is how the store knows the mirror is newer (tests/unit/store-v2.test.mjs).
