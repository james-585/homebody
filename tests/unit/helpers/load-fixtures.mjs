import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = join(here, '..', '..', 'fixtures');
export const LEGACY_DIR = join(FIXTURES_ROOT, 'legacy');
export const SYNTHETIC_DIR = join(FIXTURES_ROOT, 'synthetic');
export const REAL_EXPORT = join(LEGACY_DIR, 'vaultfit_v1_export.sanitized.json');

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The real-shape export, exactly as stored on disk. */
export function loadRealExport() {
  return readJson(REAL_EXPORT);
}

/** The export minus its `_` header fields: what persistSave writes under vaultfit_v1. */
export function stripHeader(exported) {
  return Object.fromEntries(Object.entries(exported).filter(([k]) => !k.startsWith('_')));
}

/** Every .json file in legacy/ and synthetic/, as { dir, file, path, data }. */
export function loadAllFixtures() {
  const out = [];
  for (const [dir, path] of [
    ['legacy', LEGACY_DIR],
    ['synthetic', SYNTHETIC_DIR],
  ]) {
    for (const file of readdirSync(path)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const full = join(path, file);
      out.push({ dir, file, path: full, data: readJson(full) });
    }
  }
  return out;
}

export function listFiles(dir) {
  return readdirSync(dir).sort();
}
