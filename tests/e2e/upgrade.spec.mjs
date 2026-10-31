// T4b: the first update after M1 (AC3) and multi-tab behaviour. The pre-M1 build is served from
// the frozen snapshot (docs/reference/pre-m1-d642b2b), the current shell is "deployed" over it
// into the same site directory (one origin), and the old page is driven through its own banner.
// No fixed sleeps: every wait is on an observable condition. Chromium only (the old page asks
// Google Fonts, which are blocked and counted; the zero-external assertion is for the post-upgrade page).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect as baseExpect } from '@playwright/test';
import { seedData } from './helpers/seed.mjs';
import {
  blockExternal,
  buildCurrent,
  buildVariant,
  createSite,
  installProbes,
  seedOrigin,
} from './helpers/deploy.mjs';
import { buildPreM1 } from './helpers/snapshot.mjs';

const expect = baseExpect.configure({ timeout: 15000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTIVE = JSON.parse(
  readFileSync(join(root, 'tests', 'fixtures', 'synthetic', 'hb_active_workout.json'), 'utf8'),
);
const ACTIVE_KEY = 'hb_active_workout';
const HEX12 = /^[0-9a-f]{12}$/;

const test = base.extend({
  // old = the frozen pre-M1 build, cur = the shipped shell (the "new" release), next = cur + one comment.
  builds: [
    async ({ browserName }, use) => {
      void browserName;
      const old = await buildPreM1();
      const cur = await buildCurrent();
      const next = await buildVariant();
      await use({ old, cur, next });
      await old.cleanup();
      await cur.cleanup();
      await next.cleanup();
    },
    { scope: 'worker' },
  ],
  site: async ({ builds, context }, use, testInfo) => {
    const start = testInfo.title.startsWith('multi-tab new-code') ? builds.cur : builds.old;
    const site = await createSite(start.dir);
    await use(site);
    await context.close(); // server.close() waits for idle connections: drop the browser side first
    await site.close().catch(() => {}); // already closed by a test that went offline
  },
});
test.use({ serviceWorkers: 'allow' });

/**
 * Airplane mode: browser offline AND the origin unreachable. Emulated offline alone leaves the
 * browser-process service-worker update checks (the registration moves from sw.js?v=7 to sw.js)
 * talking to the live test server, and navigations then hang; with the server gone every request
 * fails fast, as it does on a phone.
 */
async function goOffline(context, site) {
  await context.setOffline(true);
  await site.close();
}

const SEED = JSON.stringify(seedData());
const workoutJSON = (name) => JSON.stringify({ ...ACTIVE, name });

const alive = (page) => page.evaluate(() => (globalThis.__marker = 'alive'));
const gone = (page) =>
  expect
    .poll(() => page.evaluate(() => globalThis.__marker ?? 'gone').catch(() => 'navigating'))
    .toBe('gone');
const aboutVersion = (page) => page.locator('#hb-about-version');
const oldBanner = (page) => page.locator('#m-update-banner');
const newCard = (page) => page.locator('#hb-update');
const stored = (page, key) => page.evaluate((k) => globalThis.localStorage.getItem(k), key);
const cacheNames = (page) => page.evaluate(async () => (await globalThis.caches.keys()).sort());
const regState = (page) =>
  page.evaluate(async () => {
    const r = await globalThis.navigator.serviceWorker.getRegistration();
    return {
      installing: !!r.installing,
      waiting: !!r.waiting,
      active: r.active?.scriptURL.split('/').pop(),
      replies: globalThis.__replies,
    };
  });

/**
 * Seed the origin, load the pre-M1 page and wait for its own first-claim reload (the old
 * controllerchange handler reloads once on the first claim) and a controller.
 */
async function launchOld(context, page, site, { workout } = {}) {
  const external = await blockExternal(context, site.url);
  await context.clock.install(); // the old 60 s poll is a timer: the test decides when it fires
  await installProbes(page);
  const entries = { vaultfit_v1: SEED, hb_seen_guide: '1' };
  if (workout) entries[ACTIVE_KEY] = workoutJSON('Old Probe');
  await seedOrigin(page, site.url, entries);
  const documents = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) documents.push(r.url());
  });
  await page.goto(site.url + 'index.html');
  await expect.poll(() => documents.length).toBeGreaterThanOrEqual(2); // first load + claim reload
  await page.waitForLoadState('load');
  await expect
    .poll(() =>
      page
        .evaluate(
          async () =>
            !!globalThis.navigator.serviceWorker.controller &&
            (await globalThis.caches.keys()).includes('homebody-v11'),
        )
        .catch(() => false),
    )
    .toBe(true);
  await expect(page.locator('#hm-workouts')).not.toHaveText('0');
  if (workout) await expect(page.locator('#wm-overlay')).toBeAttached();
  await alive(page);
  return external;
}

