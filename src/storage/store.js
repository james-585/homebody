// The single place app state is loaded and saved. Schema 1 on localStorage: one JSON blob under
// `vaultfit_v1`, bit-for-bit what persistSave has always written.
//
// Principles enforced here (CLAUDE.md 1): legacy keys are adopted by copy and never removed; a
// corrupt or newer-than-known blob loads as empty in memory, the store goes read-only and never
// writes the original key; a failed write is retried once, then published (never swallowed).
import { runMigrations, CURRENT_SCHEMA } from './migrate.js';

export const STORAGE_KEY = 'vaultfit_v1';
export const LEGACY_KEYS = ['homebody_v1', 'homebody_v0', 'vaultfit_v0'];

/** Only the kind of failure is exposed, never the raw exception text. */
export function classifyError(e) {
  const name = e && e.name;
  const code = e && e.code;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
  if (code === 22 || code === 1014) return 'quota';
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotAllowedError') {
    return 'unavailable';
  }
  return 'unknown';
}

/**
 * @param {{openEngines: Array<() => object>, migrations?: Array, current?: number,
 *          retryDelayMs?: number, setTimer?: Function}} opts
 *   openEngines: ordered factories; the first that opens and reads wins.
 */
export function createStore({
  openEngines,
  migrations = [],
  current = CURRENT_SCHEMA,
  retryDelayMs = 250,
  setTimer = (fn, ms) => setTimeout(fn, ms),
}) {
  let engine = null;
  let doc = null; // the loaded document (a plain object), or null before load
  let error = null; // null | { kind }
  let readOnly = null; // null | 'corrupt' | 'future' | 'unavailable'
  let inflight = false;
  let queued = null; // { text, waiters }
  const subs = new Set();

  const publish = (kind) => {
    error = kind ? { kind } : null;
    for (const fn of [...subs]) {
      try {
        fn(status());
      } catch {
        /* a bad subscriber must not break saving */
      }
    }
  };

  function status() {
    const s = {
      engine: engine ? engine.name : 'none',
      persisted: null,
      persistAsked: false,
      lastBackupAt: null,
    };
    if (error) s.error = error.kind;
    return s;
  }

  async function load() {
    for (const open of openEngines) {
      try {
        const e = open();
        e.read(STORAGE_KEY); // proves reads work
        engine = e;
        break;
      } catch {
        /* try the next engine */
      }
    }
    if (!engine) {
      doc = {};
      readOnly = 'unavailable';
      publish('unavailable');
      return doc;
    }

    let raw;
    try {
      raw = engine.read(STORAGE_KEY);
    } catch {
      doc = {};
      readOnly = 'unavailable';
      publish('unavailable');
      return doc;
    }

    let adoptFailed = null;
    if (!raw) {
      // Adopt the first legacy key that has data by COPYING it. The legacy key is never removed.
      for (const key of LEGACY_KEYS) {
        let legacy = null;
        try {
          legacy = engine.read(key);
        } catch {
          /* ignore this key */
        }
        if (!legacy) continue;
        raw = legacy;
        try {
          await engine.write(STORAGE_KEY, legacy);
        } catch (e) {
          adoptFailed = classifyError(e); // run on the legacy data in memory; next boot retries
        }
        break;
      }
    }

    if (!raw) {
      doc = {};
      return doc;
    }
    const r = runMigrations(migrations, raw, { current });
    if (!r.ok) {
      doc = {};
      readOnly = r.reason;
      publish(r.reason);
      return doc;
    }
    doc = r.doc;
    if (adoptFailed) publish(adoptFailed);
    return doc;
  }

  /** The document that was loaded (a plain object; {} when nothing is stored). */
  const loaded = () => doc;

  // ---- saving: one writer at a time, latest payload wins, retry once -------------------------
  function writeOnce(text) {
    try {
      return Promise.resolve(engine.write(STORAGE_KEY, text));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function pump() {
    inflight = true;
    const job = queued;
    queued = null;
    const finish = (kind) => {
      for (const w of job.waiters) kind ? w.rej(Object.assign(new Error(kind), { kind })) : w.res();
      inflight = false;
      publish(kind);
      if (queued) pump();
    };
    writeOnce(job.text).then(
      () => finish(null),
      () => {
        // retry once, with the newest payload if one arrived meanwhile
        setTimer(() => {
          if (queued) {
            job.text = queued.text;
            job.waiters.push(...queued.waiters);
            queued = null;
          }
          writeOnce(job.text).then(
            () => finish(null),
            (e) => finish(classifyError(e)),
          );
        }, retryDelayMs);
      },
    );
  }

  /** Stringifies NOW (later mutation cannot leak in). Resolves on success; rejects once published. */
  function save(payload) {
    if (readOnly) {
      const kind = readOnly;
      return Promise.reject(Object.assign(new Error(kind), { kind }));
    }
    const text = JSON.stringify(payload);
    return new Promise((res, rej) => {
      const w = { res, rej };
      if (queued) {
        queued.text = text;
        queued.waiters.push(w);
      } else {
        queued = { text, waiters: [w] };
      }
      if (!inflight) pump();
    });
  }

  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  return { load, loaded, save, status, subscribe };
}
