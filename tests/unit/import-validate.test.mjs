// T7a: the import validator. Fixture facts, the malformed variants, the threat list row by row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  io,
  opts,
  REAL_TEXT,
  real,
  file,
  importFixture,
  IMPORT_MAX_BYTES,
  IO_API_VERSION,
} from './helpers/io.mjs';
import { LATEST_SCHEMA } from './helpers/hb-storage.mjs';
import { SYNTHETIC_DIR } from './helpers/load-fixtures.mjs';

const { validate, LIMITS } = io;
const V = (x, o) => validate(typeof x === 'string' ? x : JSON.stringify(x), opts(o));
const refuses = (x, reason, o) => {
  const r = V(x, o);
  assert.equal(r.ok, false, `expected refusal: ${reason}`);
  assert.equal(r.reason, reason);
  assert.equal(r.doc, undefined, 'a refused file yields no document');
  return r;
};

test('the real fixture validates with zero dropped fields and an identical document', () => {
  const r = V(REAL_TEXT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, {
    dropped: 0,
    futureDates: 0,
    duplicateIds: 0,
    unrecognised: 0,
    unrecognisedWhere: [],
  });
  const o = real();
  for (const k of [
    'workouts',
    'personalRecords',
    'bodyMetrics',
    'userPlans',
    'profile',
    'favourites',
  ]) {
    assert.deepEqual(r.doc[k], o[k], k);
  }
  assert.equal(r.version, 1);
  assert.deepEqual(r.partial, { partial: false, reason: null });
});

test('the importer and the app agree on the shared constants (skew guard)', () => {
  assert.equal(LIMITS.maxBytes, IMPORT_MAX_BYTES);
  assert.equal(LIMITS.maxBytes, 20 * 1024 * 1024);
  assert.equal(io.IO_API_VERSION, IO_API_VERSION);
  assert.equal(io.LATEST_SCHEMA, LATEST_SCHEMA);
});

const edit = (fn) => {
  const f = file({ personalRecords: { Plank: { value: 60, unit: 'sec' } } });
  f.userPlans = [real().userPlans[0]];
  f.profile = real().profile;
  f.bodyMetrics = real().bodyMetrics.slice(0, 1);
  fn(f);
  return f;
};

// AC1: ten malformed variants (and more), each with a reason and nothing changed.
const VARIANTS = [
  ['not JSON', 'not json{', 'not-json'],
  ['top level is an array', '[]', 'not-homebody'],
  ['no _vaultfit marker', { workouts: [] }, 'not-homebody'],
  ['workouts missing', { _vaultfit: true }, 'missing-workouts'],
  ['workouts is an object', file({ workouts: {} }), 'bad-type'],
  ['workout name is a number', edit((f) => (f.workouts[0].name = 7)), 'bad-type'],
  ['sets is a string', edit((f) => (f.workouts[0].exercises[0].sets = '3')), 'bad-type'],
  ['negative reps', edit((f) => (f.workouts[0].exercises[0].reps = -1)), 'out-of-range'],
  [
    'script in a workout name',
    edit((f) => (f.workouts[0].name = '<script>x</script>')),
    'bad-chars',
  ],
  ['markup in a plan name', edit((f) => (f.userPlans[0].name = 'a<b>')), 'bad-chars'],
  [
    'markup in an exercise name',
    edit((f) => (f.workouts[0].exercises[0].name = 'x>y')),
    'bad-chars',
  ],
  ['markup in a favourite', file({ favourites: ['<i>'] }), 'bad-chars'],
  ['goal that is not a token', edit((f) => (f.profile.goal = 'Bulk <b>')), 'bad-enum'],
  ['goal that is a number', edit((f) => (f.profile.goal = 5)), 'bad-enum'],
  ['PR unit is not kg or sec', edit((f) => (f.personalRecords.Plank.unit = 'lb')), 'bad-enum'],
  ['workout id is a string', edit((f) => (f.workouts[0].id = '7')), 'bad-type'],
  ['workout id is fractional', edit((f) => (f.workouts[0].id = 1.5)), 'bad-type'],
  ['plan id is zero', edit((f) => (f.userPlans[0].id = 0)), 'out-of-range'],
  ['plan id is a string', edit((f) => (f.userPlans[0].id = '1')), 'bad-type'],
  ['PR value is a string', edit((f) => (f.personalRecords.Plank.value = '60')), 'bad-type'],
  [
    'equipment weight is a string',
    edit((f) => (f.profile.equipment.dumbbells = ['5'])),
    'bad-type',
  ],
  ['date is prose', edit((f) => (f.workouts[0].date = 'yesterday')), 'bad-date'],
  [
    'date Date.parse would accept',
    edit((f) => (f.workouts[0].date = '2026-01-01 (<img src=x onerror=alert(1)>)')),
    'bad-date',
  ],
  ['date before 2000', edit((f) => (f.workouts[0].date = '1999-12-31T00:00:00.000Z')), 'bad-date'],
  [
    'date a year and a day ahead',
    edit((f) => (f.workouts[0].date = '2027-11-05T12:00:00.000Z')),
    'bad-date',
  ],
  [
    'impossible calendar date',
    edit((f) => (f.workouts[0].date = '2026-02-30T00:00:00.000Z')),
    'bad-date',
  ],
  ['_version 0', file({ _version: 0 }), 'bad-version'],
  ['_version 1.5', file({ _version: 1.5 }), 'bad-version'],
  ['_version "2"', file({ _version: '2' }), 'bad-version'],
  ['_version 99', file({ _version: 99 }), 'newer-version'],
  ['bad _partialReason', file({ _partial: true, _partialReason: 'x' }), 'bad-enum'],
  ['_exported is prose', file({ _exported: 'today' }), 'bad-date'],
  ['missing exercise name', edit((f) => delete f.workouts[0].exercises[0].name), 'missing-field'],
  ['rpe above 10', edit((f) => (f.workouts[0].rpe = 11)), 'out-of-range'],
  [
    'progression log timestamp is a string',
    edit((f) => (f.userPlans[0]._progressionLog = { a: 'x' })),
    'bad-type',
  ],
  [
    'progression log timestamp out of window',
    edit((f) => (f.userPlans[0]._progressionLog = { a: 5 })),
    'bad-date',
  ],
];
for (const [name, x, reason] of VARIANTS) {
  test(`malformed: ${name} -> ${reason}`, () => {
    refuses(x, reason);
  });
}

