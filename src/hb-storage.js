// HomeBody storage and boot, shipped as ONE classic script (no ES modules, no build step).
// Why classic: an ES-module boot measured ~+100 ms on the first visible frame against the
// pre-M1 start; a classic script is at baseline (ADR 0002 note, docs/offline.md). The sections
// below are the former src/storage/{migrate,engine-local,store}.js and src/boot.js, in order.
// It attaches `HBStorage` (for the node unit tests, which import this file) and, in a browser,
// publishes window.HB and starts the app. Nothing here runs I/O at load except the boot block.
(function () {
  'use strict';

  // ---- migrate: pure runner -------------------------------------------------------------------
  // Migration runner (pure: no I/O, no clock). Contract in ADR 0002 and tests/unit/helpers/
  // migration-harness.mjs: a migration is { from, to, migrate(doc) }; a document carries its version
  // in `schemaVersion` (absent means 1). The runner never mutates its input and refuses, rather than
  // guesses, on data it cannot read: invalid JSON -> 'corrupt', a newer schema -> 'future'.

  const CURRENT_SCHEMA = 1;

  const versionOf = (doc) => doc.schemaVersion ?? 1;

  /**
   * @param {Array<{from:number,to:number,migrate:Function}>} list
   * @param {string|object} input  stored text (parsed here) or an already parsed document
   * @param {{current?:number}} [opts]
   * @returns {{ok:true, doc:object, version:number} | {ok:false, reason:'corrupt'|'future'}}
   */
  function runMigrations(list, input, { current = CURRENT_SCHEMA } = {}) {
    let doc = input;
    if (typeof input === 'string') {
      try {
        doc = JSON.parse(input);
      } catch {
        return { ok: false, reason: 'corrupt' };
      }
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, reason: 'corrupt' };
    }
    const v = versionOf(doc);
    if (!Number.isInteger(v) || v < 1) return { ok: false, reason: 'corrupt' };
    if (v > current) return { ok: false, reason: 'future' };

    let cur = structuredClone(doc);
    const ordered = [...list].sort((a, b) => a.from - b.from);
    for (const m of ordered) {
      if (versionOf(cur) === m.from) {
        cur = m.migrate(structuredClone(cur));
        if (!cur || versionOf(cur) !== m.to) {
          throw new Error(`migration ${m.from}->${m.to} did not set schemaVersion to ${m.to}`);
        }
      }
    }
    return { ok: true, doc: cur, version: versionOf(cur) };
  }

  // ---- engine-local: the only code touching localStorage for app data ----------------------------
  // localStorage engine: the only code that touches localStorage for app data. An engine is
  // { name, read(key) -> string|null, write(key, text) -> Promise }. `write` calls setItem
  // synchronously (a tap followed by an OS kill still persists) and reports failure through the
  // returned promise. T6 adds an IndexedDB engine with the same shape, tried first.

  function createLocalEngine(storage = globalThis.localStorage) {
    // Throws when storage access itself is denied (some locked-down browsers); the store handles it.
    if (!storage) throw new Error('localStorage unavailable');
    storage.getItem('hb_probe_missing_key');
    return {
      name: 'localStorage',
      read: (key) => storage.getItem(key),
      write(key, text) {
        try {
          storage.setItem(key, text);
          return Promise.resolve();
        } catch (e) {
          return Promise.reject(e);
        }
      },
    };
  }

  // ---- store ---------------------------------------------------------------------------------
  // The single place app state is loaded and saved. Schema 1 on localStorage: one JSON blob under
  // `vaultfit_v1`, bit-for-bit what persistSave has always written.
  //
  // Principles enforced here (CLAUDE.md 1): legacy keys are adopted by copy and never removed; a
  // corrupt or newer-than-known blob loads as empty in memory, the store goes read-only and never
  // writes the original key; a failed write is retried once, then published (never swallowed).

  const STORAGE_KEY = 'vaultfit_v1';
  const LEGACY_KEYS = ['homebody_v1', 'homebody_v0', 'vaultfit_v0'];

  /** Only the kind of failure is exposed, never the raw exception text. */
  function classifyError(e) {
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
  function createStore({
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
        for (const w of job.waiters)
          kind ? w.rej(Object.assign(new Error(kind), { kind })) : w.res();
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

  const api = {
    runMigrations,
    CURRENT_SCHEMA,
    createLocalEngine,
    createStore,
    classifyError,
    STORAGE_KEY,
    LEGACY_KEYS,
  };
  globalThis.HBStorage = Object.freeze(api);

  // ---- boot (browser only) ---------------------------------------------------------------------
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  let domReady = document.readyState === 'complete';
  const domWait = domReady
    ? Promise.resolve()
    : new Promise((r) =>
        document.addEventListener('DOMContentLoaded', () => ((domReady = true), r()), {
          once: true,
        }),
      );

  try {
    const store = createStore({ openEngines: [() => createLocalEngine()] });
    store
      .load() // localStorage resolves in microtasks; nothing slow is awaited here
      .then(() => {
        window.HB = Object.freeze({
          storage: Object.freeze({
            save: store.save,
            status: store.status,
            subscribe: store.subscribe,
            loaded: store.loaded,
          }),
        });
        return domWait;
      })
      .then(() => window.hbStart())
      .catch((e) => {
        console.error('Boot error:', e);
        window.hbBootFailed();
      });
  } catch (e) {
    console.error('Boot error:', e);
    window.hbBootFailed();
  }
})();
