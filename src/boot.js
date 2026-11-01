// Boot: build the store, load the saved document, publish window.HB, then start the app.
// No top-level await: a module that awaits holds DOMContentLoaded, so the work is a promise chain
// and hbStart() runs from the DOMContentLoaded event itself, as the app always did.
// A failure in here must never leave a blank screen: hbBootFailed() starts the app on empty
// state without ever writing (so the stored data cannot be overwritten by an empty state).
import { createStore } from './storage/store.js';
import { createLocalEngine } from './storage/engine-local.js';

let domReady = document.readyState === 'complete';
const domWait = domReady
  ? Promise.resolve()
  : new Promise((r) =>
      document.addEventListener('DOMContentLoaded', () => ((domReady = true), r()), { once: true }),
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