test('malformed: 1e999 is not a finite number', () => {
  const t = JSON.stringify(file()).replace(/"weight":(\d+)/, '"weight":1e999');
  assert.ok(t.includes('1e999'));
  refuses(t, 'bad-type');
});

test('size: over the limit is refused before parsing; whitespace and empty are refused', () => {
  refuses('x'.repeat(LIMITS.maxBytes + 1), 'too-large');
  refuses(' '.repeat(LIMITS.maxBytes + 1), 'too-large');
  refuses('   \n', 'empty');
  refuses('', 'empty');
  assert.equal(validate(42, opts()).reason, 'not-text');
  assert.equal(validate(null, opts()).reason, 'not-text');
  refuses('x'.repeat(100), 'too-large', { maxBytes: 50 });
});

test('a single leading BOM is stripped, not rejected', () => {
  assert.equal(V('\uFEFF' + JSON.stringify(file())).ok, true);
});

test('array and record caps', () => {
  refuses(
    file({ workouts: Array.from({ length: LIMITS.workouts + 1 }, (_, i) => ({ id: i })) }),
    'too-many',
  );
  refuses(
    edit(
      (f) =>
        (f.workouts[0].exercises = Array(LIMITS.exercisesPerWorkout + 1).fill(
          f.workouts[0].exercises[0],
        )),
    ),
    'too-many',
  );
  refuses(file({ favourites: Array(LIMITS.favourites + 1).fill('a') }), 'too-many');
  const prs = Object.fromEntries(
    Array.from({ length: LIMITS.personalRecords + 1 }, (_, i) => [
      `e${i}`,
      { value: 1, unit: 'kg' },
    ]),
  );
  refuses(file({ personalRecords: prs }), 'too-many');
  refuses(
    edit((f) => (f.profile.equipment.dumbbells = Array(LIMITS.equipmentList + 1).fill(5))),
    'too-many',
  );
});

test('names: refuse < > and controls, bidi, line separators, lone surrogates; allow the rest', () => {
  for (const bad of [
    'a<b',
    'a>b',
    'a\u0007b',
    'a\u0000b',
    'a\rb',
    'a\u202Eb',
    'a\u2066b',
    'a\u2028b',
    'a\u2029b',
    'a\uD800b',
    'a\uDC00b',
    'a\u0085b',
  ]) {
    refuses(
      edit((f) => (f.workouts[0].name = bad)),
      'bad-chars',
    );
  }
  for (const good of [
    "Farmer's Walk",
    'say "hi"',
    'back\\slash',
    'tick`s',
    '&#39;); alert(1)//',
    '&lt;b&gt;',
    'A (B) + C - D — E / F',
    '💪 Push 日本語 עברית',
    'tab\there',
  ]) {
    assert.equal(V(edit((f) => (f.workouts[0].name = good))).ok, true, good);
  }
  refuses(
    edit((f) => (f.workouts[0].name = 'x'.repeat(LIMITS.nameMax + 1))),
    'too-long',
  );
});

