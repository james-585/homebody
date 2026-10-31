// Migration-test harness (T1). Later tasks (T6, T10, T12) only add migrations to MIGRATIONS and
// call `checkInvariants`; the invariants below must hold for every fixture in
// tests/fixtures/legacy/ and tests/fixtures/synthetic/.
//
// Migration contract (ADR 0002): a pure function object { from, to, migrate(doc) } returning a new
// document, with no I/O and no clock. The document carries its version in `schemaVersion`
// (absent means 1, the shipped format). The runner applies migrations in order and never mutates
// its input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SYNTHETIC_DIR,
  listFiles,
  loadAllFixtures,
  stripHeader,
} from './helpers/load-fixtures.mjs';

/** The real migrations. Empty in T1: schema 1 is the shipped format. */
export const MIGRATIONS = [];

export const getVersion = (doc) => doc.schemaVersion ?? 1;

/** Apply every migration whose `from` equals the current version, in order. Pure; clones input. */
export function applyMigrations(migrations, doc) {
  let cur = structuredClone(doc);
  const ordered = [...migrations].sort((a, b) => a.from - b.from);
  for (const m of ordered) {
    if (getVersion(cur) === m.from) {
      cur = m.migrate(structuredClone(cur));
      if (getVersion(cur) !== m.to) cur.schemaVersion = m.to;
    }
  }
  return cur;
}

const SET_FIELDS = ['sets', 'reps', 'weight', 'time', 'trackType'];

/** True if every own key of `a` is present in `b` (values are not compared). */
function keysKept(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return true;
  return b && typeof b === 'object' && Object.keys(a).every((k) => k in b);
}

/** Fixtures that are a stored store document (the `workouts`/`personalRecords`/... blob). */
export function toStoreDoc(fixture) {
  const d = fixture.data;
  return d && Array.isArray(d.workouts) ? stripHeader(d) : null;
}

/** Invariants for one store document. Returns a list of human-readable violations. */
export function documentViolations(migrations, input) {
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
  const afterIds = new Set(ids);
  for (const w of before) if (!afterIds.has(w.id)) v.push(`workout ${w.id} lost`);

  const byId = new Map(after.map((w) => [w.id, w]));
  for (const w of before) {
    const o = byId.get(w.id);
    if (!o) continue;
    // workout-level scalars and unknown fields
    if (!keysKept(w, o)) v.push(`workout ${w.id} lost a field`);
    for (const f of [
      'date',
      'totalVolume',
      'totalSets',
      'calories',
      'duration',
      'bodyWeight',
      'rpe',
      'notes',
    ]) {
      if (f in w && JSON.stringify(w[f]) !== JSON.stringify(o[f]))
        v.push(`workout ${w.id}.${f} changed`);
    }
    if (o.exercises.length !== w.exercises.length) {
      v.push(`workout ${w.id} exercise count ${w.exercises.length} -> ${o.exercises.length}`);
      continue;
    }
    w.exercises.forEach((e, i) => {
      const oe = o.exercises[i];
      for (const f of SET_FIELDS) {
        if (f in e && JSON.stringify(e[f]) !== JSON.stringify(oe[f])) {
          v.push(
            `workout ${w.id} entry ${i} ${f}: ${JSON.stringify(e[f])} -> ${JSON.stringify(oe[f])}`,
          );
        }
      }
      if (!keysKept(e, oe)) v.push(`workout ${w.id} entry ${i} lost a field`);
    });
  }

  // top level keys and unknown fields on other records
  for (const k of Object.keys(input)) if (!(k in out)) v.push(`top-level key ${k} lost`);
  if (input.profile && !keysKept(input.profile, out.profile)) v.push('profile lost a field');
  for (const key of ['bodyMetrics', 'userPlans']) {
    (input[key] ?? []).forEach((r, i) => {
      if (!keysKept(r, out[key]?.[i])) v.push(`${key}[${i}] lost a field`);
    });
  }
  if ((out.bodyMetrics ?? []).length !== (input.bodyMetrics ?? []).length)
    v.push('bodyMetrics rows lost');
  if ((out.userPlans ?? []).length !== (input.userPlans ?? []).length) v.push('userPlans lost');
  if ((out.favourites ?? []).length < (input.favourites ?? []).length) v.push('favourites lost');
  if (
    Object.keys(out.personalRecords ?? {}).length === 0 &&
    Object.keys(input.personalRecords ?? {}).length > 0
  ) {
    v.push('personal records lost');
  }

  // idempotence: running the chain again changes nothing
  const twice = applyMigrations(migrations, out);
  if (JSON.stringify(twice) !== JSON.stringify(out))
    v.push('not idempotent: second run changed the document');
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
        if (JSON.stringify(s[f]) !== JSON.stringify(oe.sets[j]?.[f]))
          v.push(`exercise ${i} set ${j} ${f} changed`);
      }
    });
  });
  for (const f of ['startTime', 'elapsed', 'planCtx']) {
    if (JSON.stringify(input[f]) !== JSON.stringify(out[f])) v.push(`active workout ${f} changed`);
  }
  return v;
}

