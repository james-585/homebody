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
    e && typeof e === 'object' ? [e.name, e.sets, e.reps, e.time, e.weight] : null,
  );
  return JSON.stringify([w && w.date, w && w.name, ex]);
}

/**
 * Hands out ids no one else uses: the smallest unused above the current maximum, and when the
 * maximum is Number.MAX_SAFE_INTEGER the smallest unused positive safe integer. Never exceeds
 * MAX_SAFE_INTEGER; null when no id is left (the import is then refused).
 */
function idAllocator(used, startMax) {
  let max = startMax;
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

/**
 * The document an import would produce. `current` is what the store holds NOW (never the caller's
 * in-memory state); `incoming` is a validated doc. Nothing is mutated.
 * merge   keeps everything you have and adds what is new (yours win ties); it cannot remove data.
 * replace takes the file's six sets whole.
 * @returns {{ok:true, doc:object, counts:object} | {ok:false, reason:'id-space'}}
 */
export function mergeDocs(current, incoming, mode) {
  const merge = mode === 'merge';
  const cur = {
    workouts: list(current.workouts),
    personalRecords: dictOf(current.personalRecords),
    bodyMetrics: list(current.bodyMetrics),
    userPlans: list(current.userPlans),
    profile: current.profile && typeof current.profile === 'object' ? current.profile : null,
    favourites: list(current.favourites),
  };
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
  const used = new Set(merge ? cur.workouts.map((w) => w && w.id) : []);
  const alloc = idAllocator(
    used,
    maxInt([
      ...(merge ? cur.workouts.map((w) => w && w.id) : []),
      ...incoming.workouts.map((w) => w.id),
    ]),
  );
  const fresh = [];
  for (const w of incoming.workouts) {
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
  const workouts = merge ? mergeByDate(cur.workouts, fresh) : fresh;
  if (!merge) {
    const inFile = new Set(incoming.workouts.map(fingerprint));
    counts.workoutsRemoved = cur.workouts.filter((w) => !inFile.has(fingerprint(w))).length;
  }
  counts.resultWorkouts = workouts.length;

  // personal records (yours win: comparing two records needs unit-aware direction)
  let personalRecords;
  if (merge) {
    personalRecords = { ...cur.personalRecords };
    for (const k of Object.keys(incoming.personalRecords)) {
      if (hasOwn(cur.personalRecords, k)) counts.prsOverlap++;
      else {
        Object.defineProperty(personalRecords, k, {
          value: incoming.personalRecords[k],
          enumerable: true,
          writable: true,
          configurable: true,
        });
        counts.prsAdded++;
      }
    }
  } else {
    personalRecords = incoming.personalRecords;
  }

  // body metrics: union by exact date, yours win
  let bodyMetrics;
  if (merge) {
    const dates = new Set(cur.bodyMetrics.map((r) => r && r.date));
    const add = incoming.bodyMetrics.filter((r) => !dates.has(r.date));
    counts.bodyAdded = add.length;
    bodyMetrics = mergeByDate(cur.bodyMetrics, add);
  } else {
    bodyMetrics = incoming.bodyMetrics;
  }

  // plans: a plan id you already have keeps yours; other collisions inside the file get a new id
  const curPlanIds = new Set(merge ? cur.userPlans.map((p) => p && p.id) : []);
  const planUsed = new Set(curPlanIds);
  const planAlloc = idAllocator(
    planUsed,
    Math.floor(maxInt([...planUsed, ...incoming.userPlans.map((p) => p.id)])),
  );
  const userPlans = merge ? [...cur.userPlans] : [];
  for (const p of incoming.userPlans) {
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
  if (merge) {
    const have = new Set(cur.favourites);
    favourites = [...cur.favourites];
    for (const f of incoming.favourites) {
      if (!have.has(f)) {
        have.add(f);
        favourites.push(f);
        counts.favouritesAdded++;
      }
    }
  } else {
    favourites = incoming.favourites;
  }

  // profile: Merge takes the file's only when you have none yet; Replace takes the file's
  let profile;
  if (merge) {
    if ((!cur.profile || !cur.profile.name) && incoming.profile) {
      profile = incoming.profile;
      counts.profile = 'taken';
    } else {
      profile = current.profile ?? null;
      counts.profile = cur.profile ? 'kept' : 'none';
    }
  } else {
    profile = incoming.profile;
    counts.profile = incoming.profile
      ? cur.profile
        ? 'replaced'
        : 'taken'
      : cur.profile
        ? 'removed'
        : 'none';
  }

  return {
    ok: true,
    doc: { workouts, personalRecords, bodyMetrics, userPlans, profile, favourites },
    counts,
  };
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

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

/**
 * Plain numbers and clipped strings, for both modes, for the preview. The UI renders only this
 * (text nodes). Writes nothing.
 */
export function summarize(current, validated, { mirrorCeiling = Infinity } = {}) {
  const d = validated.doc;
  const cur = {
    workouts: list(current.workouts),
    personalRecords: dictOf(current.personalRecords),
    bodyMetrics: list(current.bodyMetrics),
    userPlans: list(current.userPlans),
    profile: current.profile ?? null,
    favourites: list(current.favourites),
  };
  const side = (mode) => {
    const m = mergeDocs(current, d, mode);
    if (!m.ok) return { error: m.reason };
    return { ...m.counts, mirrorStale: JSON.stringify(m.doc).length + 24 > mirrorCeiling };
  };
  const replace = side('replace');
  if (!replace.error) replace.allowed = !validated.partial.partial;
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
      profileName: d.profile ? clip(d.profile.name, 100) : null,
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
      hasProfile: !!cur.profile,
      dateRange: range(cur.workouts),
    },
    warnings: { ...validated.warnings },
    merge: side('merge'),
    replace,
  };
}

/**
 * The export file. Compact JSON (not pretty-printed). Header: _vaultfit, _version (the current
 * schema), _exported, _containsHealthData, and for the plain Export in unreadable-data states
 * _partial + _partialReason. No profile name in the header or the filename. Refuses (reason
 * 'too-large') a file the importer would refuse for size, so the app never produces a backup it
 * cannot restore; the caller points the user at the raw "as found" export. After building, the
 * same validator runs over the text: records it would refuse and fields it would ignore are
 * reported in `warnings`, and the file is still produced.
 */
export function buildExport(state, { now, partialReason = null, migrate } = {}) {
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
  const bytes =
    text.length * 3 <= LIMITS.maxBytes ? text.length : new TextEncoder().encode(text).length;
  if (bytes > LIMITS.maxBytes) return { ok: false, reason: 'too-large' };
  const v = validate(text, { now, migrate });
  const day = exported.slice(0, 10);
  return {
    ok: true,
    text,
    bytes,
    filename: partialReason ? `HomeBody_partial_${day}.vaultfit` : `HomeBody_${day}.vaultfit`,
    partial: !!partialReason,
    warnings: v.ok
      ? { refused: [], dropped: v.warnings.dropped }
      : { refused: v.problems, dropped: 0 },
  };
}
