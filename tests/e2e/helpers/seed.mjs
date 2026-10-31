import { test as base, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../scripts/serve.mjs';
import { loadRealExport, stripHeader } from '../../unit/helpers/load-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Frozen instant for every characterisation run (T1 plan, Q2). */
export const FROZEN_ISO = '2026-11-01T12:00:00Z';
export const FROZEN_MS = Date.parse(FROZEN_ISO);

/** What persistSave would have stored: the fixture export minus its `_` header fields. */
export function seedData() {
  return stripHeader(loadRealExport());
}

export const test = base.extend({
  // One static server per worker, on a random free port.
  siteURL: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startServer(root, 0);
      await use(server.url);
      await server.close();
    },
    { scope: 'worker' },
  ],

  /** External requests the page tried to make (always aborted; tests never touch the network). */
  blocked: async ({}, use) => use([]), // eslint-disable-line no-empty-pattern

  /**
   * A page with: frozen Date, no real profile (fresh context), seeded vaultfit_v1 (if `seed`
   * option given via test.use), Google Fonts and every non-local host blocked.
   */
  appPage: async ({ page, siteURL, blocked }, use) => {
    await page.clock.setFixedTime(FROZEN_MS);
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(siteURL)) return route.continue();
      if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      blocked.push(url);
      return route.abort();
    });
    await use(page);
  },
});

/** Seed localStorage before any app script runs. Only writes if the key is absent. */
export async function seedStorage(page, entries) {
  await page.addInitScript((items) => {
    for (const [k, v] of Object.entries(items)) {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }
  }, entries);
}

export async function openSeeded(page, siteURL, data = seedData()) {
  await seedStorage(page, { vaultfit_v1: JSON.stringify(data) });
  await page.goto(siteURL + 'index.html');
  await page.waitForFunction(
    () => typeof state !== 'undefined' && document.readyState === 'complete',
  );
}

export { expect };

// ---- goldens -------------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const goldenDir = join(root, 'tests', 'golden');

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
}

export function stableStringify(v) {
  return JSON.stringify(sortKeys(v), null, 2) + '\n';
}

/**
 * Compare `actual` with tests/golden/<name>.json exactly. The only way to write a golden is
 * UPDATE_GOLDENS=1; a missing golden is a failure, never a silent pass.
 */
export function checkGolden(name, actual) {
  const file = join(goldenDir, `${name}.json`);
  const text = stableStringify(actual);
  if (process.env.UPDATE_GOLDENS === '1') {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(
      `Missing golden ${file}. Record it with UPDATE_GOLDENS=1 and review it by hand.`,
    );
  }
  expect(text).toBe(readFileSync(file, 'utf8'));
}
