// localStorage engine: the only code that touches localStorage for app data. An engine is
// { name, read(key) -> string|null, write(key, text) -> Promise }. `write` calls setItem
// synchronously (a tap followed by an OS kill still persists) and reports failure through the
// returned promise. T6 adds an IndexedDB engine with the same shape, tried first.

export function createLocalEngine(storage = globalThis.localStorage) {
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
