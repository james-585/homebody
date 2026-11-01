import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORAGE_KEY } from './helpers/hb-storage.mjs';
import { createLocalEngine } from './helpers/hb-storage.mjs';
import { FakeStorage, createManualEngine, quotaError } from './helpers/fake-storage.mjs';
import { loadAllFixtures, stripHeader } from './helpers/load-fixtures.mjs';

const mk = (fs, extra = {}) =>
  createStore({
    openEngines: [() => createLocalEngine(fs)],
    retryDelayMs: 0,
    setTimer: (fn) => setTimeout(fn, 0),
    ...extra,
  });
const fixture = (file) => loadAllFixtures().find((f) => f.file === file).data;
const payloadOf = (d) => ({
  workouts: d.workouts,
  personalRecords: d.personalRecords,
  bodyMetrics: d.bodyMetrics,
  userPlans: d.userPlans,
  profile: d.profile,
  favourites: d.favourites,
});

test('round trip: stored string equals the pre-M1 persistSave expression', async () => {
  const fs = new FakeStorage();
  const store = mk(fs);
  await store.load();
  const real = stripHeader(fixture('vaultfit_v1_export.sanitized.json'));
  const p = payloadOf(real);
  await store.save(p);
  const old = JSON.stringify({
    workouts: p.workouts,
    personalRecords: p.personalRecords,
    bodyMetrics: p.bodyMetrics,
    userPlans: p.userPlans,
    profile: p.profile,
    favourites: p.favourites,
  });
  assert.equal(fs.getItem(STORAGE_KEY), old);
  const again = mk(fs);
  assert.deepEqual(await again.load(), JSON.parse(old));
});

test('save stringifies at call time: later mutation does not leak', async () => {
  const fs = new FakeStorage();
  const store = mk(fs);
  await store.load();
  const p = { workouts: [{ id: 1 }] };
  const pr = store.save(p);
  p.workouts[0].id = 2;
  await pr;
  assert.equal(JSON.parse(fs.getItem(STORAGE_KEY)).workouts[0].id, 1);
});

for (const key of ['homebody_v1', 'homebody_v0', 'vaultfit_v0']) {
  test(`legacy key ${key} is adopted and left byte-identical`, async () => {
    const raw = JSON.stringify(fixture(`${key}.json`));
    const fs = new FakeStorage({ [key]: raw });
    const doc = await mk(fs).load();
    assert.deepEqual(doc, JSON.parse(raw));
    assert.equal(fs.getItem(key), raw);
    assert.equal(fs.getItem(STORAGE_KEY), raw);
    assert.ok(!fs.log.some((l) => l.op === 'remove'));
  });
}

test('legacy keys are not read when vaultfit_v1 exists', async () => {
  const fs = new FakeStorage({ [STORAGE_KEY]: '{"workouts":[]}', homebody_v1: '{"workouts":[1]}' });
  assert.deepEqual(await mk(fs).load(), { workouts: [] });
  assert.deepEqual(fs.log, []);
});

test('quota during adoption: legacy intact, runs in memory, error published', async () => {
  const raw = JSON.stringify(fixture('homebody_v1.json'));
  const fs = new FakeStorage({ homebody_v1: raw });
  fs.failWrites = quotaError;
  const store = mk(fs);
  const doc = await store.load();
  assert.deepEqual(doc, JSON.parse(raw));
  assert.equal(fs.getItem('homebody_v1'), raw);
  assert.equal(fs.getItem(STORAGE_KEY), null);
  assert.equal(store.status().error, 'quota');
});

test('forced quota: one retry, error published, a later save succeeds and clears it', async () => {
  const fs = new FakeStorage();
  const store = mk(fs);
  await store.load();
  const seen = [];
  store.subscribe((s) => seen.push(s.state + ':' + (s.error ?? '-')));
  let attempts = 0;
  fs.failWrites = () => (attempts++, quotaError());
  await assert.rejects(store.save({ workouts: [1] }), { kind: 'quota' });
  assert.equal(attempts, 2, 'initial attempt plus exactly one retry');
  assert.equal(store.status().error, 'quota');
  assert.equal(fs.getItem(STORAGE_KEY), null);
  fs.failWrites = null;
  await store.save({ workouts: [1, 2] });
  assert.equal(store.status().error, undefined);
  assert.deepEqual(JSON.parse(fs.getItem(STORAGE_KEY)).workouts, [1, 2]);
  assert.deepEqual(seen, ['retrying:quota', 'failed:quota', 'idle:-']);
});

