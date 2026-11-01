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
  store.subscribe((s) => seen.push(s.error ?? null));
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
  assert.deepEqual(seen, ['quota', null]);
});

test('interrupted write leaves the previous valid blob', async () => {
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
