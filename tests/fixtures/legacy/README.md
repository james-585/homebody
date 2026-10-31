# Legacy storage fixtures

Real-shape samples of stored user data, one per shipped format, used by migration tests (CLAUDE.md principle 1). This folder is append-only for agents: add a new file for each format; never edit an existing one (enforced by `.claude/hooks/protect-paths.mjs`).

Present:
- `vaultfit_v1_export.sanitized.json`: a real `.vaultfit` export (format `_version` 1, exported 2026-10-31) with identity, health-revealing plan and workout names, and body metrics replaced by synthetic values. Structure is untouched: 149 workouts (Mar–Oct 2026) in three record shapes (with and without `notes` / `rpe`), 1,377 exercise entries, 474 using the " (Left)"/" (Right)" name suffix of which 248 also carry `bilateral`/`side`, 10 exercise names no longer in the current library (orphans; 11 counting PR keys), 12 PRs, 7 body-metric rows with nulls, one custom 8-day plan with `_progressionLog`, and a sparse equipment profile (dumbbells 5/10 kg, kettlebells 10/16 kg). Do not try to re-identify it or replace it with the original.

Still needed (the human supplies these, since agents must not invent what real data looks like):
- `vaultfit_v1.json`: a real export or localStorage dump from the current format, with a few weeks of workouts, PRs, body metrics, a user plan and a profile. Strip anything personal.
- Samples for the legacy keys `homebody_v1`, `homebody_v0` and `vaultfit_v0`, if any exist.
- A `.vaultfit` export file as produced by Export Data.

Samples of the legacy-key formats are still missing; derive a minimal `synthetic` one from `persistSave` only for formats no real sample covers.
