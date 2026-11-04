// Shared helpers for the T7 import/export tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS, LATEST_SCHEMA, runMigrations } from './hb-storage.mjs';
import { SYNTHETIC_DIR, REAL_EXPORT } from './load-fixtures.mjs';

export * as io from '../../../src/storage/import-export.js';
// Constants the existing helper does not re-export (read from the same global it uses).
export const {
  MAX_SEQ,
  SEQ_JUMP,
  HBSEQ_CORRUPT,
  MIRROR_CEILING,
  IMPORT_MAX_BYTES,
  IO_API_VERSION,
} = globalThis.HBStorage;
export const NOW = Date.UTC(2026, 10, 3, 12);
export const migrate = (d) => runMigrations(MIGRATIONS, d, { current: LATEST_SCHEMA });
export const REAL_TEXT = readFileSync(REAL_EXPORT, 'utf8');
export const real = () => JSON.parse(REAL_TEXT);
export const importFixture = (name) => readFileSync(join(SYNTHETIC_DIR, 'import', name), 'utf8');
export const opts = (extra = {}) => ({ now: NOW, migrate, ...extra });
/** A small valid file around one workout (current schema). */
export function file(over = {}) {
  const w = real().workouts[0];
  return {
    _vaultfit: true,
    _version: 2,
    workouts: [w],
    personalRecords: {},
    bodyMetrics: [],
    userPlans: [],
    profile: null,
    favourites: [],
    ...over,
  };
}
