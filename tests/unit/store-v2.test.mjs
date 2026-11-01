// T6: the IndexedDB store end to end on in-memory doubles (fake localStorage, fake IndexedDB):
// migration 001, snapshots and restore, the v1 mirror and the boot rule, fallback, failure.
// The real IndexedDB engine runs the same contract in the page (tests/e2e/idb.spec.mjs).
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  createStore,
  createIdbEngine,
  createLocalEngine,
  MIGRATIONS,
  LATEST_SCHEMA,
  KEYS,
  STORAGE_KEY,
  projectToV1,
} from './helpers/hb-storage.mjs';
import { FakeStorage, quotaError } from './helpers/fake-storage.mjs';
import { createFakeIDB } from './helpers/fake-idb.mjs';
import {
  SYNTHETIC_DIR,
  loadAllFixtures,
  loadRealExport,
  stripHeader,
} from './helpers/load-fixtures.mjs';
import { applyMigrations, toStoreDoc } from './helpers/migration-harness.mjs';

const V1 = stripHeader(loadRealExport());
const V1_TEXT = JSON.stringify(V1);
const N = V1.workouts.length;

function rig({
  fs = new FakeStorage(),
  fake = createFakeIDB(),
  timeoutMs = 200,
  nav = null,
  fast = false,
} = {}) {
  let t = 1000;
  const openIdb = () => createIdbEngine({ factory: fake.factory, timeoutMs }).open();
  openIdb.idb = true;
  const make = () =>
    createStore({
      openEngines: [openIdb, () => createLocalEngine(fs)],
      migrations: MIGRATIONS,
      current: LATEST_SCHEMA,
      fastBoot: fast,
      retryDelayMs: 0,
      setTimer: (fn) => setTimeout(fn, 0),
      now: () => (t += 10),
      nav,
    });
  return { fs, fake, make };
}
const payload = (d) => ({
  workouts: d.workouts,
  personalRecords: d.personalRecords,
  bodyMetrics: d.bodyMetrics,
  userPlans: d.userPlans,
  profile: d.profile,
  favourites: d.favourites,
});
const idbMeta = (fake) => Object.fromEntries(fake.inspect().stores.get('meta').rows);
const idbSnaps = (fake) => [...fake.inspect().stores.get('snapshots').rows.values()];
const mirrorOf = (fs) => JSON.parse(fs.getItem(STORAGE_KEY));
const seeded = () => new FakeStorage({ [STORAGE_KEY]: V1_TEXT });

test('LATEST_SCHEMA is 2 and migration 001 is the only link in the chain', () => {
  assert.equal(LATEST_SCHEMA, 2);
  assert.deepEqual(
    MIGRATIONS.map((m) => [m.from, m.to]),
    [[1, 2]],
  );
});

test('AC3: projectToV1(migrate(fixture)) deep-equals the fixture data, key order too', () => {
  for (const fx of loadAllFixtures()) {
    const d = toStoreDoc(fx);
    if (!d || 'seq' in d || 'hbSeq' in d) continue;
    const six = projectToV1(d);
    assert.equal(
      JSON.stringify(projectToV1(applyMigrations(MIGRATIONS, d))),
      JSON.stringify(six),
      fx.file,
    );
  }
});

test('first boot: one transaction migrates, snapshots the source byte for byte, leaves the key readable', async () => {
  const { fs, fake, make } = rig({ fs: seeded() });
  const store = make();
  const doc = await store.load();
  assert.equal(doc.workouts.length, N);
  assert.equal(doc.schemaVersion, 2);
  assert.equal(store.status().engine, 'indexedDB');
  assert.equal(fake.inspect().stores.get('workouts').rows.size, N);
  const snaps = idbSnaps(fake);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].reason, 'pre-migration');
  assert.equal(snaps[0].keep, true);
  assert.equal(snaps[0].schemaVersion, 1);
  assert.equal(snaps[0].payload, V1_TEXT, 'verbatim source text');
  assert.equal(idbMeta(fake).schemaVersion, 2);
  assert.equal(idbMeta(fake).migratedFrom, 1);
  assert.equal(fs.getItem(STORAGE_KEY), V1_TEXT, 'vaultfit_v1 is left exactly as found');
  assert.ok(idbMeta(fake).mirrorSig, 'and recognised by its fingerprint');
  assert.equal((await store.snapshots()).length, 1);
  assert.equal(JSON.stringify(await store.snapshots()).includes('payload'), false);
});

