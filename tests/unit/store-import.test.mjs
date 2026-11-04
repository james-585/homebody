// T7a: importDoc, previewImport, Undo, the K39 bounds and the mirror ceiling, end to end on the
// in-memory doubles (fake localStorage, fake IndexedDB). The pure validate/merge rules are in
// import-validate / import-merge; this file is about what the STORE guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createStore,
  createIdbEngine,
  createLocalEngine,
  MIGRATIONS,
  LATEST_SCHEMA,
  STORAGE_KEY,
  projectToV1,
  decideBoot,
  canFastBoot,
  hbSeqOf,
} from './helpers/hb-storage.mjs';
import { FakeStorage, quotaError } from './helpers/fake-storage.mjs';
import { createFakeIDB } from './helpers/fake-idb.mjs';
import { SYNTHETIC_DIR } from './helpers/load-fixtures.mjs';
import {
  io,
  NOW,
  REAL_TEXT,
  real,
  file,
  importFixture,
  MAX_SEQ,
  SEQ_JUMP,
  HBSEQ_CORRUPT,
  MIRROR_CEILING,
} from './helpers/io.mjs';

const OLD_TEXT = readFileSync(join(SYNTHETIC_DIR, 'homebody_v1.json'), 'utf8'); // 2 workouts: "different data"
const OLD = JSON.parse(OLD_TEXT);
const N = real().workouts.length;

