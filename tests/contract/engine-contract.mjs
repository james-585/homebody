// One contract suite for every storage engine (T6, AC1). Environment-neutral ES module: node
// imports it for the localStorage engine (and the IndexedDB engine on the fake), and the page
// imports it over HTTP to run the same cases against real IndexedDB (tests/e2e/idb.spec.mjs).
//
// A case is { name, run(c) }. `c` is built by the caller:
//   c.engine         a fresh, empty engine (already opened)
//   c.project(doc)   HBStorage.projectToV1
//   c.poison()       a value that makes a write fail partway (DataCloneError / circular JSON)
//   c.faults         { quota(on), seedFuture(), seedCorrupt() }
const fail = (m) => {
  throw new Error(m);
};
const eq = (a, b, m = '') => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) fail(`${m} expected ${y} but got ${x}`);
};
async function rejects(fn, m = '') {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return fail(`${m} should have rejected`);
}

const doc = (workouts, extra = {}) => ({
  workouts,
  personalRecords: { 'DB Curl': { value: 20, unit: 'kg' } },
  bodyMetrics: [{ date: '2026-01-01', weight: 80 }],
  userPlans: [{ name: 'Plan A' }],
  profile: { name: 'Test' },
  favourites: ['DB Curl'],
  ...extra,
});

export const cases = [
  {
    name: 'a fresh engine reads null',
    run: async (c) => eq(await c.engine.readDoc(), null),
  },
  {
    name: 'write then read round-trips every record set, and the seq',
    run: async (c) => {
      const d = doc([{ id: 1, name: 'A', exercises: [{ name: 'x', sets: [1] }] }, { id: 2 }]);
      await c.engine.writeDoc(d, { seq: 3 });
      const r = await c.engine.readDoc();
      eq(c.project(r.doc), c.project(d), 'document');
      eq(r.seq, 3, 'seq');
    },
  },
  {
    name: 'a second write replaces: deleted workouts and records are gone',
    run: async (c) => {
      await c.engine.writeDoc(doc([{ id: 1 }, { id: 2 }, { id: 3 }]), { seq: 1 });
      const d2 = { workouts: [{ id: 2 }], profile: { name: 'B' } };
      await c.engine.writeDoc(d2, { seq: 2 });
      const r = await c.engine.readDoc();
      eq(c.project(r.doc), c.project(d2));
      eq(r.seq, 2);
    },
  },
  {
    name: 'duplicate ids, missing ids and order survive',
    run: async (c) => {
      const w = [{ id: 7, a: 1 }, { name: 'no id' }, { id: 7, a: 2 }, { id: null }];
      await c.engine.writeDoc(doc(w), { seq: 1 });
      eq((await c.engine.readDoc()).doc.workouts, w);
    },
  },
  {
    name: 'interrupted write: the previous state is intact',
    run: async (c) => {
      const good = doc([{ id: 1 }, { id: 2 }]);
      await c.engine.writeDoc(good, { seq: 1 });
      await rejects(
        async () => c.engine.writeDoc(doc([{ id: 9 }, { id: 10, bad: c.poison() }]), { seq: 2 }),
        'poisoned write',
      );
      const r = await c.engine.readDoc();
      eq(c.project(r.doc), c.project(good), 'document after the failed write');
      eq(r.seq, 1, 'seq after the failed write');
    },
  },
  {
    name: 'quota fault: rejects as QuotaExceededError, previous state intact, recovers',
    run: async (c) => {
      const good = doc([{ id: 1 }]);
      await c.engine.writeDoc(good, { seq: 1 });
      c.faults.quota(true);
      const e = await rejects(() => c.engine.writeDoc(doc([{ id: 5 }]), { seq: 2 }), 'quota');
      eq(e.name, 'QuotaExceededError');
      c.faults.quota(false);
      eq(c.project((await c.engine.readDoc()).doc), c.project(good), 'intact');
      await c.engine.writeDoc(doc([{ id: 6 }]), { seq: 2 });
      eq((await c.engine.readDoc()).doc.workouts, [{ id: 6 }]);
    },
  },
  {
    name: 'a newer schema version is reported, not hidden',
    run: async (c) => {
      await c.faults.seedFuture();
      eq((await c.engine.readDoc()).doc.schemaVersion, 99);
    },
  },
  {
    name: 'corrupt stored data is reported as corrupt',
    run: async (c) => {
      await c.faults.seedCorrupt();
      eq((await c.engine.readDoc()).corrupt, true);
    },
  },
  {
    name: 'the sidecar fields round-trip',
    run: async (c) => {
      await c.engine.writeMeta({ persistAskedAt: 5, persistGranted: true });
      const m = await c.engine.readMeta();
      eq([m.persistAskedAt, m.persistGranted], [5, true]);
    },
  },
];