test('AC2: booting twice migrates once and takes one snapshot', async () => {
  const r = rig({ fs: seeded() });
  await r.make().load();
  const commits = r.fake.ctl.commits;
  const again = r.make();
  const doc = await again.load();
  assert.equal(doc.workouts.length, N);
  assert.equal(idbSnaps(r.fake).length, 1);
  assert.equal(r.fake.ctl.commits, commits, 'the second boot wrote nothing');
});

test('two tabs booting together migrate once', async () => {
  const r = rig({ fs: seeded() });
  const [a, b] = [r.make(), r.make()];
  const [da, db] = await Promise.all([a.load(), b.load()]);
  assert.equal(r.fake.ctl.commits, 1);
  assert.equal(idbSnaps(r.fake).length, 1);
  assert.equal(da.workouts.length, N);
  assert.equal(db.workouts.length, N);
});

for (const key of ['homebody_v1', 'homebody_v0', 'vaultfit_v0']) {
  test(`legacy key ${key} is adopted, migrated and left untouched`, async () => {
    const raw = V1_TEXT.replace('"workouts"', '"workouts"');
    const fs = new FakeStorage({ [key]: raw });
    const r = rig({ fs });
    const doc = await r.make().load();
    assert.equal(doc.workouts.length, N);
    assert.equal(fs.getItem(key), raw);
    assert.equal(idbSnaps(r.fake)[0].payload, raw);
    assert.ok(!fs.log.some((l) => l.op === 'remove'));
  });
}

test('an empty profile: nothing is written until the first save, which then migrates nothing', async () => {
  const r = rig();
  const store = r.make();
  assert.deepEqual(await store.load(), {});
  assert.equal(r.fake.ctl.commits, 0);
  await store.save({ workouts: [{ id: 1 }] });
  assert.equal(idbMeta(r.fake).seq, 1);
  assert.equal(mirrorOf(r.fs).hbSeq, 1);
});

test('save writes IndexedDB and the mirror together; seq and hbSeq agree', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  const d = await store.load();
  d.workouts.push({ id: 424242, name: 'new', exercises: [] });
  await store.save(payload(d));
  assert.equal(idbMeta(r.fake).seq, 2);
  assert.equal(mirrorOf(r.fs).hbSeq, 2);
  assert.equal(mirrorOf(r.fs).workouts.length, N + 1);
  assert.deepEqual(Object.keys(mirrorOf(r.fs)), [...Object.keys(V1), 'hbSeq']);
  const again = await r.make().load();
  assert.equal(again.workouts.length, N + 1);
});

test('the mirror write is synchronous inside save(), before the IndexedDB commit', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  const d = await store.load();
  d.workouts.push({ id: 1, exercises: [] });
  const p = store.save(payload(d));
  assert.equal(mirrorOf(r.fs).workouts.length, N + 1, 'mirror already holds it');
  assert.equal(idbMeta(r.fake).seq, 1, 'IndexedDB has not committed yet');
  await p;
});

// ---- which copy wins ---------------------------------------------------------------------------
async function migrated(extraSaves = 2) {
  const r = rig({ fs: seeded() });
  const store = r.make();
  const d = await store.load();
  for (let i = 0; i < extraSaves; i++) await store.save(payload(d));
  return { ...r, d };
}
const withWorkouts = (n) => ({ ...V1, workouts: V1.workouts.slice(0, n) });

