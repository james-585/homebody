// T4a: the update flow never interrupts a workout. Two builds of the shell are served from one
// site directory (one origin), "deployed" over each other, and the page is driven through the
// real UI. No fixed sleeps: every wait is on an observable condition.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { seedData } from './helpers/seed.mjs';
import {
  blockExternal,
  buildCurrent,
  buildVariant,
  createSite,
  installProbes,
  seedOrigin,
} from './helpers/deploy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTIVE = JSON.parse(
  readFileSync(join(root, 'tests', 'fixtures', 'synthetic', 'hb_active_workout.json'), 'utf8'),
);

const test = base.extend({
  // v1 = the shipped shell, v2 = the same with one comment added and sw.js restamped.
  builds: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const v1 = await buildCurrent();
      const v2 = await buildVariant();
      await use({ v1, v2 });
      await v1.cleanup();
      await v2.cleanup();
    },
    { scope: 'worker' },
  ],
  site: async ({ builds }, use) => {
    const site = await createSite(builds.v1.dir);
    await use(site);
    await site.close();
  },
});
test.use({ serviceWorkers: 'allow' });

const HEX12 = /^[0-9a-f]{12}$/;

/** Seed the origin, load v1, and wait until the worker controls the page and About knows its version. */
async function launch(context, page, site, { workout = false } = {}) {
  const external = await blockExternal(context, site.url);
  await installProbes(page);
  const entries = { vaultfit_v1: JSON.stringify(seedData()), hb_seen_guide: '1' };
  if (workout) entries.hb_active_workout = JSON.stringify({ ...ACTIVE, name: 'Update Probe' });
  await seedOrigin(page, site.url, entries);
  await page.goto(site.url + 'index.html');
  await page.waitForFunction(
    () => document.readyState === 'complete' && !!globalThis.navigator.serviceWorker.controller,
  );
  await expect(page.locator('#hb-about-version')).toHaveText(HEX12);
  return external;
}

/** VERSION of the active and waiting workers, asked with an uncounted probe. */
const versions = (page) =>
  page.evaluate(async () => {
    const ask = (w) =>
      new Promise((ok) => {
        if (!w) return ok(null);
        const ch = new globalThis.__RawMC();
        ch.port1.onmessage = (e) => ok(e.data);
        w.postMessage({ type: 'GET_VERSION', probe: true }, [ch.port2]);
      });
    const reg = await globalThis.navigator.serviceWorker.getRegistration();
    return { active: await ask(reg.active), waiting: await ask(reg.waiting) };
  });

const replies = (page) => page.evaluate(() => globalThis.__replies);
const bannerLog = (page) =>
  page.evaluate(() => globalThis.__log.filter((e) => e.e === 'banner-shown'));

/**
 * Publish `build`, ask the browser to check, and wait until a worker is waiting AND the page has
 * finished judging it (both GET_VERSION answers received), so "no banner" is a real result.
 */
async function deployAndSettle(page, site, build) {
  const before = await replies(page);
  await site.deploy(build.dir);
  await page.evaluate(async () => {
    await (await globalThis.navigator.serviceWorker.getRegistration()).update();
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () => !!(await globalThis.navigator.serviceWorker.getRegistration()).waiting,
      ),
    )
    .toBe(true);
  await expect.poll(() => replies(page)).toBeGreaterThanOrEqual(before + 2);
}

const showProfile = (page) => page.evaluate(() => globalThis.mShowPage('profile'));
const banner = (page) => page.locator('#hb-update');

