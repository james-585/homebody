// T3: the app opens, logs and shows history in airplane mode, never talks to a third party, and
// keeps exactly one homebody-* cache. No fixed sleeps: every wait is on an observable condition.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, seedData, seedStorage } from './helpers/seed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const swText = readFileSync(join(root, 'sw.js'), 'utf8');
const VERSION = /const VERSION = '([0-9a-f]{12})';/.exec(swText)[1];
const PRECACHE = JSON.parse(/const PRECACHE = (\[.*\]);/.exec(swText)[1]);

test.use({ serviceWorkers: 'allow' });

/** Record every request the page makes; abort anything that is not our origin. */
async function watch(context, page, siteURL) {
  const seen = { external: [], failed: [], requests: [] };
  const origin = new URL(siteURL).origin;
  const isOurs = (u) => u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:');
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (isOurs(u)) return route.continue();
    seen.external.push(u);
    return route.abort();
  });
  page.on('request', (r) => {
    seen.requests.push(r.url());
    if (!isOurs(r.url())) seen.external.push(r.url());
  });
  page.on('requestfailed', (r) => seen.failed.push(`${r.url()} ${r.failure()?.errorText}`));
  return seen;
}

/** First visit: wait until the worker is installed (cache filled) and controls a settled page. */
async function firstLoad(page, siteURL) {
  await page.goto(siteURL + 'index.html');
  // The shipped page reloads once when the worker claims it (until T4). Wait for a document
  // that was served by the worker, which is controlled from its first byte.
  await page.waitForFunction(
    () =>
      document.readyState === 'complete' &&
      !!globalThis.navigator.serviceWorker.controller &&
      globalThis.performance.getEntriesByType('navigation')[0]?.workerStart > 0,
  );
}

async function externalResources(page) {
  return page.evaluate(() =>
    globalThis.performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => new URL(n).origin !== globalThis.location.origin),
  );
}

async function visitEveryPage(page) {
  for (const p of ['plans', 'progress', 'profile', 'train']) {
    await page.evaluate((id) => globalThis.mShowPage(id), p);
    await expect(page.locator(`#page-${p}`)).toBeVisible();
  }
}

test('@smoke offline: opens, fonts load, a workout is logged and survives an offline reload', async ({
  context,
  page,
  siteURL,
}) => {
  const seen = await watch(context, page, siteURL);
  await seedStorage(page, { vaultfit_v1: JSON.stringify(seedData()), hb_seen_guide: '1' });
  await firstLoad(page, siteURL);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#hm-workouts')).toBeAttached();
  await expect(page.locator('#hm-workouts')).not.toHaveText('0');
  const fonts = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('700 16px Oswald'),
      document.fonts.load('400 16px Inter'),
    ]);
    return [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => f.family.replace(/"/g, ''));
  });
  expect(fonts).toContain('Oswald');
  expect(fonts).toContain('Inter');

  // Log a workout through the UI while offline.
  await page.click('#m-home-tab-log');
  await page.fill('#m-wname', 'Offline Probe');
  const row = page.locator('#m-ex-rows .ex-row-m').first();
  await row.locator('.ex-name-m').fill('Goblet Squat');
  const inputs = row.locator('.mini-input');
  await inputs.nth(0).fill('3');
  await inputs.nth(1).fill('10');
  await inputs.nth(2).fill('20');
  await page.click('text=Save Workout');
  await expect(page.locator('#m-log-list, #m-home-log-section').first()).toBeAttached();

  await page.reload();
  await page.click('#m-home-tab-history');
  await expect(page.locator('#m-log-list')).toContainText('Offline Probe');

  expect(seen.failed).toEqual([]);
  expect(seen.external).toEqual([]);
});

test('no request leaves the origin during a full session, online and offline', async ({
  context,
  page,
  siteURL,
}) => {
  const seen = await watch(context, page, siteURL);
  await seedStorage(page, { vaultfit_v1: JSON.stringify(seedData()), hb_seen_guide: '1' });
  await firstLoad(page, siteURL);
  await visitEveryPage(page);
  expect(await externalResources(page)).toEqual([]);

  await context.setOffline(true);
  await page.reload();
  await visitEveryPage(page);
  expect(await externalResources(page)).toEqual([]);

  expect(seen.external).toEqual([]);
  expect(seen.failed).toEqual([]);
  for (const u of seen.requests) expect(new URL(u).origin).toBe(new URL(siteURL).origin);
});

test('activation deletes stale homebody-* caches only, and the cache holds every PRECACHE entry', async ({
  page,
  siteURL,
}) => {
  // A page without a worker on the same origin, to seed caches before the first registration.
  await page.goto(siteURL + 'manifest.json');
  await page.evaluate(async () => {
    await globalThis.caches.open('homebody-0000stale0000');
    await globalThis.caches.open('other-app-v1');
  });
  await firstLoad(page, siteURL);
  await expect
    .poll(() => page.evaluate(async () => (await globalThis.caches.keys()).sort()))
    .toEqual([`homebody-${VERSION}`, 'other-app-v1'].sort());
  const cached = await page.evaluate(
    async (name) =>
      (await (await globalThis.caches.open(name)).keys()).map((r) => new URL(r.url).pathname),
    `homebody-${VERSION}`,
  );
  expect(cached.map((p) => p.replace(/^\//, '')).sort()).toEqual([...PRECACHE].sort());
});