test('mirror reconcile: no hbSeq (a pre-M1 build wrote it) is newer; IndexedDB snapshotted first', async () => {
  const r = await migrated();
  r.fs.setItem(STORAGE_KEY, JSON.stringify(withWorkouts(3)));
  const doc = await r.make().load();
  assert.equal(doc.workouts.length, 3);
  const snap = idbSnaps(r.fake).find((s) => s.reason === 'pre-reconcile');
  assert.equal(JSON.parse(snap.payload).workouts.length, N, 'the replaced state is recoverable');
  assert.equal(idbMeta(r.fake).seq, 4);
  assert.equal((await r.make().load()).workouts.length, 3, 'and it stays reconciled');
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile').length, 1);
});

test('mirror reconcile: hbSeq above meta.seq (killed before the commit) is newer', async () => {
  const r = await migrated();
  r.fs.setItem(STORAGE_KEY, JSON.stringify({ ...withWorkouts(4), hbSeq: idbMeta(r.fake).seq + 1 }));
  const doc = await r.make().load();
  assert.equal(doc.workouts.length, 4);
  assert.ok(idbSnaps(r.fake).some((s) => s.reason === 'pre-reconcile'));
});

test('mirror reconcile: equal or behind is stale and ignored; behind is reported', async () => {
  for (const delta of [0, -1]) {
    const r = await migrated();
    const seq = idbMeta(r.fake).seq;
    r.fs.setItem(STORAGE_KEY, JSON.stringify({ ...withWorkouts(2), hbSeq: seq + delta }));
    const store = r.make();
    const doc = await store.load();
    assert.equal(doc.workouts.length, N, `delta ${delta}: IndexedDB wins`);
    assert.equal(idbSnaps(r.fake).length, 1);
    assert.equal(store.status().mirror, delta ? 'stale' : 'ok');
  }
});

test('mirror reconcile: a corrupt or newer-than-known mirror is ignored, never imported', async () => {
  for (const text of ['{"workouts": [oops', JSON.stringify({ workouts: [], schemaVersion: 99 })]) {
    const r = await migrated();
    r.fs.setItem(STORAGE_KEY, text);
    const doc = await r.make().load();
    assert.equal(doc.workouts.length, N);
    assert.equal(r.fs.getItem(STORAGE_KEY), text, 'left as found');
  }
});

test('a write failure leaves the mirror ahead; the next boot adopts it (kill before commit)', async () => {
  const r = await migrated();
  const store = r.make();
  const d = await store.load();
  r.fake.ctl.failTransaction = quotaError();
  d.workouts.push({ id: 777, name: 'unsaved in IDB', exercises: [] });
  await assert.rejects(store.save(payload(d)));
  assert.equal(store.status().error, 'quota');
  assert.equal(mirrorOf(r.fs).workouts.length, N + 1, 'the sync mirror holds it');
  r.fake.ctl.failTransaction = null;
  const doc = await r.make().load();
  assert.equal(doc.workouts.length, N + 1);
  assert.ok(doc.workouts.some((w) => w.id === 777));
});

test('an interrupted write rolls back: no partial state, a later save recovers', async () => {
  const r = await migrated(1);
  const store = r.make();
  const d = await store.load();
  const before = JSON.stringify(idbMeta(r.fake));
  r.fake.ctl.abortNext = quotaError();
  const p = store.save(payload(d));
  await p; // the single retry succeeds
  assert.equal(store.status().error, undefined);
  assert.notEqual(JSON.stringify(idbMeta(r.fake)), before);
  assert.equal(r.fake.inspect().stores.get('workouts').rows.size, N);
});

