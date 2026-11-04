// Import validation (T7a). PURE: no I/O, no clock (time is passed in), never logs what it reads.
// An imported file is data, never instructions (CLAUDE.md principle 8): it is size-limited, parsed
// in try, and every kept field is COPIED BY NAME into a fresh object after a type, range and string
// check. Unknown keys are dropped and counted. One invalid record rejects the whole file.
// Loaded lazily (dynamic import) by src/hb-storage.js; node tests import it directly.

export const IO_API_VERSION = 1; // must equal IO_API_VERSION in src/hb-storage.js (skew guard)
export const LATEST_SCHEMA = 2; // must equal the app's schema (hb-storage.js LATEST_SCHEMA)

export const LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024, // must equal IMPORT_MAX_BYTES in src/hb-storage.js
  workouts: 20000,
  exercisesPerWorkout: 100,
  plans: 200,
  planDays: 100,
  exercisesPerDay: 100,
  bodyMetrics: 20000,
  personalRecords: 2000,
  favourites: 1000,
  progressionLog: 5000,
  equipmentList: 100,
  equipmentDict: 50,
  nameMax: 500,
  notesMax: 20000,
  problemsMax: 20,
});

const MIN_DATE_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 86400000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// Fixed set of reason codes (the UI maps them to copy; none carries a value from the file).
export const REASONS = Object.freeze([
  'too-large',
  'not-text',
  'empty',
  'not-json',
  'not-homebody',
  'bad-version',
  'newer-version',
  'missing-workouts',
  'missing-field',
  'bad-type',
  'out-of-range',
  'too-long',
  'too-many',
  'bad-chars',
  'bad-key',
  'bad-enum',
  'bad-date',
  'migration-failed',
]);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
const BAD = Symbol('bad');
const STOP = Symbol('stop');

