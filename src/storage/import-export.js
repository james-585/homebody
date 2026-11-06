// Import and export logic (T7a). PURE: no I/O, no clock (time is passed in), never logs content.
// The store (src/hb-storage.js) owns every write; this module only decides what the result would be.
// Loaded lazily with import() on the first Import or Export tap; node tests import it directly.
import { validate, parseDate, IO_API_VERSION, LATEST_SCHEMA, LIMITS, REASONS } from './validate.js';

export { validate, parseDate, IO_API_VERSION, LATEST_SCHEMA, LIMITS, REASONS };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const list = (v) => (Array.isArray(v) ? v : []);
const dictOf = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Identity of a workout for duplicate detection: ids are not trusted, content is. */
function fingerprint(w) {
  const ex = list(w && w.exercises).map((e) =>
    e && typeof e === 'object'
      ? [e.name, e.sets, e.reps, e.time, e.weight, e.trackType, e.bilateral, e.side]
      : null,
  );
  return JSON.stringify([w && w.date, w && w.name, ex]);
}

const filled = (v) => v !== undefined && v !== null && v !== '';
/** A profile you have set up: any personal detail, or any equipment you own (not only a name). */
function profileInUse(p) {
  if (!p || typeof p !== 'object') return false;
  if (['name', 'age', 'weight', 'goal', 'sex', 'activity'].some((k) => filled(p[k]))) return true;
  const eq = p.equipment;
  if (!eq || typeof eq !== 'object') return false;
  return Object.values(eq).some((v) =>
    Array.isArray(v)
      ? v.length > 0
      : v && typeof v === 'object'
        ? Object.keys(v).length > 0
        : false,
  );
}

/**
 * Hands out ids no one else uses: the smallest unused above the current maximum, and when the
 * maximum is Number.MAX_SAFE_INTEGER the smallest unused positive safe integer. Never exceeds
 * MAX_SAFE_INTEGER; null when no id is left (the import is then refused).
 */
function idAllocator(used, startMax) {
  let max = Math.floor(startMax);
  return () => {
    let id;
    if (max < MAX_SAFE) {
      id = max + 1;
      max = id;
    } else {
      id = 1;
      while (used.has(id)) id++;
      if (id > MAX_SAFE) return null;
    }
    used.add(id);
    return id;
  };
}
const maxInt = (ids) => ids.reduce((m, x) => (Number.isFinite(x) && x > m ? x : m), 0);

/** Stable sort, newest first; a date that cannot be read sorts last. The app keeps history newest first. */
function newestFirst(items) {
  const t = (x) => parseDate(x && x.date) ?? -Infinity;
  return items
    .map((x, i) => [x, i, t(x)])
    .sort((a, b) => b[2] - a[2] || a[1] - b[1])
    .map((e) => e[0]);
}

