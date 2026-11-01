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
    'mirrorSigSeq',
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
  // name), meta, snapshots ({id, reason, createdAt, schemaVersion, keep, bytes, payload}).
  // Every write is ONE readwrite transaction: all or nothing. Own tiny promise wrapper; no library.

  const STORES = ['workouts', 'records', 'meta', 'snapshots'];
  const KEEP_LAST = 5; // snapshots kept PER REASON besides the keep:true one (ADR 0002 amended)

  function createIdbEngine({
    factory = globalThis.indexedDB,
    name = DB_NAME,
    timeoutMs = 1200, // shorter than the 1.5 s hb-booting failsafe: the engine is chosen before the UI
    txTimeoutMs = 8000, // a transaction that neither commits nor aborts is reported as failed
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => globalThis.clearTimeout(t),
  } = {}) {
    let db = null;
    let dbp = null;
    let openP = null;
    let abandoned = false;
    let firstResult; // the boot read, handed over once by takeFirst()

    const unavailable = (why, cause) => Object.assign(new Error(why), { fallback: why, cause });
    const closeQuietly = (d) => {
      try {
        d.close();
      } catch {
        /* already closed */
      }
    };

    function openDb() {
      return new Promise((resolve, reject) => {
        let r;
        let settled = false;
        try {
          if (!factory) throw new Error('indexedDB missing');
          r = factory.open(name, 1);
        } catch (e) {
          reject(unavailable('idb-unavailable', e));
          return;
        }
        r.onupgradeneeded = () => {
          const d = r.result;
          for (const n of ['workouts', 'records', 'meta']) {
            if (!d.objectStoreNames.contains(n)) d.createObjectStore(n);
          }
          if (!d.objectStoreNames.contains('snapshots')) {
            d.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
          }
        };
        r.onblocked = () => {
          settled = true; // a late success below is closed, never used
          reject(unavailable('idb-unavailable'));
        };
        r.onerror = () => {
          settled = true;
          reject(unavailable('idb-unavailable', r.error));
        };
        r.onsuccess = () => {
          const d = r.result;
          if (abandoned || settled) {
            closeQuietly(d); // a late-opening connection is closed and ignored
            return;
          }
          if (!STORES.every((s) => d.objectStoreNames.contains(s))) {
            closeQuietly(d);
            reject(unavailable('idb-unavailable'));
            return;
          }
          const drop = () => {
            closeQuietly(d); // another tab upgrading, or the browser closed us: reopen lazily
            if (db === d) db = null;
          };
          d.onversionchange = drop;
          d.onclose = drop;
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
     * when the transaction COMMITS; rejects (with the real cause) when it aborts or does not finish
     * in txTimeoutMs. An exception in body or in a callback wrapped by safe() aborts the
     * transaction, so nothing partial persists. The transaction is created synchronously when the
     * connection is already open; a connection the browser closed is reopened once.
     */
    async function run(mode, stores, body, retried = false) {
      const d = db ?? (await getDb());
      let tx;
      try {
        tx = d.transaction(stores, mode);
      } catch (e) {
        if (e && e.name === 'InvalidStateError' && !retried) {
          if (db === d) db = null;
          return run(mode, stores, body, true);
        }
        throw e;
      }
      return new Promise((resolve, reject) => {
        let out;
        let thrown = null;
        let over = false;
        const timer = setTimer(() => {
          if (over) return;
          over = true;
          reject(Object.assign(new Error('transaction timed out'), { name: 'TimeoutError' }));
        }, txTimeoutMs);
        const end = (fn) => () => {
          clearTimer(timer);
          if (over) return;
          over = true;
          fn();
        };
        const abort = (e) => {
          thrown = e;
          try {
            tx.abort();
          } catch {
            /* already finished */
          }
        };
        tx.oncomplete = end(() => resolve(out));
        tx.onabort = end(() => reject(thrown || tx.error || new Error('aborted')));
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

    /** Issue the reads of readDoc inside `tx`; `cb` gets the interpreted result. */
    function readInto(tx, safe, cb) {
      const w = tx.objectStore('workouts').getAll();
      const rk = tx.objectStore('records').getAllKeys();
      const rv = tx.objectStore('records').getAll();
      const mk = tx.objectStore('meta').getAllKeys();
      const mv = tx.objectStore('meta').getAll();
      mv.onsuccess = safe(() =>
        cb(interpret(w.result, rk.result, rv.result, mk.result, mv.result)),
      );
    }

    const readDoc = () =>
      run('readonly', ['workouts', 'records', 'meta'], (tx, { done, safe }) =>
        readInto(tx, safe, done),
      );

    function snapshotRecord(s) {
      return {
        reason: String(s.reason).slice(0, 40),
        createdAt: s.createdAt,
        schemaVersion: s.schemaVersion,
        keep: !!s.keep,
        bytes: s.payload.length,
        payload: s.payload,
      };
    }

    /** Per reason, keep the newest KEEP_LAST; keep:true and `protectId` are never pruned. */
    function prune(st, safe, protectId) {
      const all = st.getAll();
      all.onsuccess = safe(() => {
        const byReason = new Map();
        for (const s of all.result) {
          if (s.keep || s.id === protectId) continue;
          if (!byReason.has(s.reason)) byReason.set(s.reason, []);
          byReason.get(s.reason).push(s.id);
        }
        for (const ids of byReason.values()) {
          ids
            .sort((a, b) => a - b)
            .slice(0, Math.max(0, ids.length - KEEP_LAST))
            .forEach((id) => st.delete(id));
        }
      });
    }

    /**
     * Replace the whole document in one transaction. Options: seq, schema, metaPatch, snapshot
     * ({reason, schemaVersion, keep, payload, createdAt}, added in the same transaction and pruned),
     * ifUnmigrated (do nothing if meta.schemaVersion already exists: another tab migrated first),
     * expectSeq (if meta.seq is not that, something else committed since we looked: the state being
     * replaced is first kept as a `pre-overwrite` snapshot in the same transaction; `overwriteAt` is
     * its timestamp), protectId (a snapshot id the prune must not delete).
     * Resolves {skipped, overwrote}. A DataCloneError or quota failure aborts: nothing changed.
     */
    function writeDoc(doc, o = {}) {
      return run('readwrite', STORES, (tx, { done, safe }) => {
        const result = { skipped: false, overwrote: false };
        done(result);
        const go = safe((extra) => {
          const wk = tx.objectStore('workouts');
          const rc = tx.objectStore('records');
          const mt = tx.objectStore('meta');
          const sn = tx.objectStore('snapshots');
          if (extra) sn.add(snapshotRecord(extra));
          if (o.snapshot) sn.add(snapshotRecord(o.snapshot));
          wk.clear();
          const ws = Array.isArray(doc.workouts) ? doc.workouts : [];
          for (let i = 0; i < ws.length; i++) wk.put(ws[i] ?? null, i); // holes become null, as in JSON
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
          if (o.snapshot || extra) prune(sn, safe, o.protectId);
        });
        if (o.ifUnmigrated) {
          const g = tx.objectStore('meta').get('schemaVersion');
          g.onsuccess = safe(() => {
            if (g.result !== undefined) result.skipped = true;
            else go(null);
          });
        } else if (o.expectSeq !== undefined) {
          const g = tx.objectStore('meta').get('seq');
          g.onsuccess = safe(() => {
            if (g.result === undefined || g.result === o.expectSeq) return go(null);
            readInto(tx, safe, (cur) => {
              result.overwrote = true;
              go(
                cur && !cur.corrupt
                  ? {
                      reason: 'pre-overwrite',
                      schemaVersion: cur.doc.schemaVersion,
                      keep: false,
                      payload: JSON.stringify(cur.doc),
                      createdAt: o.overwriteAt ?? 0,
                    }
                  : null,
              );
            });
          });
        } else go(null);
      });
    }

    const eng = {
      name: 'indexedDB',
      idb: true,
      supports: Object.freeze({ snapshots: true }),
      /** True while a connection is open (a save may then hand over its object, see the store). */
      isOpen: () => !!db,
      /** Open (with the timeout) and do the one boot read. Rejects with {fallback}. */
      open() {
        return (openP ??= new Promise((resolve, reject) => {
          const t = setTimer(() => {
            abandoned = true;
            eng.close(); // an already-open connection with a stuck first read is closed too
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
          closeQuietly(db);
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

  // ---- boot decision (pure) ----------------------------------------------------------------------
  // Which copy wins at boot. No I/O: the store reads, calls this, then executes the action.
  //   stored      engine.readDoc() result (null = fresh database)
  //   mirrorRaw   the vaultfit_v1 text (or the text the page was rendered from), null if none
  //   mirrorSeq   its hbSeq, null when unmarked   mirrorSig  sigOf(mirrorRaw) when unmarked
  //   rendered    the UI already shows the mirror's data (fast boot): IndexedDB winning then means
  //               the page is stale, which can only be answered by going read-only
  // Actions: 'readonly' {kind: corrupt|future|stale}, 'empty', 'migrate', 'import-mirror',
  // 'use-idb' {mirror: 'missing'|'ok'|'stale'}. 'stale' adds rewriteMirror (IndexedDB is newer).
  function decideBoot({
    stored,
    mirrorRaw,
    mirrorSeq = null,
    mirrorSig = null,
    rendered = false,
    current,
  }) {
    if (stored && stored.corrupt) return { action: 'readonly', kind: 'corrupt' };
    if (stored && stored.doc.schemaVersion > current) return { action: 'readonly', kind: 'future' };
    if (!stored) return mirrorRaw ? { action: 'migrate' } : { action: 'empty' };
    if (!mirrorRaw) return { action: 'use-idb', mirror: 'missing' };
    const idbNewer = rendered
      ? { action: 'readonly', kind: 'stale', rewriteMirror: true }
      : { action: 'use-idb', mirror: 'stale', rewriteMirror: true };
    if (mirrorSeq !== null) {
      if (mirrorSeq > stored.seq) return { action: 'import-mirror' }; // killed before the commit
      return mirrorSeq === stored.seq ? { action: 'use-idb', mirror: 'ok' } : idbNewer;
    }
    // Unmarked: written by a pre-M1 build or a fallback session (newer), or it is the text that was
    // migrated and nothing has been committed since (equal), or later commits left it behind.
    if (mirrorSig !== stored.meta.mirrorSig) return { action: 'import-mirror' };
    return stored.meta.mirrorSigSeq === stored.seq ? { action: 'use-idb', mirror: 'ok' } : idbNewer;
  }

  /**
   * Pure: may a boot skip IndexedDB and read the mirror alone? Only when the mirror is provably
   * not older than IndexedDB. Marked: its hbSeq equals the idbSeq noted after the last commit.
   * Unmarked: no commit has ever been noted (any noted commit means the mirror may have missed it).
   */
  function canFastBoot({ mirrorSeq, sidecar }) {
    return mirrorSeq !== null ? sidecar.idbSeq === mirrorSeq : sidecar.idbSeq === undefined;
  }

  const sameDoc = (a, b) =>
    JSON.stringify(projectToV1({ workouts: [], ...a })) ===
    JSON.stringify(projectToV1({ workouts: [], ...b }));

  // ---- store: state machine ------------------------------------------------------------------------
  // boot: 'kv' (localStorage engine) | 'provisional' (rendered from the mirror, IndexedDB not yet
  // attached) | 'attached' (IndexedDB) | 'readonly'. canWrite() is the one gate in front of every
  // engine write; a read-only store can never write, and nothing clears a read-only state.

  const READONLY_BAR = { corrupt: 'corrupt', future: 'future' }; // anything else reuses 'unavailable'

  /**
   * @param {{openEngines: Array<() => object|Promise<object>>, migrations?: Array, current?: number,
   *          retryDelayMs?: number, setTimer?: Function, now?: () => number, nav?: object,
   *          fastBoot?: boolean, attachTimeoutMs?: number}} opts
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
    fastBoot = false, // boot from the mirror when it is provably not older than IndexedDB
    attachTimeoutMs = 8000, // attach() as a whole
  }) {
    let engine = null; // where documents are read and written
    let local = null; // the localStorage engine (the v1 mirror when `engine` is IndexedDB)
    let boot = 'kv';
    let readOnlyKind = null; // why boot is 'readonly'
    let doc = null; // the loaded document (a plain object), or null before load
    let error = null; // null | { kind }
    let phase = 'idle'; // 'idle' | 'retrying' | 'failed' | 'readonly'
    let meta = {}; // the sidecar / IndexedDB meta, copied field by field
    let asked = false; // persist() requested (this session or an earlier one)
    let persisted = null; // navigator.storage.persisted(), refreshed after boot
    let fallback = null; // null | 'idb-unavailable' | 'idb-timeout'
    let mirror = null; // IndexedDB mode only: 'ok' | 'stale'
    let seq = 0; // last numbered save, IndexedDB mode
    let committed = 0; // last seq known committed (expectSeq for the next write)
    let inflight = false;
    let queued = null; // { text, seq, waiters }
    let idle = [];
    const subs = new Set();
    let attachStarted = false;
    let fastRaw = null; // the mirror text the document was rendered from, kept verbatim
    let lastPlain = null; // { text, spliceable } of the newest provisional save, until restamped
    let idbSeqNoted = 0;
    let scheduled = false;
    let resolveReady;
    const ready = new Promise((r) => (resolveReady = r));

    const idbMode = () => boot === 'provisional' || boot === 'attached';
    const canWrite = () => boot === 'kv' || boot === 'attached';
    const kinded = (kind) => Object.assign(new Error(kind), { kind });

    const publish = (kind, state) => {
      if (boot === 'readonly' && state !== 'readonly') return; // nothing clears a read-only state
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

    /** Enter the read-only state: never written again this session. */
    function lock(kind) {
      boot = 'readonly';
      readOnlyKind = kind;
      publish(READONLY_BAR[kind] || 'unavailable', 'readonly');
    }

    function status() {
      const s = {
        engine: engine ? engine.name : boot === 'provisional' ? 'indexedDB' : 'none',
        attached: boot !== 'provisional',
        state: phase,
        persisted,
        persistAsked: asked,
        lastBackupAt: meta.lastBackupAt ?? null,
        snapshots:
          boot !== 'provisional' && !!(engine && engine.supports && engine.supports.snapshots),
      };
      if (meta.persistGranted !== undefined) s.persistGranted = meta.persistGranted;
      if (fallback) s.fallback = fallback;
      if (idbMode()) s.mirror = local ? mirror || 'ok' : 'off';
      if (error) s.error = error.kind;
      return s;
    }

    function failLoad(kind) {
      doc = {};
      lock(kind);
      return doc;
    }

    // ---- mirror helpers ---------------------------------------------------------------------
    const readMirror = () => {
      try {
        return local ? local.read(STORAGE_KEY) : null;
      } catch {
        return null;
      }
    };

    /** The sidecar remembers the last IndexedDB commit, so the next boot can prove "not older". */
    function noteCommitted(n) {
      if (!local || !(n > idbSeqNoted)) return;
      idbSeqNoted = n;
      try {
        Promise.resolve(local.writeMeta({ idbSeq: n })).catch(() => {});
      } catch {
        /* the sidecar is an optimisation */
      }
    }

    /** Write the mirror as projectToV1(d) + hbSeq. */
    function stampMirror(d, n) {
      if (!local) return;
      try {
        local.write(STORAGE_KEY, JSON.stringify({ ...projectToV1(d), hbSeq: n })).then(
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
      if (plain && Object.keys(payload).every((k) => V1_KEYS.includes(k)) && text.startsWith('{')) {
        return text.length > 2 ? `${text.slice(0, -1)},"hbSeq":${n}}` : `{"hbSeq":${n}}`;
      }
      return JSON.stringify({ ...projectToV1(plain ? payload : {}), hbSeq: n });
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

    // ---- boot: executing the decision ---------------------------------------------------------
    /** One transaction: migrate `src`, with a verbatim snapshot, then read back and compare. */
    async function commitMigration(e, src, side) {
      const r = runMigrations(migrations, src, { current }); // from the kept text, not live state
      if (!r.ok) throw new Error(r.reason);
      let from = 1;
      try {
        from = JSON.parse(src).schemaVersion ?? 1;
      } catch {
        /* the runner already parsed it */
      }
      const res = await e.writeDoc(r.doc, {
        seq: 1,
        schema: current,
        ifUnmigrated: true,
        metaPatch: {
          migratedFrom: from,
          migratedAt: now(),
          mirrorSig: sigOf(src),
          mirrorSigSeq: 1,
          ...side,
        },
        snapshot: {
          reason: 'pre-migration',
          schemaVersion: from,
          keep: true,
          payload: src,
          createdAt: now(),
        },
      });
      if (res.skipped) return { skipped: true };
      const back = await e.readDoc();
      if (!back || back.corrupt || !sameDoc(back.doc, r.doc)) throw new Error('verify');
      return { doc: r.doc, meta: back.meta };
    }

    /** One transaction: the mirror text replaces IndexedDB's state, which is snapshotted first. */
    async function commitImport(e, stored, src, mseq) {
      const r = runMigrations(migrations, src, { current });
      if (!r.ok) return null; // a corrupt or newer-than-known mirror is ignored, left as found
      const next = Math.max(stored.seq, mseq ?? 0) + 1;
      await e.writeDoc(r.doc, {
        seq: next,
        schema: current,
        snapshot: {
          reason: 'pre-reconcile',
          schemaVersion: stored.doc.schemaVersion,
          keep: false,
          payload: JSON.stringify(stored.doc),
          createdAt: now(),
        },
      });
      return { doc: r.doc, seq: next };
    }

    /**
     * Decide and execute. `raw` is the mirror text (or what the page was rendered from). Returns
     * the document the session runs on. Throws if an IndexedDB write failed (caller falls back).
     */
    async function resolveBoot(e, stored, raw, rendered) {
      for (let pass = 0; pass < 2; pass++) {
        const mseq = hbSeqOf(raw);
        const d = decideBoot({
          stored,
          mirrorRaw: raw,
          mirrorSeq: mseq,
          mirrorSig: raw && mseq === null ? sigOf(raw) : null,
          rendered,
          current,
        });
        if (stored) {
          meta = { ...stored.meta };
          asked = meta.persistAskedAt !== undefined;
          seq = Math.max(seq, stored.seq);
          committed = stored.seq;
        }
        switch (d.action) {
          case 'readonly':
            lock(d.kind);
            if (d.rewriteMirror && !lastPlain) stampMirror(stored.doc, stored.seq);
            return d.kind === 'stale' ? doc : {};
          case 'empty':
            meta = { ...(local ? local.readMeta() : {}) };
            asked = meta.persistAskedAt !== undefined;
            return {};
          case 'migrate': {
            const m = await commitMigration(e, raw, local ? local.readMeta() : {});
            if (m.skipped) {
              stored = await e.readDoc(); // another tab migrated first: just read
              continue;
            }
            seq = committed = 1;
            meta = { ...m.meta };
            asked = meta.persistAskedAt !== undefined;
            return m.doc; // vaultfit_v1 is left exactly as found, recognised by mirrorSig
          }
          case 'import-mirror': {
            const m = await commitImport(e, stored, raw, mseq);
            if (!m) return stored.doc;
            seq = committed = m.seq;
            stampMirror(m.doc, m.seq);
            noteCommitted(m.seq);
            return m.doc;
          }
          default: // 'use-idb'
            if (d.mirror === 'stale') mirror = 'stale';
            if (d.rewriteMirror && !lastPlain) stampMirror(stored.doc, stored.seq);
            if (d.mirror === 'ok' && mseq !== null) noteCommitted(stored.seq);
            return stored.doc;
        }
      }
      throw new Error('unreadable');
    }

    /** IndexedDB could not take the work: run this session on localStorage (data stays in memory). */
    function fallBackWith(d, why, adoptFailed) {
      fallback = fallback || why || 'idb-unavailable';
      engine = local;
      boot = local ? 'kv' : 'readonly';
      if (d) doc = d;
      if (adoptFailed) publish(adoptFailed);
      return doc;
    }

    // Fast boot: the simple IndexedDB-first boot costs about +35 ms on the first visible frame (T6a
    // measurements), so a boot whose mirror is provably not older than IndexedDB reads only the
    // mirror, as before M1, and opens IndexedDB after first paint (attach). See canFastBoot.
    async function tryFast() {
      const lf = openEngines.find((f) => !f.idb);
      if (!lf || !openEngines.some((f) => f.idb)) return null;
      try {
        const l = await lf();
        const raw = l.read(STORAGE_KEY);
        if (!raw) return null;
        const mseq = hbSeqOf(raw);
        const side = l.readMeta ? l.readMeta() : {};
        if (!canFastBoot({ mirrorSeq: mseq, sidecar: side })) return null;
        const r = runMigrations(migrations, raw, { current });
        if (!r.ok) return null; // the slow path reports corrupt / newer-than-known
        delete r.doc.hbSeq;
        local = l;
        fastRaw = raw;
        seq = mseq ?? side.idbSeq ?? 0;
        boot = 'provisional';
        doc = r.doc;
        return doc;
      } catch {
        return null;
      }
    }

    /** Open IndexedDB after first paint and decide, using the text the document was rendered from. */
    async function attach() {
      if (boot !== 'provisional' || attachStarted) return ready;
      attachStarted = true;
      let timedOut = false;
      const work = (async () => {
        const e = await openEngines.find((f) => f.idb)();
        let stored = e.takeFirst();
        if (stored === undefined) stored = await e.readDoc();
        engine = e;
        await resolveBoot(e, stored, fastRaw, true);
        if (boot === 'provisional') boot = 'attached';
      })();
      const guard = new Promise((res) =>
        setTimer(() => {
          timedOut = true;
          res();
        }, attachTimeoutMs),
      );
      try {
        await Promise.race([work, guard]);
        if (timedOut)
          throw Object.assign(new Error('attach timed out'), { fallback: 'idb-timeout' });
      } catch (err) {
        work.catch(() => {});
        if (engine && engine.close) engine.close();
        // saves go to the localStorage blob (plain text, unmarked); a later boot imports them
        fallBackWith(null, (err && err.fallback) || 'idb-unavailable');
      }
      resolveReady();
      return ready;
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
        boot = 'readonly';
        readOnlyKind = 'unavailable';
        publish('unavailable', 'readonly');
        return doc;
      }
      if (engine.idb) {
        boot = 'attached';
        let raw = readMirror();
        let adoptFailed = null;
        try {
          let stored = engine.takeFirst();
          if (stored === undefined) stored = await engine.readDoc();
          if (!stored && !raw && local) {
            const a = await adoptLegacy(local);
            if (a) {
              raw = a.raw;
              adoptFailed = a.failed;
            }
          }
          doc = await resolveBoot(engine, stored, raw, false);
          if (adoptFailed) publish(adoptFailed);
          return doc;
        } catch {
          // IndexedDB failed after it opened: the mirror text (if any) runs this session
          if (!local) return failLoad('unavailable');
          let d = null;
          const r = raw ? runMigrations(migrations, raw, { current }) : null;
          if (r && r.ok) d = r.doc;
          if (r && !r.ok) return failLoad(r.reason);
          return fallBackWith(d || {}, 'idb-unavailable', adoptFailed);
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

    // Called once the document is loaded. Nothing here is awaited on the boot path.
    function afterLoad() {
      if (!idbMode() || boot === 'provisional') {
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
      if (boot === 'provisional') {
        return ready.then(() => writeOnce(job));
      }
      if (!canWrite()) return Promise.reject(kinded(readOnlyKind || 'unavailable')); // the one gate
      if (idbMode()) {
        if (!job.seq) {
          job.seq = ++seq; // a fast-boot save: numbered now that the engine is known
          job.restamp = true;
        }
        try {
          // Always from the text taken at call time: the write runs in a later task (see save()),
          // so later mutation of the caller's object cannot leak in.
          return Promise.resolve(
            engine.writeDoc(JSON.parse(job.text), {
              seq: job.seq,
              schema: current,
              expectSeq: committed,
              overwriteAt: now(),
            }),
          );
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

    /** After the commit of a fast-boot save: give the (plain) mirror its hbSeq. */
    function restampMirror(job) {
      if (!local || !lastPlain || lastPlain.text !== job.text) return;
      const t = lastPlain;
      lastPlain = null;
      try {
        const body = t.spliceable
          ? mirrorText(t.text, { workouts: 1 }, job.seq)
          : JSON.stringify({ ...projectToV1(JSON.parse(t.text)), hbSeq: job.seq });
        local.write(STORAGE_KEY, body).then(
          () => (mirror = 'ok'),
          () => (mirror = 'stale'),
        );
      } catch {
        mirror = 'stale';
      }
    }

    function pump() {
      inflight = true;
      const job = queued;
      queued = null;
      const finish = (kind) => {
        const refused = !kind ? null : boot === 'readonly' ? readOnlyKind : kind;
        for (const w of job.waiters) refused ? w.rej(kinded(refused)) : w.res();
        inflight = false;
        publish(kind);
        if (!kind && idbMode() && job.seq) {
          if (job.restamp) restampMirror(job);
          committed = job.seq;
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
          if (boot === 'readonly') return finish(readOnlyKind); // refused, not retried
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
            writeOnce(job).then(
              () => finish(null),
              (e2) => finish(boot === 'readonly' ? readOnlyKind : classifyError(e2)),
            );
          }, retryDelayMs);
        },
      );
    }

    /** Stringifies NOW (later mutation cannot leak in). Resolves on success; rejects once published. */
    function save(payload) {
      if (boot === 'readonly') return Promise.reject(kinded(readOnlyKind));
      let text;
      try {
        text = JSON.stringify(payload);
      } catch {
        // A payload that cannot be serialised (for example a circular reference) is a failed save,
        // published like any other, never an exception thrown into the caller.
        publish('unknown', 'failed');
        return Promise.reject(kinded('unknown'));
      }
      const has = !!payload && Array.isArray(payload.workouts) && payload.workouts.length > 0;
      let n = 0;
      if (idbMode()) {
        // Rollback copy first, synchronously (a tap followed by an OS kill still persists). A
        // failure here is logged, never surfaced; status().mirror says 'stale'. While IndexedDB is
        // not attached yet the mirror is written as plain v1 text (unmarked = newer at next boot).
        const provisional = boot === 'provisional';
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
          queued.waiters.push(w);
        } else {
          queued = { text, has, seq: n, waiters: [w] };
        }
        if (inflight) return;
        if (!idbMode() || boot === 'provisional') return pump(); // localStorage: synchronous, as before
        // IndexedDB: the mirror above is already written synchronously; the clone and the
        // transaction run in the next task so a tap, Finish or edit does not pay for them. A kill
        // before it runs leaves the mirror's hbSeq ahead of meta.seq, which the boot rule imports.
        if (!scheduled) {
          scheduled = true;
          setTimer(() => {
            scheduled = false;
            if (!inflight && queued) pump();
          }, 0);
        }
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
      if (boot === 'readonly') throw kinded(readOnlyKind);
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
      boot = 'readonly'; // saves are refused while it runs
      readOnlyKind = 'restoring';
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
          protectId: id,
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
        seq = committed = next;
        stampMirror(r.doc, next);
        noteCommitted(next);
        lock('restored'); // read-only until reload; the bar says to reopen
        return { restored: id };
      } catch (e) {
        if (readOnlyKind === 'restoring') {
          boot = 'attached';
          readOnlyKind = null;
        }
        throw e;
      }
    }

    async function loadAll() {
      const d = await load();
      if (engine || boot === 'provisional') afterLoad();
      if (boot !== 'provisional') resolveReady();
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
    decideBoot,
    canFastBoot,
    sigOf,
    hbSeqOf,
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
