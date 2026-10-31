// In-memory Storage double with fault switches, plus an async-engine double. Tests only.
export function quotaError() {
  const e = new Error('The quota has been exceeded.');
  e.name = 'QuotaExceededError';
  e.code = 22;
  return e;
}

export class FakeStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
    this.failWrites = null; // null | () => Error, applied to setItem of any key in failKeys
    this.failKeys = null; // null = all keys
    this.denyAccess = false; // getItem throws SecurityError
    this.log = []; // every mutation: { op, key }
  }
  getItem(k) {
    if (this.denyAccess) {
      const e = new Error('denied');
      e.name = 'SecurityError';
      throw e;
    }
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    if (this.failWrites && (!this.failKeys || this.failKeys.includes(k))) throw this.failWrites();
    this.log.push({ op: 'set', key: k });
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.log.push({ op: 'remove', key: k });
    this.map.delete(k);
  }
}

/** An engine whose writes complete only when the test says so (to prove ordering/coalescing). */
export function createManualEngine(initial = {}) {
  const data = new Map(Object.entries(initial));
  const pending = [];
  const written = [];
  return {
    name: 'manual',
    data,
    written,
    pending,
    read: (k) => (data.has(k) ? data.get(k) : null),
    write(k, text) {
      return new Promise((resolve) => {
        pending.push(() => {
          data.set(k, text);
          written.push(text);
          resolve();
        });
      });
    },
    /** Complete the oldest in-flight write. */
    flushOne() {
      pending.shift()?.();
    },
  };
}
