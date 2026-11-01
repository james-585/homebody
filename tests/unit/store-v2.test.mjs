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
  decideBoot,
  canFastBoot,
  hbSeqOf,
} from './helpers/hb-storage.mjs';
import { FakeStorage, quotaError } from './helpers/fake-storage.mjs';
import { createFakeIDB } from './helpers/fake-idb.mjs';
import {
  SYNTHETIC_DIR,
  loadAllFixtures,
  loadRealExport,
  stripHeader,
} from './helpers/load-fixtures.mjs';
import { applyMigrations, documentViolations, toStoreDoc } from './helpers/migration-harness.mjs';

const V1 = stripHeader(loadRealExport());
const V1_TEXT = JSON.stringify(V1);
const N = V1.workouts.length;

function rig({
  fs = new FakeStorage(),
  fake = createFakeIDB(),
  timeoutMs = 200,
  nav = null,
  fast = false,
  setTimer = (fn) => setTimeout(fn, 0),
  attachTimeoutMs,
  txTimeoutMs,
} = {}) {
  let t = 1000;
  const openIdb = () => createIdbEngine({ factory: fake.factory, timeoutMs, txTimeoutMs }).open();
  openIdb.idb = true;
  const make = () =>
    createStore({
      openEngines: [openIdb, () => createLocalEngine(fs)],
      migrations: MIGRATIONS,
      current: LATEST_SCHEMA,
      fastBoot: fast,
      retryDelayMs: 0,
      setTimer,
      attachTimeoutMs,
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

test('AC3: projectToV1(migrate(fixture)) equals the fixture text itself, key order too', () => {
  const six = ['workouts', 'personalRecords', 'bodyMetrics', 'userPlans', 'profile', 'favourites'];
  let compared = 0;
  for (const fx of loadAllFixtures()) {
    const d = toStoreDoc(fx);
    if (!d) continue;
    const { hbSeq, ...expected } = d; // eslint-disable-line no-unused-vars
    if (!Object.keys(expected).every((k) => six.includes(k))) continue;
    assert.equal(
      JSON.stringify(projectToV1(applyMigrations(MIGRATIONS, d))),
      JSON.stringify(expected),
      fx.file,
    );
    compared++;
  }
  assert.ok(compared >= 5, `compared ${compared} fixtures`);
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
    const raw = V1_TEXT;
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

test('mirror reconcile: equal is in sync; behind is stale, ignored and rewritten from IndexedDB', async () => {
  for (const delta of [0, -1]) {
    const r = await migrated();
    const seq = idbMeta(r.fake).seq;
    r.fs.setItem(STORAGE_KEY, JSON.stringify({ ...withWorkouts(2), hbSeq: seq + delta }));
    const store = r.make();
    const doc = await store.load();
    assert.equal(doc.workouts.length, N, `delta ${delta}: IndexedDB wins`);
    assert.equal(idbSnaps(r.fake).length, 1);
    await new Promise((res) => setTimeout(res, 5));
    if (delta) {
      // a stale mirror is rewritten from IndexedDB at once, so rollback copies are current again
      assert.equal(mirrorOf(r.fs).workouts.length, N, `delta ${delta}`);
      assert.equal(mirrorOf(r.fs).hbSeq, seq);
      assert.equal(store.status().mirror, 'ok');
    }
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
    assert.equal(mirrorOf(r.fs).workouts.length, N + 1, 'the fallback save is in the blob');
    assert.equal(store.status().state, 'idle', 'and the session stays writable');
    assert.equal(r.fake.inspect()?.stores.get('workouts').rows.size ?? 0, 0);
    // IndexedDB works again: the unmarked blob is imported with a snapshot, nothing is discarded
    r.fake.ctl.hangOpen = r.fake.ctl.errorOpen = r.fake.ctl.blockedOpen = false;
    const next = await r.make().load();
    assert.ok(next.workouts.some((w) => w.id === 9001));
    assert.equal(idbSnaps(r.fake)[0].reason, 'pre-migration');
    await r.make().load(); // and it is imported exactly once
    assert.equal(idbSnaps(r.fake).length, 1);
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
  for (let i = 0; i < 8; i++) await store.snapshot('manual');
  const list = await store.snapshots();
  assert.equal(list.length, 6);
  assert.equal(list[0].reason, 'pre-migration', 'the keep:true one survives');
  assert.deepEqual(
    list.slice(1).map((s) => s.reason),
    Array(5).fill('manual'),
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
  const { hbSeq, ...mirrorData } = mirrorOf(r.fs); // eslint-disable-line no-unused-vars
  assert.equal(JSON.stringify(mirrorData), V1_TEXT, 'mirror follows, whole');
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

// ---- review batch: pure boot decision, stale-mirror fixes, read-only gate ------------------------
const D = (o) => decideBoot({ current: 2, ...o });
const stored = (seq, meta = {}, schemaVersion = 2) => ({ doc: { schemaVersion }, seq, meta });

test('decideBoot: the table', () => {
  const rows = [
    [{ stored: { corrupt: true }, mirrorRaw: 'x' }, 'readonly', 'corrupt'],
    [{ stored: stored(1, {}, 3), mirrorRaw: 'x' }, 'readonly', 'future'],
    [{ stored: null, mirrorRaw: null }, 'empty'],
    [{ stored: null, mirrorRaw: '{}' }, 'migrate'],
    [{ stored: stored(3), mirrorRaw: null }, 'use-idb'],
    [{ stored: stored(3), mirrorRaw: 'm', mirrorSeq: 4 }, 'import-mirror'],
    [{ stored: stored(3), mirrorRaw: 'm', mirrorSeq: 3 }, 'use-idb'],
    [{ stored: stored(3), mirrorRaw: 'm', mirrorSeq: 2 }, 'use-idb', undefined, 'stale'],
    [{ stored: stored(3), mirrorRaw: 'm', mirrorSeq: 2, rendered: true }, 'readonly', 'stale'],
    [{ stored: stored(3), mirrorRaw: 'm', mirrorSeq: 4, rendered: true }, 'import-mirror'],
    [
      { stored: stored(1, { mirrorSig: 'a', mirrorSigSeq: 1 }), mirrorRaw: 'm', mirrorSig: 'a' },
      'use-idb',
      undefined,
      'ok',
    ],
    [
      { stored: stored(1, { mirrorSig: 'a', mirrorSigSeq: 1 }), mirrorRaw: 'm', mirrorSig: 'b' },
      'import-mirror',
    ],
    [
      { stored: stored(3, { mirrorSig: 'a', mirrorSigSeq: 1 }), mirrorRaw: 'm', mirrorSig: 'a' },
      'use-idb',
      undefined,
      'stale',
    ],
    [
      {
        stored: stored(3, { mirrorSig: 'a', mirrorSigSeq: 1 }),
        mirrorRaw: 'm',
        mirrorSig: 'a',
        rendered: true,
      },
      'readonly',
      'stale',
    ],
  ];
  for (const [input, action, kind, mirror] of rows) {
    const d = D(input);
    assert.equal(d.action, action, JSON.stringify(input));
    if (kind) assert.equal(d.kind, kind);
    if (mirror) assert.equal(d.mirror, mirror);
  }
});

test('canFastBoot: marked needs the matching sidecar; unmarked needs no commit ever noted', () => {
  assert.equal(canFastBoot({ mirrorSeq: 5, sidecar: { idbSeq: 5 } }), true);
  assert.equal(canFastBoot({ mirrorSeq: 5, sidecar: { idbSeq: 6 } }), false);
  assert.equal(canFastBoot({ mirrorSeq: 5, sidecar: {} }), false);
  assert.equal(canFastBoot({ mirrorSeq: null, sidecar: {} }), true);
  assert.equal(canFastBoot({ mirrorSeq: null, sidecar: { idbSeq: 2 } }), false);
});

test('hbSeqOf and the mirror text survive hostile content', async () => {
  assert.equal(hbSeqOf('{"a":1,"hbSeq":7}'), 7);
  assert.equal(hbSeqOf('{"a":{"hbSeq":7}}'), null);
  assert.equal(hbSeqOf('{"hbSeq":7,"a":1}'), null);
  assert.equal(hbSeqOf(JSON.stringify({ favourites: ['"hbSeq":9}'] })), null);
  for (const hostile of ['"hbSeq":9}', '\\"hbSeq\\":9}', '}","hbSeq":99', 'x\n}', '\u2028']) {
    const r = rig({ fs: new FakeStorage() });
    const store = r.make();
    await store.load();
    await store.save({ workouts: [{ id: 1, notes: hostile }], favourites: [hostile] });
    const raw = r.fs.getItem(STORAGE_KEY);
    assert.equal(hbSeqOf(raw), 1, hostile);
    const m = JSON.parse(raw);
    assert.equal(m.workouts[0].notes, hostile);
    assert.equal(m.hbSeq, 1);
  }
});

const settle = (ms = 15) => new Promise((res) => setTimeout(res, ms));
async function staleMirrorRig(unmarked) {
  const fs = new FakeStorage({ [STORAGE_KEY]: V1_TEXT });
  const r = rig({ fs });
  const s1 = r.make();
  const d = await s1.load();
  if (!unmarked) {
    await s1.save(payload(d));
    await settle();
  }
  fs.failWrites = quotaError;
  fs.failKeys = [STORAGE_KEY, 'hb_storage_meta'];
  for (const id of [1, 2]) {
    d.workouts.unshift({ id, name: `NEW-${id}`, exercises: [] });
    await s1.save(payload(d)).catch(() => {});
    await settle();
  }
  fs.failWrites = null;
  return { ...r, d };
}
const idbHas = (fake, name) =>
  [...fake.inspect().stores.get('workouts').rows.values()].some((w) => w.name === name);

for (const unmarked of [true, false]) {
  test(`PoC ${unmarked ? 'A' : 'B'}: a stale ${unmarked ? 'unmarked' : 'marked'} mirror after failed mirror writes never overwrites newer IndexedDB`, async () => {
    const r = await staleMirrorRig(unmarked);
    assert.ok(idbHas(r.fake, 'NEW-1') && idbHas(r.fake, 'NEW-2'));
    const s2 = rig({ fs: r.fs, fake: r.fake, fast: true }).make();
    const d2 = await s2.load(); // rendered from the stale mirror
    await s2.attach();
    assert.equal(s2.status().error, 'unavailable', 'the load-time bar kind');
    assert.equal(s2.status().state, 'readonly');
    const rows = r.fake.inspect().stores.get('workouts').rows.size;
    await assert.rejects(s2.save(payload(d2)), { kind: 'stale' });
    await settle();
    assert.equal(r.fake.inspect().stores.get('workouts').rows.size, rows);
    assert.ok(idbHas(r.fake, 'NEW-1'), 'newer IndexedDB data untouched');
    // the mirror was rewritten from IndexedDB, so the next boot is correct
    const s3 = rig({ fs: r.fs, fake: r.fake, fast: true }).make();
    const d3 = await s3.load();
    await s3.attach();
    assert.ok(d3.workouts.some((w) => w.name === 'NEW-2'));
    assert.equal(s3.status().error, undefined);
  });
}

for (const [label, mutate, kind] of [
  ['future', (f) => f.inspect().stores.get('meta').rows.set('schemaVersion', 3), 'future'],
  ['corrupt', (f) => f.inspect().stores.get('meta').rows.delete('schemaVersion'), 'corrupt'],
]) {
  test(`PoC C: a save queued before attach is refused over ${label} IndexedDB and nothing is written`, async () => {
    const fs = seeded();
    const r = rig({ fs });
    const s1 = r.make();
    const d = await s1.load();
    await s1.save(payload(d));
    await settle();
    mutate(r.fake);
    const before = JSON.stringify([...r.fake.inspect().stores.get('meta').rows]);
    const rows = r.fake.inspect().stores.get('workouts').rows.size;
    const s2 = rig({ fs, fake: r.fake, fast: true }).make();
    const d2 = await s2.load();
    const p = s2.save(payload(d2));
    const outcome = p.then(
      () => 'saved',
      (e) => e.kind,
    );
    await s2.attach();
    assert.equal(await outcome, kind);
    await assert.rejects(s2.save(payload(d2)), { kind });
    await settle();
    assert.equal(JSON.stringify([...r.fake.inspect().stores.get('meta').rows]), before);
    assert.equal(r.fake.inspect().stores.get('workouts').rows.size, rows);
    assert.equal(s2.status().state, 'readonly', 'a refused save does not clear read-only');
    assert.equal(s2.status().error, kind);
  });
}

test('expectSeq: a commit by another tab is kept as pre-overwrite before being replaced', async () => {
  const r = rig({ fs: seeded() });
  const a = r.make();
  const da = await a.load();
  const b = rig({ fs: r.fs, fake: r.fake }).make();
  const db = await b.load();
  db.workouts.unshift({ id: 11, name: 'FROM-B', exercises: [] });
  await b.save(payload(db));
  da.workouts.unshift({ id: 12, name: 'FROM-A', exercises: [] });
  await a.save(payload(da)); // a never saw b's commit
  await settle();
  const over = idbSnaps(r.fake).find((s) => s.reason === 'pre-overwrite');
  assert.ok(over, "b's state is recoverable");
  assert.ok(JSON.parse(over.payload).workouts.some((w) => w.name === 'FROM-B'));
  assert.ok(idbHas(r.fake, 'FROM-A'));
});

test('deferred commit: the mirror is written at once; a kill before the commit imports it next boot', async () => {
  const timers = [];
  const r = rig({ fs: seeded(), setTimer: (fn) => timers.push(fn) });
  const store = r.make();
  const d = await store.load();
  d.workouts.unshift({ id: 55, name: 'KILLED', exercises: [] });
  store.save(payload(d)).catch(() => {});
  assert.equal(mirrorOf(r.fs).hbSeq, 2, 'mirror numbered and written synchronously');
  assert.equal(idbMeta(r.fake).seq, 1, 'no IndexedDB work in the calling task');
  assert.equal(r.fake.ctl.commits, 1);
  const next = await rig({ fs: r.fs, fake: r.fake }).make().load(); // the kill: timers never ran
  assert.ok(next.workouts.some((w) => w.name === 'KILLED'));
  assert.ok(idbSnaps(r.fake).some((s) => s.reason === 'pre-reconcile'));
});

test('restore leaves the store read-only with the load-time bar kind', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  await store.load();
  await store.restore((await store.snapshots())[0].id);
  assert.equal(store.status().state, 'readonly');
  assert.equal(store.status().error, 'unavailable');
});

test('a transaction that never finishes is reported as failed, not hung', async () => {
  const r = rig({ fs: seeded(), txTimeoutMs: 30 });
  const store = r.make();
  const d = await store.load();
  r.fake.ctl.stallNext = true;
  await assert.rejects(store.save(payload(d)));
  assert.ok(['unknown', 'quota', 'unavailable'].includes(store.status().error));
});

test('attach as a whole is bounded: a stuck commit falls back to localStorage', async () => {
  const r = rig({ fs: seeded(), fast: true, attachTimeoutMs: 40 });
  r.fake.ctl.stallNext = true; // the migration transaction hangs
  const store = r.make();
  await store.load();
  await store.attach();
  assert.equal(store.status().engine, 'localStorage');
  assert.equal(store.status().fallback, 'idb-timeout');
  assert.equal(r.fs.getItem(STORAGE_KEY), V1_TEXT, 'the mirror is untouched');
});

test('restore never prunes the snapshot it restores from', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  await store.load();
  for (let i = 0; i < 5; i++) await store.snapshot('pre-restore');
  const oldest = (await store.snapshots()).find((s) => s.reason === 'pre-restore').id;
  await store.restore(oldest);
  const list = await store.snapshots();
  assert.ok(
    list.some((s) => s.id === oldest),
    'still there',
  );
  assert.equal(list.filter((s) => s.reason === 'pre-restore').length, 6);
});

test('sparse workouts arrays store as null, as JSON would', async () => {
  const fake = createFakeIDB();
  const e = await createIdbEngine({ factory: fake.factory, timeoutMs: 100 }).open();
  // eslint-disable-next-line no-sparse-arrays
  await e.writeDoc({ workouts: [, { id: 1 }, undefined] }, { seq: 1 });
  assert.deepEqual((await e.readDoc()).doc.workouts, [null, { id: 1 }, null]);
});

test('invariants hold on the schema 2 store dump fixture', () => {
  const dump = JSON.parse(readFileSync(join(SYNTHETIC_DIR, 'schema2', 'store_dump.json'), 'utf8'));
  const { seq, ...doc } = dump; // eslint-disable-line no-unused-vars
  assert.deepEqual(documentViolations(MIGRATIONS, doc), []);
});

// ---- second review batch ------------------------------------------------------------------------
const withWorkout = (text, w) => {
  const v = JSON.parse(text);
  v.workouts.unshift(w);
  return JSON.stringify(v);
};

test('P1: work that outlives an attach timeout changes nothing (mirror, state, IndexedDB import)', async () => {
  const fs = seeded();
  const r = rig({ fs });
  await r.make().load(); // migrates; mirror left unmarked
  fs.setItem(STORAGE_KEY, withWorkout(V1_TEXT, { id: 'W1', name: 'W1', exercises: [] })); // pre-M1 build
  const s2 = rig({ fs, fake: r.fake, fast: true, attachTimeoutMs: 40, txTimeoutMs: 1000 }).make();
  const d2 = await s2.load();
  r.fake.ctl.delayCommit = 200; // the import commits, but reports late
  await s2.attach();
  assert.equal(s2.status().engine, 'localStorage');
  assert.equal(s2.status().fallback, 'idb-timeout');
  d2.workouts.unshift({ id: 'W2', name: 'W2', exercises: [] });
  await s2.save(payload(d2));
  assert.ok(fs.getItem(STORAGE_KEY).includes('"W2"'));
  await settle(350); // the abandoned import finishes now
  assert.ok(fs.getItem(STORAGE_KEY).includes('"W2"'), 'the fallback save is still in the mirror');
  assert.equal(hbSeqOf(fs.getItem(STORAGE_KEY)), null, 'and was not restamped');
  assert.notEqual(s2.status().state, 'readonly');
  assert.equal(
    JSON.parse(fs.getItem('hb_storage_meta')).idbSeq,
    undefined,
    'no sidecar write either',
  );
  await s2.save(payload(d2)); // still writable
  const s3 = rig({ fs, fake: r.fake, fast: true }).make();
  const d3 = await s3.load();
  await s3.attach();
  assert.ok(d3.workouts.some((w) => w.id === 'W2'));
  assert.ok(
    [...r.fake.inspect().stores.get('workouts').rows.values()].some((w) => w && w.id === 'W2'),
    'imported into IndexedDB on the next boot',
  );
});

test('P2: a fallback session on a marked mirror known to be stale opens read-only', async () => {
  const fs = seeded();
  const r = rig({ fs });
  const s1 = r.make();
  const d = await s1.load();
  await s1.save(payload(d));
  await settle();
  fs.failWrites = quotaError;
  fs.failKeys = [STORAGE_KEY];
  d.workouts.unshift({ id: 'NEWER', name: 'NEWER', exercises: [] });
  await s1.save(payload(d));
  await settle();
  fs.failWrites = null;
  assert.ok(idbHas(r.fake, 'NEWER'));
  const mirrorBefore = fs.getItem(STORAGE_KEY);
  r.fake.ctl.hangOpen = true;
  const s2 = rig({ fs, fake: r.fake, fast: true, timeoutMs: 30 }).make();
  const d2 = await s2.load();
  await s2.attach();
  assert.equal(s2.status().state, 'readonly');
  assert.equal(s2.status().error, 'unavailable');
  assert.ok(d2.workouts.length >= N, 'the older data is shown, read-only');
  await assert.rejects(s2.save(payload(d2)), { kind: 'stale' });
  assert.equal(fs.getItem(STORAGE_KEY), mirrorBefore, 'nothing written');
  r.fake.ctl.hangOpen = false;
  const s3 = rig({ fs, fake: r.fake, fast: true }).make();
  const d3 = await s3.load();
  await s3.attach();
  assert.ok(
    d3.workouts.some((w) => w.name === 'NEWER'),
    'IndexedDB wins on the next boot',
  );
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile').length, 0);
});

test('P3/P4: a write transaction never replaces newer or unreadable data, whatever the tab believed', async () => {
  for (const [label, mutate, kind] of [
    ['newer schema', (m) => (m.set('schemaVersion', 3), m.set('seq', 99)), 'future'],
    ['seq not a number', (m) => m.set('seq', '7'), 'corrupt'],
    ['no schemaVersion', (m) => m.delete('schemaVersion'), 'corrupt'],
  ]) {
    const r = rig({ fs: seeded() });
    const s1 = r.make();
    const d = await s1.load();
    await s1.save(payload(d));
    await settle();
    const meta = r.fake.inspect().stores.get('meta').rows;
    mutate(meta);
    const before = JSON.stringify([...meta]);
    const rows = r.fake.inspect().stores.get('workouts').rows.size;
    d.workouts.unshift({ id: 'OLD-TAB' });
    await assert.rejects(s1.save(payload(d)), { kind }, label);
    await settle();
    assert.equal(JSON.stringify([...meta]), before, label);
    assert.equal(r.fake.inspect().stores.get('workouts').rows.size, rows, label);
    assert.equal(s1.status().state, 'readonly', label);
  }
});

test('restore also refuses to replace newer or unreadable data', async () => {
  const r = rig({ fs: seeded() });
  const s1 = r.make();
  await s1.load();
  r.fake.inspect().stores.get('meta').rows.set('schemaVersion', 3);
  await assert.rejects(s1.restore((await s1.snapshots())[0].id), { kind: 'future' });
  assert.equal(r.fake.inspect().stores.get('meta').rows.get('schemaVersion'), 3);
  assert.equal(s1.status().state, 'readonly');
});

test('snapshot reasons are a closed set', async () => {
  const r = rig({ fs: seeded() });
  const store = r.make();
  await store.load();
  await store.snapshot('<img src=x onerror=1>');
  await store.snapshot('pre-import');
  const reasons = (await store.snapshots()).map((s) => s.reason);
  assert.deepEqual(reasons, ['pre-migration', 'manual', 'pre-import']);
});

test('pre-reconcile snapshots are never pruned', async () => {
  const r = await migrated();
  for (let i = 0; i < 7; i++) {
    r.fs.setItem(STORAGE_KEY, JSON.stringify(withWorkouts(i + 1)));
    await r.make().load();
  }
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile').length, 7);
});

test('the pre-reconcile and pre-overwrite payloads are the replaced state, whole', async () => {
  const r = await migrated();
  r.fs.setItem(STORAGE_KEY, JSON.stringify(withWorkouts(3)));
  await r.make().load();
  const rec = idbSnaps(r.fake).find((s) => s.reason === 'pre-reconcile');
  assert.deepEqual(JSON.parse(rec.payload), { ...V1, schemaVersion: 2 });

  const q = rig({ fs: seeded() });
  const a = q.make();
  const da = await a.load();
  const b = rig({ fs: q.fs, fake: q.fake }).make();
  const db = await b.load();
  db.workouts.unshift({ id: 11, name: 'FROM-B', exercises: [] });
  await b.save(payload(db));
  const expected = { ...payload(db), schemaVersion: 2 };
  await a.save(payload(da));
  await settle();
  const over = idbSnaps(q.fake).find((s) => s.reason === 'pre-overwrite');
  assert.deepEqual(JSON.parse(over.payload), expected);
});

test("three writes by a tab that missed another tab's commit make exactly one pre-overwrite", async () => {
  const r = rig({ fs: seeded() });
  const a = r.make();
  const da = await a.load();
  const b = rig({ fs: r.fs, fake: r.fake }).make();
  const db = await b.load();
  db.workouts.unshift({ id: 21, name: 'B1', exercises: [] });
  await b.save(payload(db));
  for (const id of [31, 32, 33]) {
    da.workouts.unshift({ id, name: `A${id}`, exercises: [] });
    await a.save(payload(da));
    await settle();
  }
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-overwrite').length, 1);
  assert.ok(idbMeta(r.fake).seq > 2);
});

test('a retry after a transaction timeout is not mistaken for another tab', async () => {
  const r = rig({ fs: seeded(), txTimeoutMs: 30 });
  const store = r.make();
  const d = await store.load();
  r.fake.ctl.delayCommit = 45; // commits at once, reports late (after the 30 ms timeout)
  d.workouts.unshift({ id: 41, name: 'SLOW', exercises: [] });
  await store.save(payload(d));
  await settle(200);
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-overwrite').length, 0);
  assert.ok(idbHas(r.fake, 'SLOW'));
});

test('a read-only store never calls the engine to write', async () => {
  for (const mutate of [(m) => m.set('schemaVersion', 3), (m) => m.delete('schemaVersion')]) {
    const r = rig({ fs: seeded() });
    const s1 = r.make();
    const d = await s1.load();
    await s1.save(payload(d));
    await settle();
    mutate(r.fake.inspect().stores.get('meta').rows);
    let writes = 0;
    const real = createIdbEngine;
    const openIdb = () =>
      real({ factory: r.fake.factory, timeoutMs: 200 })
        .open()
        .then((e) => {
          const w = e.writeDoc;
          e.writeDoc = (...a) => (writes++, w(...a));
          return e;
        });
    openIdb.idb = true;
    const store = createStore({
      openEngines: [openIdb, () => createLocalEngine(r.fs)],
      migrations: MIGRATIONS,
      current: LATEST_SCHEMA,
      fastBoot: true,
      setTimer: (fn) => setTimeout(fn, 0),
    });
    const d2 = await store.load();
    const early = store.save(payload(d2)).catch(() => {}); // queued before attach
    await store.attach();
    await early;
    await store.save(payload(d2)).catch(() => {});
    await store.restore(1).catch(() => {});
    await store.snapshot('manual').catch(() => {});
    await settle();
    assert.equal(writes, 0);
  }
});

test('fuzz: the mirror text always parses back to the payload with the right hbSeq', async () => {
  let x = 123456789;
  const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const alphabet = [
    '"',
    '\\',
    '{',
    '}',
    ',',
    ':',
    '\n',
    '\r',
    '\u2028',
    '\ud800',
    '\udc00',
    'hbSeq',
    '"hbSeq":9}',
    ' ',
    'a',
    '0',
  ];
  const str = () =>
    Array.from(
      { length: Math.floor(rnd() * 12) },
      () => alphabet[Math.floor(rnd() * alphabet.length)],
    ).join('');
  for (let i = 0; i < 60; i++) {
    const proto = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":2},"n":' + i + '}');
    const p = {
      workouts: [{ id: i, notes: str(), ...proto }],
      favourites: [str()],
      profile: { name: str() },
    };
    const r = rig({ fs: new FakeStorage() });
    const store = r.make();
    await store.load();
    await store.save(p);
    const raw = r.fs.getItem(STORAGE_KEY);
    assert.equal(hbSeqOf(raw), 1, JSON.stringify(p));
    const m = JSON.parse(raw);
    assert.equal(m.hbSeq, 1);
    assert.equal(JSON.stringify(m.workouts), JSON.stringify(p.workouts));
    assert.equal(JSON.stringify(m.profile), JSON.stringify(p.profile));
    assert.equal({}.polluted, undefined);
    // and a non-six-key payload (projection path) agrees
    await store.save({ ...p, extra: str() });
    assert.equal(hbSeqOf(r.fs.getItem(STORAGE_KEY)), 2);
    assert.equal('extra' in JSON.parse(r.fs.getItem(STORAGE_KEY)), false);
  }
});
