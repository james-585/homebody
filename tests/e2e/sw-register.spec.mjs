// The shipped service worker registers, activates and precaches under its stamped cache name (T2).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './helpers/seed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = /const VERSION = '([0-9a-f]{12})';/.exec(
  readFileSync(join(root, 'sw.js'), 'utf8'),
)?.[1];

test.use({ serviceWorkers: 'allow' });

test('@smoke the worker registers, activates and caches the precache list', async ({
  appPage: page,
  siteURL,
}) => {
  expect(VERSION).toBeTruthy();
  await page.goto(siteURL + 'index.html');
  await page.waitForFunction(() => document.readyState === 'complete');
  const result = await page.evaluate(async () => {
    const reg = await globalThis.navigator.serviceWorker.ready;
    const names = await globalThis.caches.keys();
    const out = { active: reg.active?.state, names, cached: {} };
    for (const n of names) {
      out.cached[n] = (await (await globalThis.caches.open(n)).keys()).map(
        (r) => new URL(r.url).pathname,
      );
    }
    return out;
  });
  expect(result.active).toBe('activated');
  expect(result.names).toEqual([`homebody-${VERSION}`]);
  expect(result.cached[`homebody-${VERSION}`].some((p) => p.endsWith('/manifest.json'))).toBe(true);
  // Home still renders with the worker in control.
  await expect(page.locator('body')).toContainText(/\S/);
  await expect(page.locator('#hm-workouts')).toBeAttached();
});
