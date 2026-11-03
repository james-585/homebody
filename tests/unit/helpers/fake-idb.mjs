// A small in-memory IndexedDB double, just enough for src/hb-storage.js's IDB engine. Tests only.
// It models what the engine relies on: transactions that serialise per database, requests that run
// in order and fire onsuccess, a transaction that commits when no request is left, abort that
// rolls the stores back, structured clone at put time (DataCloneError for a function), an
// out-of-line or keyPath+autoIncrement store and one index. Faults are switches on `ctl`.
const key = (a, b) =>
  typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a === 'number' ? -1 : 1;
const micro = (fn) => void Promise.resolve().then(fn);
const dom = (name, message = name) => Object.assign(new Error(message), { name });

export function createFakeIDB() {
  const dbs = new Map();
  const ctl = {
    hangOpen: false, // open() never answers
    errorOpen: false, // open() fires onerror
    blockedOpen: false, // open() fires onblocked
    failTransaction: null, // Error thrown by db.transaction()
    abortAfterOps: null, // number: the next readwrite transaction aborts (quota) after that many requests
    delayCommit: 0, // ms: the next readwrite transaction commits but reports completion this late
    stallNext: false, // the next readwrite transaction never completes
    abortNext: null, // Error: the next readwrite transaction aborts with it before writing
    handles: [], // every connection ever opened (for versionchange / counting)
    commits: 0, // readwrite transactions that committed
  };

  function makeStore(opts = {}) {
    return { opts, rows: new Map(), indexes: new Map(), next: 1 };
  }
  const sorted = (st) => [...st.rows.entries()].sort((a, b) => key(a[0], b[0]));

  function openDbRecord(name) {
    let rec = dbs.get(name);
    if (!rec) {
      rec = { version: 0, stores: new Map(), chain: Promise.resolve() };
      dbs.set(name, rec);
    }
    return rec;
  }

  function makeTransaction(rec, handle, names, mode) {
    if (ctl.failTransaction) throw ctl.failTransaction;
    if (handle.closed) throw dom('InvalidStateError', 'connection closed');
    for (const n of names) if (!rec.stores.has(n)) throw dom('NotFoundError', n);
    const tx = { mode, error: null, oncomplete: null, onabort: null, onerror: null };
    const ops = [];
    let finished = false;
    let backup = null;
    let release;

    const finish = (aborted) => {
      if (finished) return;
      finished = true;
      if (aborted && backup) {
        for (const [n, b] of backup) {
          rec.stores.get(n).rows = b.rows;
          rec.stores.get(n).next = b.next;
        }
        ops.length = 0;
      } else if (mode === 'readwrite') ctl.commits++;
      const fire = () => (aborted ? tx.onabort : tx.oncomplete)?.();
      if (!aborted && mode === 'readwrite' && ctl.delayCommit) {
        // applied now, but the completion event (and the lock) arrive late: a slow device
        const d = ctl.delayCommit;
        ctl.delayCommit = 0;
        setTimeout(() => (fire(), release?.()), d);
        return;
      }
      micro(fire);
      release?.(); // not yet begun (aborted straight after creation): the chain releases it
    };
    tx.abort = () => {
      if (finished) throw dom('InvalidStateError', 'finished');
      finish(true);
    };

    const step = () => {
      if (finished) return;
      const op = ops.shift();
      if (!op) return finish(false);
      if (mode === 'readwrite' && ctl.abortAfterOps !== null && ctl.abortAfterOps-- <= 0) {
        ctl.abortAfterOps = null;
        tx.error = dom('QuotaExceededError');
        return finish(true);
      }
      try {
        op.req.result = op.run();
      } catch (e) {
        op.req.error = e;
        tx.error = e;
        op.req.onerror?.();
        return finish(true);
      }
      op.req.onsuccess?.();
      micro(step);
    };

    const add = (run) => {
      if (finished) throw dom('TransactionInactiveError');
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      ops.push({ req, run });
      return req;
    };

    const stores = new Map();
    tx.objectStore = (n) => {
      if (!names.includes(n)) throw dom('NotFoundError', n);
      if (stores.has(n)) return stores.get(n);
      const st = rec.stores.get(n);
      const keyPath = st.opts.keyPath;
      const o = {
        put(value, k) {
          if (mode !== 'readwrite') throw dom('ReadOnlyError');
          const v = structuredClone(value); // DataCloneError for a function, as in a browser
          return add(() => {
            let kk = k;
            if (keyPath) {
              if (v[keyPath] === undefined) {
                v[keyPath] = st.next++;
              }
              kk = v[keyPath];
            }
            st.rows.set(kk, v);
            return kk;
          });
        },
        add(value, k) {
          return o.put(value, k);
        },
        delete(k) {
          if (mode !== 'readwrite') throw dom('ReadOnlyError');
          return add(() => void st.rows.delete(k));
        },
        clear() {
          if (mode !== 'readwrite') throw dom('ReadOnlyError');
          return add(() => void st.rows.clear());
        },
        get: (k) => add(() => (st.rows.has(k) ? structuredClone(st.rows.get(k)) : undefined)),
        getAll: () => add(() => sorted(st).map(([, v]) => structuredClone(v))),
        getAllKeys: () => add(() => sorted(st).map(([k]) => k)),
        count: () => add(() => st.rows.size),
        index: (iname) => ({
          getAllKeys: () =>
            add(() => {
              const path = st.indexes.get(iname);
              return sorted(st)
                .filter(([, v]) => v && v[path] !== undefined)
                .map(([k]) => k);
            }),
        }),
      };
      stores.set(n, o);
      return o;
    };

    // Serialise: begin after the previous transaction on this database finished.
    rec.chain = rec.chain.then(
      () =>
        new Promise((resolve) => {
          release = resolve;
          if (finished) return resolve(); // aborted before it began
          if (mode === 'readwrite' && ctl.stallNext) {
            ctl.stallNext = false;
            return; // holds the database lock forever, like a hung transaction
          }
          backup = new Map(
            names.map((n) => [
              n,
              { rows: new Map(rec.stores.get(n).rows), next: rec.stores.get(n).next },
            ]),
          );
          if (mode === 'readwrite' && ctl.abortNext) {
            tx.error = ctl.abortNext;
            ctl.abortNext = null;
            ops.length = 0;
            return finish(true);
          }
          micro(step);
        }),
    );
    return tx;
  }

  const factory = {
    open(name) {
      const req = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
      };
      setTimeout(() => {
        if (ctl.hangOpen) return;
        if (ctl.blockedOpen) return req.onblocked?.();
        if (ctl.errorOpen) {
          req.error = dom('UnknownError');
          return req.onerror?.();
        }
        const rec = openDbRecord(name);
        const handle = {
          closed: false,
          onversionchange: null,
          objectStoreNames: { contains: (n) => rec.stores.has(n) },
          createObjectStore(n, opts) {
            const st = makeStore(opts);
            rec.stores.set(n, st);
            return { createIndex: (iname, path) => st.indexes.set(iname, path) };
          },
          transaction: (names, mode) => makeTransaction(rec, handle, [].concat(names), mode),
          close() {
            handle.closed = true;
          },
        };
        ctl.handles.push(handle);
        req.result = handle;
        if (rec.version < 1) {
          rec.version = 1;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };

  /** Fire versionchange on every open connection (another tab upgrading). */
  const versionChange = () =>
    ctl.handles.filter((h) => !h.closed).forEach((h) => h.onversionchange?.());
  /** Direct access for assertions and for seeding a corrupt database. */
  const inspect = (name = 'homebody') => dbs.get(name);
  return { factory, ctl, versionChange, inspect };
}
