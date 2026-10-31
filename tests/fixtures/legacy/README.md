# Legacy storage fixtures

Real-shape samples of stored user data, one per shipped format, used by migration tests (CLAUDE.md principle 1). This folder is append-only for agents: add a new file for each format; never edit an existing one (enforced by `.claude/hooks/protect-paths.mjs`).

Needed (the human supplies these, since agents must not invent what real data looks like):
- `vaultfit_v1.json`: a real export or localStorage dump from the current format, with a few weeks of workouts, PRs, body metrics, a user plan and a profile. Strip anything personal.
- Samples for the legacy keys `homebody_v1`, `homebody_v0` and `vaultfit_v0`, if any exist.
- A `.vaultfit` export file as produced by Export Data.

Until these exist, storage-sync-engineer's first task is to derive a minimal fixture from `persistSave` in index.html and mark it `synthetic`.