/** Publish the shipped build over the old site and let the old page's own poll find it. */
async function oldPollFindsUpdate(context, site, builds, ...pages) {
  await site.deploy(builds.cur.dir);
  await context.clock.runFor(60_000); // the old setInterval(() => reg.update(), 60000)
  for (const p of pages) await expect(oldBanner(p)).toBeVisible();
}

/** After the reload into the new build: its version, and exactly its cache. */
async function expectUpgraded(page, builds) {
  await expect(aboutVersion(page)).toHaveText(builds.cur.version);
  await expect.poll(() => cacheNames(page)).toEqual([`homebody-${builds.cur.version}`]);
}

// ---------------------------------------------------------------------------------------------
// AC3
// ---------------------------------------------------------------------------------------------

test('AC3: pre-M1 -> current through the old banner: no data lost, no second banner, works offline', async ({
  context,
  page,
  site,
  builds,
}) => {
  const allExternal = await launchOld(context, page, site);
  expect(await cacheNames(page)).toEqual(['homebody-v11']);
  expect(await stored(page, 'vaultfit_v1')).toBe(SEED);

  await oldPollFindsUpdate(context, site, builds, page);
  await oldBanner(page).getByRole('button', { name: 'Update Now' }).click();
  await gone(page); // the old unconditional reload

  // The new build runs; history is byte-identical; homebody-v11 is gone, only the new cache remains.
  const oldExternal = allExternal.length; // what the old page asked for; the new page's requests start here
  await expectUpgraded(page, builds);
  expect(await stored(page, 'vaultfit_v1')).toBe(SEED);
  expect(await stored(page, ACTIVE_KEY)).toBeNull();
  expect(
    await page.evaluate(() => globalThis.navigator.serviceWorker.controller.scriptURL),
  ).toMatch(/\/sw\.js(\?v=7)?$/);

  // The rename sw.js?v=7 -> sw.js: no second banner (same VERSION), no visible card.
  await expect
    .poll(async () => {
      const s = await regState(page);
      return !s.installing && (!s.waiting || s.replies >= 2);
    })
    .toBe(true);
  await expect(newCard(page)).toBeHidden();
  expect(await page.evaluate(() => globalThis.__log.filter((e) => e.e === 'banner-shown'))).toEqual(
    [],
  );
  expect(await oldBanner(page).count()).toBe(0); // the old banner is gone with the old code

  // Offline: reload, history renders, log a workout through the UI, reload offline, it is there.
  await goOffline(context, site);
  await page.reload();
  await expect(page.locator('#hm-workouts')).not.toHaveText('0');
  await page.click('#m-home-tab-log');
  await page.fill('#m-wname', 'Upgrade Probe');
  const row = page.locator('#m-ex-rows .ex-row-m').first();
  await row.locator('.ex-name-m').fill('Goblet Squat');
  const inputs = row.locator('.mini-input');
  await inputs.nth(0).fill('3');
  await inputs.nth(1).fill('10');
  await inputs.nth(2).fill('20');
  await page.click('text=Save Workout');
  await expect(page.locator('text=/"Upgrade Probe" saved/').first()).toBeVisible();
  await page.reload();
  await page.click('#m-home-tab-history');
  await expect(page.locator('#m-log-list')).toContainText('Upgrade Probe');
  const after = JSON.parse(await stored(page, 'vaultfit_v1'));
  expect(after.workouts.length).toBe(seedData().workouts.length + 1);
  expect(allExternal.slice(oldExternal)).toEqual([]); // zero requests to any other origin after the upgrade
});