test('@smoke AC1: a new version is held during a workout, offered after Finish, and Update keeps the saved workout', async ({
  context,
  page,
  site,
  builds,
}) => {
  const external = await launch(context, page, site, { workout: true });
  await expect(page.locator('#wm-overlay')).toBeAttached();
  await page.evaluate(() => (globalThis.__marker = 'alive'));
  expect((await versions(page)).active).toBe(builds.v1.version);

  await deployAndSettle(page, site, builds.v2);
  // Held: a worker is waiting, the old one still runs, nothing was shown, nothing reloaded.
  expect(await versions(page)).toEqual({ active: builds.v1.version, waiting: builds.v2.version });
  await expect(banner(page)).toBeHidden();
  expect(await bannerLog(page)).toEqual([]);
  expect(await page.evaluate(() => globalThis.__marker)).toBe('alive');
  await expect(page.locator('#wm-overlay')).toBeAttached();

  // Finish through the real UI.
  await page.locator('.wm-finish-btn').click();
  await page.getByRole('button', { name: 'Save Workout' }).click();
  await expect(page.locator('#m-toasts')).toContainText('Workout saved');
  await expect(banner(page)).toBeHidden(); // the save toast has priority
  await expect(banner(page)).toBeVisible({ timeout: 15000 });
  await expect(banner(page)).toContainText('Update ready');
  await expect(banner(page)).toContainText('Your history is kept.');

  // Released by the spec's rule: toast stack empty and not before 4 s after the workout layer closed.
  const log = await page.evaluate(() => globalThis.__log);
  const shown = log.filter((e) => e.e === 'banner-shown');
  expect(shown).toHaveLength(1);
  expect(shown[0].active).toBe(false);
  expect(shown[0].toasts).toBe(0);
  const removed = log.filter((e) => e.e === 'overlay-removed').at(-1);
  expect(shown[0].t - removed.t).toBeGreaterThanOrEqual(4000);
  expect(await page.evaluate(() => globalThis.__marker)).toBe('alive'); // still no reload

  // Update: reloads into v2 with the finished workout saved.
  await banner(page).getByRole('button', { name: 'Update' }).click();
  await expect
    .poll(() => page.evaluate(() => globalThis.__marker ?? 'gone').catch(() => 'navigating'))
    .toBe('gone');
  await expect(page.locator('#hb-about-version')).toHaveText(builds.v2.version);
  expect((await versions(page)).active).toBe(builds.v2.version);
  await expect(banner(page)).toBeHidden();
  await page.click('#m-home-tab-history');
  await expect(page.locator('#m-log-list')).toContainText('Update Probe');
  const stored = await page.evaluate(() => ({
    saved: JSON.parse(globalThis.localStorage.getItem('vaultfit_v1')).workouts.map((w) => w.name),
    active: globalThis.localStorage.getItem('hb_active_workout'),
  }));
  expect(stored.saved).toContain('Update Probe');
  expect(stored.saved.length).toBe(seedData().workouts.length + 1);
  expect(stored.active).toBeNull();
  expect(external).toEqual([]);
});

test('AC2: Later keeps the old version running; closing and reopening picks up the new one', async ({
  context,
  page,
  site,
  builds,
}) => {
  const external = await launch(context, page, site);
  await deployAndSettle(page, site, builds.v2);
  await expect(banner(page)).toBeVisible(); // idle: offered at once
  await banner(page).getByRole('button', { name: 'Later' }).click();
  await expect(banner(page)).toBeHidden();
  expect(await versions(page)).toEqual({ active: builds.v1.version, waiting: builds.v2.version });

  // Profile -> About keeps a quiet Update line, and still shows the running version.
  await showProfile(page);
  await expect(page.locator('#hb-about-update-row')).toBeVisible();
  await expect(page.locator('#hb-about-update-row')).toContainText('Update ready');
  await expect(page.locator('#hb-about-version')).toHaveText(builds.v1.version);
  await expect(page.locator('#hb-about-offline-text')).toHaveText('Ready');

  // Close the app. The waiting worker takes over once no window is left; each probe page is closed
  // again so it cannot keep the old worker alive.
  await page.close();
  await expect
    .poll(
      async () => {
        const p = await context.newPage();
        try {
          await p.goto(site.url + 'index.html');
          await expect(p.locator('#hb-about-version')).toHaveText(HEX12);
          return await p.locator('#hb-about-version').textContent();
        } finally {
          await p.close();
        }
      },
      { timeout: 30000, intervals: [250, 500, 1000] },
    )
    .toBe(builds.v2.version);
  expect(external).toEqual([]);
});

test('AC4: no timer polls for updates; a check runs on return to the app, at most once a minute', async ({
  context,
  page,
  site,
}) => {
  await launch(context, page, site);
  await page.reload(); // now controlled from the first byte: the page checks once after register
  await page.waitForFunction(() => !!globalThis.navigator.serviceWorker.controller);
  await expect.poll(() => page.evaluate(() => globalThis.__updates)).toBe(1);

  await page.clock.install();
  await page.clock.runFor(10 * 60 * 1000);
  expect(await page.evaluate(() => globalThis.__updates)).toBe(1); // ten minutes, no poll

  await page.evaluate(() =>
    globalThis.document.dispatchEvent(new globalThis.Event('visibilitychange')),
  );
  await expect.poll(() => page.evaluate(() => globalThis.__updates)).toBe(2);
  await page.evaluate(() =>
    globalThis.document.dispatchEvent(new globalThis.Event('visibilitychange')),
  );
  await page.clock.runFor(30 * 1000);
  await page.evaluate(() =>
    globalThis.document.dispatchEvent(new globalThis.Event('visibilitychange')),
  );
  expect(await page.evaluate(() => globalThis.__updates)).toBe(2); // inside a minute: no second check
});

