// Loads the classic script src/hb-storage.js (it attaches globalThis.HBStorage; its browser boot
// block is skipped outside a browser) so unit tests can use the same code the page runs.
import '../../../src/hb-storage.js';
export const {
  runMigrations,
  CURRENT_SCHEMA,
  LATEST_SCHEMA,
  MIGRATIONS,
  projectToV1,
  createIdbEngine,
  decideBoot,
  canFastBoot,
  hbSeqOf,
  sigOf,
  KEYS,
  createLocalEngine,
  createStore,
  classifyError,
  STORAGE_KEY,
  LEGACY_KEYS,
} = globalThis.HBStorage;
