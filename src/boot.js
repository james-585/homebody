// Boot: build the store, load the saved document, publish window.HB, then start the app.
// A failure in here must never leave a blank screen: hbBootFailed() starts the app on empty
// state without ever writing (so the stored data cannot be overwritten by an empty state).
import { createStore } from './storage/store.js';
import { createLocalEngine } from './storage/engine-local.js';

try {
  const store = createStore({ openEngines: [() => createLocalEngine()] });
  await store.load(); // localStorage resolves in microtasks; nothing slow is awaited here
  window.HB = Object.freeze({
    storage: Object.freeze({
      save: store.save,
      status: store.status,
      subscribe: store.subscribe,
      loaded: store.loaded,
    }),
  });
  if (document.readyState === 'loading') {
    await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  window.hbStart();
} catch (e) {
  console.error('Boot error:', e);
  window.hbBootFailed();
}