// String rule. Controls are refused except \t and \n; U+2028/2029; bidi overrides and isolates;
// lone surrogates. Name-like fields also refuse < and >; notes allow them (they only ever reach
// escaped text sinks). Nothing is silently stripped.
function hasControl(s) {
  for (let i = 0; i < s.length; i++) {
    const x = s.charCodeAt(i);
    if (
      x <= 8 ||
      (x >= 11 && x <= 31) ||
      (x >= 127 && x <= 159) ||
      x === 0x2028 ||
      x === 0x2029 ||
      (x >= 0x202a && x <= 0x202e) ||
      (x >= 0x2066 && x <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ANGLE = /[<>]/;
const ID_TOKEN = /^[a-z0-9_]{1,40}$/;
const PLATE_KEY = /^\d{1,4}(\.\d{1,3})?$/;
const GROUP = /^[A-Za-z0-9]{1,8}$/;

const GOALS = ['lose_fat', 'build_muscle', 'improve_fitness', 'increase_strength', 'maintain'];
const SEXES = ['male', 'female', 'other'];
const ACTIVITIES = ['sedentary', 'light', 'moderate', 'active', 'athlete'];
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const TRACK = ['reps', 'time'];
const SIDES = ['left', 'right'];
const UNITS = ['kg', 'sec'];
const PARTIAL_REASONS = ['unreadable', 'newer', 'unavailable'];

/** Strict calendar date or date-time (ISO 8601 subset) to epoch ms, or null. Never Date.parse. */
export function parseDate(s) {
  if (typeof s !== 'string' || s.length > 40) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      s,
    );
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, sec = 0] = m.slice(1, 7).map(Number);
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const back = new Date(t);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    sec > 59
  ) {
    return null;
  }
  let off = 0;
  if (m[8] && m[8] !== 'Z') {
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) return null;
    off = (m[8][0] === '-' ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  return t - off;
}

// ---- field checkers: (c, value, where) -> clean value, or BAD after recording a problem -----------
function problem(c, reason, where) {
  c.problems.push({ reason, where });
  if (c.problems.length >= LIMITS.problemsMax) throw STOP;
  return BAD;
}

function num(c, v, where, lo, hi, o = {}) {
  if (v === null && o.nullable) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return problem(c, 'bad-type', where);
  if (o.int && !Number.isInteger(v)) return problem(c, 'bad-type', where);
  if (v < lo || v > hi) return problem(c, 'out-of-range', where);
  return v;
}

function str(c, v, where, kind, o = {}) {
  if (v === null && o.nullable) return null;
  if (typeof v !== 'string') return problem(c, 'bad-type', where);
  const max = o.max ?? (kind === 'note' ? LIMITS.notesMax : LIMITS.nameMax);
  if (v.length > max) return problem(c, 'too-long', where);
  if (hasControl(v) || LONE_SURROGATE.test(v)) return problem(c, 'bad-chars', where);
  if (kind === 'name' && ANGLE.test(v)) return problem(c, 'bad-chars', where);
  return v;
}

function oneOf(c, v, where, list, o = {}) {
  if (v === null && o.nullable) return null;
  if (o.empty && v === '') return '';
  if (typeof v !== 'string' || !list.includes(v)) return problem(c, 'bad-enum', where);
  return v;
}

function bool(c, v, where) {
  return typeof v === 'boolean' ? v : problem(c, 'bad-type', where);
}

function date(c, v, where) {
  const t = parseDate(v);
  if (t === null || t < MIN_DATE_MS || t > c.now + 366 * DAY_MS) {
    return problem(c, typeof v === 'string' ? 'bad-date' : 'bad-type', where);
  }
  if (t > c.now + DAY_MS) c.futureDates++;
  return v;
}

function arr(c, a, where, max, each) {
  if (!Array.isArray(a)) return problem(c, 'bad-type', where);
  if (a.length > max) return problem(c, 'too-many', where);
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const v = each(c, a[i], `${where}[${i}]`);
    if (v !== BAD) out.push(v);
  }
  return out;
}

/** Copy a record by spec: {key: {req?, f(c, v, where)}}. Unknown keys are dropped and counted. */
function rec(c, o, where, spec) {
  if (!isObj(o)) return problem(c, 'bad-type', where);
  const out = {};
  for (const k of Object.keys(spec)) {
    if (!hasOwn(o, k)) {
      if (spec[k].req) problem(c, 'missing-field', `${where}.${k}`);
      continue;
    }
    const v = spec[k].f(c, o[k], `${where}.${k}`);
    if (v !== BAD) out[k] = v;
  }
  for (const k of Object.keys(o)) if (!hasOwn(spec, k)) c.dropped++;
  return out;
}

function define(out, k, v) {
  Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/**
 * A dictionary: keys are checked (never __proto__/constructor/prototype, the string rule for
 * names or a token pattern) and values by `each`. Paths use the key's position, never its text.
 */
function dict(c, o, where, max, keyRule, each) {
  if (!isObj(o)) return problem(c, 'bad-type', where);
  const keys = Object.keys(o);
  if (keys.length > max) return problem(c, 'too-many', where);
  const out = {};
  keys.forEach((k, i) => {
    const w = `${where}[key ${i}]`;
    if (DANGEROUS.has(k)) return problem(c, 'bad-key', w);
    if (keyRule === 'name') {
      if (str(c, k, w, 'name') === BAD) return;
    } else if (!keyRule.test(k)) {
      return problem(c, 'bad-key', w);
    }
    const v = each(c, o[k], w);
    if (v !== BAD) define(out, k, v);
  });
  return out;
}

// ---- record specs ------------------------------------------------------------------------------
const f = {
  name: (c, v, w) => str(c, v, w, 'name'),
  nameOrNull: (c, v, w) => str(c, v, w, 'name', { nullable: true }),
  note: (c, v, w) => str(c, v, w, 'note', { nullable: true }),
  date,
  bool,
  safeInt: (c, v, w) => num(c, v, w, 0, MAX_SAFE, { int: true }),
  planId: (c, v, w) => num(c, v, w, 0, MAX_SAFE),
  count: (c, v, w) => num(c, v, w, 0, 100000, { int: true }),
  countN: (c, v, w) => num(c, v, w, 0, 100000, { int: true, nullable: true }),
  amount: (c, v, w) => num(c, v, w, 0, 1e9),
  amountN: (c, v, w) => num(c, v, w, 0, 1e9, { nullable: true }),
  mass: (c, v, w) => num(c, v, w, 0, 5000),
  massN: (c, v, w) => num(c, v, w, 0, 1000, { nullable: true }),
  rpe: (c, v, w) => num(c, v, w, 0, 10, { nullable: true }),
  track: (c, v, w) => oneOf(c, v, w, TRACK),
  side: (c, v, w) => oneOf(c, v, w, SIDES, { nullable: true }),
};

const EXERCISE = {
  name: { req: true, f: f.name },
  sets: { req: true, f: (c, v, w) => num(c, v, w, 0, 1000, { int: true }) },
  reps: { f: f.amount },
  time: { f: f.amount },
  weight: { f: f.mass },
  trackType: { f: f.track },
  bilateral: { f: f.bool },
  side: { f: f.side },
};

const WORKOUT = {
  id: { req: true, f: f.safeInt },
  name: { req: true, f: f.name },
  date: { req: true, f: f.date },
  exercises: {
    req: true,
    f: (c, v, w) =>
      arr(c, v, w, LIMITS.exercisesPerWorkout, (c2, e, w2) => rec(c2, e, w2, EXERCISE)),
  },
  totalVolume: { f: f.amountN },
  totalSets: { f: f.countN },
  calories: { f: f.amountN },
  duration: { f: f.amountN },
  bodyWeight: { f: f.massN },
  rpe: { f: f.rpe },
  notes: { f: f.note },
  planId: { f: f.planId },
};

const PR = {
  value: { req: true, f: (c, v, w) => num(c, v, w, 0, 1e6) },
  unit: { req: true, f: (c, v, w) => oneOf(c, v, w, UNITS) },
};

const BODY = {
  date: { req: true, f: f.date },
  weight: { f: f.massN },
  waist: { f: f.massN },
  bodyfat: { f: (c, v, w) => num(c, v, w, 0, 100, { nullable: true }) },
};

const PLAN_EXERCISE = {
  name: { req: true, f: f.name },
  sets: EXERCISE.sets,
  reps: EXERCISE.reps,
  time: EXERCISE.time,
  weight: EXERCISE.weight,
  trackType: EXERCISE.trackType,
  bilateral: EXERCISE.bilateral,
  side: EXERCISE.side,
  supersetGroup: {
    f: (c, v, w) => {
      const s = str(c, v, w, 'name', { nullable: true, max: 8 });
      return s === BAD || s === null || GROUP.test(s) ? s : problem(c, 'bad-chars', w);
    },
  },
};

const PLAN_DAY = {
  name: { req: true, f: f.name },
  note: { f: f.note },
  exercises: {
    req: true,
    f: (c, v, w) =>
      arr(c, v, w, LIMITS.exercisesPerDay, (c2, e, w2) => rec(c2, e, w2, PLAN_EXERCISE)),
  },
};

const timestamp = (c, v, w) => {
  const n = num(c, v, w, 0, MAX_SAFE, { int: true });
  if (n === BAD) return BAD;
  if (n < MIN_DATE_MS || n > c.now + 366 * DAY_MS) return problem(c, 'bad-date', w);
  return n;
};

const PLAN = {
  id: { req: true, f: (c, v, w) => num(c, v, w, Number.MIN_VALUE, MAX_SAFE) },
  name: { req: true, f: f.name },
  desc: { f: f.note },
  author: { f: f.nameOrNull },
  goal: { f: (c, v, w) => oneOf(c, v, w, GOALS, { nullable: true, empty: true }) },
  level: { f: (c, v, w) => oneOf(c, v, w, LEVELS, { nullable: true }) },
  daysPerWeek: { f: (c, v, w) => num(c, v, w, 0, 14, { int: true, nullable: true }) },
  weeks: { f: (c, v, w) => num(c, v, w, 0, 520, { int: true, nullable: true }) },
  planDays: {
    req: true,
    f: (c, v, w) => arr(c, v, w, LIMITS.planDays, (c2, d, w2) => rec(c2, d, w2, PLAN_DAY)),
  },
  _generated: { f: f.bool },
  _weekCycle: { f: (c, v, w) => num(c, v, w, 0, 52, { int: true, nullable: true }) },
  _progressionLog: { f: (c, v, w) => dict(c, v, w, LIMITS.progressionLog, 'name', timestamp) },
};

const weights = (c, v, w) =>
  arr(c, v, w, LIMITS.equipmentList, (c2, x, w2) => num(c2, x, w2, 0, 1000));
const tokens = (c, v, w) =>
  arr(c, v, w, LIMITS.equipmentList, (c2, x, w2) =>
    typeof x === 'string' && ID_TOKEN.test(x) ? x : problem(c2, 'bad-chars', w2),
  );
const EQUIPMENT = {
  dumbbells: { f: weights },
  kettlebells: { f: weights },
  barbell_plates: { f: weights },
  bench: { f: tokens },
  rig: { f: tokens },
  bands: { f: tokens },
  barbell_bars: {
    f: (c, v, w) => dict(c, v, w, LIMITS.equipmentDict, ID_TOKEN, (c2, x, w2) => bool(c2, x, w2)),
  },
  barbell_plate_count: {
    f: (c, v, w) =>
      dict(c, v, w, LIMITS.equipmentDict, PLATE_KEY, (c2, x, w2) =>
        num(c2, x, w2, 0, 1000, { int: true }),
      ),
  },
};

const PROFILE = {
  name: { f: f.name },
  age: { f: (c, v, w) => num(c, v, w, 0, 150, { int: true, nullable: true }) },
  sex: { f: (c, v, w) => oneOf(c, v, w, SEXES, { nullable: true, empty: true }) },
  weight: { f: f.massN },
  goal: { f: (c, v, w) => oneOf(c, v, w, GOALS, { nullable: true, empty: true }) },
  activity: { f: (c, v, w) => oneOf(c, v, w, ACTIVITIES, { nullable: true, empty: true }) },
  equipment: { f: (c, v, w) => rec(c, v, w, EQUIPMENT) },
};

const TOP_KEYS = new Set([
  '_vaultfit',
  '_version',
  '_exported',
  '_name',
  '_containsHealthData',
  '_partial',
  '_partialReason',
  'workouts',
  'personalRecords',
  'bodyMetrics',
  'userPlans',
  'profile',
  'favourites',
]);

/** The six sets of one document. `workouts` is required by the caller; the rest default to empty. */
function checkSets(c, raw) {
  const out = {};
  out.workouts = arr(c, raw.workouts, 'workouts', LIMITS.workouts, (c2, w, p) =>
    rec(c2, w, p, WORKOUT),
  );
  if (Array.isArray(out.workouts)) {
    const ids = new Set();
    for (const w of out.workouts) {
      if (ids.has(w.id)) c.duplicateIds++;
      else ids.add(w.id);
    }
  }
  out.personalRecords = hasOwn(raw, 'personalRecords')
    ? dict(c, raw.personalRecords, 'personalRecords', LIMITS.personalRecords, 'name', (c2, v, w) =>
        rec(c2, v, w, PR),
      )
    : {};
  out.bodyMetrics = hasOwn(raw, 'bodyMetrics')
    ? arr(c, raw.bodyMetrics, 'bodyMetrics', LIMITS.bodyMetrics, (c2, v, w) => rec(c2, v, w, BODY))
    : [];
  out.userPlans = hasOwn(raw, 'userPlans')
    ? arr(c, raw.userPlans, 'userPlans', LIMITS.plans, (c2, v, w) => rec(c2, v, w, PLAN))
    : [];
  out.profile =
    hasOwn(raw, 'profile') && raw.profile !== null ? rec(c, raw.profile, 'profile', PROFILE) : null;
  out.favourites = hasOwn(raw, 'favourites')
    ? arr(c, raw.favourites, 'favourites', LIMITS.favourites, (c2, v, w) => str(c2, v, w, 'name'))
    : [];
  return out;
}

const fail = (reason, where = '', problems = null) => ({
  ok: false,
  reason,
  where,
  problems: problems || [{ reason, where }],
});

/**
 * @param {string} input   the file text
 * @param {{now:number, migrate?:(doc:object)=>{ok:boolean,doc?:object}, maxBytes?:number}} opts
 * @returns {{ok:true, doc:object, version:number, exported:string|null,
 *            partial:{partial:boolean, reason:string|null},
 *            warnings:{dropped:number, futureDates:number, duplicateIds:number}}
 *          | {ok:false, reason:string, where:string, problems:Array<{reason:string,where:string}>}}
 */
export function validate(input, opts) {
  const maxBytes = opts.maxBytes ?? LIMITS.maxBytes;
  if (typeof input !== 'string') return fail('not-text');
  if (input.length > maxBytes) return fail('too-large');
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; // one leading BOM
  if (text.trim() === '') return fail('empty');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('not-json');
  }
  if (!isObj(raw) || raw._vaultfit !== true) return fail('not-homebody');
  const version = hasOwn(raw, '_version') ? raw._version : 1; // pre-M1 files only ever had _vaultfit
  if (!Number.isInteger(version) || version < 1) return fail('bad-version', '_version');
  if (version > LATEST_SCHEMA) return fail('newer-version', '_version');
  if (!hasOwn(raw, 'workouts')) return fail('missing-workouts', 'workouts');

  const c = {
    now: opts.now,
    problems: [],
    dropped: 0,
    futureDates: 0,
    duplicateIds: 0,
  };
  let doc;
  let exported = null;
  let partial = false;
  let partialReason = null;
  try {
    if (hasOwn(raw, '_exported')) {
      const e = date(c, raw._exported, '_exported');
      if (e !== BAD) exported = e;
    }
    if (hasOwn(raw, '_containsHealthData')) bool(c, raw._containsHealthData, '_containsHealthData');
    if (hasOwn(raw, '_partial')) {
      const p = bool(c, raw._partial, '_partial');
      if (p !== BAD) partial = p;
    }
    if (hasOwn(raw, '_partialReason')) {
      const r = oneOf(c, raw._partialReason, '_partialReason', PARTIAL_REASONS);
      if (r !== BAD) partialReason = r;
    }
    for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) c.dropped++;
    doc = checkSets(c, raw);
  } catch (e) {
    if (e !== STOP) return fail('bad-type', '', null);
  }
  if (c.problems.length > 0) return fail(c.problems[0].reason, c.problems[0].where, c.problems);

  if (version < LATEST_SCHEMA) {
    // Older format: lift it through the migration chain, then check the result against the
    // current shape again (a migration is code, not a trusted source).
    let m;
    try {
      m = opts.migrate ? opts.migrate({ ...doc, schemaVersion: version }) : null;
    } catch {
      m = null;
    }
    if (!m || !m.ok || !isObj(m.doc)) return fail('migration-failed');
    const c2 = { now: opts.now, problems: [], dropped: 0, futureDates: 0, duplicateIds: 0 };
    try {
      doc = checkSets(c2, m.doc);
    } catch (e) {
      if (e !== STOP) return fail('migration-failed');
    }
    if (c2.problems.length > 0) return fail('migration-failed', c2.problems[0].where);
  }

  return {
    ok: true,
    doc,
    version,
    exported,
    partial: { partial, reason: partialReason },
    warnings: { dropped: c.dropped, futureDates: c.futureDates, duplicateIds: c.duplicateIds },
  };
}