test('AC3: an active workout survives the first update through the old banner', async ({
  context,
  page,
  site,
  builds,
}) => {
  const external = await launchOld(context, page, site, { workout: true });
  await expect(page.locator('#m-toasts')).toContainText('Workout resumed'); // old restore
  await oldPollFindsUpdate(context, site, builds, page);
  const before = JSON.parse(await stored(page, ACTIVE_KEY));
  await oldBanner(page).getByRole('button', { name: 'Update Now' }).click();
  await gone(page);
  await expectUpgraded(page, builds);

  // Restorable, and the stored workout is what it was (the stopwatch's `elapsed` is the only field
  // the running page keeps rewriting).
  await expect(page.locator('#wm-overlay')).toBeAttached();
  await expect(page.locator('#m-toasts')).toContainText('Workout resumed');
  const strip = ({ elapsed, ...rest }) => (void elapsed, rest);
  expect(strip(JSON.parse(await stored(page, ACTIVE_KEY)))).toEqual(strip(before));
  expect(await stored(page, 'vaultfit_v1')).toBe(SEED);
  expect(external.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u))).toEqual([]);
});

test('AC3: reload first (new page under the old worker), then update through the new banner', async ({
  context,
  page,
  site,
  builds,
}) => {
  const external = await launchOld(context, page, site);
  await site.deploy(builds.cur.dir);
  await page.reload(); // the old worker serves HTML network-first: the new page now runs under the old worker
  await expect(page.locator('#hm-workouts')).not.toHaveText('0');
  await alive(page);
  expect(
    await page.evaluate(() => globalThis.navigator.serviceWorker.controller.scriptURL),
  ).toMatch(/sw\.js\?v=7$/);
  // The old worker does not answer GET_VERSION: counted as different, so the new notice appears.
  await expect(newCard(page)).toBeVisible({ timeout: 20000 });
  await newCard(page).getByRole('button', { name: 'Update' }).click();
  await gone(page);
  await expectUpgraded(page, builds);
  expect(await stored(page, 'vaultfit_v1')).toBe(SEED);
  expect(external.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u))).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Multi-tab, old code: a characterisation (the record of a known limitation, not a request to fix it)
// ---------------------------------------------------------------------------------------------