// ---- migration failure, fallback ---------------------------------------------------------------
test('a failed migration commits nothing, leaves the source untouched and reruns next boot', async () => {
  const r = rig({ fs: seeded() });
  r.fake.ctl.abortNext = quotaError();
  const store = r.make();
  const doc = await store.load();
  assert.equal(doc.workouts.length, N, 'the session runs on the source');
  assert.equal(store.status().engine, 'localStorage');
  assert.equal(store.status().fallback, 'idb-unavailable');
  assert.equal(r.fs.getItem(STORAGE_KEY), V1_TEXT, 'byte-identical');
  assert.equal(r.fake.inspect().stores.get('snapshots').rows.size, 0);
  assert.equal(r.fake.inspect().stores.get('workouts').rows.size, 0);
  assert.equal(r.fake.inspect().stores.get('meta').rows.size, 0, 'not marked migrated');
  await r.make().load();
  assert.equal(idbSnaps(r.fake).length, 1);
  assert.equal(idbMeta(r.fake).schemaVersion, 2);
});

test('a migration interrupted part-way (after the snapshot and the first writes) leaves nothing behind', async () => {
  for (const after of [1, 2, 40, 120]) {
    const r = rig({ fs: seeded() });
    r.fake.ctl.abortAfterOps = after;
    const store = r.make();
    await store.load();
    const stores = r.fake.inspect().stores;
    assert.equal(stores.get('snapshots').rows.size, 0, `snapshot after ${after} ops`);
    assert.equal(stores.get('workouts').rows.size, 0);
    assert.equal(stores.get('records').rows.size, 0);
    assert.equal(stores.get('meta').rows.size, 0);
    assert.equal(r.fs.getItem(STORAGE_KEY), V1_TEXT);
  }
});

for (const [name, setup, reason] of [
  ['open error', (f) => (f.ctl.errorOpen = true), 'idb-unavailable'],
  ['blocked', (f) => (f.ctl.blockedOpen = true), 'idb-unavailable'],
  ['no answer within the timeout', (f) => (f.ctl.hangOpen = true), 'idb-timeout'],
]) {
  test(`IndexedDB ${name}: localStorage engine, fallback reported, work kept and imported later`, async () => {
    const r = rig({ fs: seeded(), timeoutMs: 30 });
    setup(r.fake);
    const store = r.make();
    const d = await store.load();
    assert.equal(d.workouts.length, N);
    assert.deepEqual(
      [store.status().engine, store.status().fallback, store.status().snapshots],
      ['localStorage', reason, false],
    );
    d.workouts.push({ id: 9001, name: 'fallback session', exercises: [] });
    await store.save(payload(d));
    assert.equal(mirrorOf(r.fs).hbSeq, undefined, 'the fallback blob is unmarked');
    assert.equal(r.fake.inspect()?.stores.get('workouts').rows.size ?? 0, 0);
    // IndexedDB works again: the unmarked blob is imported with a snapshot, nothing is discarded
    r.fake.ctl.hangOpen = r.fake.ctl.errorOpen = r.fake.ctl.blockedOpen = false;
    const next = await r.make().load();
    assert.ok(next.workouts.some((w) => w.id === 9001));
    assert.equal(idbSnaps(r.fake)[0].reason, 'pre-migration');
  });
}

test('no localStorage and no IndexedDB: unavailable, read-only, never throws', async () => {
  const fake = createFakeIDB();
  fake.ctl.errorOpen = true;
  const store = createStore({
    openEngines: [
      () => createIdbEngine({ factory: fake.factory }).open(),
      () => createLocalEngine(null),
    ],
    migrations: MIGRATIONS,
    current: 2,
  });
  assert.deepEqual(await store.load(), {});
  assert.equal(store.status().error, 'unavailable');
  await assert.rejects(store.save({ workouts: [] }));
});

test('corrupt and future IndexedDB: empty, read-only, never written; raw export reads the mirror', async () => {
  const corrupt = rig({ fs: seeded() });
  await corrupt.make().load();
  corrupt.fake.inspect().stores.get('meta').rows.delete('schemaVersion');
  const cs = corrupt.make();
  assert.deepEqual(await cs.load(), {});
  assert.equal(cs.status().error, 'corrupt');
  const before = corrupt.fs.getItem(STORAGE_KEY);
  await assert.rejects(cs.save({ workouts: [{ id: 1 }] }));
  assert.equal(corrupt.fs.getItem(STORAGE_KEY), before);
  assert.equal(cs.rawText(), before);

  const future = rig({ fs: seeded() });
  await future.make().load();
  future.fake.inspect().stores.get('meta').rows.set('schemaVersion', 99);
  const fsr = future.make();
  assert.deepEqual(await fsr.load(), {});
  assert.equal(fsr.status().error, 'future');
  await assert.rejects(fsr.save({ workouts: [] }));
  assert.equal(future.fake.inspect().stores.get('workouts').rows.size, N);
});

