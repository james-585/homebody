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

  const CURRENT_SCHEMA = 1; // the default for createStore (the T5 tests keep their meaning)
  const LATEST_SCHEMA = 2; // what the app runs at (boot passes it)

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

  // ---- migrations (pure) -----------------------------------------------------------------------
  // 001 (1 -> 2): record shapes are identical in v1 and v2, so the migration only sets the version.
  // "Moving into IndexedDB" is the engine's job (one atomic transaction with a verbatim snapshot),
  // not a transformation. No clock and no I/O here. Tested on every fixture by the harness.
  const MIGRATIONS = Object.freeze([
    Object.freeze({
      from: 1,
      to: 2,
      id: '001-indexeddb',
      migrate: (d) => ({ ...d, schemaVersion: 2 }),
    }),
  ]);

  // The six keys the pre-M1 persistSave wrote, in its order. Also the whitelist of what is copied
  // by name out of IndexedDB (external data is never merged into a document by key).
  const V1_KEYS = Object.freeze([
    'workouts',
    'personalRecords',
    'bodyMetrics',
    'userPlans',
    'profile',
    'favourites',
  ]);
  const RECORD_KEYS = V1_KEYS.slice(1);
  const META_FIELDS = [
    'schemaVersion',
    'seq',
    'migratedFrom',
    'migratedAt',
    'persistAskedAt',
    'persistGranted',
    'lastBackupAt',
    'mirrorSig',
  ];

  const STORAGE_KEY = 'vaultfit_v1';
  const LEGACY_KEYS = ['homebody_v1', 'homebody_v0', 'vaultfit_v0'];
  const META_KEY = 'hb_storage_meta'; // additive sidecar: { persistAskedAt, persistGranted }
  const ACTIVE_KEY = 'hb_active_workout';
  const DB_NAME = 'homebody';

  /** Every key the app keeps on the device: the one list "delete all my data" must use. */
  const KEYS = Object.freeze({
    localStorage: Object.freeze([
      STORAGE_KEY,
      ...LEGACY_KEYS,
      META_KEY,
      ACTIVE_KEY,
      'hb_milestones',
      'hb_theme',
      'hb_seen_guide',
      'hb_seen_tutorial',
    ]),
    indexedDB: Object.freeze([DB_NAME]),
  });

  /** Pure: the exact v1 blob persistSave has always written (six keys, that order). */
  function projectToV1(doc) {
    const out = {};
    for (const k of V1_KEYS) if (doc && doc[k] !== undefined) out[k] = doc[k];
    return out;
  }

  /** Cheap fingerprint of a mirror text (length + FNV-1a): "is this the text I migrated?" */
  function sigOf(t) {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${t.length}:${(h >>> 0).toString(16)}`;
  }

  /** hbSeq from the tail of a mirror text without parsing it (null when absent). */
  function hbSeqOf(raw) {
    const m = typeof raw === 'string' ? /,?"hbSeq":(\d{1,15})\}$/.exec(raw.slice(-40)) : null;
    return m ? Number(m[1]) : null;
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
    const eng = {
      name: 'localStorage',
      supports: Object.freeze({ snapshots: false }),
      read: (key) => storage.getItem(key),
      write(key, text) {
        try {
          storage.setItem(key, text);
          return Promise.resolve();
        } catch (e) {
          const p = Promise.reject(e);
          p.syncError = e; // lets the store announce a failure inside the calling tick
          return p;
        }
      },
      // Document-level contract (shared with the IndexedDB engine). This engine always keeps the
      // v1-shaped blob; `seq` is written as hbSeq only when given (the store's mirror does that).
      readDoc() {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw === null) return null;
        let doc;
        try {
          doc = JSON.parse(raw);
        } catch {
          return { doc: null, raw, seq: null, corrupt: true };
        }
        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
          return { doc: null, raw, seq: null, corrupt: true };
        }
        const seq = Number.isInteger(doc.hbSeq) ? doc.hbSeq : null;
        delete doc.hbSeq;
        return { doc, raw, seq };
      },
      writeDoc(doc, { seq } = {}) {
        const p = projectToV1(doc);
        if (seq !== undefined && seq !== null) p.hbSeq = seq;
        return eng.write(STORAGE_KEY, JSON.stringify(p));
      },
      readMeta() {
        try {
          const raw = storage.getItem(META_KEY);
          const m = raw && raw.length < 1024 ? JSON.parse(raw) : null;
          if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
          const out = {};
          if (typeof m.persistAskedAt === 'number') out.persistAskedAt = m.persistAskedAt;
          if (Number.isInteger(m.idbSeq) && m.idbSeq >= 0) out.idbSeq = m.idbSeq;
          if (
            ['unsupported', 'error'].includes(m.persistGranted) ||
            typeof m.persistGranted === 'boolean'
          )
            out.persistGranted = m.persistGranted;
          return out;
        } catch {
          return {};
        }
      },
      writeMeta(patch) {
        return eng.write(META_KEY, JSON.stringify({ ...eng.readMeta(), ...patch }));
      },
    };
    return eng;
  }

  // ---- engine-idb: IndexedDB, behind the same document-level contract --------------------------
  // Database `homebody`, version 1. Stores: workouts (out-of-line keys = array index, so duplicate
  // or missing ids cannot overwrite each other and order is kept), records (the five record sets by
  // name), meta, snapshots ({id, reason, createdAt, schemaVersion, keep, keepKey, bytes, payload}).
  // Every write is ONE readwrite transaction: all or nothing. Own tiny promise wrapper; no library.

  const STORES = ['workouts', 'records', 'meta', 'snapshots'];
  const KEEP_LAST = 5; // snapshots kept besides the keep:true one (ADR 0002)

  function createIdbEngine({
    factory = globalThis.indexedDB,
    name = DB_NAME,
    timeoutMs = 1200, // shorter than the 1.5 s hb-booting failsafe: the engine is chosen before the UI
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => globalThis.clearTimeout(t),
  } = {}) {
    let db = null;
    let dbp = null;
    let openP = null;
    let abandoned = false;
    let firstResult; // the boot read, handed over once by takeFirst()

    const unavailable = (why, cause) => Object.assign(new Error(why), { fallback: why, cause });

    function openDb() {
      return new Promise((resolve, reject) => {
        let r;
        try {
          if (!factory) throw new Error('indexedDB missing');
          r = factory.open(name, 1);
        } catch (e) {
          reject(unavailable('idb-unavailable', e));
          return;
        }
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('workouts')) d.createObjectStore('workouts');
          if (!d.objectStoreNames.contains('records')) d.createObjectStore('records');
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
          if (!d.objectStoreNames.contains('snapshots')) {
            d.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true }).createIndex(
              'keep',
              'keepKey',
            );
          }
        };
        r.onblocked = () => reject(unavailable('idb-unavailable'));
        r.onerror = () => reject(unavailable('idb-unavailable', r.error));
        r.onsuccess = () => {
          const d = r.result;
          if (abandoned) {
            try {
              d.close(); // a late-opening connection is closed and ignored
            } catch {
              /* ignore */
            }
            return;
          }
          if (!STORES.every((s) => d.objectStoreNames.contains(s))) {
            d.close();
            reject(unavailable('idb-unavailable'));
            return;
          }
          d.onversionchange = () => {
            try {
              d.close(); // let another tab upgrade; reopen lazily on the next use
            } catch {
              /* ignore */
            }
            if (db === d) db = null;
          };
          resolve(d);
        };
      });
    }
    const getDb = () =>
      db
        ? Promise.resolve(db)
        : (dbp ??= openDb().then(
            (d) => ((dbp = null), (db = d)),
            (e) => {
              dbp = null;
              throw e;
            },
          ));

    /**
     * Run `body(tx, {done, safe})` in one transaction. Resolves with the value passed to done()
     * when the transaction COMMITS; rejects (with the real cause) when it aborts. An exception in
     * body or in a callback wrapped by safe() aborts the transaction, so nothing partial persists.
     * The transaction is created synchronously when the connection is already open.
     */
    async function run(mode, stores, body) {
      const d = db ?? (await getDb());
      return new Promise((resolve, reject) => {
        let tx;
        try {
          tx = d.transaction(stores, mode);
        } catch (e) {
          reject(e);
          return;
        }
        let out;
        let thrown = null;
        const abort = (e) => {
          thrown = e;
          try {
            tx.abort();
          } catch {
            /* already finished */
          }
        };
        tx.oncomplete = () => resolve(out);
        tx.onabort = () => reject(thrown || tx.error || new Error('aborted'));
        const safe =
          (fn) =>
          (...a) => {
            try {
              fn(...a);
            } catch (e) {
              abort(e);
            }
          };
        try {
          body(tx, { done: (v) => (out = v), safe });
        } catch (e) {
          abort(e);
        }
      });
    }

    function interpret(w, rk, rv, mk, mv) {
      const meta = {};
      mk.forEach((k, i) => {
        if (META_FIELDS.includes(k)) meta[k] = mv[i];
      });
      const recs = {};
      rk.forEach((k, i) => {
        if (RECORD_KEYS.includes(k)) recs[k] = rv[i];
      });
      if (meta.schemaVersion === undefined) {
        // Stores present but no meta: empty = a fresh database; any data = corrupt (never trusted)
        return w.length || Object.keys(recs).length
          ? { doc: null, raw: null, seq: null, meta, corrupt: true }
          : null;
      }
      const sv = meta.schemaVersion;
      if (!Number.isInteger(sv) || sv < 1 || typeof meta.seq !== 'number' || !isFinite(meta.seq)) {
        return { doc: null, raw: null, seq: null, meta, corrupt: true };
      }
      const doc = { workouts: w };
      for (const k of RECORD_KEYS) if (k in recs) doc[k] = recs[k];
      doc.schemaVersion = sv;
      return { doc, raw: null, seq: meta.seq, meta };
    }

    const readDoc = () =>
      run('readonly', ['workouts', 'records', 'meta'], (tx, { done, safe }) => {
        const w = tx.objectStore('workouts').getAll();
        const rk = tx.objectStore('records').getAllKeys();
        const rv = tx.objectStore('records').getAll();
        const mk = tx.objectStore('meta').getAllKeys();
        const mv = tx.objectStore('meta').getAll();
        mv.onsuccess = safe(() =>
          done(interpret(w.result, rk.result, rv.result, mk.result, mv.result)),
        );
      });

    function snapshotRecord(s) {
      const rec = {
        reason: String(s.reason).slice(0, 40),
        createdAt: s.createdAt,
        schemaVersion: s.schemaVersion,
        keep: !!s.keep,
        bytes: s.payload.length,
        payload: s.payload,
      };
      if (s.keep) rec.keepKey = 1; // only keep:true records enter the 'keep' index
      return rec;
    }

    function prune(st, safe) {
      const all = st.getAllKeys();
      all.onsuccess = safe(() => {
        const kept = st.index('keep').getAllKeys();
        kept.onsuccess = safe(() => {
          const keep = new Set(kept.result);
          const rest = all.result.filter((id) => !keep.has(id)); // ascending = oldest first
          for (const id of rest.slice(0, Math.max(0, rest.length - KEEP_LAST))) st.delete(id);
        });
      });
    }

    /**
     * Replace the whole document in one transaction. Options: seq, schema, metaPatch, snapshot
     * ({reason, schemaVersion, keep, payload, createdAt}, added in the same transaction and pruned),
     * ifUnmigrated (do nothing if meta.schemaVersion already exists: another tab migrated first).
     * Resolves {skipped}. A DataCloneError or quota failure aborts: the previous state is intact.
     */
    function writeDoc(doc, o = {}) {
      return run('readwrite', STORES, (tx, { done, safe }) => {
        const result = { skipped: false };
        done(result);
        const go = safe(() => {
          const wk = tx.objectStore('workouts');
          const rc = tx.objectStore('records');
          const mt = tx.objectStore('meta');
          const sn = tx.objectStore('snapshots');
          if (o.snapshot) sn.add(snapshotRecord(o.snapshot));
          wk.clear();
          (Array.isArray(doc.workouts) ? doc.workouts : []).forEach((x, i) => wk.put(x, i));
          for (const k of RECORD_KEYS) {
            if (doc[k] !== undefined) rc.put(doc[k], k);
            else rc.delete(k);
          }
          mt.put(o.schema ?? doc.schemaVersion ?? LATEST_SCHEMA, 'schemaVersion');
          mt.put(o.seq ?? 0, 'seq');
          for (const f of META_FIELDS) {
            if (o.metaPatch && o.metaPatch[f] !== undefined && f !== 'schemaVersion' && f !== 'seq')
              mt.put(o.metaPatch[f], f);
          }
          if (o.snapshot) prune(sn, safe);
        });
        if (o.ifUnmigrated) {
          const g = tx.objectStore('meta').get('schemaVersion');
          g.onsuccess = safe(() => {
            if (g.result !== undefined) result.skipped = true;
            else go();
          });
        } else go();
      });
    }

    const eng = {
      name: 'indexedDB',
      idb: true,
      supports: Object.freeze({ snapshots: true }),
      /** Open (with the timeout) and do the one boot read. Rejects with {fallback}. */
      open() {
        return (openP ??= new Promise((resolve, reject) => {
          const t = setTimer(() => {
            abandoned = true;
            reject(unavailable('idb-timeout'));
          }, timeoutMs);
          getDb()
            .then(() => readDoc())
            .then(
              (first) => {
                clearTimer(t);
                if (abandoned) return;
                firstResult = first;
                resolve(eng);
              },
              (e) => {
                clearTimer(t);
                if (!abandoned) reject(e && e.fallback ? e : unavailable('idb-unavailable', e));
              },
            );
        }));
      },
      /** The read made during open(), once; undefined afterwards. */
      takeFirst() {
        const f = firstResult;
        firstResult = undefined;
        return f;
      },
      readDoc,
      writeDoc,
      readMeta: () =>
        run('readonly', ['meta'], (tx, { done, safe }) => {
          const k = tx.objectStore('meta').getAllKeys();
          const v = tx.objectStore('meta').getAll();
          v.onsuccess = safe(() => {
            const m = {};
            k.result.forEach((key, i) => {
              if (META_FIELDS.includes(key)) m[key] = v.result[i];
            });
            done(m);
          });
        }),
      writeMeta: (patch) =>
        run('readwrite', ['meta'], (tx) => {
          for (const f of META_FIELDS) {
            if (patch[f] !== undefined && f !== 'schemaVersion' && f !== 'seq')
              tx.objectStore('meta').put(patch[f], f);
          }
        }),
      addSnapshot: (s) =>
        run('readwrite', ['snapshots'], (tx, { done, safe }) => {
          const st = tx.objectStore('snapshots');
          const r = st.add(snapshotRecord(s));
          r.onsuccess = safe(() => done(r.result));
          prune(st, safe);
        }),
      listSnapshots: () =>
        run('readonly', ['snapshots'], (tx, { done, safe }) => {
          const r = tx.objectStore('snapshots').getAll();
          r.onsuccess = safe(() =>
            done(
              r.result.map((s) => ({
                id: s.id,
                reason: s.reason,
                createdAt: s.createdAt,
                schemaVersion: s.schemaVersion,
                bytes: s.bytes,
                keep: !!s.keep,
              })),
            ),
          );
        }),
      getSnapshot: (id) =>
        run('readonly', ['snapshots'], (tx, { done, safe }) => {
          const r = tx.objectStore('snapshots').get(id);
          r.onsuccess = safe(() => done(r.result ?? null));
        }),
      close() {
        abandoned = true;
        if (db) {
          try {
            db.close();
          } catch {
            /* ignore */
          }
          db = null;
        }
      },
    };
    return eng;
  }

  // ---- store ---------------------------------------------------------------------------------
  // The single place app state is loaded and saved. Schema 1 on localStorage: one JSON blob under
  // `vaultfit_v1`, bit-for-bit what persistSave has always written.
  //
  // Principles enforced here (CLAUDE.md 1): legacy keys are adopted by copy and never removed; a
  // corrupt or newer-than-known blob loads as empty in memory, the store goes read-only and never
  // writes the original key; a failed write is retried once, then published (never swallowed).

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
   * @param {{openEngines: Array<() => object|Promise<object>>, migrations?: Array, current?: number,
   *          retryDelayMs?: number, setTimer?: Function, now?: () => number, nav?: object}} opts
   *   openEngines: ordered factories; the first that opens and reads wins. When that is the
   *   IndexedDB engine, the first localStorage engine in the list is also opened (the v1 mirror).
   */
  function createStore({
    openEngines,
    migrations = [],
    current = CURRENT_SCHEMA,
    retryDelayMs = 250,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    now = () => 0,
    nav = null, // navigator-like { storage: { persist, persisted } }; never required
    fastBoot = false, // boot from the mirror when it is provably equal to IndexedDB (see tryFast)
  }) {
    let engine = null; // where documents are read and written
    let local = null; // the localStorage engine (the v1 mirror when `engine` is IndexedDB)
    let doc = null; // the loaded document (a plain object), or null before load
    let error = null; // null | { kind }
    let phase = 'idle'; // 'idle' | 'retrying' | 'failed' | 'readonly'
    let meta = {}; // the sidecar / IndexedDB meta, copied field by field
    let asked = false; // persist() requested (this session or an earlier one)
    let persisted = null; // navigator.storage.persisted(), refreshed after boot
    let readOnly = null; // null | 'corrupt' | 'future' | 'unavailable' | 'restoring' | 'restored'
    let fallback = null; // null | 'idb-unavailable' | 'idb-timeout'
    let mirror = null; // IndexedDB mode only: 'ok' | 'stale'
    let seq = 0; // last committed (or mirrored) sequence number, IndexedDB mode
    let inflight = false;
    let queued = null; // { text, obj, seq, waiters }
    let idle = [];
    const subs = new Set();
    // Fast boot: `provisional` from the moment the document came from the mirror until attach()
    // has opened IndexedDB and decided. Saves in that window write the mirror as plain v1 text (as
    // persistSave always did) and wait for `ready` before their IndexedDB commit.
    let provisional = false;
    let attachStarted = false;
    let fastRaw = null; // the mirror text the document was loaded from, kept verbatim
    let fastSeq = null; // its hbSeq (null = unmarked)
    let lastPlain = null; // { text, spliceable } of the newest provisional save, until restamped
    let idbSeqNoted = 0;
    let resolveReady;
    const ready = new Promise((r) => (resolveReady = r));

    const idbMode = () => provisional || !!(engine && engine.idb);
    const kinded = (kind) => Object.assign(new Error(kind), { kind });

    const publish = (kind, state) => {
      error = kind ? { kind } : null;
      phase = state || (kind ? 'failed' : 'idle');
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
        engine: engine ? engine.name : provisional ? 'indexedDB' : 'none',
        state: phase,
        persisted,
        persistAsked: asked,
        lastBackupAt: meta.lastBackupAt ?? null,
        snapshots: !provisional && !!(engine && engine.supports && engine.supports.snapshots),
      };
      if (meta.persistGranted !== undefined) s.persistGranted = meta.persistGranted;
      if (fallback) s.fallback = fallback;
      if (idbMode()) s.mirror = local ? mirror || 'ok' : 'off';
      if (error) s.error = error.kind;
      return s;
    }

    function failLoad(kind) {
      doc = {};
      readOnly = kind;
      publish(kind, 'readonly');
      return doc;
    }

    /** Copy the first legacy key that has data into vaultfit_v1. The legacy key is never removed. */
    async function adoptLegacy(eng) {
      for (const key of LEGACY_KEYS) {
        let legacy = null;
        try {
          legacy = eng.read(key);
        } catch {
          /* ignore this key */
        }
        if (!legacy) continue;
        let failed = null;
        try {
          await eng.write(STORAGE_KEY, legacy);
        } catch (e) {
          failed = classifyError(e); // run on the legacy data in memory; next boot retries
        }
        return { raw: legacy, failed };
      }
      return null;
    }

    // ---- fast boot -----------------------------------------------------------------------------
    // The simple IndexedDB-first boot costs about +35 ms on the first visible frame (T6a
    // measurements), so a boot whose mirror is PROVABLY equal to IndexedDB reads only the mirror,
    // as before M1, and opens IndexedDB after first paint (attach). Provable means: the mirror is
    // unmarked (it always wins at boot, so IndexedDB cannot be newer), or its hbSeq equals the
    // idbSeq written to the sidecar after the last IndexedDB commit. Anything else: the slow path.
    async function tryFast() {
      const lf = openEngines.find((f) => !f.idb);
      if (!lf || !openEngines.some((f) => f.idb)) return null;
      let l;
      try {
        l = await lf();
        const raw = l.read(STORAGE_KEY);
        if (!raw) return null;
        const mseq = hbSeqOf(raw);
        const side = l.readMeta ? l.readMeta() : {};
        if (mseq !== null && side.idbSeq !== mseq) return null;
        const r = runMigrations(migrations, raw, { current });
        if (!r.ok) return null; // the slow path reports corrupt / newer-than-known
        delete r.doc.hbSeq;
        local = l;
        fastRaw = raw;
        fastSeq = mseq;
        seq = mseq ?? side.idbSeq ?? 0;
        provisional = true;
        doc = r.doc;
        return doc;
      } catch {
        return null;
      }
    }

    /** Open IndexedDB after first paint and decide, using the text the document was loaded from. */
    async function attach() {
      if (!provisional || attachStarted) return ready;
      attachStarted = true;
      try {
        const e = await openEngines.find((f) => f.idb)();
        engine = e;
        let stored = e.takeFirst();
        if (stored === undefined) stored = await e.readDoc();
        await attachDecide(e, stored);
      } catch (err) {
        fallback = (err && err.fallback) || fallback || 'idb-unavailable';
        engine = local; // saves go to the localStorage blob (unmarked); a later boot imports them
      }
      provisional = false;
      resolveReady();
      return ready;
    }

    async function attachDecide(e, stored) {
      if (stored && stored.corrupt) {
        readOnly = 'corrupt';
        publish('corrupt', 'readonly');
        return;
      }
      if (stored && stored.doc.schemaVersion > current) {
        readOnly = 'future';
        publish('future', 'readonly');
        return;
      }
      const sig = sigOf(fastRaw);
      if (!stored) {
        const r = runMigrations(migrations, fastRaw, { current }); // from the kept text, not live state
        let from = 1;
        try {
          from = JSON.parse(fastRaw).schemaVersion ?? 1;
        } catch {
          /* keep 1 */
        }
        const res = await e.writeDoc(r.doc, {
          seq: 1,
          schema: current,
          ifUnmigrated: true,
          metaPatch: { migratedFrom: from, migratedAt: now(), mirrorSig: sig, ...meta },
          snapshot: {
            reason: 'pre-migration',
            schemaVersion: from,
            keep: true,
            payload: fastRaw,
            createdAt: now(),
          },
        });
        if (!res.skipped) {
          const back = await e.readDoc();
          const same =
            back &&
            !back.corrupt &&
            back.doc.workouts.length === (r.doc.workouts || []).length &&
            JSON.stringify(projectToV1(back.doc)) === JSON.stringify(projectToV1(r.doc));
          if (!same) throw new Error('verify');
          seq = Math.max(seq, 1);
          return;
        }
        stored = await e.readDoc(); // another tab migrated first
        if (!stored || stored.corrupt) throw new Error('unreadable');
      }
      seq = Math.max(seq, stored.seq);
      const inSync = fastSeq !== null ? stored.seq >= fastSeq : stored.meta.mirrorSig === sig;
      if (inSync) return;
      const r = runMigrations(migrations, fastRaw, { current });
      const next = Math.max(stored.seq, fastSeq ?? 0) + 1;
      await e.writeDoc(r.doc, {
        seq: next,
        schema: current,
        metaPatch: { mirrorSig: sig },
        snapshot: {
          reason: 'pre-reconcile',
          schemaVersion: stored.doc.schemaVersion,
          keep: false,
          payload: JSON.stringify(stored.doc),
          createdAt: now(),
        },
      });
      seq = next;
    }

    async function load() {
      if (fastBoot) {
        const d = await tryFast();
        if (d) return d;
      }
      let primary = null;
      for (const open of openEngines) {
        if (primary && (!primary.idb || local)) break;
        try {
          const e = await open();
          if (!e.idb) e.read(STORAGE_KEY); // proves reads work
          if (!primary) primary = e;
          if (!e.idb && !local) local = e;
        } catch (err) {
          if (err && err.fallback && !fallback) fallback = err.fallback;
          /* try the next engine */
        }
      }
      engine = primary;
      if (!engine) {
        doc = {};
        readOnly = 'unavailable';
        publish('unavailable', 'readonly');
        return doc;
      }
      if (engine.idb) {
        try {
          return await loadIdb();
        } catch (e) {
          // The IndexedDB read failed after it opened: use localStorage for this session.
          if (!local) return failLoad('unavailable');
          fallback = fallback || 'idb-unavailable';
          engine = local;
          void e;
        }
      }
      return loadKv();
    }

    async function loadKv() {
      let raw;
      try {
        raw = engine.read(STORAGE_KEY);
      } catch {
        return failLoad('unavailable');
      }

      let adoptFailed = null;
      if (!raw) {
        const a = await adoptLegacy(engine);
        if (a) {
          raw = a.raw;
          adoptFailed = a.failed;
        }
      }

      if (!raw) {
        doc = {};
        return doc;
      }
      const r = runMigrations(migrations, raw, { current });
      if (!r.ok) return failLoad(r.reason);
      doc = r.doc;
      if (adoptFailed) publish(adoptFailed);
      return doc;
    }

    // ---- IndexedDB boot: which copy wins -----------------------------------------------------
    // IndexedDB holds the truth; vaultfit_v1 is a mirror stamped with hbSeq (the seq of the last
    // save). A mirror WITHOUT hbSeq (a pre-M1 build or a localStorage-fallback session wrote it) or
    // with hbSeq ABOVE meta.seq (killed after the sync mirror write, before the IndexedDB commit)
    // is newer: snapshot IndexedDB first (pre-reconcile), then import the mirror. A mirror at or
    // below meta.seq is stale and ignored (rewritten on the next save).
    const sidecar = () => (local ? local.readMeta() : {});

    /** The sidecar remembers the last IndexedDB commit, so the next boot can prove "equal". */
    function noteCommitted(n) {
      if (!local || !(n > idbSeqNoted)) return;
      idbSeqNoted = n;
      try {
        Promise.resolve(local.writeMeta({ idbSeq: n })).catch(() => {});
      } catch {
        /* the sidecar is an optimisation */
      }
    }

    function stampMirror(d) {
      if (!local) return;
      try {
        const p = local.write(STORAGE_KEY, JSON.stringify({ ...projectToV1(d), hbSeq: seq }));
        p.then(
          () => (mirror = 'ok'),
          () => (mirror = 'stale'),
        );
      } catch {
        mirror = 'stale';
      }
    }

    async function loadIdb() {
      let stored = engine.takeFirst();
      if (stored === undefined) stored = await engine.readDoc();
      const readMirror = () => {
        try {
          return local ? local.read(STORAGE_KEY) : null;
        } catch {
          return null;
        }
      };
      const raw = readMirror();
      for (let pass = 0; pass < 2; pass++) {
        if (stored && stored.corrupt) return failLoad('corrupt');
        if (stored && stored.doc.schemaVersion > current) return failLoad('future');

        if (!stored) {
          // First boot on this database: migrate the stored text (mirror, else a legacy key) in
          // ONE transaction together with a verbatim snapshot of it. The source stays untouched.
          let src = raw;
          let adoptFailed = null;
          if (!src && local) {
            const a = await adoptLegacy(local);
            if (a) {
              src = a.raw;
              adoptFailed = a.failed;
            }
          }
          const side = sidecar();
          if (!src) {
            doc = {};
            meta = { ...side };
            asked = meta.persistAskedAt !== undefined;
            return doc;
          }
          const r = runMigrations(migrations, src, { current });
          if (!r.ok) return failLoad(r.reason);
          let from = 1;
          try {
            from = JSON.parse(src).schemaVersion ?? 1;
          } catch {
            /* the runner already parsed it; keep 1 */
          }
          let res;
          try {
            res = await engine.writeDoc(r.doc, {
              seq: 1,
              schema: current,
              ifUnmigrated: true,
              metaPatch: { migratedFrom: from, migratedAt: now(), mirrorSig: sigOf(src), ...side },
              snapshot: {
                reason: 'pre-migration',
                schemaVersion: from,
                keep: true,
                payload: src,
                createdAt: now(),
              },
            });
          } catch {
            return fallBackWith(r.doc, adoptFailed); // nothing committed; the source reruns next boot
          }
          if (res.skipped) {
            stored = await engine.readDoc(); // another tab migrated first: just read
            continue;
          }
          const back = await engine.readDoc();
          const same =
            back &&
            !back.corrupt &&
            back.doc.workouts.length === (r.doc.workouts || []).length &&
            JSON.stringify(projectToV1(back.doc)) === JSON.stringify(projectToV1(r.doc));
          if (!same) return fallBackWith(r.doc, adoptFailed);
          seq = 1;
          meta = { ...back.meta };
          asked = meta.persistAskedAt !== undefined;
          doc = r.doc; // vaultfit_v1 is left exactly as found: unmarked, and equal by mirrorSig
          if (adoptFailed) publish(adoptFailed);
          return doc;
        }

        seq = stored.seq;
        meta = { ...stored.meta };
        asked = meta.persistAskedAt !== undefined;
        doc = stored.doc;
        const mseq = hbSeqOf(raw);
        const sig = raw && mseq === null ? sigOf(raw) : null;
        if (raw && (mseq === null ? stored.meta.mirrorSig !== sig : mseq > seq)) {
          const r = runMigrations(migrations, raw, { current });
          if (r.ok) {
            const next = Math.max(seq, mseq ?? 0) + 1;
            try {
              await engine.writeDoc(r.doc, {
                seq: next,
                schema: current,
                metaPatch: { mirrorSig: sig ?? undefined },
                snapshot: {
                  reason: 'pre-reconcile',
                  schemaVersion: stored.doc.schemaVersion,
                  keep: false,
                  payload: JSON.stringify(stored.doc),
                  createdAt: now(),
                },
              });
              seq = next;
              if (mseq !== null) stampMirror(r.doc);
            } catch (e) {
              seq = Math.max(seq, mseq ?? 0); // newer data lives in memory; the next save writes it
              publish(classifyError(e));
            }
            doc = r.doc;
          }
          // a corrupt or newer-than-known mirror is ignored: IndexedDB stays authoritative
        } else if (raw && mseq !== null && mseq < seq) {
          mirror = 'stale';
        } else if (raw && mseq !== null && mseq === seq) {
          noteCommitted(seq); // both copies equal: let the next boot take the fast path
        }
        return doc;
      }
      return failLoad('unavailable');
    }

    /** IndexedDB could not take the migration: run this session on localStorage, in memory first. */
    function fallBackWith(d, adoptFailed) {
      fallback = fallback || 'idb-unavailable';
      engine = local;
      doc = d;
      if (adoptFailed) publish(adoptFailed);
      return doc;
    }

    // Called once the document is loaded. Nothing here is awaited on the boot path.
    function afterLoad() {
      if (!idbMode() || provisional) {
        const src = engine || local;
        const m = src && src.readMeta ? src.readMeta() : {};
        Object.assign(meta, m);
        asked = meta.persistAskedAt !== undefined;
      }
      try {
        if (nav && nav.storage && typeof nav.storage.persisted === 'function')
          nav.storage.persisted().then(
            (v) => (persisted = !!v),
            () => {},
          );
      } catch {
        /* ignore */
      }
    }

    // Ask the browser for persistent storage once, after the first successful save that holds a
    // workout. The result is kept in the sidecar key (and IndexedDB meta); a failed write of it is
    // not an app error.
    function askPersist() {
      asked = true;
      const record = (granted) => {
        meta = { ...meta, persistAskedAt: now(), persistGranted: granted };
        if (granted === true) persisted = true;
        const patch = { persistAskedAt: meta.persistAskedAt, persistGranted: granted };
        try {
          if (idbMode()) {
            ready.then(() => engine.idb && engine.writeMeta(patch)).catch(() => {});
            if (local) Promise.resolve(local.writeMeta(patch)).catch(() => {});
          } else {
            Promise.resolve(engine.writeMeta(patch)).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      };
      try {
        if (!nav || !nav.storage || typeof nav.storage.persist !== 'function') {
          record('unsupported');
          return;
        }
        nav.storage.persist().then(
          (g) => record(!!g),
          () => record('error'),
        );
      } catch {
        record('error');
      }
    }

    /**
     * The stored text of the main key, read fresh and unchanged (for the "export saved file" button
     * when the data could not be read). Read-only: never writes. null when unreadable. With
     * IndexedDB this is the v1 mirror.
     */
    function rawText() {
      try {
        const e = local || engine;
        return e ? e.read(STORAGE_KEY) : null;
      } catch {
        return null;
      }
    }

    /** The document that was loaded (a plain object; {} when nothing is stored). */
    const loaded = () => doc;

    // ---- saving: one writer at a time, latest payload wins, retry once -------------------------
    function writeOnce(job) {
      if (provisional) {
        job.obj = null; // the text taken at call time is the truth once we wait
        return ready.then(() => writeOnce(job));
      }
      if (idbMode()) {
        if (!job.seq) {
          job.seq = ++seq; // a fast-boot save: numbered now that the engine is known
          job.restamp = true;
        }
        try {
          // job.obj is only set when pump runs inside the save() call (structured clone happens
          // at put, so later mutation cannot leak in); otherwise the text taken at call time.
          const d = job.obj || JSON.parse(job.text);
          return Promise.resolve(engine.writeDoc(d, { seq: job.seq, schema: current }));
        } catch (e) {
          return Promise.reject(e);
        }
      }
      try {
        return Promise.resolve(engine.write(STORAGE_KEY, job.text));
      } catch (e) {
        const p = Promise.reject(e);
        p.syncError = e;
        return p;
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
        if (!kind && idbMode() && job.seq) {
          if (job.restamp) restampMirror(job);
          noteCommitted(job.seq);
        }
        if (!kind && job.has && !asked) askPersist();
        if (queued) pump();
        else {
          const w = idle;
          idle = [];
          w.forEach((r) => r());
        }
      };
      // First failure: announce 'retrying' now (synchronously when the engine fails in the call).
      const announce = (e) => {
        if (job.announced) return;
        job.announced = true;
        publish(classifyError(e), 'retrying');
      };
      const first = writeOnce(job);
      if (first.syncError) announce(first.syncError);
      first.then(
        () => finish(null),
        (e) => {
          announce(e);
          // retry once, with the newest payload if one arrived meanwhile
          setTimer(() => {
            if (queued) {
              job.text = queued.text;
              job.seq = queued.seq;
              job.has = queued.has;
              job.waiters.push(...queued.waiters);
              queued = null;
            }
            job.obj = null;
            writeOnce(job).then(
              () => finish(null),
              (e2) => finish(classifyError(e2)),
            );
          }, retryDelayMs);
        },
      );
    }

    /** After the commit of a fast-boot save: give the (plain) mirror its hbSeq. */
    function restampMirror(job) {
      if (!local || !lastPlain || lastPlain.text !== job.text) return;
      const t = lastPlain;
      lastPlain = null;
      try {
        const body = t.spliceable
          ? mirrorText(t.text, { workouts: 1 }, job.seq)
          : JSON.stringify({ ...projectToV1(JSON.parse(t.text)), hbSeq: job.seq });
        const p = local.write(STORAGE_KEY, body);
        p.then(
          () => (mirror = 'ok'),
          () => (mirror = 'stale'),
        );
      } catch {
        mirror = 'stale';
      }
    }

    /** The mirror text: the payload's own JSON with hbSeq appended (no second serialisation). */
    function mirrorText(text, payload, n) {
      const plain = payload && typeof payload === 'object' && !Array.isArray(payload);
      if (plain && Object.keys(payload).every((k) => V1_KEYS.includes(k))) {
        return text.length > 2 ? `${text.slice(0, -1)},"hbSeq":${n}}` : `{"hbSeq":${n}}`;
      }
      return JSON.stringify({ ...projectToV1(plain ? payload : {}), hbSeq: n });
    }

    /** Stringifies NOW (later mutation cannot leak in). Resolves on success; rejects once published. */
    function save(payload) {
      if (readOnly) {
        const kind = readOnly;
        return Promise.reject(Object.assign(new Error(kind), { kind }));
      }
      let text;
      try {
        text = JSON.stringify(payload);
      } catch {
        // A payload that cannot be serialised (for example a circular reference) is a failed save,
        // published like any other, never an exception thrown into the caller.
        publish('unknown', 'failed');
        return Promise.reject(Object.assign(new Error('unknown'), { kind: 'unknown' }));
      }
      const has = !!payload && Array.isArray(payload.workouts) && payload.workouts.length > 0;
      let n = 0;
      if (idbMode()) {
        // Rollback copy first, synchronously (a tap followed by an OS kill still persists). A
        // failure here is logged, never surfaced; status().mirror says 'stale'. While IndexedDB is
        // not attached yet the mirror is written as plain v1 text (unmarked = newer at next boot).
        if (provisional) {
          lastPlain = {
            text,
            spliceable:
              !!payload &&
              typeof payload === 'object' &&
              !Array.isArray(payload) &&
              Object.keys(payload).every((k) => V1_KEYS.includes(k)),
          };
        } else {
          n = ++seq;
          lastPlain = null;
        }
        if (local) {
          const p = local.write(STORAGE_KEY, provisional ? text : mirrorText(text, payload, n));
          mirror = p.syncError ? 'stale' : 'ok';
          if (p.syncError) console.warn('HomeBody: v1 mirror not written');
          p.catch(() => {});
        }
      }
      return new Promise((res, rej) => {
        const w = { res, rej };
        if (queued) {
          queued.text = text;
          queued.has = has;
          queued.seq = n;
          queued.obj = null;
          queued.waiters.push(w);
        } else {
          queued = { text, has, seq: n, obj: inflight ? null : payload, waiters: [w] };
        }
        if (!inflight) pump();
      });
    }

    function subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    }

    const settled = () =>
      !inflight && !queued ? Promise.resolve() : new Promise((r) => idle.push(r));

    // ---- snapshots and the way back (IndexedDB only; console API until T8) -------------------
    async function usable() {
      await ready;
      if (!engine || !engine.idb) throw kinded('unsupported');
      if (readOnly) throw kinded(readOnly);
    }

    /** Snapshot what is stored now (for T7's pre-import call). Resolves the new snapshot id. */
    async function snapshot(reason = 'manual') {
      await usable();
      await settled();
      const cur = await engine.readDoc();
      if (!cur || cur.corrupt) throw kinded('empty');
      return engine.addSnapshot({
        reason: typeof reason === 'string' && reason ? reason : 'manual',
        schemaVersion: cur.doc.schemaVersion,
        keep: false,
        payload: JSON.stringify(cur.doc),
        createdAt: now(),
      });
    }

    async function snapshots() {
      await ready;
      if (!engine || !engine.idb) return [];
      return engine.listSnapshots();
    }

    /**
     * Restore a snapshot: refuses during a workout, snapshots the present state first (same
     * transaction as the replace), lifts an old payload through the migration runner, then goes
     * read-only until reload so the stale in-memory state cannot be saved over the restore.
     */
    async function restore(id) {
      await usable();
      if (!Number.isInteger(id)) throw kinded('not-found');
      let active = null;
      try {
        active = local ? local.read(ACTIVE_KEY) : null;
      } catch {
        /* unreadable: treated as none */
      }
      if (active) throw kinded('workout-active');
      readOnly = 'restoring'; // saves are refused while it runs
      try {
        await settled();
        const snap = await engine.getSnapshot(id);
        if (!snap) throw kinded('not-found');
        const r = runMigrations(migrations, snap.payload, { current });
        if (!r.ok) throw kinded(r.reason);
        const cur = await engine.readDoc();
        const next = Math.max(seq, cur && !cur.corrupt ? cur.seq : 0) + 1;
        await engine.writeDoc(r.doc, {
          seq: next,
          schema: current,
          snapshot:
            cur && !cur.corrupt
              ? {
                  reason: 'pre-restore',
                  schemaVersion: cur.doc.schemaVersion,
                  keep: false,
                  payload: JSON.stringify(cur.doc),
                  createdAt: now(),
                }
              : undefined,
        });
        seq = next;
        stampMirror(r.doc);
        noteCommitted(next);
        readOnly = 'restored';
        return { restored: id };
      } catch (e) {
        if (readOnly === 'restoring') readOnly = null;
        throw e;
      }
    }

    async function loadAll() {
      const d = await load();
      if (engine || provisional) afterLoad();
      if (!provisional) resolveReady();
      return d;
    }

    return {
      load: loadAll,
      loaded,
      rawText,
      save,
      status,
      subscribe,
      snapshot,
      snapshots,
      restore,
      attach,
      ready: () => ready,
    };
  }

  const api = {
    runMigrations,
    CURRENT_SCHEMA,
    LATEST_SCHEMA,
    MIGRATIONS,
    projectToV1,
    createLocalEngine,
    createIdbEngine,
    createStore,
    classifyError,
    STORAGE_KEY,
    LEGACY_KEYS,
    KEYS,
  };
  globalThis.HBStorage = Object.freeze(api);

  // ---- boot (browser only) ---------------------------------------------------------------------
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const domWait =
    document.readyState === 'complete'
      ? Promise.resolve()
      : new Promise((r) =>
          document.addEventListener('DOMContentLoaded', () => r(), { once: true }),
        );

  try {
    const openIdb = () => createIdbEngine().open();
    openIdb.idb = true; // lets the store tell it from the localStorage factory without calling it
    // IndexedDB first (opened and read right here, with a 1.2 s timeout), then localStorage, which
    // is also the v1 mirror. Any IndexedDB trouble falls back to localStorage for the session.
    const store = createStore({
      openEngines: [openIdb, () => createLocalEngine()],
      fastBoot: true,
      migrations: MIGRATIONS,
      current: LATEST_SCHEMA,
      now: () => Date.now(),
      nav: window.navigator,
    });
    store
      .load()
      .then(() => {
        window.HB = Object.freeze({
          storage: Object.freeze({
            save: store.save,
            status: store.status,
            subscribe: store.subscribe,
            loaded: store.loaded,
            rawText: store.rawText,
            snapshot: store.snapshot,
            snapshots: store.snapshots,
            restore: store.restore,
            ready: store.ready,
          }),
        });
        // Attach the save-problem bar now, so a load-time problem is on screen before hbStart removes
        // hb-booting. A fault in the bar must never stop the app from booting.
        try {
          if (window.hbSaveBarAttach) window.hbSaveBarAttach(window.HB.storage);
        } catch (e) {
          console.error('Save bar error:', e);
        }
        return domWait;
      })
      .then(() => window.hbStart())
      .then(() => {
        // Fast boot only: open IndexedDB right after the first paint (a timer backs up rAF, which
        // does not run in a hidden tab). attach() is idempotent and never throws.
        window.requestAnimationFrame(() => setTimeout(store.attach, 0));
        setTimeout(store.attach, 400);
      })
      .catch((e) => {
        console.error('Boot error:', e);
        window.hbBootFailed();
      });
  } catch (e) {
    console.error('Boot error:', e);
    window.hbBootFailed();
  }
})();