/** Merge two lists that are newest first by `date`, keeping each list's own order. */
function mergeByDate(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const at = parseDate(a[i] && a[i].date);
    const bt = parseDate(b[j] && b[j].date);
    if (at !== null && bt !== null && bt > at) out.push(b[j++]);
    else out.push(a[i++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

const normal = (current) => ({
  workouts: list(current.workouts),
  personalRecords: dictOf(current.personalRecords),
  bodyMetrics: list(current.bodyMetrics),
  userPlans: list(current.userPlans),
  profile: current.profile && typeof current.profile === 'object' ? current.profile : null,
  favourites: list(current.favourites),
});

/**
 * The document an import would produce. `current` is what the store holds NOW (never the caller's
 * in-memory state); `incoming` is a validated doc. Nothing is mutated.
 * merge   keeps everything you have and adds what is new (yours win ties); it cannot remove data.
 * replace takes the file's six sets whole (history newest first, in-file duplicate ids re-id'd).
 * plans   merge limited to plans: everything else is yours, untouched.
 * The returned `doc` shares objects with `current` and `incoming` (no copy is made): callers must
 * not mutate it; the store writes it at once and replaces its own copy.
 * @returns {{ok:true, doc:object, counts:object} | {ok:false, reason:'id-space'}}
 */
export function mergeDocs(current, incoming, mode) {
  const plansOnly = mode === 'plans';
  const merge = mode === 'merge' || plansOnly;
  const cur = normal(current);
  const inc = plansOnly
    ? {
        ...incoming,
        workouts: [],
        personalRecords: {},
        bodyMetrics: [],
        favourites: [],
        profile: null,
      }
    : incoming;
  const counts = {
    workoutsAdded: 0,
    workoutsPresent: 0,
    workoutsReid: 0,
    workoutsRemoved: 0,
    prsAdded: 0,
    prsOverlap: 0,
    bodyAdded: 0,
    plansAdded: 0,
    plansPresent: 0,
    plansReid: 0,
    favouritesAdded: 0,
    profile: 'none',
    resultWorkouts: 0,
  };

  // workouts
  const curFp = new Set(cur.workouts.map(fingerprint));
  const curIds = merge ? cur.workouts.map((w) => w && w.id) : [];
  const used = new Set(curIds);
  const alloc = idAllocator(used, maxInt([...curIds, ...inc.workouts.map((w) => w.id)]));
  const fresh = [];
  for (const w of inc.workouts) {
    if (merge && curFp.has(fingerprint(w))) {
      counts.workoutsPresent++;
      continue;
    }
    let copy = w;
    if (used.has(w.id)) {
      const id = alloc();
      if (id === null) return { ok: false, reason: 'id-space' };
      copy = { ...w, id };
      counts.workoutsReid++;
    } else {
      used.add(w.id);
    }
    fresh.push(copy);
    counts.workoutsAdded++;
  }
  let workouts;
  if (plansOnly) workouts = current.workouts ?? [];
  else if (merge) workouts = mergeByDate(cur.workouts, fresh);
  else workouts = newestFirst(fresh);
  if (!merge) {
    const inFile = new Set(inc.workouts.map(fingerprint));
    counts.workoutsRemoved = cur.workouts.filter((w) => !inFile.has(fingerprint(w))).length;
  }
  counts.resultWorkouts = workouts.length;

  // personal records (yours win: comparing two records needs unit-aware direction)
  let personalRecords;
  if (plansOnly) {
    personalRecords = current.personalRecords ?? {};
  } else if (merge) {
    personalRecords = { ...cur.personalRecords };
    for (const k of Object.keys(inc.personalRecords)) {
      if (hasOwn(cur.personalRecords, k)) counts.prsOverlap++;
      else {
        Object.defineProperty(personalRecords, k, {
          value: inc.personalRecords[k],
          enumerable: true,
          writable: true,
          configurable: true,
        });
        counts.prsAdded++;
      }
    }
  } else {
    personalRecords = inc.personalRecords;
  }

  // body metrics: union by exact date, yours win
  let bodyMetrics;
  if (plansOnly) {
    bodyMetrics = current.bodyMetrics ?? [];
  } else if (merge) {
    const dates = new Set(cur.bodyMetrics.map((r) => r && r.date));
    const add = inc.bodyMetrics.filter((r) => !dates.has(r.date));
    counts.bodyAdded = add.length;
    bodyMetrics = mergeByDate(cur.bodyMetrics, add);
  } else {
    bodyMetrics = newestFirst(inc.bodyMetrics);
  }

  // plans: a plan id you already have keeps yours; other collisions inside the file get a new id
  const curPlanIds = new Set(merge ? cur.userPlans.map((p) => p && p.id) : []);
  const planUsed = new Set(curPlanIds);
  const planAlloc = idAllocator(planUsed, maxInt([...planUsed, ...inc.userPlans.map((p) => p.id)]));
  const userPlans = merge ? [...cur.userPlans] : [];
  for (const p of inc.userPlans) {
    if (curPlanIds.has(p.id)) {
      counts.plansPresent++;
      continue;
    }
    let copy = p;
    if (planUsed.has(p.id)) {
      const id = planAlloc();
      if (id === null) return { ok: false, reason: 'id-space' };
      copy = { ...p, id };
      counts.plansReid++;
    } else {
      planUsed.add(p.id);
    }
    userPlans.push(copy);
    counts.plansAdded++;
  }

  // favourites
  let favourites;
  if (plansOnly) {
    favourites = current.favourites ?? [];
  } else if (merge) {
    const have = new Set(cur.favourites);
    favourites = [...cur.favourites];
    for (const f of inc.favourites) {
      if (!have.has(f)) {
        have.add(f);
        favourites.push(f);
        counts.favouritesAdded++;
      }
    }
  } else {
    favourites = inc.favourites;
  }

  // profile: Merge takes the file's only when you have none set up (no detail, no equipment);
  // Replace takes the file's and says what changes
  let profile;
  const mine = profileInUse(cur.profile);
  if (plansOnly) {
    profile = current.profile ?? null;
  } else if (merge) {
    if (!mine && inc.profile) {
      profile = inc.profile;
      counts.profile = 'taken';
    } else {
      profile = current.profile ?? null;
      counts.profile = mine ? 'kept' : 'none';
    }
  } else {
    profile = inc.profile;
    counts.profile = inc.profile ? (mine ? 'replaced' : 'taken') : mine ? 'removed' : 'none';
  }

  return {
    ok: true,
    doc: { workouts, personalRecords, bodyMetrics, userPlans, profile, favourites },
    counts,
  };
}

/** True when applying `counts` in a merge-like mode would change nothing. */
export function addsNothing(counts) {
  return (
    counts.workoutsAdded === 0 &&
    counts.prsAdded === 0 &&
    counts.bodyAdded === 0 &&
    counts.plansAdded === 0 &&
    counts.favouritesAdded === 0 &&
    counts.profile !== 'taken'
  );
}

function range(workouts) {
  let lo = null;
  let hi = null;
  let loT = Infinity;
  let hiT = -Infinity;
  for (const w of workouts) {
    const t = parseDate(w && w.date);
    if (t === null) continue;
    if (t < loT) [loT, lo] = [t, w.date];
    if (t > hiT) [hiT, hi] = [t, w.date];
  }
  return lo === null ? null : { from: lo, to: hi };
}

/** Clip by code points, so a surrogate pair is never cut in half. */
const clip = (s, n) => (typeof s === 'string' ? [...s].slice(0, n).join('') : null);

/** In file / new / already yours / yours only, by each category's own identity. */
function category(inFile, mine, key) {
  const have = new Set(mine.map(key));
  const file = new Set(inFile.map(key));
  const present = inFile.filter((x) => have.has(key(x))).length;
  return {
    inFile: inFile.length,
    mine: mine.length,
    new: inFile.length - present,
    present,
    removed: mine.filter((x) => !file.has(key(x))).length,
  };
}

const PLAN_LIST_MAX = 20;

/**
 * Plain numbers and clipped strings, for the preview (the UI renders only this, as text nodes,
 * and computes nothing from its own state). Writes nothing.
 *   file / current   counts, date range, profile name (clipped), partial flag, `_exported`
 *   cats             per category (workouts, prs, body, plans, favourites): inFile, mine, new,
 *                    present, removed (mode independent)
 *   merge / replace / onlyPlans  per mode: the counts of mergeDocs, `nothing` (the UI must not
 *                    recompute it), mirrorStale, and for replace `allowed`
 *   plans            first 20 plans in file order {name (40 chars), days, present} and the total
 *   warnings         dropped, futureDates, duplicateIds (inside the file), unrecognised (count) and
 *                    unrecognisedWhere (record paths, never values)
 */
export function summarize(current, validated, { mirrorCeiling = Infinity } = {}) {
  const d = validated.doc;
  const cur = normal(current);
  const side = (mode) => {
    const m = mergeDocs(current, d, mode);
    if (!m.ok) return { error: m.reason };
    return {
      ...m.counts,
      // true when applying would change nothing (spec 4.3.5, 4.10): the UI shows Done, not Import.
      // Replace is never 'nothing': it rewrites the stores and takes a snapshot even on identical data.
      nothing: mode !== 'replace' && addsNothing(m.counts),
      mirrorStale: JSON.stringify(m.doc).length + 24 > mirrorCeiling,
    };
  };
  const replace = side('replace');
  if (!replace.error) replace.allowed = !validated.partial.partial;
  const planIds = new Set(cur.userPlans.map((p) => p && p.id));
  return {
    file: {
      version: validated.version,
      exported: validated.exported,
      workouts: d.workouts.length,
      personalRecords: Object.keys(d.personalRecords).length,
      bodyMetrics: d.bodyMetrics.length,
      userPlans: d.userPlans.length,
      favourites: d.favourites.length,
      hasProfile: !!d.profile,
      profileName: d.profile ? clip(d.profile.name, 500) : null,
      dateRange: range(d.workouts),
      partial: validated.partial.partial,
      partialReason: validated.partial.reason,
    },
    current: {
      workouts: cur.workouts.length,
      personalRecords: Object.keys(cur.personalRecords).length,
      bodyMetrics: cur.bodyMetrics.length,
      userPlans: cur.userPlans.length,
      favourites: cur.favourites.length,
      hasProfile: profileInUse(cur.profile),
      dateRange: range(cur.workouts),
    },
    cats: {
      workouts: category(d.workouts, cur.workouts, fingerprint),
      prs: category(Object.keys(d.personalRecords), Object.keys(cur.personalRecords), (k) => k),
      body: category(d.bodyMetrics, cur.bodyMetrics, (r) => r && r.date),
      plans: category(d.userPlans, cur.userPlans, (p) => p && p.id),
      favourites: category(d.favourites, cur.favourites, (f) => f),
    },
    plans: {
      total: d.userPlans.length,
      items: d.userPlans.slice(0, PLAN_LIST_MAX).map((p) => ({
        name: clip(p.name, 500), // the name cap: the UI does the 40-grapheme clip and the ellipsis
        days: p.planDays.length,
        present: planIds.has(p.id),
      })),
    },
    warnings: { ...validated.warnings },
    merge: side('merge'),
    replace,
    onlyPlans: side('plans'),
  };
}

/**
 * The export file. Compact JSON (not pretty-printed). Header: _vaultfit, _version (the current
 * schema), _exported, _containsHealthData, and for the plain Export in unreadable-data states
 * _partial + _partialReason. No profile name in the header or the filename. Refuses (reason
 * 'too-large') a file the importer would refuse for size, so the app never produces a backup it
 * cannot restore; the caller points the user at the raw "as found" export. After building, the
 * same validator runs over the text: records it would refuse and fields it would ignore are
 * reported in `warnings`, and the file is still produced. `bytes` is the exact UTF-8 size.
 */
export function buildExport(state, { now, partialReason = null, migrate, uncapped = false } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('buildExport: now must be a finite number');
  const st = state || {};
  const exported = new Date(now).toISOString();
  const payload = {
    _vaultfit: true,
    _version: LATEST_SCHEMA,
    _exported: exported,
    _containsHealthData: true,
  };
  if (partialReason) {
    payload._partial = true;
    payload._partialReason = partialReason;
  }
  payload.workouts = list(st.workouts);
  payload.personalRecords = dictOf(st.personalRecords);
  payload.bodyMetrics = list(st.bodyMetrics);
  payload.userPlans = list(st.userPlans);
  payload.profile = st.profile ?? null;
  payload.favourites = list(st.favourites);
  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    return { ok: false, reason: 'not-serialisable' };
  }
  const bytes = new TextEncoder().encode(text).length;
  const over = bytes > LIMITS.maxBytes;
  if (over && !uncapped) return { ok: false, reason: 'too-large' };
  // `uncapped` (the "Save as text file" escape for a history the importer would refuse for size): the same text,
  // not checked by the validator (it would refuse the size), so its warnings are empty and `unchecked` says so.
  const v = over ? { ok: true, warnings: { dropped: 0 } } : validate(text, { now, migrate });
  const day = exported.slice(0, 10);
  return {
    ok: true,
    text,
    bytes,
    filename: partialReason ? `HomeBody_partial_${day}.vaultfit` : `HomeBody_${day}.vaultfit`,
    partial: !!partialReason,
    unchecked: over,
    warnings: v.ok
      ? { refused: [], dropped: v.warnings.dropped }
      : { refused: v.problems, dropped: 0 },
  };
}
