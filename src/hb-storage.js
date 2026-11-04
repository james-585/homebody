// HomeBody storage and boot, shipped as ONE classic script (no ES modules, no build step).
// Why classic: an ES-module boot measured ~+100 ms on the first visible frame against the
// pre-M1 start; a classic script is at baseline (ADR 0002 note, docs/offline.md). The sections
// below are the former src/storage/{migrate,engine-local,store}.js and src/boot.js, in order.
// It attaches `HBStorage` (for the node unit tests, which import this file) and, in a browser,
// publishes window.HB and starts the app. Nothing here runs I/O at load except the boot block.
(function () {
  'use strict';
  // The URL of this script, captured now: document.currentScript is null in later async code. The
  // lazy import/export modules are resolved against it (T7).
  const SCRIPT_SRC =
    typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : null;

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
    'writer',
  ];

  const STORAGE_KEY = 'vaultfit_v1';
  const LEGACY_KEYS = ['homebody_v1', 'homebody_v0', 'vaultfit_v0'];
  const META_KEY = 'hb_storage_meta'; // additive sidecar: { persistAskedAt, persistGranted }
  const ACTIVE_KEY = 'hb_active_workout';
  const DB_NAME = 'homebody';

  // ---- bounds (T7) -------------------------------------------------------------------------------
  // Counters: seq and hbSeq are integers in [0, MAX_SEQ]. Anything else read from storage is corrupt,
  // and nothing in this file writes a number above it (K39). A mirror whose hbSeq is more than
  // SEQ_JUMP past IndexedDB's seq is treated as corrupt too (a real gap is a few commits).
  const MAX_SEQ = 2147483647; // 2^31 - 1: ten digits at most
  const SEQ_JUMP = 1000000;
  const HBSEQ_CORRUPT = 'corrupt'; // hbSeqOf: a token is there but is not a valid counter
  // One ceiling for every mirror write (James, T7 Q2): above it the mirror is left as it is and
  // status().mirror says 'stale'. Never applied to the localStorage fallback engine's own writes.
  const MIRROR_CEILING = 512 * 1024; // characters of mirror text
  const IMPORT_MAX_BYTES = 20 * 1024 * 1024; // must equal LIMITS.maxBytes in src/storage/validate.js
  const IO_API_VERSION = 1; // must equal IO_API_VERSION in src/storage/validate.js (skew guard)

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

  /**
   * hbSeq from the tail of a mirror text without parsing it. null = no hbSeq token as the last key
   * (unmarked); an integer in [0, MAX_SEQ]; or HBSEQ_CORRUPT when a token is there but is negative,
   * a string, an exponent, too long or above MAX_SEQ. A corrupt token is never read as "absent".
   */
  function hbSeqOf(raw) {
    if (typeof raw !== 'string') return null;
    const at = raw.lastIndexOf('"hbSeq":'); // a raw quote cannot occur inside a JSON string
    if (at < 1 || (raw[at - 1] !== ',' && raw[at - 1] !== '{')) return null;
    const m = /^"hbSeq":("[^"\\]*"|[^,{}[\]"]*)\}$/.exec(raw.slice(at));
    if (!m) return null;
    if (!/^(0|[1-9]\d{0,9})$/.test(m[1])) return HBSEQ_CORRUPT;
    const n = Number(m[1]);
    return n <= MAX_SEQ ? n : HBSEQ_CORRUPT;
  }

  const seqOk = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_SEQ;

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
      /** Remove a key (the active workout, when it ends). true on success; never throws. */
      remove(key) {
        try {
          storage.removeItem(key);
          return true;
        } catch {
          return false;
        }
      },
      readMeta() {
        try {
          const raw = storage.getItem(META_KEY);
          const m = raw && raw.length < 1024 ? JSON.parse(raw) : null;
          if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
          const out = {};
          if (typeof m.persistAskedAt === 'number') out.persistAskedAt = m.persistAskedAt;
          if (seqOk(m.idbSeq)) out.idbSeq = m.idbSeq;
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
  // Stored reasons are a closed set (a caller-supplied string is never stored as is). pre-reconcile
  // snapshots are never pruned until T8 ships a visible restore (K33).
  const SNAPSHOT_REASONS = [
    'pre-migration',
    'pre-reconcile',
    'pre-restore',
    'pre-overwrite',
    'pre-import',
    'manual',
  ];
  const UNPRUNED_REASONS = ['pre-reconcile'];

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
      if (!Number.isInteger(sv) || sv < 1 || !seqOk(meta.seq)) {
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
        reason: SNAPSHOT_REASONS.includes(s.reason) ? s.reason : 'manual',
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
          if (s.keep || s.id === protectId || UNPRUNED_REASONS.includes(s.reason)) continue;
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
        const result = { skipped: false, overwrote: false, seq: o.seq ?? 0 };
        done(result);
        const target = o.schema ?? doc.schemaVersion ?? LATEST_SCHEMA;
        const refuse = (kind) => {
          throw Object.assign(new Error(kind), { kind });
        };
        // our own earlier attempt that finished after its timeout (same seq, same session tag)
        const ownRetry = () =>
          o.writer !== undefined && sq.result === o.seq && wr.result === o.writer;
        const go = safe((extra) => {
          const wk = tx.objectStore('workouts');
          const rc = tx.objectStore('records');
          const mt = tx.objectStore('meta');
          const sn = tx.objectStore('snapshots');
          if (extra) sn.add(snapshotRecord(extra));
          if (o.snapshot) {
            const added = sn.add(snapshotRecord(o.snapshot));
            added.onsuccess = safe(() => {
              result.snapshotId = added.result; // lets a caller (import) offer Undo
            });
          }
          wk.clear();
          const ws = Array.isArray(doc.workouts) ? doc.workouts : [];
          for (let i = 0; i < ws.length; i++) wk.put(ws[i] ?? null, i); // holes become null, as in JSON
          for (const k of RECORD_KEYS) {
            if (doc[k] !== undefined) rc.put(doc[k], k);
            else rc.delete(k);
          }
          // meta.seq never goes backwards: past whatever was there, unless it is our own late retry
          const floor = typeof sq.result === 'number' && !ownRetry() ? sq.result + 1 : 0;
          result.seq = Math.max(o.seq ?? 0, floor);
          if (!seqOk(result.seq)) refuse('corrupt'); // MAX_SEQ: abort, nothing is written
          mt.put(target, 'schemaVersion');
          mt.put(result.seq, 'seq');
          // every document write sets or clears the tag, so another tab's import or restore is
          // never mistaken for this tab's own late retry
          if (o.writer !== undefined) mt.put(o.writer, 'writer');
          else mt.delete('writer');
          for (const f of META_FIELDS) {
            if (o.metaPatch && o.metaPatch[f] !== undefined && f !== 'schemaVersion' && f !== 'seq')
              mt.put(o.metaPatch[f], f);
          }
          if (o.snapshot || extra) prune(sn, safe, o.protectId);
        });
        // Preflight inside the transaction: never replace corrupt data or a newer schema, whatever
        // this tab believed when it started. Then, unless a migration claims a fresh database,
        // check meta.seq (expectSeq) and keep what is replaced if somebody else committed.
        const sv = tx.objectStore('meta').get('schemaVersion');
        const sq = tx.objectStore('meta').get('seq');
        const wr = tx.objectStore('meta').get('writer');
        const wc = tx.objectStore('workouts').count();
        const rcnt = tx.objectStore('records').count();
        rcnt.onsuccess = safe(() => {
          const v = sv.result;
          if (v === undefined) {
            if (wc.result > 0 || rcnt.result > 0) refuse('corrupt'); // data without meta
          } else if (!Number.isInteger(v) || v < 1 || !seqOk(sq.result)) {
            refuse('corrupt'); // includes a seq that is not an integer or is above MAX_SEQ
          } else if (v > target) refuse('future');
          if (o.ifUnmigrated) {
            if (v !== undefined) result.skipped = true;
            else go(null);
          } else if (
            o.expectSeq === undefined ||
            sq.result === undefined ||
            sq.result === o.expectSeq ||
            ownRetry()
          ) {
            go(null);
          } else {
            if (o.skipOnMismatch) {
              result.skipped = true; // the caller re-reads and decides again
              return;
            }
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
          }
        });
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
    // A counter that is not a valid integer, or absurdly far ahead, is corrupt (K39): the mirror is
    // ignored (IndexedDB wins, no import) and rewritten; the store keeps its text first if it differs.
    if (mirrorSeq === HBSEQ_CORRUPT || (mirrorSeq !== null && mirrorSeq > stored.seq + SEQ_JUMP)) {
      return { action: 'use-idb', mirror: 'stale', rewriteMirror: true, ignoredMirror: true };
    }
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
    if (mirrorSeq === HBSEQ_CORRUPT) return false;
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
   *          fastBoot?: boolean, attachTimeoutMs?: number, loadIo?: Function}} opts
   *   openEngines: ordered factories; the first that opens and reads wins. When that is the
   *   IndexedDB engine, the first localStorage engine in the list is also opened (the v1 mirror).
   */
  function createStore({
    openEngines,
    migrations = [],
    current = CURRENT_SCHEMA,
    retryDelayMs = 250,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => globalThis.clearTimeout(t),
    now = () => 0,
    nav = null, // navigator-like { storage: { persist, persisted } }; never required
    fastBoot = false, // boot from the mirror when it is provably not older than IndexedDB
    attachTimeoutMs = 8000, // attach() as a whole
    loadIo = null, // () => Promise<module>: the lazy import/export module (T7); never required
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
    let activeError = null; // last saveActive failure kind, null when the last write worked
    const writer = Math.random().toString(36).slice(2, 10); // per session, only tells our own retry from another tab's commit
    let resolveReady;
    const ready = new Promise((r) => (resolveReady = r));

    // The mirror and sidecar are only maintained by an IndexedDB session (or a restore in progress).
    const mirrorLive = () =>
      idbMode() || readOnlyKind === 'restoring' || readOnlyKind === 'importing';
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
      if (activeError) s.activeError = activeError;
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
      if (!local || !mirrorLive() || !(n > idbSeqNoted)) return;
      idbSeqNoted = n;
      try {
        Promise.resolve(local.writeMeta({ idbSeq: n })).catch(() => {});
      } catch {
        /* the sidecar is an optimisation */
      }
    }

    /** Write the mirror as projectToV1(d) + hbSeq (through the one gate, mirrorText). */
    function stampMirror(d, n) {
      if (!local || !mirrorLive()) return; // work that outlived its session must not touch the mirror
      try {
        const p = projectToV1(d);
        const body = mirrorText(JSON.stringify(p), p, n);
        if (body === null) {
          mirror = 'stale'; // over the ceiling or a bad counter: the existing mirror is left as it is
          return;
        }
        local.write(STORAGE_KEY, body).then(
          () => (mirror = 'ok'),
          () => (mirror = 'stale'),
        );
      } catch {
        mirror = 'stale';
      }
    }

    /**
     * THE gate for every mirror write (stampMirror, renumberMirror, restampMirror, the save path,
     * including provisional plain writes). The mirror text is the payload's own JSON with hbSeq
     * appended (no second serialisation); n null/undefined = a plain write with no counter.
     * Returns null when the write must not happen: the counter is not an integer in [0, MAX_SEQ]
     * (K39), or the text is over MIRROR_CEILING (then the existing mirror stays as it is, and the
     * caller reports mirror 'stale'). Never used for the localStorage fallback engine's own writes
     * or for the legacy-key adoption, where refusing would drop the only copy.
     */
    function mirrorText(text, payload, n) {
      if (text.length > MIRROR_CEILING) return null;
      let out;
      if (n === null || n === undefined) {
        out = text;
      } else if (!seqOk(n)) {
        return null;
      } else {
        const plain = payload && typeof payload === 'object' && !Array.isArray(payload);
        if (
          plain &&
          Object.keys(payload).every((k) => V1_KEYS.includes(k)) &&
          text.startsWith('{')
        ) {
          out = text.length > 2 ? `${text.slice(0, -1)},"hbSeq":${n}}` : `{"hbSeq":${n}}`;
        } else {
          out = JSON.stringify({ ...projectToV1(plain ? payload : {}), hbSeq: n });
        }
      }
      return out.length > MIRROR_CEILING ? null : out;
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
      const res = await e.writeDoc(r.doc, {
        seq: next,
        schema: current,
        expectSeq: stored.seq,
        skipOnMismatch: true,
        snapshot: {
          reason: 'pre-reconcile',
          schemaVersion: stored.doc.schemaVersion,
          keep: false,
          payload: JSON.stringify(stored.doc),
          createdAt: now(),
        },
      });
      return res.skipped ? { skipped: true } : { doc: r.doc, seq: res.seq };
    }

    /**
     * A mirror with a corrupt counter is ignored (IndexedDB wins). Before it is overwritten, its
     * text is kept as a pre-reconcile snapshot when it differs from what IndexedDB holds, so
     * nothing is lost. Resolves false when the text should not be overwritten (it could not be
     * kept). Nothing is overwritten, so nothing is kept, when the gate would refuse the rewrite.
     */
    async function keepIgnoredMirror(e, stored, raw) {
      const p = projectToV1(stored.doc);
      if (mirrorText(JSON.stringify(p), p, stored.seq) === null) return true; // rewrite refused anyway
      let same = false;
      try {
        const m = JSON.parse(raw);
        if (m && typeof m === 'object' && !Array.isArray(m)) {
          delete m.hbSeq;
          same = sameDoc(m, stored.doc);
        }
      } catch {
        /* unparseable: kept as text */
      }
      if (same) return true;
      try {
        await e.addSnapshot({
          reason: 'pre-reconcile',
          schemaVersion: 1,
          keep: false,
          payload: raw,
          createdAt: now(),
        });
        return true;
      } catch {
        return false;
      }
    }

    /**
     * Decide and execute. `raw` is the mirror text (or what the page was rendered from). Returns
     * the document the session runs on. Throws if an IndexedDB write failed (caller falls back).
     */
    async function resolveBoot(e, stored, raw, rendered, live = () => true) {
      const check = () => {
        if (!live()) throw Object.assign(new Error('cancelled'), { cancelled: true });
      };
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
        check();
        if (stored) {
          meta = { ...stored.meta };
          asked = meta.persistAskedAt !== undefined;
          seq = Math.max(seq, stored.seq);
          committed = stored.seq;
        }
        switch (d.action) {
          case 'readonly':
            if (d.rewriteMirror && !lastPlain) stampMirror(stored.doc, stored.seq); // before lock()
            lock(d.kind);
            return d.kind === 'stale' ? doc : {};
          case 'empty':
            meta = { ...(local ? local.readMeta() : {}) };
            asked = meta.persistAskedAt !== undefined;
            return {};
          case 'migrate': {
            const m = await commitMigration(e, raw, local ? local.readMeta() : {});
            check(); // an IndexedDB session that was given up on changes nothing more
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
            check();
            if (m && m.skipped) {
              stored = await e.readDoc(); // changed under us: look again
              check();
              continue;
            }
            if (!m) return stored.doc;
            seq = committed = m.seq;
            stampMirror(m.doc, m.seq);
            noteCommitted(m.seq);
            return m.doc;
          }
          default: // 'use-idb'
            if (d.mirror === 'stale') mirror = 'stale';
            if (d.ignoredMirror && !lastPlain && !(await keepIgnoredMirror(e, stored, raw))) {
              return stored.doc; // could not keep the ignored text: leave the mirror as found
            }
            check();
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
      // Once this session is given up on (timeout or failure), `live()` is false and nothing the
      // abandoned work does afterwards may change state, the mirror or the sidecar.
      let isLive = true;
      const live = () => isLive;
      let timer;
      let timedOut = false;
      const work = (async () => {
        const e = await openEngines.find((f) => f.idb)();
        if (!live()) return e.close();
        let stored = e.takeFirst();
        if (stored === undefined) {
          try {
            stored = await e.readDoc();
          } catch (x) {
            e.close();
            throw x;
          }
        }
        if (!live()) return e.close();
        engine = e;
        await resolveBoot(e, stored, fastRaw, true, live);
        if (live() && boot === 'provisional') boot = 'attached';
      })();
      const guard = new Promise((res) => {
        timer = setTimer(() => {
          timedOut = true;
          res();
        }, attachTimeoutMs);
      });
      try {
        await Promise.race([work, guard]);
        if (timedOut)
          throw Object.assign(new Error('attach timed out'), { fallback: 'idb-timeout' });
      } catch (err) {
        isLive = false;
        work.catch(() => {});
        if (engine && engine.close) engine.close();
        if (err && (err.kind === 'future' || err.kind === 'corrupt')) {
          lock(err.kind); // the transaction refused to replace unreadable or newer data
        } else {
          // saves go to the localStorage blob (plain text, unmarked); a later boot imports them
          fallBackWith(null, (err && err.fallback) || 'idb-unavailable');
        }
      } finally {
        clearTimer(timer);
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
        } catch (err) {
          // IndexedDB failed after it opened: the mirror text (if any) runs this session
          if (err && (err.kind === 'future' || err.kind === 'corrupt')) return failLoad(err.kind);
          if (!local) return failLoad('unavailable');
          let d = null;
          const r = raw ? runMigrations(migrations, raw, { current }) : null;
          if (r && r.ok) d = r.doc;
          if (r && !r.ok) return failLoad(r.reason);
          fallBackWith(d || {}, 'idb-unavailable', adoptFailed);
          return staleGuard(raw);
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
      delete doc.hbSeq;
      if (adoptFailed) publish(adoptFailed);
      return fallback ? staleGuard(raw) : doc;
    }

    /**
     * A localStorage session that replaces IndexedDB (fallback) must not run writable on a marked
     * mirror known to be older than IndexedDB (hbSeq below the sidecar's idbSeq): it would write
     * stale data as the newest. Open read-only on that data instead (the existing "Saving is not
     * working, close and reopen" bar); a later IndexedDB boot repairs the mirror.
     */
    function staleGuard(raw) {
      const mseq = hbSeqOf(raw);
      let side = {};
      try {
        side = local && local.readMeta ? local.readMeta() : {};
      } catch {
        /* unreadable sidecar: no proof of staleness */
      }
      if (mseq !== null && side.idbSeq !== undefined && mseq < side.idbSeq) lock('stale');
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
              writer,
              expectSeq: committed,
              overwriteAt: now(),
            }),
          ).then((res) => {
            // another tab committed first: its state was kept as pre-overwrite, and our counter
            // moves past it so the next write is not mistaken for another overwrite
            if (res) {
              seq = Math.max(seq, res.seq);
              job.committedSeq = res.seq;
            }
            return res;
          });
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

    /** The commit was numbered past what it replaced: give the mirror the same number (if still newest). */
    function renumberMirror(job) {
      if (!local || !mirrorLive() || queued) return;
      try {
        const body = mirrorText(job.text, JSON.parse(job.text), job.committedSeq);
        if (body === null) {
          mirror = 'stale';
          return;
        }
        local.write(STORAGE_KEY, body).catch(() => (mirror = 'stale'));
      } catch {
        mirror = 'stale';
      }
    }

    /** After the commit of a fast-boot save: give the (plain) mirror its hbSeq. */
    function restampMirror(job) {
      if (!local || !lastPlain || lastPlain.text !== job.text) return;
      const t = lastPlain;
      lastPlain = null;
      try {
        let body;
        if (t.spliceable) {
          body = mirrorText(t.text, { workouts: 1 }, job.seq);
        } else {
          const p = projectToV1(JSON.parse(t.text));
          body = mirrorText(JSON.stringify(p), p, job.seq);
        }
        if (body === null) {
          mirror = 'stale'; // the provisional plain write was refused too; the old mirror stays
          return;
        }
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
          else if (job.committedSeq !== undefined && job.committedSeq !== job.seq)
            renumberMirror(job);
          committed = job.committedSeq ?? job.seq;
          noteCommitted(job.committedSeq ?? job.seq);
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
          if (e && (e.kind === 'future' || e.kind === 'corrupt') && boot !== 'readonly')
            lock(e.kind);
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
              (e2) => {
                if (e2 && (e2.kind === 'future' || e2.kind === 'corrupt') && boot !== 'readonly')
                  lock(e2.kind);
                finish(boot === 'readonly' ? readOnlyKind : classifyError(e2));
              },
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
          const body = provisional ? mirrorText(text, null, null) : mirrorText(text, payload, n);
          if (body === null) {
            mirror = 'stale'; // over the ceiling: no plain text is written, the old mirror stays
          } else {
            const p = local.write(STORAGE_KEY, body);
            mirror = p.syncError ? 'stale' : 'ok';
            if (p.syncError) console.warn('HomeBody: v1 mirror not written');
            p.catch(() => {});
          }
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

    // ---- the active workout (hb_active_workout stays in localStorage, ADR 0002) -----------------
    /**
     * Write (a JSON string) or clear (null) the in-progress workout. SYNCHRONOUS: setItem runs in
     * the calling tick, so logging a set survives an OS kill the moment it is tapped. Returns true
     * on success, false on failure (kind in status().activeError); never throws. The caller (the
     * app's wmPersist) turns the result into the save-problem bar and clears it on a later success.
     */
    function saveActive(json) {
      const eng = local || (engine && !engine.idb ? engine : null);
      let ok = false;
      let kind = null;
      try {
        if (!eng) throw Object.assign(new Error('unavailable'), { name: 'SecurityError' });
        if (json === null) {
          ok = eng.remove(ACTIVE_KEY);
          if (!ok) kind = 'unknown';
        } else {
          const p = eng.write(ACTIVE_KEY, json);
          p.catch(() => {});
          if (p.syncError) kind = classifyError(p.syncError);
          else ok = true;
        }
      } catch (e) {
        kind = classifyError(e);
      }
      activeError = ok ? null : kind || 'unknown';
      return ok;
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
      await settled(); // let queued saves finish first, then refuse new ones while this runs
      boot = 'readonly';
      readOnlyKind = 'restoring';
      try {
        await settled();
        const snap = await engine.getSnapshot(id);
        if (!snap) throw kinded('not-found');
        const r = runMigrations(migrations, snap.payload, { current });
        if (!r.ok) throw kinded(r.reason);
        const cur = await engine.readDoc();
        const next = Math.max(seq, cur && !cur.corrupt ? cur.seq : 0) + 1;
        const res = await engine.writeDoc(r.doc, {
          seq: next,
          schema: current,
          protectId: id,
          expectSeq: cur && !cur.corrupt ? cur.seq : undefined,
          overwriteAt: now(),
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
        seq = committed = res.seq;
        stampMirror(r.doc, res.seq);
        noteCommitted(res.seq);
        lock('restored'); // read-only until reload; the bar says to reopen
        return { restored: id };
      } catch (e) {
        if (readOnlyKind === 'restoring') {
          boot = 'attached';
          readOnlyKind = null;
        }
        if (e && (e.kind === 'future' || e.kind === 'corrupt')) lock(e.kind);
        throw e;
      }
    }

    // ---- import, undo, export (T7). The pure work (validate, merge, summarise, build) lives in the
    // lazily loaded module src/storage/import-export.js; everything that touches storage is here. -----
    const activeWorkout = () => {
      try {
        return !!(local && local.read(ACTIVE_KEY));
      } catch {
        return false; // unreadable: treated as none, as restore does
      }
    };

    /** The lazy module, or a refusal. Never falls back to any older import path. */
    async function getIo() {
      if (!loadIo) throw kinded('io-unavailable');
      let m;
      try {
        m = await loadIo();
      } catch {
        throw kinded('io-unavailable'); // no detail is kept: it could echo a URL or file content
      }
      if (!m || m.IO_API_VERSION !== IO_API_VERSION || m.LATEST_SCHEMA !== current) {
        throw kinded('io-skew'); // old page, new modules (or the reverse): reload
      }
      return m;
    }

    /** Validate raw file text. Throws kind 'invalid' with {reason, where, problems} (no values). */
    function validateText(io, text) {
      const v = io.validate(text, {
        now: now(),
        migrate: (d) => runMigrations(migrations, d, { current }),
      });
      if (!v.ok) {
        throw Object.assign(kinded('invalid'), {
          reason: v.reason,
          where: v.where,
          problems: v.problems,
        });
      }
      return v;
    }

    /** What would change, for both modes. Writes nothing. Refuses where an import would be refused. */
    async function previewImport(text) {
      const io = await getIo();
      const v = validateText(io, text);
      await usable();
      if (doc === null) throw kinded('not-loaded');
      await settled();
      const cur = await engine.readDoc();
      if (cur && cur.corrupt) throw kinded('corrupt');
      const curDoc = cur ? cur.doc : { workouts: [] };
      return {
        summary: io.summarize(curDoc, v, { mirrorCeiling: MIRROR_CEILING }),
        partial: v.partial,
      };
    }

    /**
     * Import file text. ALWAYS validates the raw text itself (there is no "already validated"
     * input), then, under the same kind of lock restore uses, merges against what IndexedDB holds
     * NOW (never against the caller's in-memory state), and writes data + `pre-import` snapshot +
     * meta in ONE transaction (expectSeq, skipOnMismatch). Resolves {snapshotId, seq, doc, counts}:
     * the caller replaces its state from `doc` in the same tick. The store is writable again only
     * when this resolves or fails; on any failure it is released (unless the data is corrupt/newer).
     */
    async function importDoc(text, { mode = 'merge' } = {}) {
      if (mode !== 'merge' && mode !== 'replace') throw kinded('bad-mode');
      const io = await getIo();
      const v = validateText(io, text);
      if (mode === 'replace' && v.partial.partial) throw kinded('partial-replace');
      await usable(); // IndexedDB engine only (the fallback engine has no snapshots: refused)
      if (doc === null) throw kinded('not-loaded');
      if (boot !== 'attached') throw kinded(readOnlyKind || 'unavailable');
      if (activeWorkout()) throw kinded('workout-active');
      boot = 'readonly'; // the lock: no save can start until state is replaced or this fails
      readOnlyKind = 'importing';
      try {
        await settled();
        if (activeWorkout()) throw kinded('workout-active'); // re-check after the wait
        const cur = await engine.readDoc();
        if (cur && cur.corrupt) throw kinded('corrupt');
        const curDoc = cur ? cur.doc : { workouts: [], schemaVersion: current };
        const m = io.mergeDocs(curDoc, v.doc, mode);
        if (!m.ok) throw Object.assign(kinded('invalid'), { reason: m.reason, where: 'merge' });
        const next = { ...m.doc, schemaVersion: current };
        const res = await engine.writeDoc(next, {
          seq: Math.max(seq, cur ? cur.seq : 0) + 1,
          schema: current,
          expectSeq: cur ? cur.seq : undefined,
          skipOnMismatch: true, // another tab committed since we looked: refuse, preview again
          overwriteAt: now(),
          snapshot: {
            reason: 'pre-import',
            schemaVersion: curDoc.schemaVersion ?? current,
            keep: false,
            payload: JSON.stringify(curDoc),
            createdAt: now(),
          },
        });
        if (res.skipped) throw kinded('changed-elsewhere');
        seq = committed = res.seq;
        stampMirror(next, res.seq); // needs the lock kind (mirrorLive); over the ceiling -> 'stale'
        noteCommitted(res.seq);
        doc = next;
        boot = 'attached';
        readOnlyKind = null;
        return { snapshotId: res.snapshotId ?? null, seq: res.seq, doc: next, counts: m.counts };
      } catch (e) {
        if (readOnlyKind === 'importing') {
          boot = 'attached';
          readOnlyKind = null;
        }
        if (e && (e.kind === 'future' || e.kind === 'corrupt')) lock(e.kind);
        throw e;
      }
    }

    /** Is Undo still clean? It reads meta.seq from IndexedDB now, not an in-memory value. */
    async function checkUndo({ commitSeq }) {
      await usable();
      await settled();
      const m = await engine.readMeta();
      return { laterChanges: m.seq !== commitSeq };
    }

    /**
     * Undo an import: restore its pre-import snapshot (restore snapshots the present state first,
     * so even later changes are kept). If something was saved since the import (any tab) this
     * refuses with 'changed-since' unless the caller passes acceptLater (the designer's warning
     * said later changes will be removed). The store is read-only afterwards: the caller reloads.
     */
    async function undoImport({ snapshotId, commitSeq }, { acceptLater = false } = {}) {
      if (!Number.isInteger(snapshotId)) throw kinded('not-found');
      const { laterChanges } = await checkUndo({ commitSeq });
      if (laterChanges && !acceptLater) throw kinded('changed-since');
      return restore(snapshotId);
    }

    /** Build the export file text for `payload` (the six sets). Partial when the data is unreadable. */
    async function buildExport(payload) {
      const io = await getIo();
      let partialReason = null;
      if (boot === 'readonly' && !['restored', 'restoring', 'importing'].includes(readOnlyKind)) {
        partialReason = { corrupt: 'unreadable', future: 'newer' }[readOnlyKind] || 'unavailable';
      }
      return io.buildExport(payload, {
        now: now(),
        partialReason,
        migrate: (d) => runMigrations(migrations, d, { current }),
      });
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
      previewImport,
      importDoc,
      checkUndo,
      undoImport,
      buildExport,
      saveActive,
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
    MAX_SEQ,
    SEQ_JUMP,
    HBSEQ_CORRUPT,
    MIRROR_CEILING,
    IMPORT_MAX_BYTES,
    IO_API_VERSION,
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
      // Lazy: nothing is fetched until the first Import/Export. A failure refuses ('io-unavailable');
      // there is no fallback to any older import path. file:// is unsupported (no module loads).
      loadIo: () =>
        SCRIPT_SRC && /^https?:/.test(SCRIPT_SRC)
          ? import(SCRIPT_SRC.replace(/[?#].*$/, '').replace(/[^/]*$/, 'storage/import-export.js'))
          : Promise.reject(new Error('no module url')),
    });
    const ioError = (kind, extra) => Object.assign(new Error(kind), { kind }, extra);
    const io = Object.freeze({
      /**
       * Read, validate and preview an import file. Nothing is written until apply().
       * Resolves {summary, apply({mode}), checkUndo(), undo({acceptLater})}; rejects with an Error
       * whose `kind` is a fixed code ('invalid' + reason/where, 'io-unavailable', 'io-skew', ...).
       */
      async importFile(file) {
        if (!file || typeof file.size !== 'number' || typeof file.text !== 'function') {
          throw ioError('invalid', { reason: 'not-text' });
        }
        if (file.size > IMPORT_MAX_BYTES) throw ioError('invalid', { reason: 'too-large' });
        let text = await file.text();
        const preview = await store.previewImport(text);
        let last = null;
        return Object.freeze({
          summary: preview.summary,
          async apply({ mode = 'merge' } = {}) {
            if (text === null) throw ioError('consumed');
            const r = await store.importDoc(text, { mode });
            text = null;
            last = { snapshotId: r.snapshotId, commitSeq: r.seq };
            return r;
          },
          checkUndo: () => (last ? store.checkUndo(last) : Promise.reject(ioError('not-found'))),
          undo: (o) => (last ? store.undoImport(last, o) : Promise.reject(ioError('not-found'))),
        });
      },
      /** The export file for `payload` (the six sets): {ok, text, filename, partial, warnings}. */
      exportFile: (payload) => store.buildExport(payload),
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
            saveActive: store.saveActive,
            ready: store.ready,
          }),
          io,
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
