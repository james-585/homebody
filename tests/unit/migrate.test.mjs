import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../src/storage/migrate.js';
import { applyMigrations } from './helpers/migration-harness.mjs';
import { loadAllFixtures, stripHeader } from './helpers/load-fixtures.mjs';

const docs = () =>
  loadAllFixtures()
    .map((f) => f.data)
    .filter((d) => d && Array.isArray(d.workouts))
    .map(stripHeader);

const step = (from, to, fn) => ({ from, to, migrate: (d) => ({ ...fn(d), schemaVersion: to }) });

test('empty list is identity on every fixture', () => {
  assert.ok(docs().length >= 4);
  for (const d of docs()) {
    const r = runMigrations([], d, { current: 1 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.doc, d);
  }
});

test('accepts stored text as well as a parsed document', () => {
  const d = docs()[0];
  assert.deepEqual(runMigrations([], JSON.stringify(d)).doc, d);
});

test('steps run in from-order and the input is never mutated', () => {
  const list = [step(2, 3, (d) => ({ ...d, c: 1 })), step(1, 2, (d) => ({ ...d, b: 1 }))];
  const input = { workouts: [] };
  const frozen = JSON.stringify(input);
  const r = runMigrations(list, input, { current: 3 });
  assert.deepEqual(r.doc, { workouts: [], b: 1, c: 1, schemaVersion: 3 });
  assert.equal(JSON.stringify(input), frozen);
});

test('a step that does not set schemaVersion throws', () => {
  assert.throws(
    () => runMigrations([{ from: 1, to: 2, migrate: (d) => d }], { workouts: [] }, { current: 2 }),
    /did not set schemaVersion/,
  );
});

test('refuses corrupt and future data rather than guessing', () => {
  assert.deepEqual(runMigrations([], '{not json'), { ok: false, reason: 'corrupt' });
  assert.deepEqual(runMigrations([], '[1]'), { ok: false, reason: 'corrupt' });
  assert.deepEqual(runMigrations([], 'null'), { ok: false, reason: 'corrupt' });
  assert.deepEqual(runMigrations([], { schemaVersion: 'x' }), { ok: false, reason: 'corrupt' });
  assert.deepEqual(runMigrations([], { schemaVersion: 2 }, { current: 1 }), {
    ok: false,
    reason: 'future',
  });
});

test('parity with the harness applyMigrations over every fixture', () => {
  const lists = [
    [],
    [step(1, 2, (d) => ({ ...d, extra: true }))],
    [step(1, 2, (d) => ({ ...d, workouts: d.workouts.slice(1) }))], // lossy, must match too
  ];
  for (const list of lists) {
    const current = list.length ? 2 : 1;
    for (const d of docs()) {
      assert.deepEqual(runMigrations(list, d, { current }).doc, applyMigrations(list, d));
    }
  }
});
