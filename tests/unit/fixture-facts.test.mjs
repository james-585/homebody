// Pins the measured facts of the real-shape fixture (docs/plans/m1.md, T1 plan). If the fixture
// or those docs drift, this fails; neither is edited to agree with the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { FIXTURES_ROOT, LEGACY_DIR, listFiles, loadRealExport } from './helpers/load-fixtures.mjs';

const SUFFIX = / \((Left|Right)\)$/;
const base = (name) => name.replace(SUFFIX, '');

/** The shipped EXERCISES library, evaluated from the array literal in index.html (no execution of app code). */
function loadLibraryNames() {
  const html = readFileSync(join(FIXTURES_ROOT, '..', '..', 'index.html'), 'utf8');
  const start = html.indexOf('const EXERCISES = [');
  assert.notEqual(start, -1, 'EXERCISES not found in index.html');
  const open = html.indexOf('[', start);
  let depth = 0;
  let close = open;
  for (; close < html.length; close++) {
    if (html[close] === '[') depth++;
    else if (html[close] === ']' && --depth === 0) break;
  }
  const lib = vm.runInNewContext('(' + html.slice(open, close + 1) + ')');
  return new Set(lib.map((e) => e.name));
}

const data = loadRealExport();
const entries = data.workouts.flatMap((w) => w.exercises);

test('the legacy folder contains only the known real sample and its README', () => {
  assert.deepEqual(listFiles(LEGACY_DIR), ['README.md', 'vaultfit_v1_export.sanitized.json']);
});

test('export header', () => {
  assert.equal(data._vaultfit, true);
  assert.equal(data._version, 1);
  assert.deepEqual(Object.keys(data), [
    '_vaultfit',
    '_version',
    '_exported',
    '_name',
    'workouts',
    'personalRecords',
    'bodyMetrics',
    'userPlans',
    'profile',
    'favourites',
  ]);
});

test('workout counts and the three record shapes', () => {
  assert.equal(data.workouts.length, 149);
  const withBoth = data.workouts.filter((w) => 'notes' in w && 'rpe' in w);
  const rpeOnly = data.workouts.filter((w) => !('notes' in w) && 'rpe' in w);
  const neither = data.workouts.filter((w) => !('notes' in w) && !('rpe' in w));
  assert.deepEqual([withBoth.length, rpeOnly.length, neither.length], [99, 26, 24]);
  assert.equal(new Set(data.workouts.map((w) => w.id)).size, 149, 'workout ids are unique');
});

test('exercise entries, suffixes and side encoding', () => {
  assert.equal(entries.length, 1377);
  const suffixed = entries.filter((e) => SUFFIX.test(e.name));
  assert.equal(suffixed.length, 474);
  const withSide = suffixed.filter((e) => 'bilateral' in e || 'side' in e);
  const suffixOnly = suffixed.filter((e) => !('bilateral' in e) && !('side' in e));
  assert.equal(withSide.length, 248);
  assert.equal(suffixOnly.length, 226);
  // bilateral and side always travel together, and only on suffixed entries
  assert.equal(entries.filter((e) => 'bilateral' in e || 'side' in e).length, 248);
  assert.ok(withSide.every((e) => 'bilateral' in e && 'side' in e));

  // L/R pairs: a Left entry directly followed by the matching Right entry in the same workout
  let pairs = 0;
  for (const w of data.workouts) {
    w.exercises.forEach((e, i) => {
      const next = w.exercises[i + 1];
      if (/ \(Left\)$/.test(e.name) && next && next.name === base(e.name) + ' (Right)') pairs++;
    });
  }
  assert.equal(pairs, 237);
});

test('entry field shapes', () => {
  const shapes = new Map();
  for (const e of entries) {
    const k = Object.keys(e).sort().join(',');
    shapes.set(k, (shapes.get(k) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(shapes), {
    'bilateral,name,reps,sets,side,time,trackType,weight': 248,
    'name,reps,sets,time,trackType,weight': 1129,
  });
});

test('orphans: names in the data that the current library does not have', () => {
  const lib = loadLibraryNames();
  assert.equal(lib.size, 236, 'library size');
  const historyBases = [...new Set(entries.map((e) => base(e.name)))];
  const orphanNames = historyBases.filter((n) => !lib.has(n)).sort();
  assert.equal(orphanNames.length, ORPHANS_IN_HISTORY.length);
  assert.deepEqual(orphanNames, ORPHANS_IN_HISTORY);

  const orphanEntries = entries.filter((e) => !lib.has(base(e.name)));
  assert.equal(orphanEntries.length, ORPHAN_ENTRIES);
  const orphanWorkouts = data.workouts.filter((w) =>
    w.exercises.some((e) => !lib.has(base(e.name))),
  );
  assert.equal(orphanWorkouts.length, ORPHAN_WORKOUTS);

  const prOrphans = Object.keys(data.personalRecords)
    .filter((n) => !lib.has(base(n)))
    .sort();
  const withPr = [...new Set([...orphanNames, ...prOrphans])].sort();
  assert.deepEqual(withPr, ORPHANS_WITH_PR_KEYS);
});

test('personal records, body metrics, plans, profile, favourites', () => {
  const prs = Object.entries(data.personalRecords);
  assert.equal(prs.length, PR_KEY_COUNT);
  assert.deepEqual(
    prs.reduce((m, [, v]) => ((m[v.unit] = (m[v.unit] ?? 0) + 1), m), {}),
    PR_UNITS,
  );
  assert.equal(data.bodyMetrics.length, 7);
  assert.ok(
    data.bodyMetrics.some((r) => Object.values(r).includes(null)),
    'body rows include nulls',
  );
  assert.equal(data.userPlans.length, 1);
  assert.ok('_progressionLog' in data.userPlans[0]);
  assert.equal(data.userPlans[0].planDays.length, 8);
  assert.deepEqual(data.profile.equipment, { dumbbells: [5, 10], kettlebells: [10, 16] });
  assert.deepEqual(data.favourites, []);
});

// Measured values. m1.md and the fixture README say 10 orphan names in history and 11 counting PR
// keys (measured here: the same). The T1 plan also lists "12 PRs"; the fixture holds 74 PR keys
// (70 kg, 4 sec), so 74 is pinned and the "12" is flagged to the human rather than edited.
const ORPHANS_IN_HISTORY = [
  'Bodyweight Lunge',
  'DB Curl',
  'DB Floor Fly',
  'DB Floor Tate Press',
  'DB Single-Leg Calf Raise',
  'DB Sumo Squat with Capf Raise',
  'KB Front Raise',
  'KB Glute Bridge',
  'KB Romanian Deadlift',
  'Sit up',
];
const ORPHAN_ENTRIES = 87;
const ORPHAN_WORKOUTS = 56;
const ORPHANS_WITH_PR_KEYS = [...ORPHANS_IN_HISTORY, 'KB Lateral Raise'].sort();
const PR_KEY_COUNT = 74;
const PR_UNITS = { kg: 70, sec: 4 };