/**
 * Run every invariant over every fixture. Store migrations apply to store documents only; the
 * active-workout blob has its own (separate) list, `activeMigrations`, empty until T10.
 * Returns [{fixture, violations}] for failures only. */
export function checkInvariants(migrations, fixtures = loadAllFixtures(), activeMigrations = []) {
  const failures = [];
  for (const fx of fixtures) {
    const doc = toStoreDoc(fx);
    const violations = doc
      ? documentViolations(migrations, doc)
      : fx.file.startsWith('hb_active_workout')
        ? activeWorkoutViolations(activeMigrations, fx.data)
        : [`fixture ${fx.file} is neither a store document nor an active workout`];
    if (violations.length) failures.push({ fixture: `${fx.dir}/${fx.file}`, violations });
  }
  return failures;
}

test('there are fixtures to run against, from both folders', () => {
  const all = loadAllFixtures();
  assert.ok(all.some((f) => f.dir === 'legacy'));
  for (const name of ['homebody_v1', 'homebody_v0', 'vaultfit_v0', 'hb_active_workout']) {
    assert.ok(
      all.some((f) => f.dir === 'synthetic' && f.file === `${name}.json`),
      `${name} synthetic fixture`,
    );
  }
});

test('all invariants hold for every fixture with the real migration list', () => {
  assert.deepEqual(checkInvariants(MIGRATIONS), []);
});

test('with an empty list every document comes back identical (schema 1 is untouched)', () => {
  for (const fx of loadAllFixtures()) {
    const doc = toStoreDoc(fx) ?? fx.data;
    assert.deepEqual(applyMigrations([], doc), doc, fx.file);
  }
});

test('the synthetic active workout has a unilateral exercise with doneL/doneR', () => {
  const fx = loadAllFixtures().find((f) => f.file === 'hb_active_workout.json');
  const uni = fx.data.exercises.find((e) => e.unilateral);
  assert.ok(uni, 'unilateral exercise present');
  assert.ok(uni.sets.every((s) => 'doneL' in s && 'doneR' in s));
});

test('every synthetic fixture has a README entry', () => {
  const readme = readFileSync(join(SYNTHETIC_DIR, 'README.md'), 'utf8');
  for (const f of listFiles(SYNTHETIC_DIR).filter((n) => n.endsWith('.json'))) {
    assert.ok(
      readme.includes('`' + f + '`'),
      `${f} is described in tests/fixtures/synthetic/README.md`,
    );
  }
});

// ---- the harness must be able to fail --------------------------------------------------------

const bump = { from: 1, to: 2, migrate: (d) => ({ ...d, schemaVersion: 2 }) };
const lossy = {
  dropsAWorkout: { from: 1, to: 2, migrate: (d) => ({ ...d, workouts: d.workouts.slice(1) }) },
  changesAWeight: {
    from: 1,
    to: 2,
    migrate: (d) => ({
      ...d,
      workouts: d.workouts.map((w) => ({
        ...w,
        exercises: w.exercises.map((e) => ({ ...e, weight: (e.weight ?? 0) + 1 })),
      })),
    }),
  },
  dropsUnknownField: {
    from: 1,
    to: 2,
    migrate: (d) => ({ ...d, workouts: d.workouts.map(({ rpe, ...rest }) => rest) }), // eslint-disable-line no-unused-vars
  },
  duplicatesId: {
    from: 1,
    to: 2,
    migrate: (d) => ({ ...d, workouts: d.workouts.map((w) => ({ ...w, id: 1 })) }),
  },
  notIdempotent: {
    from: 1,
    to: 1,
    migrate: (d) => ({
      ...d,
      workouts: d.workouts.map((w) => ({ ...w, totalSets: w.totalSets ?? 0 })),
      counter: (d.counter ?? 0) + 1,
    }),
  },
};

test('negative self-test: a benign additive migration passes', () => {
  assert.deepEqual(checkInvariants([bump]), []);
});

for (const [name, m] of Object.entries(lossy)) {
  test(`negative self-test: the harness fails a migration that ${name}`, () => {
    const failures = checkInvariants([m]);
    assert.ok(failures.length > 0, `${name} should have been caught`);
  });
}

test('negative self-test: a migration that drops a field from the active workout is caught', () => {
  const fx = loadAllFixtures().filter((f) => f.file === 'hb_active_workout.json');
  const dropsElapsed = { from: 1, to: 2, migrate: ({ elapsed, ...rest }) => rest }; // eslint-disable-line no-unused-vars
  assert.ok(checkInvariants([], fx, [dropsElapsed]).length > 0);
});

// ---- not provable until a runner exists ------------------------------------------------------

test(
  'corrupt JSON blob fails safe and never overwrites the stored value',
  { todo: 'needs the migration runner (T5/T6)' },
  () => {
    assert.fail('pending runner');
  },
);

test(
  'future-version blob fails safe and never overwrites the stored value',
  { todo: 'needs the migration runner (T5/T6)' },
  () => {
    assert.fail('pending runner');
  },
);
