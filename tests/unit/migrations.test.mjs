// Migration-test harness checks (T1). The harness itself lives in helpers/migration-harness.mjs so
// later tests can import it without re-running these tests. Later tasks (T6, T10, T12) add real
// migrations to MIGRATIONS below; every invariant must then hold for every fixture in
// tests/fixtures/legacy/ and tests/fixtures/synthetic/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNTHETIC_DIR, listFiles, loadAllFixtures } from './helpers/load-fixtures.mjs';
import { createStore, MIGRATIONS } from './helpers/hb-storage.mjs';
import { createLocalEngine } from './helpers/hb-storage.mjs';
import { FakeStorage } from './helpers/fake-storage.mjs';
import { applyMigrations, checkInvariants, toStoreDoc } from './helpers/migration-harness.mjs';

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

/** Build a fake 1->2 migration that applies `fn` and bumps the version, as a real one must. */
const fake = (fn, changes) => ({
  from: 1,
  to: 2,
  changes,
  migrate: (d) => ({ ...fn(d), schemaVersion: 2 }),
});
const mapWorkouts = (d, f) => ({ ...d, workouts: d.workouts.map(f) });
const mapEntries = (d, f) =>
  mapWorkouts(d, (w) => ({ ...w, exercises: w.exercises.map((e) => f(e)) }));

const lossy = {
  dropsAWorkout: fake((d) => ({ ...d, workouts: d.workouts.slice(1) })),
  changesAWeight: fake((d) => mapEntries(d, (e) => ({ ...e, weight: (e.weight ?? 0) + 1 }))),
  dropsAnUnknownWorkoutField: fake((d) => mapWorkouts(d, ({ rpe, ...rest }) => rest)), // eslint-disable-line no-unused-vars
  changesAnUnknownWorkoutFieldValue: fake((d) =>
    mapWorkouts(d, (w) => ('notes' in w ? { ...w, notes: w.notes + '!' } : { ...w, rpe: 1 })),
  ),
  duplicatesId: fake((d) => mapWorkouts(d, (w) => ({ ...w, id: 1 }))),
  deletesOnePersonalRecordKey: fake((d) => {
    const { [Object.keys(d.personalRecords)[0]]: _gone, ...rest } = d.personalRecords; // eslint-disable-line no-unused-vars
    return { ...d, personalRecords: rest };
  }),
  zeroesPersonalRecordValues: fake((d) => ({
    ...d,
    personalRecords: Object.fromEntries(
      Object.entries(d.personalRecords).map(([k, p]) => [k, { ...p, value: 0 }]),
    ),
  })),
  changesAPersonalRecordUnit: fake((d) => ({
    ...d,
    personalRecords: Object.fromEntries(
      Object.entries(d.personalRecords).map(([k, p]) => [k, { ...p, unit: 'lb' }]),
    ),
  })),
  changesEntrySide: fake((d) =>
    mapEntries(d, (e) => (e.side ? { ...e, side: e.side === 'Left' ? 'Right' : 'Left' } : e)),
  ),
  changesEntryName: fake((d) => mapEntries(d, (e) => ({ ...e, name: e.name + ' x' }))),
  overwritesBodyMetricValues: fake((d) => ({
    ...d,
    bodyMetrics: d.bodyMetrics.map((r) => ({ ...r, weight: 0 })),
  })),
  changesProfile: fake((d) => ({ ...d, profile: { ...d.profile, weight: 1 } })),
  changesAPlan: fake((d) => ({
    ...d,
    userPlans: d.userPlans.map((p) => ({ ...p, name: 'renamed' })),
  })),
  dropsFavourites: fake((d) => ({ ...d, favourites: [] })),
  notIdempotent: {
    from: 1,
    to: 1,
    migrate: (d) => ({ ...d, counter: (d.counter ?? 0) + 1 }),
  },
  doesNotBumpTheVersion: { from: 1, to: 2, migrate: (d) => d },
};

test('negative self-test: a benign additive migration passes', () => {
  const additive = fake((d) =>
    mapEntries({ ...d, extra: true }, (e) => ({ ...e, exerciseId: 'x' })),
  );
  assert.deepEqual(checkInvariants([additive]), []);
});

for (const [name, m] of Object.entries(lossy)) {
  test(`negative self-test: the harness fails a migration that ${name}`, () => {
    const failures = checkInvariants([m]);
    assert.ok(failures.length > 0, `${name} should have been caught`);
  });
}

test('negative self-test: a field dropped from the active workout is caught', () => {
  const fx = loadAllFixtures().filter((f) => f.file === 'hb_active_workout.json');
  const dropsElapsed = fake(({ elapsed, ...rest }) => rest); // eslint-disable-line no-unused-vars
  assert.ok(checkInvariants([], fx, [dropsElapsed]).length > 0);
});

test('declared changes relax only what they name', () => {
  const renames = fake(
    (d) => mapEntries(d, (e) => ({ ...e, name: e.name + ' x' })),
    ['entry.name'],
  );
  assert.deepEqual(checkInvariants([renames]), [], 'declared entry.name rewrite passes');

  // declaring entry.name does not excuse any other loss
  const renamesAndDrops = fake(
    (d) => ({ ...mapEntries(d, (e) => ({ ...e, name: e.name + ' x' })), workouts: [] }),
    ['entry.name'],
  );
  assert.ok(checkInvariants([renamesAndDrops]).length > 0);

  const rekeys = fake(
    (d) => ({
      ...d,
      personalRecords: Object.fromEntries(
        Object.entries(d.personalRecords).map(([k, p]) => [k.toLowerCase(), p]),
      ),
    }),
    ['personalRecords'],
  );
  assert.deepEqual(checkInvariants([rekeys]), [], 'declared personalRecords rewrite passes');
});

// ---- the real runner refuses unreadable data and never overwrites it ------------------------

for (const [name, raw] of [
  ['corrupt JSON', '{"workouts": [truncated'],
  ['future-version', JSON.stringify({ workouts: [], schemaVersion: 99 })],
]) {
  test(`${name} blob fails safe and never overwrites the stored value`, async () => {
    const fs = new FakeStorage({ vaultfit_v1: raw });
    const store = createStore({ openEngines: [() => createLocalEngine(fs)] });
    await store.load();
    await assert.rejects(store.save({ workouts: [{ id: 1 }] }));
    assert.equal(fs.getItem('vaultfit_v1'), raw, 'stored string is byte-identical');
    assert.deepEqual(fs.log, [], 'nothing was written or removed');
  });
}
