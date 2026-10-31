// T3: the app opens, logs and shows history in airplane mode, never talks to a third party, and
// keeps exactly one homebody-* cache. No fixed sleeps: every wait is on an observable condition.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startServer } from '../../scripts/serve.mjs';
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
  const isOurs = (u) => {
    if (u.startsWith('data:') || u.startsWith('blob:')) return true;
    try {
      return new URL(u).origin === origin;
    } catch {
      return false;
    }
  };
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

/** First visit: wait until the worker controls the page and its cache holds the whole shell. */
async function firstLoad(page, siteURL) {
  await page.goto(siteURL + 'index.html');
  // The worker claims the open page without a reload (T4). The cache is complete before activation.
  await page.waitForFunction(
    () => document.readyState === 'complete' && !!globalThis.navigator.serviceWorker.controller,
  );
  // (waitForFunction does not poll an async predicate, so the cache check polls from here.)
  await expect
    .poll(() =>
      page.evaluate(
        async ([name, files]) => {
          if (!(await globalThis.caches.has(name))) return false;
          const have = (await (await globalThis.caches.open(name)).keys()).map((r) =>
            new URL(r.url).pathname.replace(/^\//, ''),
          );
          return files.every((f) => have.includes(f));
        },
        [`homebody-${VERSION}`, PRECACHE],
      ),
    )
    .toBe(true);
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
  await expect(page.locator('text=/"Offline Probe" saved/').first()).toBeVisible();

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

test('a failed precache fetch leaves no new cache and the old worker in charge', async ({
  page,
}) => {
  // A throwaway copy of the shell, served from its own server, so a file can be removed.
  const dir = await mkdtemp(join(tmpdir(), 'hb-atomic-'));
  for (const f of ['sw.js', ...PRECACHE]) {
    await cp(join(root, f), join(dir, f), { recursive: true });
  }
  const server = await startServer(dir, 0);
  try {
    await seedStorage(page, { hb_seen_guide: '1' });
    await firstLoad(page, server.url);
    const before = await page.evaluate(async () => ({
      keys: await globalThis.caches.keys(),
      script: (await globalThis.navigator.serviceWorker.ready).active.scriptURL,
    }));
    expect(before.keys).toEqual([`homebody-${VERSION}`]);

    // "Release 2": a different VERSION whose precache list names a file that now answers 404.
    const sw2 = (await readFile(join(dir, 'sw.js'), 'utf8')).replace(VERSION, 'deadbeef0000');
    await writeFile(join(dir, 'sw.js'), sw2);
    await rm(join(dir, 'fonts/oswald-latin.woff2'));

    const after = await page.evaluate(async () => {
      const reg = await globalThis.navigator.serviceWorker.ready;
      await reg.update();
      const w = reg.installing || reg.waiting;
      if (w && w.state !== 'redundant') {
        await new Promise((ok) =>
          w.addEventListener('statechange', () => w.state === 'redundant' && ok()),
        );
      }
      return {
        keys: (await globalThis.caches.keys()).sort(),
        active: reg.active.scriptURL,
        waiting: !!reg.waiting,
        sawWorker: !!w,
      };
    });
    expect(after.sawWorker).toBe(true);
    expect(after.keys).toEqual([`homebody-${VERSION}`]);
    expect(after.active).toBe(before.script);
    expect(after.waiting).toBe(false);
  } finally {
    // server.close() waits for idle keep-alive and speculative browser connections; close the page
    // (and with it its worker) first, or the close can wait past the test timeout.
    await page.context().close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