test('onversionchange closes the connection; the next save reopens it', async () => {
  const r = await migrated(0);
  const store = r.make();
  const d = await store.load();
  r.fake.versionChange();
  assert.ok(r.fake.ctl.handles.every((h) => h.closed));
  await store.save(payload(d));
  assert.equal(idbMeta(r.fake).seq, 2);
});

// ---- snapshots, retention, restore ---------------------------------------------------------------
test('retention: the last 5 plus the first pre-migration snapshot', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  await store.load();
  for (let i = 0; i < 8; i++) await store.snapshot(`manual-${i}`);
  const list = await store.snapshots();
  assert.equal(list.length, 6);
  assert.equal(list[0].reason, 'pre-migration', 'the keep:true one survives');
  assert.deepEqual(
    list.slice(1).map((s) => s.reason),
    ['manual-3', 'manual-4', 'manual-5', 'manual-6', 'manual-7'],
  );
});

test('AC6: restore(id) puts the snapshot back, snapshotting the present state first', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  const d = await store.load();
  d.workouts = d.workouts.slice(0, 5);
  await store.save(payload(d));
  const first = (await store.snapshots())[0];
  await store.restore(first.id);
  const list = await store.snapshots();
  const pre = list.find((s) => s.reason === 'pre-restore');
  assert.ok(pre, 'the state before the restore is recoverable');
  assert.equal(
    JSON.parse(
      (await r.make().load()) && idbSnaps(r.fake).find((s) => s.reason === 'pre-restore').payload,
    ).workouts.length,
    5,
  );
  const after = await r.make().load();
  assert.equal(after.workouts.length, N);
  assert.equal(mirrorOf(r.fs).workouts.length, N, 'mirror follows');
  await assert.rejects(store.save(payload(d)), { kind: 'restored' }, 'read-only until reload');
  assert.equal(JSON.stringify(projectToV1(after)), V1_TEXT, 'history equals the snapshot');
});

test('restore refuses during a workout and changes nothing', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  await store.load();
  r.fs.setItem('hb_active_workout', '{"name":"x"}');
  const id = (await store.snapshots())[0].id;
  const commits = r.fake.ctl.commits;
  await assert.rejects(store.restore(id), { kind: 'workout-active' });
  assert.equal(r.fake.ctl.commits, commits);
  r.fs.removeItem('hb_active_workout');
  await assert.rejects(store.restore(9999), { kind: 'not-found' });
});

test('restore lifts an old v1 payload through the migration runner', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  await store.load();
  await store.restore((await store.snapshots())[0].id);
  assert.equal(idbMeta(r.fake).schemaVersion, 2);
});

test('a localStorage-only store has no snapshots and says so', async () => {
  const store = createStore({ openEngines: [() => createLocalEngine(new FakeStorage())] });
  await store.load();
  assert.equal(store.status().snapshots, false);
  assert.deepEqual(await store.snapshots(), []);
  await assert.rejects(store.restore(1), { kind: 'unsupported' });
});

// ---- persist() and the key list ------------------------------------------------------------------
test('persist() result is kept in IndexedDB meta and the sidecar, and read back next boot', async () => {
  let calls = 0;
  const nav = { storage: { persist: async () => (calls++, true), persisted: async () => false } };
  const r = rig({ fs: seeded(), nav });
  const store = r.make();
  const d = await store.load();
  await store.save(payload(d));
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(calls, 1);
  assert.equal(idbMeta(r.fake).persistGranted, true);
  const next = r.make();
  await next.load();
  assert.equal(next.status().persistAsked, true);
  assert.equal(next.status().persistGranted, true);
});