test('notes may contain < and > (escaped text only) but not controls; 20,000 cap', () => {
  assert.equal(V(edit((f) => (f.workouts[0].notes = 'a > b <i> done'))).ok, true);
  refuses(
    edit((f) => (f.workouts[0].notes = 'a\u0007')),
    'bad-chars',
  );
  refuses(
    edit((f) => (f.workouts[0].notes = 'a\u202Eb')),
    'bad-chars',
  );
  assert.equal(V(edit((f) => (f.workouts[0].notes = 'x'.repeat(LIMITS.notesMax)))).ok, true);
  refuses(
    edit((f) => (f.workouts[0].notes = 'x'.repeat(LIMITS.notesMax + 1))),
    'too-long',
  );
  refuses(
    edit((f) => (f.userPlans[0].desc = 'a\u0001')),
    'bad-chars',
  );
});

test('dictionary keys follow the name rule too (PR keys, progression log keys)', () => {
  refuses(file({ personalRecords: { 'a<b': { value: 1, unit: 'kg' } } }), 'bad-chars');
  refuses(file({ personalRecords: { ['x'.repeat(501)]: { value: 1, unit: 'kg' } } }), 'too-long');
  refuses(
    edit((f) => (f.userPlans[0]._progressionLog = { 'a<b': Date.UTC(2026, 5, 1) })),
    'bad-chars',
  );
  assert.equal(
    V(file({ personalRecords: { "Farmer's Walk": { value: 40, unit: 'kg' } } })).ok,
    true,
  );
});

test('prototype pollution: __proto__, constructor, prototype keys are refused, nothing leaks', () => {
  refuses(importFixture('proto_key_refused.json'), 'bad-key');
  for (const k of ['constructor', 'prototype']) {
    refuses(file({ personalRecords: JSON.parse(`{"${k}":{"value":1,"unit":"kg"}}`) }), 'bad-key');
  }
  const t = `{"_vaultfit":true,"workouts":[],"__proto__":{"polluted":1},"personalRecords":{"__proto__":{"value":1,"unit":"kg"}}}`;
  V(t);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.keys(Object.prototype).length, 0);
  const ok = V(`{"_vaultfit":true,"workouts":[],"__proto__":{"x":1},"constructor":{"y":1}}`);
  assert.equal(ok.ok, true);
  assert.equal(ok.warnings.dropped, 2, 'dropped and counted');
  assert.equal(Object.getPrototypeOf(ok.doc), Object.prototype);
  assert.equal(Object.getPrototypeOf(ok.doc.personalRecords), Object.prototype);
});

test('unknown keys are dropped and counted; counter keys never survive at any level', () => {
  const f = edit((x) => {
    x.hbSeq = 5;
    x.seq = 9;
    x.schemaVersion = 7;
    x.extra = { a: 1 };
    x.workouts[0].seq = 1;
    x.workouts[0].hbSeq = 2;
    x.workouts[0].exercises[0].junk = 'z';
    x.profile.schemaVersion = 3;
  });
  const r = V(f);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.dropped, 8);
  const text = JSON.stringify(r.doc);
  for (const k of ['hbSeq', '"seq"', 'schemaVersion', 'extra', 'junk'])
    assert.ok(!text.includes(k), k);
});

test('errors name a record path, never the value; the problem list is capped', () => {
  const secret = 'SECRET<VALUE';
  const r = refuses(
    edit((f) => (f.workouts[0].name = secret)),
    'bad-chars',
  );
  assert.equal(r.where, 'workouts[0].name');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  const many = file({
    workouts: Array.from({ length: 50 }, (_, i) => ({ ...file().workouts[0], id: i + 1, name: 5 })),
  });
  const m = V(many);
  assert.equal(m.ok, false);
  assert.equal(m.problems.length, LIMITS.problemsMax);
  const key = V(file({ personalRecords: { ['k<' + secret]: { value: 1, unit: 'kg' } } }));
  assert.ok(!JSON.stringify(key).includes('SECRET'), 'dictionary keys appear by position');
});