test('a failed write leaves the previous valid blob (setItem is atomic per key)', async () => {
  const fs = new FakeStorage();
  const store = mk(fs);
  await store.load();
  await store.save({ workouts: ['good'] });
  fs.failWrites = quotaError;
  await assert.rejects(store.save({ workouts: ['bad'] }));
  assert.deepEqual(JSON.parse(fs.getItem(STORAGE_KEY)).workouts, ['good']);
});

test('coalescing: one writer at a time, latest payload wins, every caller settles', async () => {
  const eng = createManualEngine();
  const store = createStore({ openEngines: [() => eng] });
  await store.load();
  const settled = [];
  const a = store.save({ n: 1 }).then(() => settled.push('a'));
  const b = store.save({ n: 2 }).then(() => settled.push('b'));
  const c = store.save({ n: 3 }).then(() => settled.push('c'));
  assert.equal(eng.pending.length, 1, 'only one write in flight');
  eng.flushOne(); // a done; b and c coalesced into one write of n:3
  await a;
  assert.equal(eng.pending.length, 1);
  eng.flushOne();
  await Promise.all([b, c]);
  assert.deepEqual(eng.written, ['{"n":1}', '{"n":3}']);
  assert.deepEqual(JSON.parse(eng.data.get(STORAGE_KEY)), { n: 3 });
  assert.deepEqual(settled.sort(), ['a', 'b', 'c']);
});

test('idle save writes synchronously inside the call', async () => {
  const fs = new FakeStorage();
  const store = mk(fs);
  await store.load();
  const p = store.save({ workouts: [] });
  assert.ok(fs.getItem(STORAGE_KEY), 'setItem already happened before any await');
  await p;
});

test('engine open failure: empty in-memory start, error set, saves fail visibly', async () => {
  const fs = new FakeStorage();
  fs.denyAccess = true;
  const store = mk(fs);
  assert.deepEqual(await store.load(), {});
  assert.equal(store.status().error, 'unavailable');
  await assert.rejects(store.save({ workouts: [] }), { kind: 'unavailable' });
});

for (const [name, raw, reason] of [
  ['corrupt', '{"workouts": [oops', 'corrupt'],
  ['future', JSON.stringify({ workouts: [{ id: 1 }], schemaVersion: 99 }), 'future'],
]) {
  test(`${name} blob: loads empty, read-only, original key never written`, async () => {
    const fs = new FakeStorage({ [STORAGE_KEY]: raw });
    const store = mk(fs);
    assert.deepEqual(await store.load(), {});
    assert.equal(store.status().error, reason);
    await assert.rejects(store.save({ workouts: [] }), { kind: reason });
    assert.equal(fs.getItem(STORAGE_KEY), raw);
    assert.deepEqual(fs.log, []);
  });
}

test('retrying is published synchronously inside the failing save() call', async () => {
  const fs = new FakeStorage();
  const store = mk(fs);
  await store.load();
  fs.failWrites = quotaError;
  const seen = [];
  store.subscribe((s) => seen.push(s.state));
  const p = store.save({ workouts: [] });
  assert.deepEqual(seen, ['retrying'], 'announced before save() returned');
  await assert.rejects(p);
});

const nav = (persist) => ({ storage: { persist, persisted: async () => false } });
const withWorkout = { workouts: [{ id: 1 }] };

test('persist(): not asked on load or for an empty history; asked once after a workout save', async () => {
  const fs = new FakeStorage();
  let calls = 0;
  const mkp = () => mk(fs, { now: () => 1234, nav: nav(async () => (calls++, true)) });
  const a = mkp();
  await a.load();
  assert.equal(calls, 0);
  await a.save({ workouts: [] });
  assert.equal(calls, 0);
  await a.save(withWorkout);
  await a.save(withWorkout);
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(JSON.parse(fs.getItem('hb_storage_meta')), {
    persistAskedAt: 1234,
    persistGranted: true,
  });
  const b = mkp(); // a second store instance (a reload) must not ask again
  await b.load();
  assert.equal(b.status().persistAsked, true);
  assert.equal(b.status().persistGranted, true);
  await b.save(withWorkout);
  assert.equal(calls, 1);
});

test('persist(): unsupported and error outcomes are recorded', async () => {
  for (const [n, expected] of [
    [null, 'unsupported'],
    [nav(async () => Promise.reject(new Error('x'))), 'error'],
    [nav(async () => false), false],
  ]) {
    const fs = new FakeStorage();
    const store = mk(fs, { nav: n, now: () => 5 });
    await store.load();
    await store.save(withWorkout);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(JSON.parse(fs.getItem('hb_storage_meta')).persistGranted, expected);
    assert.equal(store.status().persistGranted, expected);
  }
});