test('AC4: index.html has no setInterval or setTimeout near a registration update call', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const calls = [...html.matchAll(/\.update\s*\(/g)];
  expect(calls.length).toBeGreaterThan(0); // the launch / return-to-app check exists
  for (const m of calls) {
    const before = html.slice(Math.max(0, m.index - 200), m.index);
    expect(before).not.toMatch(/set(Interval|Timeout)\s*\(/);
  }
  expect(html).not.toMatch(/sw\.js\?v=/);
});

test('sw.js never calls skipWaiting at install; only a page message (string or object) does', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const install = sw.slice(
    sw.indexOf("addEventListener('install'"),
    sw.indexOf("addEventListener('activate'"),
  );
  expect(install.length).toBeGreaterThan(0);
  expect(install).not.toMatch(/skipWaiting/);
  const calls = sw.match(/self\.skipWaiting\(\)/g) ?? [];
  expect(calls).toHaveLength(1); // the message handler only
  expect(sw).toMatch(/d === 'skipWaiting' \|\| \(d && d\.type === 'SKIP_WAITING'\)/);
});

test('first install: one document, no reload, a ready-offline toast, About says Ready', async ({
  context,
  page,
  site,
  builds,
}) => {
  const external = await blockExternal(context, site.url);
  await installProbes(page);
  await seedOrigin(page, site.url, { vaultfit_v1: JSON.stringify(seedData()), hb_seen_guide: '1' });
  const documents = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) documents.push(r.url());
  });
  await page.goto(site.url + 'index.html');
  await page.evaluate(() => (globalThis.__marker = 'alive'));
  await page.waitForFunction(() => !!globalThis.navigator.serviceWorker.controller);
  await expect
    .poll(() => page.evaluate(() => globalThis.__toasts.join(' | ')))
    .toContain('Ready to use offline');
  expect(
    await page.evaluate(() => globalThis.__toasts.filter((t) => /Ready to use/.test(t)).length),
  ).toBe(1);
  expect(await page.evaluate(() => globalThis.__marker)).toBe('alive'); // the claim did not reload
  expect(documents).toEqual([site.url + 'index.html']);

  await showProfile(page);
  await expect(page.locator('#hb-about-offline-text')).toHaveText('Ready');
  await expect(page.locator('#hb-about-version')).toHaveText(builds.v1.version);
  await expect(page.getByRole('button', { name: 'Copy version' })).toBeVisible();
  await expect(page.locator('#hb-about-update-row')).toBeHidden();
  await expect(banner(page)).toBeHidden();
  expect(external).toEqual([]);
});

for (const [label, message] of [
  ['the legacy "skipWaiting" string', 'skipWaiting'],
  ['{type: "SKIP_WAITING"}', { type: 'SKIP_WAITING' }],
]) {
  test(`${label} activates a waiting worker, and a page that did not ask does not reload`, async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await page.evaluate(() => (globalThis.__marker = 'alive'));
    await deployAndSettle(page, site, builds.v2);
    expect(await versions(page)).toEqual({ active: builds.v1.version, waiting: builds.v2.version });

    await page.evaluate(async (m) => {
      (await globalThis.navigator.serviceWorker.getRegistration()).waiting.postMessage(m);
    }, message);
    await expect.poll(async () => (await versions(page)).active).toBe(builds.v2.version);
    expect((await versions(page)).waiting).toBeNull();
    // Updated "elsewhere" as far as this page can tell: it asks for a reload, it does not reload.
    await expect(banner(page)).toContainText('HomeBody was updated');
    expect(await page.evaluate(() => globalThis.__marker)).toBe('alive');
  });
}

test('a waiting worker with the same VERSION as the running one raises no notice', async ({
  context,
  page,
  site,
  builds,
}) => {
  await launch(context, page, site);
  const before = await replies(page);
  await site.redeploySameVersion(builds.v1.dir);
  await page.evaluate(async () => {
    await (await globalThis.navigator.serviceWorker.getRegistration()).update();
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () => !!(await globalThis.navigator.serviceWorker.getRegistration()).waiting,
      ),
    )
    .toBe(true);
  await expect.poll(() => replies(page)).toBeGreaterThanOrEqual(before + 2); // the page has judged it
  expect(await versions(page)).toEqual({ active: builds.v1.version, waiting: builds.v1.version });
  await expect(banner(page)).toBeHidden();
  expect(await bannerLog(page)).toEqual([]);
  await showProfile(page);
  await expect(page.locator('#hb-about-update-row')).toBeHidden();
});