function rig({
  fs = new FakeStorage({ [STORAGE_KEY]: OLD_TEXT }),
  fake = createFakeIDB(),
  fast = false,
  module = io,
  wrapEngine,
  timeoutMs = 200,
} = {}) {
  const openIdb = () => {
    const e = createIdbEngine({ factory: fake.factory, timeoutMs });
    if (wrapEngine) wrapEngine(e);
    return e.open();
  };
  openIdb.idb = true;
  const make = (over = {}) =>
    createStore({
      openEngines: [openIdb, () => createLocalEngine(fs)],
      migrations: MIGRATIONS,
      current: LATEST_SCHEMA,
      fastBoot: fast,
      retryDelayMs: 0,
      setTimer: (fn) => setTimeout(fn, 0),
      now: () => NOW,
      loadIo: async () => module,
      ...over,
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
const idbWorkouts = (fake) => [...fake.inspect().stores.get('workouts').rows.values()];
const mirror = (fs) => fs.getItem(STORAGE_KEY);
const booted = async (r) => {
  const store = r.make();
  const doc = await store.load();
  return { store, doc };
};
const projected = (d) => JSON.stringify(projectToV1(d));

// ---- the main flow ------------------------------------------------------------------------------
test('AC2: replace the fixture over different data, then Undo restores the previous state exactly', async () => {
  const r = rig();
  const { store, doc } = await booted(r);
  const before = projected(doc);
  assert.equal(doc.workouts.length, OLD.workouts.length);
  const res = await store.importDoc(REAL_TEXT, { mode: 'replace' });
  assert.equal(res.doc.workouts.length, N);
  assert.equal(idbWorkouts(r.fake).length, N);
  const snap = idbSnaps(r.fake).find((s) => s.reason === 'pre-import');
  assert.ok(snap, 'a pre-import snapshot exists');
  assert.equal(
    JSON.stringify(projectToV1(JSON.parse(snap.payload))),
    before,
    'whole previous state',
  );
  assert.equal(res.snapshotId, snap.id);
  // the store is writable again and its in-memory document is the imported one
  assert.equal(store.loaded().workouts.length, N);
  await store.save(payload(res.doc));
  // Undo: nothing saved since the commit? We saved above, so it must warn first.
  await assert.rejects(store.undoImport({ snapshotId: res.snapshotId, commitSeq: res.seq }), {
    kind: 'changed-since',
  });
  await store.undoImport({ snapshotId: res.snapshotId, commitSeq: res.seq }, { acceptLater: true });
  const after = await r.make().load();
  assert.equal(projected(after), before, 'exactly the state before the import');
});

test('Undo with nothing saved since the import is clean and reads meta.seq at tap time', async () => {
  const r = rig();
  const { store, doc } = await booted(r);
  const before = projected(doc);
  const res = await store.importDoc(REAL_TEXT, { mode: 'replace' });
  assert.deepEqual(await store.checkUndo({ commitSeq: res.seq }), {
    laterChanges: false,
    unsaved: false,
  });
  // another tab saves: the check sees it in IndexedDB although this tab's memory did not change
  const other = r.make();
  const od = await other.load();
  await other.save(payload({ ...od, favourites: ['z'] }));
  assert.deepEqual(await store.checkUndo({ commitSeq: res.seq }), {
    laterChanges: true,
    unsaved: false,
  });
  await assert.rejects(store.undoImport({ snapshotId: res.snapshotId, commitSeq: res.seq }), {
    kind: 'changed-since',
  });
  await other.undoImport; // (other tab has no import)
  // acceptLater: the later change is kept in a pre-restore snapshot, never lost
  const fresh = r.make();
  await fresh.load();
  await fresh.undoImport({ snapshotId: res.snapshotId, commitSeq: res.seq }, { acceptLater: true });
  assert.ok(idbSnaps(r.fake).some((s) => s.reason === 'pre-restore'));
  assert.equal(projected(await r.make().load()), before);
});

test('Undo is refused during a workout, and merge is the default mode', async () => {
  const r = rig();
  const { store } = await booted(r);
  const res = await store.importDoc(REAL_TEXT); // default: merge
  assert.equal(res.doc.workouts.length, N + OLD.workouts.length, 'yours kept, theirs added');
  r.fs.setItem('hb_active_workout', '{"name":"x"}');
  await assert.rejects(store.undoImport({ snapshotId: res.snapshotId, commitSeq: res.seq }), {
    kind: 'workout-active',
  });
  await assert.rejects(store.importDoc(REAL_TEXT), { kind: 'workout-active' });
  assert.equal(idbWorkouts(r.fake).length, N + OLD.workouts.length, 'nothing changed');
});

test('data, snapshot and meta are ONE transaction; the mirror follows with the committed seq', async () => {
  const r = rig();
  const { store } = await booted(r);
  const commits = r.fake.ctl.commits;
  const res = await store.importDoc(REAL_TEXT, { mode: 'replace' });
  assert.equal(r.fake.ctl.commits, commits + 1, 'exactly one transaction');
  assert.equal(idbMeta(r.fake).seq, res.seq);
  assert.equal(idbMeta(r.fake).schemaVersion, 2);
  const m = JSON.parse(mirror(r.fs));
  assert.equal(m.hbSeq, res.seq);
  assert.equal(m.workouts.length, N);
  assert.equal(store.status().mirror, 'ok');
  assert.equal(JSON.parse(r.fs.getItem('hb_storage_meta')).idbSeq, res.seq);
});

test('interrupted write: nothing changes, no pre-import snapshot, the store stays writable', async () => {
  const r = rig();
  const { store, doc } = await booted(r);
  const before = projected(doc);
  const snaps = idbSnaps(r.fake).length;
  r.fake.ctl.abortNext = quotaError();
  await assert.rejects(store.importDoc(REAL_TEXT, { mode: 'replace' }));
  assert.equal(idbWorkouts(r.fake).length, OLD.workouts.length);
  assert.equal(idbSnaps(r.fake).length, snaps, 'the snapshot rolled back with the data');
  assert.equal(projected(store.loaded()), before);
  await store.save(payload(doc)); // not left locked
  assert.notEqual(store.status().state, 'readonly');
});

test('H1: a save accepted just before importDoc commits first; it is in the Merge result and in the Replace snapshot', async () => {
  for (const mode of ['merge', 'replace']) {
    const r = rig();
    const { store, doc } = await booted(r);
    const saved = store.save({ ...payload(doc), favourites: ['saved just before'] }); // accepted: mirror written, commit queued
    const imp = store.importDoc(REAL_TEXT, { mode });
    await saved; // it was committed, not refused by the lock
    const res = await imp;
    if (mode === 'merge') {
      assert.deepEqual(res.doc.favourites, ['saved just before']);
      assert.ok(mirror(r.fs).includes('saved just before'), 'and in the mirror');
      assert.ok(
        idbSnaps(r.fake).some(
          (s) => s.reason === 'pre-import' && s.payload.includes('saved just before'),
        ),
      );
    } else {
      const snap = idbSnaps(r.fake).find((s) => s.reason === 'pre-import');
      assert.ok(snap.payload.includes('saved just before'), 'recoverable through Undo');
      await store.undoImport({ snapshotId: res.snapshotId, commitSeq: res.seq });
      const back = await r.make().load();
      assert.deepEqual(back.favourites, ['saved just before']);
    }
  }
});

test('the lock: a save while the import holds it is refused; it is released on a real throw after the lock', async () => {
  let ref = null;
  let attempt = null;
  let boom = false;
  const r = rig({
    wrapEngine(e) {
      const read = e.readDoc;
      e.readDoc = (...a) => {
        if (attempt) {
          attempt = ref.save({ workouts: [] }).then(
            () => 'accepted',
            (x) => x.kind,
          );
        }
        if (boom) return Promise.reject(new Error('disk on fire'));
        return read(...a);
      };
    },
  });
  const { store, doc } = await booted(r);
  ref = store;
  attempt = true; // the import's own read happens under the lock: a save now must be refused
  const res = await store.importDoc(REAL_TEXT, { mode: 'replace' });
  assert.equal(await attempt, 'importing');
  assert.equal(res.doc.workouts.length, N);
  attempt = null;
  await store.save(payload(store.loaded())); // released
  boom = true; // a throw after the lock was taken
  await assert.rejects(store.importDoc(REAL_TEXT, { mode: 'replace' }), /disk on fire/);
  boom = false;
  await store.save(payload(doc)); // not left locked
  assert.notEqual(store.status().state, 'readonly');
});

test('plans only: adds plans, keeps all else, snapshots; re-import is a no-op without a commit; no plans refuses', async () => {
  const r = rig();
  const { store } = await booted(r);
  const res = await store.importDoc(REAL_TEXT, { mode: 'plans' });
  assert.equal(res.doc.userPlans.length, 1);
  assert.equal(res.doc.workouts.length, OLD.workouts.length, 'workouts are yours, untouched');
  assert.ok(idbSnaps(r.fake).some((s) => s.reason === 'pre-import'));
  assert.equal(idbWorkouts(r.fake).length, OLD.workouts.length);
  const commits = r.fake.ctl.commits;
  const again = await store.importDoc(REAL_TEXT, { mode: 'plans' });
  assert.equal(again.nothing, true);
  assert.equal(r.fake.ctl.commits, commits, 'already present: nothing written');
  await assert.rejects(store.importDoc(JSON.stringify(file()), { mode: 'plans' }), {
    kind: 'no-plans',
  });
  await store.save(payload(store.loaded())); // lock released on the no-op and the refusal
  await store.undoImport({ snapshotId: res.snapshotId, commitSeq: res.seq }, { acceptLater: true });
  assert.equal((await r.make().load()).userPlans.length, OLD.userPlans.length);
});

test('merge that adds nothing writes nothing', async () => {
  const r = rig();
  const { store } = await booted(r);
  await store.importDoc(REAL_TEXT, { mode: 'merge' });
  const commits = r.fake.ctl.commits;
  const again = await store.importDoc(REAL_TEXT, { mode: 'merge' });
  assert.equal(again.nothing, true);
  assert.equal(r.fake.ctl.commits, commits);
});

test("an empty database read by the import: another tab's first commit is a mismatch, not overwritten", async () => {
  const fake = createFakeIDB();
  const other = createIdbEngine({ factory: fake.factory });
  await other.open();
  let tripped = false;
  const r = rig({
    fs: new FakeStorage(),
    fake,
    wrapEngine(e) {
      const read = e.readDoc;
      e.readDoc = (...a) => {
        const p = read(...a);
        if (tripped) {
          tripped = false;
          void other.writeDoc(
            { workouts: [{ id: 1, name: 'theirs' }], schemaVersion: 2 },
            { seq: 1, schema: 2 },
          );
        }
        return p;
      };
    },
  });
  const { store } = await booted(r);
  tripped = true;
  await assert.rejects(store.importDoc(REAL_TEXT, { mode: 'replace' }), {
    kind: 'changed-elsewhere',
  });
  assert.equal(idbWorkouts(r.fake).length, 1);
  assert.equal(idbWorkouts(r.fake)[0].name, 'theirs');
});

test('skipOnMismatch: another tab committed between our read and our write -> refuse, preview again', async () => {
  const fake = createFakeIDB();
  let tripped = false;
  const other = createIdbEngine({ factory: fake.factory });
  await other.open(); // opened beforehand: its transaction can be created synchronously
  const r = rig({
    fake,
    wrapEngine(e) {
      const read = e.readDoc;
      e.readDoc = (...a) => {
        const p = read(...a);
        if (tripped) {
          tripped = false;
          // the other tab's transaction is created right behind our read, before our write
          void other.writeDoc({ workouts: [], schemaVersion: 2 }, { seq: 50, schema: 2 });
        }
        return p;
      };
    },
  });
  const { store } = await booted(r);
  tripped = true;
  await assert.rejects(store.importDoc(REAL_TEXT, { mode: 'replace' }), {
    kind: 'changed-elsewhere',
  });
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-import').length, 0);
  assert.equal(
    idbWorkouts(r.fake).length,
    0,
    "the other tab's state stands; nothing of ours was written",
  );
  // released: a new attempt (preview again) succeeds
  const again = await store.importDoc(REAL_TEXT, { mode: 'replace' });
  assert.equal(again.doc.workouts.length, N);
});

// ---- refusals -----------------------------------------------------------------------------------
test('always validates the raw input itself: objects and hostile text are refused, nothing written', async () => {
  const r = rig();
  const { store } = await booted(r);
  const commits = r.fake.ctl.commits;
  await assert.rejects(store.importDoc({ workouts: real().workouts }), {
    kind: 'invalid',
    reason: 'not-text',
  });
  const bad = await store.importDoc(importFixture('hostile_name_refused.json')).catch((e) => e);
  assert.equal(bad.kind, 'invalid');
  assert.equal(bad.reason, 'bad-chars');
  assert.equal(bad.where, 'workouts[0].name');
  await assert.rejects(store.importDoc(importFixture('proto_key_refused.json')), {
    reason: 'bad-key',
  });
  await assert.rejects(store.importDoc(REAL_TEXT, { mode: 'overwrite' }), { kind: 'bad-mode' });
  assert.equal(r.fake.ctl.commits, commits);
  assert.equal({}.polluted, undefined);
});

test('refuses: partial file with replace; fallback engine; read-only; module missing or skewed', async () => {
  const r = rig();
  const { store } = await booted(r);
  const partial = JSON.stringify(file({ _partial: true, _partialReason: 'unreadable' }));
  await assert.rejects(store.importDoc(partial, { mode: 'replace' }), { kind: 'partial-replace' });
  assert.equal(
    (await store.importDoc(partial, { mode: 'merge' })).doc.workouts.length,
    OLD.workouts.length + 1,
  );

  const missing = rig();
  const m = missing.make({ loadIo: null });
  await m.load();
  await assert.rejects(m.importDoc(REAL_TEXT), { kind: 'io-unavailable' });
  const failing = rig().make({ loadIo: async () => Promise.reject(new Error('https://x/secret')) });
  await failing.load();
  const e = await failing.importDoc(REAL_TEXT).catch((x) => x);
  assert.equal(e.kind, 'io-unavailable');
  assert.ok(!/secret/.test(e.message), 'no detail from the failure');
  for (const bad of [
    { ...io, IO_API_VERSION: 99 },
    { ...io, LATEST_SCHEMA: 3 },
  ]) {
    const s = rig({ module: bad }).make();
    await s.load();
    await assert.rejects(s.importDoc(REAL_TEXT), { kind: 'io-skew' });
    await assert.rejects(s.previewImport(REAL_TEXT), { kind: 'io-skew' });
  }

  const fb = rig({ fake: createFakeIDB() });
  fb.fake.ctl.errorOpen = true; // IndexedDB unavailable: the localStorage engine runs the session
  const fs = fb.make();
  await fs.load();
  assert.equal(fs.status().fallback, 'idb-unavailable');
  await assert.rejects(fs.importDoc(REAL_TEXT), { kind: 'unsupported' });
  await assert.rejects(fs.previewImport(REAL_TEXT), { kind: 'unsupported' });
  assert.equal(
    JSON.parse(mirror(fb.fs)).workouts.length,
    OLD.workouts.length,
    'localStorage untouched',
  );
});

test('refuses on a newer-than-known or corrupt store, and says why', async () => {
  const r = rig();
  await booted(r);
  r.fake.inspect().stores.get('meta').rows.set('schemaVersion', 99);
  const s = r.make();
  await s.load();
  await assert.rejects(s.importDoc(REAL_TEXT), { kind: 'future' });
  assert.equal(idbWorkouts(r.fake).length, OLD.workouts.length);
  const c = rig();
  await booted(c);
  c.fake.inspect().stores.get('meta').rows.delete('schemaVersion');
  const cs = c.make();
  await cs.load();
  await assert.rejects(cs.importDoc(REAL_TEXT), { kind: 'corrupt' });
});

test('a workout that starts while the import waits is caught by the re-check after settled()', async () => {
  const r = rig();
  const { store, doc } = await booted(r);
  let reads = 0;
  const get = r.fs.getItem.bind(r.fs);
  r.fs.getItem = (k) => (k === 'hb_active_workout' && ++reads >= 2 ? '{"name":"x"}' : get(k));
  void doc;
  await assert.rejects(store.importDoc(REAL_TEXT, { mode: 'replace' }), { kind: 'workout-active' });
  assert.equal(idbWorkouts(r.fake).length, OLD.workouts.length);
  r.fs.getItem = get;
  await store.save(payload(store.loaded())); // lock released
});

test('previewImport writes nothing and describes both modes', async () => {
  const r = rig();
  const { store } = await booted(r);
  const commits = r.fake.ctl.commits;
  const p = await store.previewImport(REAL_TEXT);
  assert.equal(r.fake.ctl.commits, commits);
  assert.equal(p.summary.current.workouts, OLD.workouts.length);
  assert.equal(p.summary.file.workouts, N);
  assert.equal(p.summary.replace.workoutsRemoved, OLD.workouts.length);
  assert.equal(p.summary.merge.workoutsAdded, N);
  await assert.rejects(store.previewImport('nope'), { kind: 'invalid', reason: 'not-json' });
});

// ---- the mirror ceiling (one gate) --------------------------------------------------------------
const bigDoc = (d) => ({
  ...payload(d),
  workouts: Array.from({ length: 30 }, (_, i) => ({
    id: 90000 + i,
    name: 'big',
    date: '2026-10-01T00:00:00.000Z',
    exercises: [],
    notes: 'x'.repeat(20000),
  })),
});

test('an over-ceiling import commits to IndexedDB, leaves the old mirror, reports stale; later saves and the next boot agree', async () => {
  const r = rig();
  const { store, doc } = await booted(r);
  await store.save(payload(doc)); // a marked mirror at the current seq
  const marked = mirror(r.fs);
  const bigFile = JSON.stringify({ ...file(), workouts: bigDoc(doc).workouts });
  assert.ok(bigFile.length > MIRROR_CEILING);
  const prev = await store.previewImport(bigFile);
  assert.equal(prev.summary.replace.mirrorStale, true, 'the preview warns before apply');
  const res = await store.importDoc(bigFile, { mode: 'replace' });
  assert.equal(idbWorkouts(r.fake).length, 30, 'the commit is the save');
  assert.equal(mirror(r.fs), marked, 'the mirror is left as it is');
  assert.equal(store.status().mirror, 'stale');
  await store.save(bigDoc(store.loaded())); // a later save: still gated
  assert.equal(mirror(r.fs), marked);
  assert.equal(store.status().mirror, 'stale');
  assert.ok(res.seq < idbMeta(r.fake).seq);
  // boot after: IndexedDB wins, no import-mirror, no pre-reconcile
  const snaps = idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile').length;
  const back = await r.make().load();
  assert.equal(back.workouts.length, 30);
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile').length, snaps);
  assert.equal(idbWorkouts(r.fake).length, 30);
});

test('ceiling, fast boot: provisional save writes no plain text; restamp is gated; reboot: IndexedDB wins', async () => {
  const r = rig({ fast: true });
  const store = r.make();
  const d = await store.load();
  const seeded = mirror(r.fs);
  const p = store.save(bigDoc(d));
  assert.equal(mirror(r.fs), seeded, 'no plain text was written over the ceiling');
  await store.attach();
  await p;
  assert.equal(mirror(r.fs), seeded, 'the restamp was refused too');
  assert.equal(store.status().mirror, 'stale');
  const reboot = r.make();
  const back = await reboot.load();
  await reboot.attach();
  assert.equal(back.workouts.length, 30, 'IndexedDB wins');
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile').length, 0);
});

test("ceiling, renumber: a commit numbered past another tab's is refused by the gate; the marked text stays", async () => {
  // sized so that hbSeq 2 (one digit) just fits and the renumbered hbSeq 11 (two digits) does not
  const sized = (d) => {
    const w = { id: 1, name: 'p', date: '2026-10-01T00:00:00.000Z', exercises: [], notes: '' };
    const base = JSON.stringify({ ...payload(d), workouts: [w] }).length;
    return { ...payload(d), workouts: [{ ...w, notes: 'x'.repeat(MIRROR_CEILING - 10 - base) }] };
  };
  const r = rig();
  const a = r.make();
  const da = await a.load();
  const b = r.make();
  const db = await b.load();
  for (let i = 0; i < 9; i++) await b.save(payload({ ...db, favourites: [`b${i}`] })); // seq 10
  assert.equal(hbSeqOf(mirror(r.fs)), 10);
  assert.equal(
    JSON.stringify(sized(da)).length + 10,
    MIRROR_CEILING,
    'a one-digit counter fits exactly',
  );
  await a.save(sized(da)); // a numbers it 2 (fits); the commit is numbered past b's: 11 (does not fit)
  await a.ready();
  assert.equal(idbWorkouts(r.fake).length, 1, 'the commit went through');
  assert.equal(idbMeta(r.fake).seq, 11);
  assert.equal(a.status().mirror, 'stale');
  assert.notEqual(hbSeqOf(mirror(r.fs)), 11, 'the renumbered text was refused by the gate');
  const back = await r.make().load();
  assert.equal(back.workouts.length, 1, 'IndexedDB wins at the next boot');
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile').length, 0);
});

test('the localStorage fallback engine still saves an over-ceiling document (the gate never applies)', async () => {
  const fake = createFakeIDB();
  fake.ctl.errorOpen = true;
  const r = rig({ fake });
  const store = r.make();
  const d = await store.load();
  assert.equal(store.status().engine, 'localStorage');
  await store.save(bigDoc(d));
  assert.equal(JSON.parse(mirror(r.fs)).workouts.length, 30);
  assert.ok(mirror(r.fs).length > MIRROR_CEILING);
});

// ---- K39: counters are bounded --------------------------------------------------------------------
test('hbSeqOf: any hbSeq token that is not a valid counter is corrupt, never absent', () => {
  const t = (tok) => `{"workouts":[],"hbSeq":${tok}}`;
  for (const bad of [
    '-1',
    '"7"',
    '1e3',
    '1.5',
    '01',
    '',
    'null',
    'true',
    '2147483648',
    '12345678901',
    '999999999999999',
    '9'.repeat(100),
  ]) {
    assert.equal(hbSeqOf(t(bad)), HBSEQ_CORRUPT, bad);
  }
  assert.equal(hbSeqOf(t('0')), 0);
  assert.equal(hbSeqOf(t(String(MAX_SEQ))), MAX_SEQ);
  assert.equal(hbSeqOf(t('7')), 7);
  assert.equal(hbSeqOf('{"a":{"hbSeq":7}}'), null, 'not the last key of the top level: absent');
  assert.equal(hbSeqOf('{"hbSeq":7,"a":1}'), null);
  assert.equal(hbSeqOf('{"workouts":[]}'), null);
  assert.equal(hbSeqOf(null), null);
});

test('decideBoot and canFastBoot: a corrupt or absurdly far counter is ignored, never imported', () => {
  const stored = { doc: { schemaVersion: 2 }, seq: 5, meta: { mirrorSig: 'x', mirrorSigSeq: 5 } };
  for (const mirrorSeq of [HBSEQ_CORRUPT, 5 + SEQ_JUMP + 1]) {
    const d = decideBoot({ stored, mirrorRaw: '{}', mirrorSeq, current: 2 });
    assert.equal(d.action, 'use-idb');
    assert.equal(d.rewriteMirror, true);
    assert.equal(d.ignoredMirror, true);
  }
  assert.equal(
    decideBoot({ stored, mirrorRaw: '{}', mirrorSeq: 5 + SEQ_JUMP, current: 2 }).action,
    'import-mirror',
  );
  assert.equal(canFastBoot({ mirrorSeq: HBSEQ_CORRUPT, sidecar: { idbSeq: 5 } }), false);
  assert.equal(canFastBoot({ mirrorSeq: HBSEQ_CORRUPT, sidecar: {} }), false);
});

test('K39: a mirror with a 15-digit hbSeq is ignored once, kept as a snapshot when it differs, then repaired', async () => {
  const r = rig();
  const { store, doc } = await booted(r);
  await store.save(payload(doc));
  const corrupt = importFixture('k39_mirror_15_digit_hbseq.json');
  assert.equal(hbSeqOf(corrupt), HBSEQ_CORRUPT);
  // same data as IndexedDB holds: nothing differs, nothing to keep
  r.fs.setItem(
    STORAGE_KEY,
    JSON.stringify(projectToV1(doc)).slice(0, -1) + ',"hbSeq":999999999999999}',
  );
  const snaps0 = idbSnaps(r.fake).length;
  const d1 = await r.make().load();
  assert.equal(d1.workouts.length, OLD.workouts.length);
  assert.equal(idbSnaps(r.fake).length, snaps0, 'same data: no snapshot');
  assert.equal(typeof hbSeqOf(mirror(r.fs)), 'number', 'the mirror was repaired');
  // different data: its text is kept before it is overwritten
  const other =
    JSON.stringify({ ...OLD, favourites: ['only in the mirror'] }).slice(0, -1) +
    ',"hbSeq":999999999999999}';
  r.fs.setItem(STORAGE_KEY, other);
  const d2 = await r.make().load();
  assert.equal(d2.workouts.length, OLD.workouts.length, 'IndexedDB won; no import');
  const kept = idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].payload, other, 'verbatim');
  assert.equal(typeof hbSeqOf(mirror(r.fs)), 'number');
  // the next boot changes nothing more (no snapshot on every boot)
  await r.make().load();
  assert.equal(idbSnaps(r.fake).filter((s) => s.reason === 'pre-reconcile').length, 1);
});

test('K39: no mirror writer can stamp a counter above MAX_SEQ; a stored seq above it is corrupt', async () => {
  const r = rig();
  const { store, doc } = await booted(r);
  // the commit counter at the bound: the next write aborts, the data stays, the store locks as corrupt
  r.fake.inspect().stores.get('meta').rows.set('seq', MAX_SEQ);
  const before = idbWorkouts(r.fake).length;
  const rejected = await store.save(payload({ ...doc, favourites: ['x'] })).catch((e) => e);
  assert.ok(rejected instanceof Error);
  assert.equal(idbWorkouts(r.fake).length, before);
  assert.equal(idbMeta(r.fake).seq, MAX_SEQ, 'nothing written');
  assert.equal(store.status().state, 'readonly');
  // a meta.seq above the bound reads as corrupt at boot: read-only, nothing written
  r.fake
    .inspect()
    .stores.get('meta')
    .rows.set('seq', MAX_SEQ + 1);
  const s = r.make();
  await s.load();
  assert.equal(s.status().state, 'readonly');
  assert.equal(s.status().error, 'corrupt');
  await assert.rejects(s.importDoc(REAL_TEXT), { kind: 'corrupt' });
  const k39 = JSON.parse(
    readFileSync(join(SYNTHETIC_DIR, 'import', 'k39_meta_seq_1e15.json'), 'utf8'),
  );
  r.fake.inspect().stores.get('meta').rows.set('seq', k39.seq);
  const s2 = r.make();
  await s2.load();
  assert.equal(
    s2.status().error,
    'corrupt',
    'the K39 install: read-only (Export still works), recovery is restore in T8',
  );
  r.fake.inspect().stores.get('meta').rows.set('seq', 1.5);
  const s3 = r.make();
  await s3.load();
  assert.equal(s3.status().error, 'corrupt');
});

test('K39: a sidecar idbSeq above MAX_SEQ is ignored', () => {
  const fs = new FakeStorage({ hb_storage_meta: JSON.stringify({ idbSeq: MAX_SEQ + 1 }) });
  assert.equal(createLocalEngine(fs).readMeta().idbSeq, undefined);
  const ok = new FakeStorage({ hb_storage_meta: JSON.stringify({ idbSeq: MAX_SEQ }) });
  assert.equal(createLocalEngine(ok).readMeta().idbSeq, MAX_SEQ);
});

test('a file cannot set a counter: hbSeq, seq and schemaVersion are dropped and the store numbers it', async () => {
  const r = rig();
  const { store } = await booted(r);
  const f = file({ hbSeq: 999999999999999, seq: 5e15, schemaVersion: 99 });
  f.workouts[0].seq = 1e15;
  const res = await store.importDoc(JSON.stringify(f), { mode: 'replace' });
  assert.ok(res.seq < 100);
  assert.equal(idbMeta(r.fake).schemaVersion, 2);
  assert.equal(hbSeqOf(mirror(r.fs)), res.seq);
  assert.ok(
    !JSON.stringify(idbWorkouts(r.fake)).includes('1e15') &&
      !mirror(r.fs).includes('999999999999999'),
  );
});

// ---- export, partial states ------------------------------------------------------------------------
test('buildExport marks a partial export when the data could not be read, and not otherwise', async () => {
  const r = rig();
  const { store, doc } = await booted(r);
  assert.equal((await store.buildExport(payload(doc))).partial, false);
  r.fake.inspect().stores.get('meta').rows.set('schemaVersion', 99);
  const s = r.make();
  const d = await s.load();
  const e = await s.buildExport(payload(d));
  assert.equal(e.partial, true);
  assert.equal(JSON.parse(e.text)._partialReason, 'newer');
  assert.match(e.filename, /^HomeBody_partial_/);
  r.fake.inspect().stores.get('meta').rows.delete('schemaVersion');
  const c = r.make();
  await c.load();
  assert.equal(
    JSON.parse((await c.buildExport({ workouts: [] })).text)._partialReason,
    'unreadable',
  );
  await assert.rejects(rig().make({ loadIo: null }).buildExport({}), { kind: 'io-unavailable' });
});

test('every storage key still written is on the KEYS list (no new key from import or export)', async () => {
  const r = rig();
  const { store } = await booted(r);
  await store.importDoc(REAL_TEXT, { mode: 'replace' });
  const { KEYS } = globalThis.HBStorage;
  for (const w of r.fs.log) assert.ok(KEYS.localStorage.includes(w.key), w.key);
});

// ---- M-A: an edit that is not saved anywhere must not be wiped by an import or a restore ----------
async function failedSave() {
  const r = rig();
  const { store, doc } = await booted(r);
  r.fake.ctl.failTransaction = quotaError(); // every IndexedDB write fails; the mirror still takes it
  await assert.rejects(
    store.save({ ...payload(doc), favourites: ['only in memory and the mirror'] }),
  );
  r.fake.ctl.failTransaction = null;
  assert.ok(store.status().error, 'the save-problem state is up');
  assert.ok(mirror(r.fs).includes('only in memory and the mirror'));
  return { r, store, doc };
}

test('M-A: with a failed save outstanding every import mode and Undo refuse "unsaved"; nothing is written or locked', async () => {
  const { r, store } = await failedSave();
  const commits = r.fake.ctl.commits;
  const mirrorBefore = mirror(r.fs);
  for (const mode of ['merge', 'replace', 'plans']) {
    await assert.rejects(store.importDoc(REAL_TEXT, { mode }), { kind: 'unsaved' });
  }
  await assert.rejects(store.previewImport(REAL_TEXT), { kind: 'unsaved' });
  assert.equal(await store.importBlocked(), 'unsaved');
  assert.equal((await store.checkUndo({ commitSeq: 1 })).unsaved, true);
  const snap = (await store.snapshots())[0];
  await assert.rejects(store.restore(snap.id), { kind: 'unsaved' });
  await assert.rejects(
    store.undoImport({ snapshotId: snap.id, commitSeq: 1 }, { acceptLater: true }),
    { kind: 'unsaved' },
  );
  assert.equal(r.fake.ctl.commits, commits, 'nothing written');
  assert.equal(mirror(r.fs), mirrorBefore, 'the unsaved edit is still in the mirror');
  assert.notEqual(store.status().state, 'readonly', 'no lock was taken');
  // saving again succeeds, which clears the state and lets the import through
  await store.save(payload({ ...store.loaded(), favourites: ['saved now'] }));
  assert.equal(await store.importBlocked(), null);
  const res = await store.importDoc(REAL_TEXT, { mode: 'merge' });
  assert.ok(res.doc.workouts.length > OLD.workouts.length);
});

test('importBlocked reports the other refusals too, and null when an import would go ahead', async () => {
  const r = rig();
  const { store } = await booted(r);
  assert.equal(await store.importBlocked(), null);
  r.fs.setItem('hb_active_workout', '{"name":"x"}');
  assert.equal(await store.importBlocked(), 'workout-active');
  r.fs.removeItem('hb_active_workout');
  const fb = rig({ fake: createFakeIDB() });
  fb.fake.ctl.errorOpen = true;
  const f = fb.make();
  await f.load();
  assert.equal(await f.importBlocked(), 'unsupported');
  const kinds = globalThis.HBStorage.IMPORT_KINDS;
  for (const k of [
    'unsaved',
    'workout-active',
    'changed-elsewhere',
    'changed-since',
    'partial-replace',
    'no-plans',
    'unsupported',
    'io-unavailable',
    'io-skew',
    'read-failed',
    'consumed',
  ]) {
    assert.ok(kinds.includes(k), k);
  }
});

test('previewImport (so "Check again") refuses while an import is being applied', async () => {
  let ref = null;
  let seen = null;
  const r = rig({
    wrapEngine(e) {
      const read = e.readDoc;
      e.readDoc = (...a) => {
        if (seen === true)
          seen = ref.previewImport(REAL_TEXT).then(
            () => 'ok',
            (x) => x.kind,
          );
        return read(...a);
      };
    },
  });
  const { store } = await booted(r);
  ref = store;
  seen = true;
  await store.importDoc(REAL_TEXT, { mode: 'replace' });
  assert.equal(await seen, 'importing');
});

test('Replace on identical data still writes and snapshots (only Merge and plans-only detect "nothing")', async () => {
  const r = rig();
  const { store } = await booted(r);
  await store.importDoc(REAL_TEXT, { mode: 'replace' });
  const commits = r.fake.ctl.commits;
  const again = await store.importDoc(REAL_TEXT, { mode: 'replace' });
  assert.equal(again.nothing, undefined);
  assert.equal(r.fake.ctl.commits, commits + 1);
  assert.ok(again.snapshotId);
});

test('Undo with healthy saves is unaffected by the unsaved check', async () => {
  const r = rig();
  const { store } = await booted(r);
  const res = await store.importDoc(REAL_TEXT, { mode: 'replace' });
  assert.deepEqual(await store.checkUndo({ commitSeq: res.seq }), {
    laterChanges: false,
    unsaved: false,
  });
  await store.undoImport({ snapshotId: res.snapshotId, commitSeq: res.seq });
  assert.equal(store.status().state, 'readonly', 'restored: reload next');
});