test('persist() is not asked when the save fails, and a failing sidecar write is harmless', async () => {
  const fs = new FakeStorage();
  let calls = 0;
  const store = mk(fs, { nav: nav(async () => (calls++, true)) });
  await store.load();
  fs.failWrites = quotaError;
  await assert.rejects(store.save(withWorkout));
  assert.equal(calls, 0);
  fs.failKeys = ['hb_storage_meta']; // only the sidecar fails afterwards
  fs.failWrites = quotaError;
  await store.save(withWorkout);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
  assert.equal(store.status().error, undefined);
});

test('save() with an unserialisable payload rejects as unknown, publishes, writes nothing', async () => {
  const fs = new FakeStorage();
  const store = mk(fs);
  await store.load();
  const seen = [];
  store.subscribe((s) => seen.push(s.state + ':' + (s.error ?? '-')));
  const circular = { workouts: [] };
  circular.self = circular;
  await assert.rejects(store.save(circular), { kind: 'unknown' });
  assert.deepEqual(seen, ['failed:unknown']);
  assert.deepEqual(fs.log, []);
  await store.save({ workouts: [1] }); // the store still works afterwards
  assert.equal(store.status().error, undefined);
});

test('a save arriving during the retry delay is the one written; both promises settle', async () => {
  const fs = new FakeStorage();
  const timers = [];
  const store = mk(fs, { setTimer: (fn) => timers.push(fn) });
  await store.load();
  fs.failWrites = quotaError;
  const a = store.save({ v: 'A' });
  await Promise.resolve(); // first attempt has failed; the retry is waiting on a timer
  const b = store.save({ v: 'B' });
  fs.failWrites = null;
  assert.equal(timers.length, 1);
  timers.shift()();
  await Promise.all([a, b]);
  assert.deepEqual(JSON.parse(fs.getItem(STORAGE_KEY)), { v: 'B' });
});

test('a save during the retry write is queued and written after it; final blob is the newest', async () => {
  const eng = createManualEngine();
  const timers = [];
  const store = createStore({ openEngines: [() => eng], setTimer: (fn) => timers.push(fn) });
  await store.load();
  const a = store.save({ v: 'A' });
  eng.failOne(quotaError());
  await new Promise((r) => setTimeout(r, 0));
  timers.shift()(); // retry write is now in flight
  assert.equal(eng.pending.length, 1);
  const b = store.save({ v: 'B' });
  eng.flushOne(); // retry of A completes
  await a;
  assert.equal(eng.pending.length, 1);
  eng.flushOne();
  await b;
  assert.deepEqual(eng.written, ['{"v":"A"}', '{"v":"B"}']);
  assert.deepEqual(JSON.parse(eng.data.get(STORAGE_KEY)), { v: 'B' });
});

test('a corrupt legacy key is copied as found, the store goes read-only, the legacy key is untouched', async () => {
  const fs = new FakeStorage({ homebody_v1: '{"workouts": [truncated' });
  const store = mk(fs);
  assert.deepEqual(await store.load(), {});
  assert.equal(store.status().error, 'corrupt');
  assert.equal(fs.getItem('homebody_v1'), '{"workouts": [truncated');
  assert.equal(fs.getItem(STORAGE_KEY), '{"workouts": [truncated');
  await assert.rejects(store.save({ workouts: [] }), { kind: 'corrupt' });
  assert.ok(!fs.log.some((l) => l.op === 'remove'));
});

test('rawText() returns the stored text unchanged and never writes', async () => {
  const raw = '{"workouts": [oops';
  const fs = new FakeStorage({ [STORAGE_KEY]: raw });
  const store = mk(fs);
  await store.load();
  assert.equal(store.rawText(), raw);
  assert.deepEqual(fs.log, []);
});

for (const [name, sidecar] of [
  ['invalid JSON', '{not json'],
  ['an array', '[1,2,3]'],
  ['a __proto__ payload', '{"__proto__":{"polluted":"yes"},"persistAskedAt":"x"}'],
  ['wrong types', '{"persistAskedAt":"yesterday","persistGranted":{"a":1}}'],
  ['a huge string', JSON.stringify({ persistAskedAt: 'x'.repeat(2_000_000) })],
]) {
  test(`malformed sidecar (${name}): ignored, no pollution, main blob untouched`, async () => {
    const main = JSON.stringify({ workouts: [{ id: 1 }] });
    const fs = new FakeStorage({ [STORAGE_KEY]: main, hb_storage_meta: sidecar });
    const store = mk(fs);
    await store.load();
    assert.equal(store.status().persistAsked, false);
    assert.equal(store.status().persistGranted, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(fs.getItem(STORAGE_KEY), main);
    assert.deepEqual(fs.log, []);
  });
}