test('multi-tab old-code: a tab on pre-M1 code reloads on any controllerchange, mid-workout, without a tap', async ({
  context,
  page: pageA,
  site,
  builds,
}) => {
  await launchOld(context, pageA, site);
  const pageB = await context.newPage();
  await installProbes(pageB);
  await pageB.goto(site.url + 'index.html');
  await expect(pageB.locator('#hm-workouts')).not.toHaveText('0');
  // B starts a workout: the key is seeded, B reloads to restore it (the old restore path).
  await pageB.evaluate(
    ([k, v]) => globalThis.localStorage.setItem(k, v),
    [ACTIVE_KEY, workoutJSON('Tab B')],
  );
  await pageB.reload();
  await expect(pageB.locator('#wm-overlay')).toBeAttached();
  await alive(pageA);
  await alive(pageB);

  // B logs a set (persisted on the tick; the tick also starts the rest timer) and types a weight
  // into another field without leaving it (the app saves on `change`).
  await pageB.locator('#wm-tick-0-1').click();
  await expect(pageB.locator('#m-timer-modal')).toHaveClass(/open/);
  await pageB.locator('#wm-set-0-0 input').nth(1).fill('77');
  const savedBefore = JSON.parse(await stored(pageB, ACTIVE_KEY));
  expect(savedBefore.exercises[0].sets[1].done).toBe(true);
  expect(savedBefore.exercises[0].sets[0].weight).not.toBe(77);

  // Update through A's own old banner.
  await oldPollFindsUpdate(context, site, builds, pageA, pageB);
  await oldBanner(pageA).getByRole('button', { name: 'Update Now' }).click();

  // Fact 1: both reload; B without any tap and with a workout in progress.
  await gone(pageA);
  await gone(pageB);
  await expectUpgraded(pageB, builds);

  // Fact 2, survives: the workout and every set logged, restored with "Workout resumed".
  await expect(pageB.locator('#wm-overlay')).toBeAttached();
  await expect(pageB.locator('#m-toasts')).toContainText('Workout resumed');
  const savedAfter = JSON.parse(await stored(pageB, ACTIVE_KEY));
  expect(savedAfter.name).toBe('Tab B');
  expect(savedAfter.exercises).toEqual(savedBefore.exercises);
  expect(await stored(pageB, 'vaultfit_v1')).toBe(SEED);

  // Fact 3, lost: in-memory state. The running rest timer (its sheet is closed again) and text that
  // was typed but not yet saved into a set.
  expect(
    await pageB.evaluate(() =>
      globalThis.document.getElementById('m-timer-modal').classList.contains('open'),
    ),
  ).toBe(false);
  expect(await pageB.locator('#wm-set-0-0 input').nth(1).inputValue()).not.toBe('77');
});

// ---------------------------------------------------------------------------------------------
// Multi-tab, new code: two tabs on the shipped build
// ---------------------------------------------------------------------------------------------

/** Two new-code pages on one origin, both controlled, both idle. */
async function launchTwo(context, pageA, site) {
  const external = await blockExternal(context, site.url);
  await installProbes(pageA);
  await seedOrigin(pageA, site.url, { vaultfit_v1: SEED, hb_seen_guide: '1' });
  await pageA.goto(site.url + 'index.html');
  await pageA.waitForFunction(() => !!globalThis.navigator.serviceWorker.controller);
  await expect(aboutVersion(pageA)).toHaveText(HEX12);
  const pageB = await context.newPage();
  await installProbes(pageB);
  await pageB.goto(site.url + 'index.html');
  await pageB.waitForFunction(() => !!globalThis.navigator.serviceWorker.controller);
  await expect(aboutVersion(pageB)).toHaveText(HEX12);
  for (const p of [pageA, pageB]) await expect(p.locator('#m-toasts > *')).toHaveCount(0);
  return { pageB, external };
}

/** Start a workout in `page` the way a returning user does: the key exists, a reload restores it. */
async function startWorkoutIn(page, name) {
  await page.evaluate(
    ([k, v]) => globalThis.localStorage.setItem(k, v),
    [ACTIVE_KEY, workoutJSON(name)],
  );
  await page.reload();
  await expect(page.locator('#wm-overlay')).toBeAttached();
}

async function finishWorkout(page) {
  await page.locator('.wm-finish-btn').click();
  await page.getByRole('button', { name: 'Save Workout' }).click();
  await expect(page.locator('#m-toasts')).toContainText('Workout saved');
}

const settledOn = (page) => regState(page);
async function deployToBoth(site, build, ...pages) {
  const before = await Promise.all(pages.map((p) => p.evaluate(() => globalThis.__replies)));
  await site.deploy(build.dir);
  await pages[0].evaluate(async () => {
    await (await globalThis.navigator.serviceWorker.getRegistration()).update();
  });
  for (const [i, p] of pages.entries()) {
    await expect.poll(async () => (await settledOn(p)).waiting).toBe(true);
    await expect
      .poll(() => p.evaluate(() => globalThis.__replies))
      .toBeGreaterThanOrEqual(before[i] + 2);
  }
}

