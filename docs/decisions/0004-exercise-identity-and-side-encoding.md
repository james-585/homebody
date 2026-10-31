# 0004 — Stable exercise IDs, alias map, and per-side entries with a `side` field

Status: Proposed · Date: 2026-10-31 · Author: architect · Milestone: M1

## Context
Exercises are matched by display name (~20 `EXERCISES.find(x => x.name === …)` sites; PRs are keyed by name; plan days, favourites and the live workout hold names) (K3). The library (`const EXERCISES`) has 236 entries with no IDs. Unilateral work is logged as two entries, `"<name> (Left)"` and `"<name> (Right)"`; whether an exercise is unilateral is decided by a set plus keyword matching (`mIsUnilateral`).

Measured on the real-shape fixture (T1 pins these as tests):
- 1,377 entries; 474 carry the side suffix (237 Left, 237 Right, always adjacent pairs); 248 of those also carry `bilateral: true, side`; 226 carry the suffix only. No entry has `side` without the suffix.
- 10 base names in history are not in the library (87 entries in 56 of 149 workouts): KB Glute Bridge (28), Bodyweight Lunge (24), KB Romanian Deadlift (13), Sit up (6), DB Floor Fly (5), DB Floor Tate Press (4), DB Curl (2), DB Single-Leg Calf Raise (2), DB Sumo Squat with Capf Raise (2), KB Front Raise (1). PR keys add an 11th, KB Lateral Raise. The custom plan references 4 of them. K16 says 12 and lists Farmer's Walk, which *is* in the current library; T9 reconciles this.
- PRs both for "DB Curl" and "DB Bicep Curl" exist, so merging aliases can collide.

## Options
- ID format: (a) UUIDs; (b) integers; (c) **frozen kebab-case slugs, e.g. `db-single-arm-row` (recommended)**. Slugs are readable in exports and diffs; they are assigned once and never regenerated from a name.
- Side encoding: (a) keep the suffix; (b) merge each L/R pair into one entry with `sides: {left, right}`; (c) **keep one entry per side, add `exerciseId` and `side: 'left' | 'right' | null`, name becomes a plain label (recommended)**. (b) changes every reader and the set/volume arithmetic at once; (c) keeps the data one-to-one with what was logged and changes only how a side is labelled.
- Orphans: (a) drop them; (b) silently map them by fuzzy match; (c) **explicit alias table confirmed by the human, with anything unconfirmed kept as a user custom exercise (recommended)**.

## Recommendation
- `src/data/exercise-ids.js`: one frozen record per library entry `{id, name, laterality: 'bilateral' | 'unilateral'}`, generated once by a script from the current `EXERCISES` and `mIsUnilateral`, then hand-maintained. A snapshot test fails if any existing id changes or disappears.
- `src/data/exercise-aliases.js`: `oldName -> id`, covering renames and orphans the human has confirmed. Unconfirmed orphans become user custom exercises `custom-<slug>` (stored in a new `customExercises` record with name and the muscle the user picks, or `unknown`), so they count in stats without anyone inventing a muscle.
- `src/core/exercises.js` (pure): `resolve(nameOrId) -> {id, label, side}` that strips a legacy suffix, consults aliases, then the library, then customs; never throws; returns `{id: null}` for the truly unknown, and unknown names are reported, not skipped.
- Migration v2→v3 (additive, legacy readers unaffected): each history entry, plan exercise, favourite and the live workout gains `exerciseId`; suffixed entries gain `bilateral: true` and `side`. `name` is untouched.
- Migration v3→v4 (after every reader uses `resolve`): `name` loses the suffix; `personalRecords` is re-keyed by `exerciseId` (collisions with the same unit keep the max and record the merged names; different units keep both and are flagged). The v1 mirror projection (ADR 0002) restores suffixes and names.
- Volume, set and PR arithmetic is preserved exactly in M1 (per-side entries counted as today). Whether a unilateral set counts once or twice is a training-logic question for training-scientist in a later milestone.
- Primary/secondary muscles: M1 keeps the existing single `muscle`. Secondary muscles need sourced data (exercise-data-curator) and are out of M1.

## Consequences
- + Renames no longer break history, PRs or plans; orphaned history starts counting.
- − Stats change once orphans resolve (more volume, PRs and recovery load). This is a correction, but it is user-visible: T11 ships a drift report, and training-scientist and the human sign off.
- − Orphan mappings need human confirmation, which can block T10's data. Unconfirmed names fall back to custom exercises, so the migration never waits on them.
- − Two migrations (v3, v4) instead of one, in exchange for every step shipping safely.