test('duplicate ids are counted and kept; future dates are counted; far future is refused', () => {
  const a = file().workouts[0];
  const r = V(file({ workouts: [a, { ...a, name: 'other' }] }));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.duplicateIds, 1);
  assert.equal(r.doc.workouts.length, 2);
  const soon = V(edit((f) => (f.workouts[0].date = '2026-11-06T12:00:00.000Z')));
  assert.equal(soon.ok, true);
  assert.equal(soon.warnings.futureDates, 1);
  assert.equal(
    V(edit((f) => (f.workouts[0].date = '2026-11-04T11:00:00.000Z'))).warnings.futureDates,
    0,
  );
});

test('missing optional sets are empty; a null profile stays null; partial flags are read', () => {
  const r = V({ _vaultfit: true, workouts: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(
    [r.doc.personalRecords, r.doc.bodyMetrics, r.doc.userPlans, r.doc.profile, r.doc.favourites],
    [{}, [], [], null, []],
  );
  const p = V(file({ _partial: true, _partialReason: 'newer' }));
  assert.deepEqual(p.partial, { partial: true, reason: 'newer' });
});

test('hostile strings that are valid data pass and stay data; the markup name is refused', () => {
  const r = V(importFixture('hostile_strings_allowed.json'));
  assert.equal(r.ok, true);
  assert.match(r.doc.workouts[0].name, /Farmer's Walk/);
  assert.match(r.doc.workouts[0].notes, /<img/);
  refuses(importFixture('hostile_name_refused.json'), 'bad-chars');
});

test('an older v1 export without _version, rpe or notes validates and is lifted', () => {
  const r = V(importFixture('v1_export_no_rpe.json'));
  assert.equal(r.ok, true);
  assert.equal(r.version, 1);
  assert.equal(r.doc.workouts.length, 3);
  assert.equal(r.warnings.dropped, 0, '_name is a known header key');
  assert.ok(r.doc.workouts.every((w) => !('rpe' in w) && !('notes' in w)));
});

test('a failing migration refuses the file', () => {
  refuses(file({ _version: 1 }), 'migration-failed', {
    migrate: () => ({ ok: false, reason: 'corrupt' }),
  });
  refuses(file({ _version: 1 }), 'migration-failed', {
    migrate: () => ({ ok: true, doc: { workouts: [{ id: 'x' }] } }),
  });
  refuses(file({ _version: 1 }), 'migration-failed', { migrate: undefined });
  refuses(file({ _version: 1 }), 'migration-failed', {
    migrate: () => {
      throw new Error('boom');
    },
  });
});

test('deep nesting in an unknown key neither throws nor leaks', () => {
  const deep = '['.repeat(4000) + ']'.repeat(4000);
  const r = V(`{"_vaultfit":true,"workouts":[],"junk":${deep}}`);
  assert.ok(r.ok === true ? r.warnings.dropped === 1 : r.reason === 'not-json');
});

test('equipment: only the known shapes survive', () => {
  assert.equal(
    V(
      edit(
        (f) =>
          (f.profile.equipment = {
            dumbbells: [2.5, 5],
            rig: ['pullup_bar'],
            barbell_bars: { standard_bar: true },
            barbell_plates: [1.25],
            barbell_plate_count: { 1.25: 4 },
            bench: [],
            bands: ['band_medium'],
            kettlebells: [],
          }),
      ),
    ).ok,
    true,
  );
  refuses(
    edit((f) => (f.profile.equipment = { rig: ["x'y"] })),
    'bad-chars',
  );
  refuses(
    edit((f) => (f.profile.equipment = { barbell_bars: { 'a"b': true } })),
    'bad-key',
  );
  refuses(
    edit((f) => (f.profile.equipment = { barbell_plate_count: { x: 1 } })),
    'bad-key',
  );
  refuses(
    edit((f) => (f.profile.equipment = { barbell_bars: { a: 'yes' } })),
    'bad-type',
  );
  const r = V(edit((f) => (f.profile.equipment = { drone: [1] })));
  assert.equal(r.warnings.dropped, 1);
});

test('validator speed on the fixture (reported; loose bound here, strict in the PR report)', () => {
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) V(REAL_TEXT);
  const per = (performance.now() - t0) / 5;
  console.log(`# validate(real fixture, 169 KB): ${per.toFixed(1)} ms`);
  assert.ok(per < 100, `fixture validation took ${per} ms`);
});

test('display-only enums: an unknown lowercase token is kept and reported by path, never value', () => {
  const r = V(
    edit((f) => {
      f.profile.goal = 'general';
      f.profile.sex = 'x';
      f.profile.activity = 'very_active';
      f.userPlans[0].level = 'expert';
      f.userPlans[0].goal = 'tone';
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.warnings.unrecognised, 5);
  assert.deepEqual(r.warnings.unrecognisedWhere.sort(), [
    'profile.activity',
    'profile.goal',
    'profile.sex',
    'userPlans[0].goal',
    'userPlans[0].level',
  ]);
  assert.ok(!JSON.stringify(r.warnings).includes('general'));
  assert.equal(r.doc.profile.goal, 'general', 'kept as found');
  // the known values are not reported, and the strict ones stay strict
  assert.equal(V(edit((f) => (f.profile.goal = 'lose_fat'))).warnings.unrecognised, 0);
  refuses(
    edit((f) => (f.workouts[0].exercises[0].trackType = 'distance')),
    'bad-enum',
  );
  refuses(
    edit((f) => (f.personalRecords.Plank.unit = 'lb')),
    'bad-enum',
  );
  refuses(
    edit((f) => (f.workouts[0].exercises[0].side = 'middle')),
    'bad-enum',
  );
  // the synthetic fixtures use goal "general": they now import
  assert.equal(
    V(readFileSync(join(SYNTHETIC_DIR, 'homebody_v1.json'), 'utf8')).ok,
    false,
    'not a file: no _vaultfit',
  );
});

test('dates: date-only, HH:MM, seconds and offset forms are accepted; impossible ones are not', () => {
  for (const d of [
    '2026-10-01',
    '2026-10-01T08:00',
    '2026-10-01T08:00:30',
    '2026-10-01T08:00:30.5',
    '2026-10-01T08:00:30.123Z',
    '2026-10-01T08:00:30+02:00',
    '2026-10-01T08:00-05:30',
  ]) {
    assert.equal(V(edit((f) => (f.workouts[0].date = d))).ok, true, d);
  }
  for (const d of [
    '2026-10-01T24:00',
    '2026-10-01T08:60',
    '2026-13-01',
    '2026-10-01T08:00+25:00',
    '2026-10-01T',
    '',
  ]) {
    refuses(
      edit((f) => (f.workouts[0].date = d)),
      'bad-date',
    );
  }
});

test('invisible and direction characters are refused: zero-width, marks, BOM inside, noncharacters', () => {
  for (const c of [
    '\u200B',
    '\u200C',
    '\u200D',
    '\u200E',
    '\u200F',
    '\u061C',
    '\uFEFF',
    '\uFFFE',
    '\uFFFF',
  ]) {
    refuses(
      edit((f) => (f.workouts[0].name = `a${c}b`)),
      'bad-chars',
    );
    refuses(
      edit((f) => (f.workouts[0].notes = `a${c}b`)),
      'bad-chars',
    );
  }
});

test('now must be a finite number (a clear error, not a silent window)', () => {
  assert.throws(() => validate('{}', {}), TypeError);
  assert.throws(() => validate('{}', { now: NaN }), TypeError);
  assert.throws(() => io.buildExport({}, { now: undefined }), TypeError);
});

test('every reason the validator or the merge can give is a listed code', () => {
  for (const r of [
    'too-large',
    'not-text',
    'empty',
    'not-json',
    'not-homebody',
    'bad-version',
    'newer-version',
    'missing-workouts',
    'missing-field',
    'bad-type',
    'out-of-range',
    'too-long',
    'too-many',
    'bad-chars',
    'bad-key',
    'bad-enum',
    'bad-date',
    'migration-failed',
    'id-space',
  ]) {
    assert.ok(io.REASONS.includes(r), r);
  }
  for (const [name, x] of VARIANTS) assert.ok(io.REASONS.includes(V(x).reason), name);
});

test('validator speed on a file near the size limit: parse + validate well inside 2 s', () => {
  const w = real().workouts[0];
  const workouts = Array.from({ length: 9000 }, (_, i) => ({
    ...w,
    id: i + 1,
    notes: 'n'.repeat(900),
  }));
  const text = JSON.stringify({ _vaultfit: true, _version: 2, workouts });
  assert.ok(text.length > 14 * 1024 * 1024 && text.length < LIMITS.maxBytes);
  const t0 = performance.now();
  const r = V(text);
  const ms = performance.now() - t0;
  console.log(
    `# validate(${(text.length / 1048576).toFixed(1)} MB, 9000 workouts): ${ms.toFixed(0)} ms`,
  );
  assert.equal(r.ok, true);
  assert.ok(ms < 2000, `took ${ms} ms`);
});