test('every localStorage key written in a full fake session is on HBStorage.KEYS', async () => {
  const nav = { storage: { persist: async () => true, persisted: async () => true } };
  const written = new Set();
  for (const seed of [
    { [STORAGE_KEY]: V1_TEXT },
    { homebody_v1: V1_TEXT },
    { homebody_v0: V1_TEXT },
    { vaultfit_v0: V1_TEXT },
  ]) {
    const fs = new FakeStorage(seed);
    const r = rig({ fs, nav });
    const store = r.make();
    const d = await store.load();
    await store.save(payload(d));
    await new Promise((res) => setTimeout(res, 10));
    await store.snapshot('t');
    await store.restore((await store.snapshots())[0].id);
    // and a fallback session
    const fb = new FakeStorage(seed);
    const rf = rig({ fs: fb, nav, timeoutMs: 20 });
    rf.fake.ctl.errorOpen = true;
    const s2 = rf.make();
    await s2.load();
    await s2.save(payload(d));
    await new Promise((res) => setTimeout(res, 10));
    for (const log of [fs.log, fb.log]) for (const l of log) written.add(l.key);
  }
  assert.ok(written.size >= 2, [...written].join());
  for (const k of written) assert.ok(KEYS.localStorage.includes(k), `${k} is not on KEYS`);
  assert.deepEqual(KEYS.indexedDB, ['homebody']);
  assert.ok(Object.isFrozen(KEYS) && Object.isFrozen(KEYS.localStorage));
});

// ---- fast boot: the mirror is read first, IndexedDB opens after first paint -----------------------
test('fast boot, upgrade from main: the document is ready without IndexedDB; attach migrates', async () => {
  const r = rig({ fs: seeded(), fast: true });
  const store = r.make();
  const doc = await store.load();
  assert.equal(doc.workouts.length, N);
  assert.equal(r.fake.ctl.handles.length, 0, 'IndexedDB not touched before first paint');
  assert.equal(store.status().engine, 'indexedDB');
  await store.attach();
  await store.ready();
  assert.equal(r.fake.inspect().stores.get('workouts').rows.size, N);
  assert.equal(idbSnaps(r.fake)[0].payload, V1_TEXT);
  assert.equal(r.fs.getItem(STORAGE_KEY), V1_TEXT, 'mirror untouched');
  assert.equal(store.status().snapshots, true);
  // and the next boot is fast too (unmarked, nothing changed) without importing again
  const again = r.make();
  await again.load();
  await again.attach();
  assert.equal(idbSnaps(r.fake).length, 1);
  assert.equal(r.fake.ctl.commits, 1);
});

test('fast boot, steady state: a marked mirror with the sidecar proof boots with IndexedDB hanging', async () => {
  const r = rig({ fs: seeded() });
  const s1 = r.make();
  const d = await s1.load();
  await s1.save(payload(d));
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(JSON.parse(r.fs.getItem('hb_storage_meta')).idbSeq, 2);
  const fake2 = r.fake;
  fake2.ctl.hangOpen = true;
  const f = rig({ fs: r.fs, fake: fake2, fast: true, timeoutMs: 20 }).make();
  const doc = await f.load();
  assert.equal(doc.workouts.length, N, 'no wait for IndexedDB');
  assert.equal(doc.hbSeq, undefined);
  await f.attach();
  assert.equal(f.status().engine, 'localStorage');
  assert.equal(f.status().fallback, 'idb-timeout');
});

test('fast boot: no proof (marked mirror, sidecar missing) takes the slow path', async () => {
  const r = rig({ fs: seeded() });
  const s1 = r.make();
  const d = await s1.load();
  await s1.save(payload(d));
  await new Promise((res) => setTimeout(res, 10));
  r.fs.removeItem('hb_storage_meta');
  const f = rig({ fs: r.fs, fake: r.fake, fast: true }).make();
  await f.load();
  assert.ok(r.fake.ctl.handles.length > 1, 'IndexedDB was opened to decide');
  assert.equal(f.status().engine, 'indexedDB');
  assert.equal(f.status().snapshots, true);
});

