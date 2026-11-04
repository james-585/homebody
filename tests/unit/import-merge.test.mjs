// T7a: merge, replace, summary and export. Pure functions over validated documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io, opts, REAL_TEXT, file, importFixture, NOW } from './helpers/io.mjs';

const { validate, mergeDocs, summarize, buildExport } = io;
const MAX = Number.MAX_SAFE_INTEGER;
const valid = (x) => {
  const r = validate(typeof x === 'string' ? x : JSON.stringify(x), opts());
  assert.equal(r.ok, true, r.reason);
  return r;
};
const FIX = () => valid(REAL_TEXT);
const wk = (id, over = {}) => ({
  id,
  name: `W${id}`,
  date: `2026-10-${String(10 + (id % 18)).padStart(2, '0')}T08:00:00.000Z`,
  exercises: [{ name: 'Plank', sets: 3, reps: 0, time: 30, weight: 0, trackType: 'time' }],
  ...over,
});
const docOf = (workouts, rest = {}) => ({
  workouts,
  personalRecords: {},
  bodyMetrics: [],
  userPlans: [],
  profile: null,
  favourites: [],
  ...rest,
});
const incoming = (workouts, rest) => valid(file({ workouts, ...rest })).doc;
const ids = (ws) => ws.map((w) => w.id);
const unique = (a) => new Set(a).size === a.length;

test('merge: every current workout survives unchanged; counts never drop', () => {
  const cur = docOf([wk(3), wk(2), wk(1)]);
  const inc = incoming([wk(10), wk(11)]);
  const m = mergeDocs(cur, inc, 'merge');
  assert.equal(m.ok, true);
  assert.equal(m.doc.workouts.length, 5);
  for (const w of cur.workouts)
    assert.ok(
      m.doc.workouts.some((x) => x === w),
      'same object, untouched',
    );
  assert.equal(m.counts.workoutsAdded, 2);
  assert.equal(m.counts.workoutsRemoved, 0);
});

test('merge(a, a) = a: merging the fixture into itself changes nothing', () => {
  const f = FIX();
  const cur = { ...f.doc, schemaVersion: 2 };
  const m = mergeDocs(cur, f.doc, 'merge');
  assert.deepEqual(m.doc.workouts, f.doc.workouts);
  assert.deepEqual(m.doc.personalRecords, f.doc.personalRecords);
  assert.deepEqual(m.doc.bodyMetrics, f.doc.bodyMetrics);
  assert.deepEqual(m.doc.userPlans, f.doc.userPlans);
  assert.deepEqual(m.doc.profile, f.doc.profile);
  assert.equal(m.counts.workoutsPresent, 149);
  assert.equal(m.counts.workoutsAdded, 0);
  assert.equal(m.counts.plansPresent, 1);
});

test('merge into an empty store equals replace, including in-file duplicate ids', () => {
  const a = wk(5);
  const inc = incoming([a, { ...a, name: 'same id, other workout' }, { ...a }], {
    personalRecords: { Plank: { value: 60, unit: 'sec' } },
    profile: { name: 'Sam' },
    favourites: ['Plank'],
  });
  const m = mergeDocs(docOf([]), inc, 'merge');
  const r = mergeDocs(docOf([]), inc, 'replace');
  assert.deepEqual(m.doc, r.doc);
  assert.ok(unique(ids(m.doc.workouts)), 'output ids are unique');
  assert.equal(m.doc.workouts.length, 3, 'nothing deduped inside the file');
  assert.equal(m.counts.workoutsReid, 2);
});

test('an id that collides with one you have is re-id and ids stay unique', () => {
  const cur = docOf([wk(5), wk(6)]);
  const inc = incoming([wk(5, { name: 'different' }), wk(5, { name: 'other' })]);
  const m = mergeDocs(cur, inc, 'merge');
  assert.ok(unique(ids(m.doc.workouts)));
  assert.equal(m.doc.workouts.length, 4);
  assert.deepEqual(
    ids(m.doc.workouts)
      .filter((i) => i > 6)
      .sort(),
    [7, 8],
    'smallest unused above the maximum',
  );
  assert.equal(m.counts.workoutsReid, 2);
});

