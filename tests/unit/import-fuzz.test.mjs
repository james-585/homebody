// T7a: seeded fuzz and property test of the validator. No dependency: a small PRNG, fixed seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io, opts, real, NOW } from './helpers/io.mjs';

const { validate, LIMITS } = io;
const ITERATIONS = 2000;

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function base() {
  const f = real();
  f.workouts = f.workouts.slice(0, 12);
  f.bodyMetrics = f.bodyMetrics.slice(0, 3);
  f.personalRecords = Object.fromEntries(Object.entries(f.personalRecords).slice(0, 6));
  f.userPlans[0].planDays = f.userPlans[0].planDays.slice(0, 2);
  f._version = 2;
  f.favourites = ['Plank', "Farmer's Walk"];
  return f;
}

const INF = '__INF__';
const VALUES = [
  null,
  true,
  false,
  '',
  'x',
  '<img src=x onerror=alert(1)>',
  "'); alert(1)//",
  '&#39;',
  '\u0007',
  '\u202E',
  '\uD800',
  'x'.repeat(30000),
  0,
  -1,
  1.5,
  2 ** 53,
  -(2 ** 53),
  INF,
  [],
  {},
  [[[[]]]],
  { a: { b: { c: 1 } } },
  '2026-01-01 (<img>)',
  '2999-01-01T00:00:00.000Z',
];

/** Every [parent, key] position in a tree (own enumerable). */
function slots(node, out = []) {
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      out.push([node, k]);
      slots(node[k], out);
    }
  }
  return out;
}

function mutate(doc, rnd) {
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const all = slots(doc);
    const [parent, key] = all[Math.floor(rnd() * all.length)];
    const pick = rnd();
    if (pick < 0.45) {
      parent[key] = VALUES[Math.floor(rnd() * VALUES.length)];
    } else if (pick < 0.6) {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (pick < 0.7) {
      Object.defineProperty(parent, '__proto__', {
        value: { polluted: 1 },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else if (pick < 0.78) {
      parent[
        ['hbSeq', 'seq', 'schemaVersion', 'constructor', 'prototype', 'junk'][Math.floor(rnd() * 6)]
      ] = 7;
    } else if (pick < 0.88 && Array.isArray(parent[key])) {
      const a = parent[key];
      const extra = Math.floor(rnd() * 400);
      for (let j = 0; j < extra && a.length; j++) a.push(structuredClone(a[j % a.length]));
    } else if (pick < 0.94) {
      const other = all[Math.floor(rnd() * all.length)];
      [parent[key], other[0][other[1]]] = [other[0][other[1]], parent[key]];
    } else {
      parent[key] = JSON.parse(JSON.stringify(parent[key] ?? null));
    }
  }
}

function text(doc) {
  return JSON.stringify(doc).replaceAll(`"${INF}"`, '1e999');
}

/** The invariants of every document the validator accepts. */
function check(node, path, depth = 0) {
  assert.ok(depth < 8, `depth at ${path}`);
  if (typeof node === 'number') assert.ok(Number.isFinite(node), `finite at ${path}`);
  else if (typeof node === 'string') {
    assert.ok(node.length <= LIMITS.notesMax, `string cap at ${path}`);
    for (let i = 0; i < node.length; i++) {
      const c = node.charCodeAt(i);
      assert.ok(!(c <= 8 || (c >= 11 && c <= 31) || (c >= 127 && c <= 159)), `control at ${path}`);
      assert.ok(
        c !== 0x2028 &&
          c !== 0x2029 &&
          !(c >= 0x202a && c <= 0x202e) &&
          !(c >= 0x2066 && c <= 0x2069),
        `bidi at ${path}`,
      );
    }
  } else if (Array.isArray(node)) {
    assert.ok(node.length <= LIMITS.workouts, `array cap at ${path}`);
    node.forEach((v, i) => check(v, `${path}[${i}]`, depth + 1));
  } else if (node && typeof node === 'object') {
    assert.equal(Object.getPrototypeOf(node), Object.prototype, `plain prototype at ${path}`);
    for (const k of Object.keys(node)) {
      assert.ok(!['__proto__', 'constructor', 'prototype'].includes(k), `dangerous key at ${path}`);
      assert.ok(!['hbSeq', 'seq', 'schemaVersion'].includes(k), `counter key at ${path}`);
      check(node[k], `${path}.${k}`, depth + 1);
    }
  }
}

test(`fuzz: ${ITERATIONS} mutations of the fixture never throw, never pollute, accepted output is clean`, () => {
  const rnd = prng(20261103);
  let accepted = 0;
  let refused = 0;
  const reasons = new Set();
  for (let i = 0; i < ITERATIONS; i++) {
    const doc = base();
    mutate(doc, rnd);
    const t = text(doc);
    let r;
    assert.doesNotThrow(() => (r = validate(t, opts())), `iteration ${i}`);
    assert.equal({}.polluted, undefined, `iteration ${i}`);
    assert.equal(Object.keys(Object.prototype).length, 0, `iteration ${i}`);
    if (!r.ok) {
      refused++;
      reasons.add(r.reason);
      assert.equal(r.doc, undefined);
      assert.ok(r.problems.length >= 1 && r.problems.length <= LIMITS.problemsMax);
      assert.ok(!JSON.stringify(r).includes('alert(1)'), 'no value from the file in an error');
      continue;
    }
    accepted++;
    check(r.doc, 'doc');
    // fixed point: what was accepted validates to itself, with nothing left to drop
    const again = validate(text({ _vaultfit: true, _version: 2, ...r.doc }), opts());
    assert.equal(again.ok, true, `iteration ${i} re-validates`);
    assert.deepEqual(again.doc, r.doc);
    assert.equal(again.warnings.dropped, 0);
  }
  console.log(
    `# fuzz: ${accepted} accepted, ${refused} refused, reasons: ${[...reasons].sort().join(' ')}`,
  );
  assert.ok(accepted > 100 && refused > 100, 'the mutations exercise both outcomes');
});

test('fuzz: arbitrary text (truncations and byte noise) never throws', () => {
  const rnd = prng(7);
  const t = text(base());
  for (let i = 0; i < 400; i++) {
    const cut = Math.floor(rnd() * t.length);
    const noisy =
      rnd() < 0.5
        ? t.slice(0, cut)
        : t.slice(0, cut) + String.fromCharCode(Math.floor(rnd() * 0xffff)) + t.slice(cut + 1);
    assert.doesNotThrow(() => validate(noisy, { now: NOW, migrate: undefined }));
  }
});
