# Synthetic fixtures

Derived from the code, not from a person's data. Every file here is labelled synthetic; replace it (in `tests/fixtures/legacy/`, which is append-only) when a real sample turns up. Each file is exactly the JSON string that the named `localStorage` key would hold.

- `homebody_v1.json`: derived from `persistSave()` in `index.html` (keys `workouts`, `personalRecords`, `bodyMetrics`, `userPlans`, `profile`, `favourites`). The code treats `homebody_v1` identically to `vaultfit_v1` (`LEGACY_STORAGE_KEYS` in `persistLoad`), so the shape is the same. Two workouts, one with an L/R pair, one time-based entry, one orphan name (`DB Curl`), three PRs, one body row with nulls.
- `homebody_v0.json`: same derivation and shape as above; the code does not distinguish it from `vaultfit_v1`. One workout also carries a deliberately unknown field (`legacyFlag`) so the harness can check that unknown fields are kept.
- `vaultfit_v0.json`: same derivation and shape as `homebody_v1.json`.
- `hb_active_workout.json`: derived from `wmPersist()` (keys `name`, `planName`, `dayName`, `exercises`, `startTime`, `elapsed`, `rpe`, `planCtx`), with exercise and set shapes taken from `mStartWorkoutMode`. Includes a bilateral exercise (`done`) and a unilateral exercise (`DB Single-Arm Row`) with `doneL`/`doneR`, one set half done. `startTime` is a fixed epoch-ms value.

Real older formats may differ (earlier builds may have lacked fields such as `rpe` or `notes`); that is unknown until real samples exist. Tolerant readers and the "unknown fields kept" invariant cover the gap.