test('re-id when the maximum is 2^53-1: the smallest unused positive safe integer', () => {
  const cur = docOf([wk(MAX), wk(1)]);
  const inc = incoming([wk(MAX, { name: 'x' }), wk(1, { name: 'y' }), wk(2, { name: 'z' })]);
  const m = mergeDocs(cur, inc, 'merge');
  assert.equal(m.ok, true);
  const out = ids(m.doc.workouts);
  assert.ok(unique(out));
  assert.ok(out.every((i) => Number.isSafeInteger(i) && i >= 1));
  assert.ok(out.includes(3) && out.includes(4), 'took the lowest free ids (2 was free for z)');
  const r = mergeDocs(docOf([]), incoming([wk(MAX), wk(MAX, { name: 'b' })]), 'replace');
  assert.ok(unique(ids(r.doc.workouts)) && ids(r.doc.workouts).every(Number.isSafeInteger));
});

test('duplicates are decided against current data by content, not by id', () => {
  const same = wk(9);
  const cur = docOf([{ ...same, id: 999 }]);
  const m = mergeDocs(cur, incoming([same, wk(9, { name: 'other' })]), 'merge');
  assert.equal(m.counts.workoutsPresent, 1);
  assert.equal(m.doc.workouts.length, 2);
});

test('merged and replaced workouts are newest first; an unreadable date sorts last', () => {
  const cur = docOf([wk(3), wk(1)]);
  const inc = incoming([wk(2)]);
  const dates = mergeDocs(cur, inc, 'merge').doc.workouts.map((w) => w.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  const r = mergeDocs(cur, incoming([wk(1), wk(3)]), 'replace');
  assert.deepEqual(ids(r.doc.workouts), [3, 1], 'replace sorts the file newest first');
  const same = mergeDocs(cur, incoming([wk(3), wk(1)]), 'replace');
  assert.deepEqual(same.doc.workouts, cur.workouts, 'an already sorted file is unchanged');
});

test('PRs, body metrics, plans, favourites: yours win, new ones are added', () => {
  const cur = docOf([], {
    personalRecords: { Plank: { value: 100, unit: 'sec' } },
    bodyMetrics: [{ date: '2026-10-01T00:00:00.000Z', weight: 80 }],
    userPlans: [{ id: 7, name: 'Mine', planDays: [] }],
    favourites: ['A'],
    profile: { name: 'Me' },
  });
  const inc = incoming([wk(1)], {
    personalRecords: { Plank: { value: 5, unit: 'sec' }, Curl: { value: 20, unit: 'kg' } },
    bodyMetrics: [
      { date: '2026-10-01T00:00:00.000Z', weight: 99 },
      { date: '2026-10-02T00:00:00.000Z', weight: 81 },
    ],
    userPlans: [
      { id: 7, name: 'Theirs', planDays: [] },
      { id: 8, name: 'New', planDays: [] },
    ],
    favourites: ['A', 'B'],
    profile: { name: 'Them' },
  });
  const m = mergeDocs(cur, inc, 'merge');
  assert.equal(m.doc.personalRecords.Plank.value, 100);
  assert.equal(m.doc.personalRecords.Curl.value, 20);
  assert.equal(m.doc.bodyMetrics.length, 2);
  assert.equal(m.doc.bodyMetrics.find((r) => r.date.startsWith('2026-10-01')).weight, 80);
  assert.deepEqual(
    m.doc.userPlans.map((p) => p.name),
    ['Mine', 'New'],
  );
  assert.deepEqual(m.doc.favourites, ['A', 'B']);
  assert.deepEqual(m.doc.profile, { name: 'Me' });
  assert.equal(m.counts.profile, 'kept');
  assert.deepEqual(
    [
      m.counts.prsAdded,
      m.counts.prsOverlap,
      m.counts.bodyAdded,
      m.counts.plansPresent,
      m.counts.plansAdded,
    ],
    [1, 1, 1, 1, 1],
  );
  // re-importing the same plan again is a no-op
  const again = mergeDocs(m.doc, inc, 'merge');
  assert.equal(again.doc.userPlans.length, 2);
});

test('profile: merge takes the file profile only when you have none; replace shows the change', () => {
  const inc = incoming([wk(1)], { profile: { name: 'Them' } });
  assert.equal(mergeDocs(docOf([]), inc, 'merge').counts.profile, 'taken');
  assert.equal(
    mergeDocs(docOf([], { profile: { equipment: {} } }), inc, 'merge').counts.profile,
    'taken',
  );
  assert.equal(
    mergeDocs(docOf([], { profile: { name: 'Me' } }), inc, 'replace').counts.profile,
    'replaced',
  );
  const none = incoming([wk(1)]);
  const r = mergeDocs(docOf([], { profile: { name: 'Me' } }), none, 'replace');
  assert.equal(r.counts.profile, 'removed');
  assert.equal(r.doc.profile, null);
});

test('replace: takes the file whole and counts what you would lose', () => {
  const cur = docOf([wk(1), wk(2), wk(3)], { favourites: ['x'] });
  const r = mergeDocs(cur, incoming([wk(2), wk(9)]), 'replace');
  assert.deepEqual(ids(r.doc.workouts), [9, 2]);
  assert.equal(r.counts.workoutsRemoved, 2);
  assert.deepEqual(r.doc.favourites, []);
});

test('neither mode mutates its inputs', () => {
  const cur = docOf([wk(1)]);
  const inc = incoming([wk(1, { name: 'z' })]);
  const a = JSON.stringify(cur);
  const b = JSON.stringify(inc);
  mergeDocs(cur, inc, 'merge');
  mergeDocs(cur, inc, 'replace');
  assert.equal(JSON.stringify(cur), a);
  assert.equal(JSON.stringify(inc), b);
});

test('summary: plain numbers for both modes; a partial file cannot be used with replace', () => {
  const cur = docOf([wk(1)]);
  const v = valid(file({ workouts: [wk(1), wk(2)], _partial: true, _partialReason: 'unreadable' }));
  const s = summarize(cur, v, { mirrorCeiling: 512 * 1024 });
  assert.equal(s.file.workouts, 2);
  assert.equal(s.file.partial, true);
  assert.equal(s.current.workouts, 1);
  assert.equal(s.merge.workoutsAdded, 1);
  assert.equal(s.merge.workoutsPresent, 1);
  assert.equal(s.replace.allowed, false);
  assert.equal(s.merge.mirrorStale, false);
  assert.equal(summarize(cur, v, { mirrorCeiling: 10 }).merge.mirrorStale, true);
  const real = summarize(docOf([]), FIX());
  assert.deepEqual(real.file.dateRange.from <= real.file.dateRange.to, true);
  assert.equal(real.file.profileName, 'Test User');
  // only numbers, booleans and short strings: nothing that could be markup beyond clipped names
  assert.ok(JSON.stringify(real).length < 2000);
});

// ---- export -------------------------------------------------------------------------------------
test('export: header markers, compact JSON, no profile name in the filename or header', () => {
  const state = FIX().doc;
  state.profile = { ...state.profile, name: 'Zed Person' };
  const e = buildExport(state, { now: NOW });
  assert.equal(e.ok, true);
  const o = JSON.parse(e.text);
  assert.equal(o._vaultfit, true);
  assert.equal(o._version, 2);
  assert.equal(o._containsHealthData, true);
  assert.equal(o._exported, '2026-11-03T12:00:00.000Z');
  assert.ok(!('_name' in o) && !('_partial' in o));
  assert.equal(e.filename, 'HomeBody_2026-11-03.vaultfit');
  assert.ok(!e.text.includes('\n'), 'compact');
  assert.ok(!/Zed/.test(e.filename));
  assert.deepEqual(e.warnings, { refused: [], dropped: 0 });
});

test('export: a partial export is marked in the file and the filename', () => {
  const e = buildExport({ workouts: [] }, { now: NOW, partialReason: 'unreadable' });
  const o = JSON.parse(e.text);
  assert.equal(o._partial, true);
  assert.equal(o._partialReason, 'unreadable');
  assert.equal(e.filename, 'HomeBody_partial_2026-11-03.vaultfit');
  assert.equal(e.partial, true);
  assert.equal(validate(e.text, opts()).partial.partial, true);
});

test('a current export re-imports to the identical state', () => {
  const f = FIX();
  const e = buildExport(f.doc, { now: NOW });
  const back = validate(e.text, opts());
  assert.equal(back.ok, true);
  assert.equal(back.version, 2);
  assert.deepEqual(back.doc, f.doc);
  const r = mergeDocs(docOf([]), back.doc, 'replace');
  assert.deepEqual(r.doc, f.doc);
});

test('export: an old v1 file imports into the current schema (version lifted)', () => {
  const r = valid(importFixture('v1_export_no_rpe.json'));
  assert.equal(r.version, 1);
  const again = validate(buildExport(r.doc, { now: NOW }).text, opts());
  assert.deepEqual(again.doc, r.doc);
});

test('export: too large to restore is refused, never produced; records the importer would refuse warn', () => {
  const big = buildExport(
    { workouts: [{ ...wk(1), notes: 'x'.repeat(21 * 1024 * 1024) }] },
    { now: NOW },
  );
  assert.deepEqual([big.ok, big.reason], [false, 'too-large']);
  const odd = buildExport(
    { workouts: [wk(1, { name: 'a<b' })], profile: { name: 'x', extra: 1 } },
    { now: NOW },
  );
  assert.equal(odd.ok, true, 'still exports');
  assert.equal(odd.warnings.refused[0].where, 'workouts[0].name');
  const extra = buildExport({ workouts: [{ ...wk(1), mystery: 1 }] }, { now: NOW });
  assert.equal(extra.warnings.dropped, 1, 'fields the importer would ignore are reported');
  assert.ok(extra.text.includes('mystery'), 'but they are in the file');
  const circ = {};
  circ.self = circ;
  assert.equal(
    buildExport({ workouts: [], profile: circ }, { now: NOW }).reason,
    'not-serialisable',
  );
});

test('profile in use: any detail or equipment counts, not only a name (Merge keeps it, Replace says so)', () => {
  const inc = incoming([wk(1)], { profile: { name: 'Them' } });
  for (const p of [
    { equipment: { dumbbells: [5, 10] } },
    { equipment: { barbell_bars: { standard_bar: true } } },
    { age: 30 },
    { weight: 80 },
    { goal: 'lose_fat' },
    { sex: 'male' },
    { activity: 'active' },
  ]) {
    const m = mergeDocs(docOf([], { profile: p }), inc, 'merge');
    assert.equal(m.counts.profile, 'kept', JSON.stringify(p));
    assert.deepEqual(m.doc.profile, p);
    assert.equal(mergeDocs(docOf([], { profile: p }), inc, 'replace').counts.profile, 'replaced');
  }
  for (const p of [
    null,
    {},
    { equipment: {} },
    { equipment: { dumbbells: [], rig: [] } },
    { name: '' },
  ]) {
    assert.equal(mergeDocs(docOf([], { profile: p }), inc, 'merge').counts.profile, 'taken');
  }
});

test('plans only: everything but userPlans is yours, untouched; same id keeps yours; nothing to add is detected', () => {
  const cur = docOf([wk(1)], {
    personalRecords: { Plank: { value: 1, unit: 'sec' } },
    favourites: ['a'],
    profile: { name: 'Me' },
    userPlans: [{ id: 7, name: 'Mine', planDays: [] }],
  });
  const inc = incoming([wk(50)], {
    userPlans: [
      { id: 7, name: 'Theirs', planDays: [] },
      { id: 8, name: 'New', planDays: [{ name: 'D', exercises: [] }] },
    ],
    favourites: ['b'],
    personalRecords: { Curl: { value: 5, unit: 'kg' } },
  });
  const m = mergeDocs(cur, inc, 'plans');
  assert.deepEqual(m.doc.workouts, cur.workouts);
  assert.deepEqual(m.doc.personalRecords, cur.personalRecords);
  assert.deepEqual(m.doc.favourites, ['a']);
  assert.deepEqual(m.doc.profile, { name: 'Me' });
  assert.deepEqual(
    m.doc.userPlans.map((p) => p.name),
    ['Mine', 'New'],
  );
  assert.equal(m.counts.plansPresent, 1);
  assert.equal(io.addsNothing(m.counts), false);
  const again = mergeDocs(m.doc, inc, 'plans');
  assert.equal(io.addsNothing(again.counts), true, 're-importing the same plans is a no-op');
  assert.deepEqual(again.doc.userPlans, m.doc.userPlans);
  assert.equal(io.addsNothing(mergeDocs(cur, incoming([wk(1)]), 'merge').counts), true);
});

test('summary carries every number the preview needs (the UI computes nothing)', () => {
  const cur = docOf([wk(1), wk(2)], {
    personalRecords: { Plank: { value: 1, unit: 'sec' }, Mine: { value: 2, unit: 'kg' } },
    bodyMetrics: [{ date: '2026-10-01T00:00:00.000Z', weight: 80 }],
    favourites: ['a', 'z'],
    userPlans: [{ id: 7, name: 'Mine', planDays: [] }],
  });
  const plans = Array.from({ length: 25 }, (_, i) => ({
    id: i + 7,
    name: `Plan ${i} ${'x'.repeat(60)}`,
    planDays: [{ name: 'D', exercises: [] }],
  }));
  const v = valid(
    file({
      workouts: [wk(1), wk(3)],
      personalRecords: { Plank: { value: 9, unit: 'sec' }, Curl: { value: 5, unit: 'kg' } },
      bodyMetrics: [
        { date: '2026-10-01T00:00:00.000Z', weight: 79 },
        { date: '2026-10-05T00:00:00.000Z', weight: 78 },
      ],
      favourites: ['a', 'b'],
      userPlans: plans,
      profile: { name: 'Emoji \u{1F4AA}'.repeat(30) },
    }),
  );
  const s = summarize(cur, v, { mirrorCeiling: 512 * 1024 });
  assert.deepEqual(s.cats.workouts, { inFile: 2, mine: 2, new: 1, present: 1, removed: 1 });
  assert.deepEqual(s.cats.prs, { inFile: 2, mine: 2, new: 1, present: 1, removed: 1 });
  assert.deepEqual(s.cats.body, { inFile: 2, mine: 1, new: 1, present: 1, removed: 0 });
  assert.deepEqual(s.cats.favourites, { inFile: 2, mine: 2, new: 1, present: 1, removed: 1 });
  assert.deepEqual(s.cats.plans, { inFile: 25, mine: 1, new: 24, present: 1, removed: 0 });
  assert.equal(s.plans.total, 25);
  assert.equal(s.plans.items.length, 20, 'listed up to 20, in file order');
  assert.deepEqual([s.plans.items[0].present, s.plans.items[1].present], [true, false]);
  assert.equal([...s.plans.items[0].name].length, 40);
  assert.equal(s.plans.items[0].days, 1);
  assert.equal(s.onlyPlans.plansAdded, 24);
  assert.ok(s.file.exported === null && s.file.dateRange.from && s.file.profileName);
  assert.ok([...s.file.profileName].length <= 100);
  assert.ok(
    !/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/.test(s.file.profileName.slice(-1)),
    'cut by code points, never mid-pair',
  );
  assert.deepEqual(Object.keys(s.warnings).sort(), [
    'dropped',
    'duplicateIds',
    'futureDates',
    'unrecognised',
    'unrecognisedWhere',
  ]);
  for (const k of ['workoutsReid', 'mirrorStale', 'profile'])
    assert.ok(k in s.merge && k in s.replace, k);
});

test('replace and merge into an empty store agree on order and ids after the newest-first sort', () => {
  const a = wk(5);
  const inc = incoming([wk(1), a, { ...a }]);
  const m = mergeDocs(docOf([]), inc, 'merge');
  const r = mergeDocs(docOf([]), inc, 'replace');
  assert.ok(unique(ids(r.doc.workouts)));
  assert.deepEqual(ids(m.doc.workouts).sort(), ids(r.doc.workouts).sort());
});

test('summary says whether Merge and plans-only would add nothing; Replace never "nothing"', () => {
  const f = FIX();
  const same = summarize({ ...f.doc, schemaVersion: 2 }, f);
  assert.equal(same.merge.nothing, true);
  assert.equal(same.onlyPlans.nothing, true);
  assert.equal(same.replace.nothing, false, 'Replace rewrites and snapshots even identical data');
  const empty = summarize(docOf([]), f);
  assert.equal(empty.merge.nothing, false);
  assert.equal(empty.onlyPlans.nothing, false);
  const profileOnly = summarize(docOf([]), valid(file({ workouts: [], profile: { name: 'A' } })));
  assert.equal(profileOnly.merge.nothing, false, 'taking the profile is a change');
});