test('multi-tab new-code: a workout in tab B holds the notice in tab A until B finishes', async ({
  context,
  page: pageA,
  site,
  builds,
}) => {
  const { pageB, external } = await launchTwo(context, pageA, site);
  await startWorkoutIn(pageB, 'Tab B workout');
  await alive(pageA);
  await alive(pageB);
  await deployToBoth(site, builds.next, pageA, pageB);
  await expect(newCard(pageA)).toBeHidden();
  await expect(newCard(pageB)).toBeHidden();
  expect(
    await pageA.evaluate(() => globalThis.__log.filter((e) => e.e === 'banner-shown')),
  ).toEqual([]);

  await finishWorkout(pageB); // removes the key; tab A hears it through the `storage` event
  await expect(newCard(pageA)).toBeVisible({ timeout: 20000 });
  await expect(newCard(pageA)).toContainText('Update ready');
  expect(await pageA.evaluate(() => globalThis.__marker)).toBe('alive');
  expect(external).toEqual([]);
});

test('multi-tab new-code: an update applied from tab A does not reload tab B during its workout', async ({
  context,
  page: pageA,
  site,
  builds,
}) => {
  const { pageB } = await launchTwo(context, pageA, site);
  await deployToBoth(site, builds.next, pageA, pageB);
  await expect(newCard(pageA)).toBeVisible({ timeout: 20000 });

  // A taps Update. Hold the message so B can start its workout before the takeover happens.
  await pageA.evaluate(() => {
    const o = globalThis.ServiceWorker.prototype.postMessage;
    globalThis.__origPost = o;
    globalThis.ServiceWorker.prototype.postMessage = function (m, t) {
      if (m && m.type === 'SKIP_WAITING') {
        globalThis.__held = [this, m];
        return;
      }
      return o.call(this, m, t);
    };
  });
  await newCard(pageA).getByRole('button', { name: 'Update' }).click();
  await expect.poll(() => pageA.evaluate(() => !!globalThis.__held)).toBe(true);
  await startWorkoutIn(pageB, 'Tab B workout');
  await alive(pageA);
  await alive(pageB);

  await pageA.evaluate(() => {
    const [w, m] = globalThis.__held;
    globalThis.__origPost.call(w, m); // the takeover happens now: both tabs are claimed
  });
  await expect
    .poll(() =>
      pageB.evaluate(
        async () => (await globalThis.navigator.serviceWorker.getRegistration()).active.scriptURL,
      ),
    )
    .toMatch(/sw\.js/);
  await expect
    .poll(() =>
      pageB.evaluate(
        async () => !(await globalThis.navigator.serviceWorker.getRegistration()).waiting,
      ),
    )
    .toBe(true);
  // Neither tab reloaded, and B shows nothing during its workout.
  expect(await pageB.evaluate(() => globalThis.__marker)).toBe('alive');
  expect(await pageA.evaluate(() => globalThis.__marker)).toBe('alive');
  await expect(pageB.locator('#wm-overlay')).toBeAttached();
  await expect(newCard(pageB)).toBeHidden();

  // B finishes: it now asks for a reload, and reloads only on its own tap.
  await finishWorkout(pageB);
  await expect(newCard(pageB).locator('.hb-t')).toHaveText('HomeBody updated', { timeout: 20000 });
  expect(await pageB.evaluate(() => globalThis.__marker)).toBe('alive');
  await newCard(pageB).getByRole('button', { name: 'Reload' }).click();
  await gone(pageB);
  await expect(aboutVersion(pageB)).toHaveText(builds.next.version);
  const saved = JSON.parse(await stored(pageB, 'vaultfit_v1'));
  expect(saved.workouts.map((w) => w.name)).toContain('Tab B workout');
});
