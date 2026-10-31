// Migration-test harness. Import this from any test file; importing it registers no tests.
// Later tasks (T6, T10, T12) add migrations and call `checkInvariants`.
//
// Migration contract (ADR 0002): a pure object { from, to, migrate(doc), changes? } where migrate
// returns a new document, with no I/O and no clock. The document carries its version in
// `schemaVersion` (absent means 1, the shipped format). `migrate` must bump `schemaVersion` to
// `to`; the runner throws if it does not. The runner never mutates its input.
//
// `changes` is the explicit opt-out list: a migration that intentionally rewrites something names
// it here, and only those comparisons are relaxed. Nothing else is skipped. Allowed entries:
//   'personalRecords' | 'bodyMetrics' | 'profile' | 'userPlans' | 'favourites'   (whole record set)
//   'workout.<field>'   a field on workout records, e.g. 'workout.notes'
//   'entry.<field>'     a field on exercise entries, e.g. 'entry.name', 'entry.side'
import { loadAllFixtures, stripHeader } from './load-fixtures.mjs';

export const getVersion = (doc) => doc.schemaVersion ?? 1;

/** Apply every migration whose `from` equals the current version, in order. Pure; clones input. */
export function applyMigrations(migrations, doc) {
  let cur = structuredClone(doc);
  const ordered = [...migrations].sort((a, b) => a.from - b.from);
  for (const m of ordered) {
    if (getVersion(cur) === m.from) {
      cur = m.migrate(structuredClone(cur));
      if (!cur || getVersion(cur) !== m.to) {
        throw new Error(`migration ${m.from}->${m.to} did not set schemaVersion to ${m.to}`);
      }
    }
  }
  return cur;
}

/** Deep subset: everything in `a` is present and equal in `b` (b may have extra keys). */
export function isSubset(a, b) {
  if (a === null || typeof a !== 'object') return Object.is(a, b) || a === b;
  if (b === null || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => isSubset(x, b[i]));
  }
  if (Array.isArray(b)) return false;
  return Object.keys(a).every((k) => k in b && isSubset(a[k], b[k]));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Fixtures that are a stored store document (the `workouts`/`personalRecords`/... blob). */
export function toStoreDoc(fixture) {
  const d = fixture.data;
  return d && Array.isArray(d.workouts) ? stripHeader(d) : null;
}

/** Invariants for one store document. Returns a list of human-readable violations. */
export function documentViolations(migrations, input) {
  const declared = new Set(migrations.flatMap((m) => m.changes ?? []));
  const v = [];
  const frozen = JSON.stringify(input);
  const out = applyMigrations(migrations, input);
  if (JSON.stringify(input) !== frozen) v.push('input document was mutated');

  const before = input.workouts;
  const after = out.workouts;
  if (!Array.isArray(after)) return [...v, 'workouts is not an array after migration'];

  // no workout lost, ids unique
  if (after.length !== before.length) v.push(`workout count ${before.length} -> ${after.length}`);
  const ids = after.map((w) => w.id);
  if (new Set(ids).size !== ids.length) v.push('workout ids are not unique');
  const byId = new Map(after.map((w) => [w.id, w]));
  for (const w of before) if (!byId.has(w.id)) v.push(`workout ${w.id} lost`);

  for (const w of before) {
    const o = byId.get(w.id);
    if (!o) continue;
    // every workout field (known or unknown) kept with the same value, unless declared
    for (const f of Object.keys(w)) {
      if (f === 'exercises' || declared.has(`workout.${f}`)) continue;
      if (!(f in o)) v.push(`workout ${w.id} lost field ${f}`);
      else if (!same(w[f], o[f])) v.push(`workout ${w.id}.${f} changed`);
    }
    if (!Array.isArray(o.exercises) || o.exercises.length !== w.exercises.length) {
      v.push(`workout ${w.id} exercise count ${w.exercises.length} -> ${o.exercises?.length}`);
      continue;
    }
    w.exercises.forEach((e, i) => {
      const oe = o.exercises[i];
      for (const f of Object.keys(e)) {
        if (declared.has(`entry.${f}`)) continue;
        if (!(f in oe)) v.push(`workout ${w.id} entry ${i} lost field ${f}`);
        else if (!same(e[f], oe[f])) {
          v.push(
            `workout ${w.id} entry ${i} ${f}: ${JSON.stringify(e[f])} -> ${JSON.stringify(oe[f])}`,
          );
        }
      }
    });
  }

  // top-level keys
  for (const k of Object.keys(input)) if (!(k in out)) v.push(`top-level key ${k} lost`);

  // personal records: every key kept with the same value, unless the migration declares a rewrite
  if (!declared.has('personalRecords')) {
    for (const [k, val] of Object.entries(input.personalRecords ?? {})) {
      if (!(k in (out.personalRecords ?? {}))) v.push(`personal record ${k} lost`);
      else if (!same(val, out.personalRecords[k])) v.push(`personal record ${k} changed`);
    }
  }

  // other record sets: input must be a deep subset of output (new fields allowed, no value changes)
  for (const key of ['bodyMetrics', 'profile', 'userPlans', 'favourites']) {
    if (declared.has(key) || !(key in input)) continue;
    if (!isSubset(input[key], out[key])) v.push(`${key} changed or lost data`);
  }

  // idempotence: running the chain again changes nothing
  const twice = applyMigrations(migrations, out);
  if (!same(twice, out)) v.push('not idempotent: second run changed the document');
  return v;
}

/** Invariants for the active-workout blob (hb_active_workout): preserved set for set. */
export function activeWorkoutViolations(migrations, input) {
  const v = [];
  const out = applyMigrations(migrations, input);
  if (!Array.isArray(out.exercises) || out.exercises.length !== input.exercises.length) {
    return ['active workout exercises lost'];
  }
  input.exercises.forEach((e, i) => {
    const oe = out.exercises[i];
    if (oe.sets.length !== e.sets.length) v.push(`exercise ${i} set count changed`);
    e.sets.forEach((s, j) => {
      for (const f of Object.keys(s)) {
        if (!same(s[f], oe.sets[j]?.[f])) v.push(`exercise ${i} set ${j} ${f} changed`);
      }
    });
  });
  for (const f of ['startTime', 'elapsed', 'planCtx']) {
    if (!same(input[f], out[f])) v.push(`active workout ${f} changed`);
  }
  return v;
}

/**
 * Run every invariant over every fixture. Store migrations apply to store documents only; the
 * active-workout blob has its own (separate) list, `activeMigrations`, empty until T10.
 * Returns [{fixture, violations}] for failures only. A thrown error counts as a violation.
 */
export function checkInvariants(migrations, fixtures = loadAllFixtures(), activeMigrations = []) {
  const failures = [];
  for (const fx of fixtures) {
    let violations;
    try {
      const doc = toStoreDoc(fx);
      violations = doc
        ? documentViolations(migrations, doc)
        : fx.file.startsWith('hb_active_workout')
          ? activeWorkoutViolations(activeMigrations, fx.data)
          : [`fixture ${fx.file} is neither a store document nor an active workout`];
    } catch (err) {
      violations = [`threw: ${err.message}`];
    }
    if (violations.length) failures.push({ fixture: `${fx.dir}/${fx.file}`, violations });
  }
  return failures;
}
