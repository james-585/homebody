// T6 AC1 in node: the shared contract suite against the localStorage engine (fake storage) and
// against the IndexedDB engine on the in-memory double. The same suite runs against real IndexedDB
// in the page (tests/e2e/idb.spec.mjs).
import { test } from 'node:test';
import {
  createLocalEngine,
  createIdbEngine,
  projectToV1,
  STORAGE_KEY,
} from './helpers/hb-storage.mjs';
import { FakeStorage, quotaError } from './helpers/fake-storage.mjs';
import { createFakeIDB } from './helpers/fake-idb.mjs';
import { cases } from '../contract/engine-contract.mjs';

const circular = () => {
  const o = {};
  o.self = o;
  return o;
};

async function localCtx() {
  const fs = new FakeStorage();
  return {
    engine: createLocalEngine(fs),
    project: projectToV1,
    poison: circular,
    faults: {
      quota: (on) => (fs.failWrites = on ? quotaError : null),
      seedFuture: () => fs.setItem(STORAGE_KEY, '{"workouts":[],"schemaVersion":99}'),
      seedCorrupt: () => fs.setItem(STORAGE_KEY, '{"workouts": [oops'),
    },
  };
}

async function idbCtx() {
  const fake = createFakeIDB();
  const engine = createIdbEngine({ factory: fake.factory, name: 'contract', timeoutMs: 500 });
  await engine.open();
  return {
    engine,
    project: projectToV1,
    poison: () => () => 1, // a function cannot be structured-cloned
    faults: {
      quota: (on) => (fake.ctl.failTransaction = on ? quotaError() : null),
      seedFuture: () =>
        engine.writeDoc({ workouts: [], schemaVersion: 99 }, { seq: 1, schema: 99 }),
      seedCorrupt: () => fake.inspect('contract').stores.get('workouts').rows.set(0, { id: 1 }),
    },
  };
}

for (const [label, make] of [
  ['localStorage engine', localCtx],
  ['IndexedDB engine (in-memory double)', idbCtx],
]) {
  for (const c of cases) {
    test(`contract: ${label}: ${c.name}`, async () => c.run(await make()));
  }
}