test('fast boot: a save before attach writes plain v1 text, commits after attach, then restamps', async () => {
  const r = rig({ fs: seeded(), fast: true });
  const store = r.make();
  const d = await store.load();
  d.workouts.push({ id: 31337, name: 'early', exercises: [] });
  const p = store.save(payload(d));
  const plain = r.fs.getItem(STORAGE_KEY);
  assert.equal(JSON.parse(plain).hbSeq, undefined, 'plain v1 text, as persistSave always wrote');
  assert.equal(JSON.parse(plain).workouts.length, N + 1);
  await store.attach();
  await p;
  const m = mirrorOf(r.fs);
  assert.equal(m.workouts.length, N + 1);
  assert.equal(m.hbSeq, idbMeta(r.fake).seq, 'restamped to the committed seq');
  assert.equal(r.fake.inspect().stores.get('workouts').rows.size, N + 1);
  assert.equal(JSON.parse(r.fs.getItem('hb_storage_meta')).idbSeq, m.hbSeq);
  assert.equal(
    idbSnaps(r.fake)[0].payload,
    V1_TEXT,
    'the snapshot is the text from before the save',
  );
});

test('fast boot: killed after an early save and before attach, the next boot imports it', async () => {
  const r = rig({ fs: seeded(), fast: true });
  const s1 = r.make();
  const d = await s1.load();
  await s1.attach();
  await s1.ready();
  const s2 = r.make(); // a later boot that dies before attach
  const d2 = await s2.load();
  d2.workouts.push({ id: 4242, name: 'lost?', exercises: [] });
  s2.save(payload(d2)).catch(() => {});
  assert.equal(d.workouts.length, N);
  const s3 = rig({ fs: r.fs, fake: r.fake }).make(); // the slow path decides
  const d3 = await s3.load();
  assert.ok(d3.workouts.some((w) => w.id === 4242));
  assert.ok(idbSnaps(r.fake).some((s) => s.reason === 'pre-reconcile'));
});

test('fast boot: corrupt IndexedDB after attach goes read-only and never writes', async () => {
  const r = rig({ fs: seeded() });
  await r.make().load();
  r.fake.inspect().stores.get('meta').rows.delete('schemaVersion');
  const f = r.make();
  const fs2 = rig({ fs: r.fs, fake: r.fake, fast: true }).make();
  void f;
  await fs2.load();
  await fs2.attach();
  assert.equal(fs2.status().error, 'corrupt');
  const before = r.fs.getItem(STORAGE_KEY);
  await assert.rejects(fs2.save({ workouts: [] }), { kind: 'corrupt' });
  assert.equal(r.fs.getItem(STORAGE_KEY), before);
});

test('the schema 2 store dump fixture is exactly what the stores hold after migrating the legacy fixture', async () => {
  const dump = JSON.parse(readFileSync(join(SYNTHETIC_DIR, 'schema2', 'store_dump.json'), 'utf8'));
  const { seq, ...expected } = dump;
  const r = rig({ fs: seeded() });
  await r.make().load();
  const stored = await createIdbEngine({ factory: r.fake.factory, timeoutMs: 100 })
    .open()
    .then((e) => e.readDoc());
  assert.equal(stored.seq, seq);
  assert.deepEqual(stored.doc, expected);
  const mirrorFixture = readFileSync(join(SYNTHETIC_DIR, 'vaultfit_v1_mirror.json'), 'utf8');
  assert.equal(JSON.stringify(JSON.parse(mirrorFixture).hbSeq), '1');
  const { hbSeq, ...six } = JSON.parse(mirrorFixture); // eslint-disable-line no-unused-vars
  assert.equal(JSON.stringify(six), V1_TEXT, 'the mirror fixture is the v1 data plus hbSeq');
});
