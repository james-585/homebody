// T4a: the update flow never interrupts a workout. Two builds of the shell are served from one
// site directory (one origin), "deployed" over each other, and the page is driven through the
// real UI. No fixed sleeps: every wait is on an observable condition.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rm } from 'node:fs/promises';
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

// A first show waits for the toast stack and a settle time (4 s), so waits are longer than the default.
const expect = baseExpect.configure({ timeout: 15000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTIVE = JSON.parse(
  readFileSync(join(root, 'tests', 'fixtures', 'synthetic', 'hb_active_workout.json'), 'utf8'),
);

const test = base.extend({
  // v1 = the shipped shell, v2 = the same with one comment added and sw.js restamped.
  builds: [
    async ({ browserName }, use) => {
      void browserName;
      const v1 = await buildCurrent();
      const v2 = await buildVariant();
      await use({ v1, v2 });
      await v1.cleanup();
      await v2.cleanup();
    },
    { scope: 'worker' },
  ],
  site: async ({ builds, context }, use) => {
    const site = await createSite(builds.v1.dir);
    await use(site);
    // server.close() waits for idle and speculative browser connections: drop the browser side first.
    await context.close();
    await site.close();
  },
});
test.use({ serviceWorkers: 'allow' });

const HEX12 = /^[0-9a-f]{12}$/;

/** Seed the origin, load v1, and wait until the worker controls the page and About knows its version. */
async function launch(context, page, site, { workout = false, extra = {} } = {}) {
  const external = await blockExternal(context, site.url);
  await installProbes(page);
  const entries = { vaultfit_v1: JSON.stringify(seedData()), hb_seen_guide: '1', ...extra };
  if (workout) entries.hb_active_workout = JSON.stringify({ ...ACTIVE, name: 'Update Probe' });
  await seedOrigin(page, site.url, entries);
  await page.goto(site.url + 'index.html');
  await page.waitForFunction(
    () => document.readyState === 'complete' && !!globalThis.navigator.serviceWorker.controller,
  );
  await expect(page.locator('#hb-about-version')).toHaveText(HEX12);
  // Transient toasts (the app's welcome toast, "Ready to use offline") float above everything for
  // about 3 s; hit tests start once they are gone.
  await expect.poll(() => page.evaluate(() => globalThis.__toasts.join('|'))).toContain('Welcome');
  await expect(page.locator('#m-toasts > *')).toHaveCount(0);
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
  await page.clock.install(); // before the first document: every timer the page makes is under control
  await launch(context, page, site);
  await page.reload(); // now controlled from the first byte: the page checks once after register
  await page.waitForFunction(() => !!globalThis.navigator.serviceWorker.controller);
  await expect.poll(() => page.evaluate(() => globalThis.__updates)).toBe(1);

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
    await expect(banner(page)).toContainText('HomeBody updated');
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

// ---- Amendment 2: real-touch hit tests, clearance, z-order, Updating state, focus, wording ----

/** Where 85% across a button, at its vertical centre, lands. */
const hit = (page, sel) =>
  page.evaluate((q) => {
    const b = globalThis.document.querySelector(q);
    const r = b.getBoundingClientRect();
    const x = r.left + r.width * 0.85;
    const y = r.top + r.height / 2;
    const el = globalThis.document.elementFromPoint(x, y);
    return {
      ok: !!el && (el === b || b.contains(el)),
      x,
      y,
      hit: el ? el.id || el.tagName + ' ' + el.className : null,
    };
  }, sel);

/** Assert the hit element is the button, then tap it with real touch input. */
async function touch85(page, sel, { tap = true } = {}) {
  const h = await hit(page, sel);
  expect(h.ok, `${sel} is covered by ${h.hit}`).toBe(true);
  if (tap) await page.touchscreen.tap(h.x, h.y);
}

const scrollProfileToEnd = (page) =>
  page.evaluate(() => {
    const el = globalThis.document.getElementById('page-profile');
    el.scrollTop = el.scrollHeight;
  });

const UPDATE = '#hb-update .btn-primary';
const LATER = '#hb-update .btn-secondary';

for (const [w, h] of [
  [375, 667],
  [390, 844],
  [430, 932],
]) {
  for (const theme of ['dark', 'light']) {
    for (const motion of ['no-preference', 'reduce']) {
      test.describe(`touch ${w}x${h} ${theme} motion:${motion}`, () => {
        test.use({ viewport: { width: w, height: h }, hasTouch: true, reducedMotion: motion });

        test('State 1: the card, About Copy and About Update take real taps; the Profile end clears the FAB', async ({
          context,
          page,
          site,
          builds,
        }) => {
          await launch(context, page, site, { extra: { hb_theme: theme } });
          await page.evaluate(() => (globalThis.__marker = 'alive'));

          // The empty part of the closed FAB tray lets taps through to what is underneath.
          const tray = await page.evaluate(() => {
            const t = globalThis.document.getElementById('m-fab-tray');
            const r = t.getBoundingClientRect();
            const el = globalThis.document.elementFromPoint(r.left + 4, r.top + 4);
            return { height: r.height, through: !!el && !t.contains(el) };
          });
          expect(tray.height).toBeGreaterThan(100); // the invisible box is really there
          expect(tray.through).toBe(true);

          await deployAndSettle(page, site, builds.v2);
          await expect(banner(page)).toBeVisible();
          const look = await banner(page).evaluate((el) => {
            const c = globalThis.getComputedStyle(el);
            return { z: c.zIndex, border: c.borderTopWidth };
          });
          expect(look).toEqual({ z: '150', border: '2px' });
          await touch85(page, UPDATE, { tap: false }); // Update is reachable (tapping would reload)
          await touch85(page, LATER); // real tap
          await expect(banner(page)).toBeHidden();

          await showProfile(page);
          await scrollProfileToEnd(page);
          const row = page.locator('#hb-about-update-row');
          await expect(row).toBeVisible();
          // B2: at the end of the scroll the last About row is above the FAB.
          const gap = await page.evaluate(() => {
            const r = globalThis.document
              .getElementById('hb-about-update-row')
              .getBoundingClientRect();
            const f = globalThis.document.getElementById('m-fab-main').getBoundingClientRect();
            return f.top - r.bottom;
          });
          expect(gap).toBeGreaterThanOrEqual(0);
          // Version value never breaks mid-hash; Copy is wide enough for "Copied".
          const about = await page.evaluate(() => {
            const v = globalThis.getComputedStyle(
              globalThis.document.getElementById('hb-about-version'),
            );
            const c = globalThis.document.getElementById('hb-about-copy').getBoundingClientRect();
            return { ws: v.whiteSpace, font: v.fontFamily, copyW: c.width };
          });
          expect(about.ws).toBe('nowrap');
          expect(about.font).toMatch(/monospace|Menlo/);
          expect(about.copyW).toBeGreaterThanOrEqual(84);

          await touch85(page, '#hb-about-copy');
          await expect(page.locator('#hb-about-copy')).toHaveText(/Copied|Copy failed/);
          await touch85(page, '#hb-about-update-btn'); // real tap: applies the update
          await expect
            .poll(() =>
              page.evaluate(() => globalThis.__marker ?? 'gone').catch(() => 'navigating'),
            )
            .toBe('gone');
          await expect(page.locator('#hb-about-version')).toHaveText(builds.v2.version);
        });
      });
    }
  }
}

for (const [w, h] of [
  [375, 667],
  [390, 844],
  [430, 932],
]) {
  test.describe(`touch ${w}x${h} reload state`, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: true });

    test('State 3: Reload on the card and in About take real taps; wording', async ({
      context,
      page,
      site,
      builds,
    }) => {
      await launch(context, page, site);
      await page.evaluate(() => (globalThis.__marker = 'alive'));
      await deployAndSettle(page, site, builds.v2);
      await expect(banner(page)).toBeVisible();
      await page.evaluate(async () => {
        (await globalThis.navigator.serviceWorker.getRegistration()).waiting.postMessage({
          type: 'SKIP_WAITING',
        });
      });
      await expect(banner(page)).toContainText('HomeBody updated');
      await expect(banner(page)).toContainText('Reload to use the new version.');
      await expect(banner(page).locator('.btn-primary')).toHaveText('Reload');
      await touch85(page, UPDATE, { tap: false });
      await touch85(page, LATER);
      await expect(banner(page)).toBeHidden();
      await showProfile(page);
      await scrollProfileToEnd(page);
      await expect(page.locator('#hb-about-update-label')).toHaveText('Updated, reload to use it');
      await expect(page.locator('#hb-about-update-btn')).toHaveText('Reload');
      await touch85(page, '#hb-about-update-btn'); // real tap: reloads
      await expect
        .poll(() => page.evaluate(() => globalThis.__marker ?? 'gone').catch(() => 'navigating'))
        .toBe('gone');
      await expect(page.locator('#hb-about-version')).toHaveText(builds.v2.version);
    });
  });
}

test.describe('FAB and sheets (390x844, touch)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the FAB still opens its tray and Rest / 30s / Wake still work by touch', async ({
    context,
    page,
    site,
  }) => {
    await launch(context, page, site);
    await page.evaluate(() => {
      globalThis.__fab = { qt: 0, wake: 0 };
      globalThis.mQuickTap = () => globalThis.__fab.qt++;
      globalThis.mToggleWakeLock = () => globalThis.__fab.wake++;
    });
    const tapCentre = async (sel) => {
      const b = await page.locator(sel).boundingBox();
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    };
    await tapCentre('#m-fab-main');
    await expect(page.locator('#m-fab-rest')).toHaveCSS('opacity', '1');
    await expect(page.locator('#m-fab-rest')).toHaveCSS('pointer-events', 'auto');
    await tapCentre('#m-qt-btn');
    await tapCentre('#m-wake-btn');
    expect(await page.evaluate(() => globalThis.__fab)).toEqual({ qt: 1, wake: 1 });
    await tapCentre('#m-fab-rest');
    await expect(page.locator('#m-timer-modal')).toHaveClass(/open/);
    // closed again: the hidden children take no taps
    await page.evaluate(() => globalThis.mCloseModal('m-timer-modal'));
    await expect(page.locator('#m-fab-rest')).toHaveCSS('pointer-events', 'none');
  });

  test('a sheet (z-index 200) covers the update card', async ({ context, page, site, builds }) => {
    await launch(context, page, site);
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    await touch85(page, UPDATE, { tap: false });
    await page.evaluate(() => globalThis.mOpenModal('m-timer-modal'));
    const covered = await page.evaluate(() => {
      const r = globalThis.document
        .querySelector('#hb-update .btn-primary')
        .getBoundingClientRect();
      const el = globalThis.document.elementFromPoint(
        r.left + r.width * 0.85,
        r.top + r.height / 2,
      );
      return !globalThis.document.getElementById('hb-update').contains(el);
    });
    expect(covered).toBe(true);
  });

  test('Updating: the primary stays at full opacity with taps blocked, Later is dimmed, status says so, then it restores', async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    // Keep the worker waiting so the busy state can be observed: drop SKIP_WAITING.
    await page.evaluate(() => {
      globalThis.__posts = 0;
      const o = globalThis.ServiceWorker.prototype.postMessage;
      globalThis.__origPost = o;
      globalThis.ServiceWorker.prototype.postMessage = function (m, t) {
        if (m && m.type === 'SKIP_WAITING') {
          globalThis.__posts++;
          globalThis.__held = [this, m];
          return;
        }
        return o.call(this, m, t);
      };
    });
    // Everything the live region is told, in order.
    await page.evaluate(() => {
      globalThis.__live = [];
      const live = globalThis.document.querySelector('#hb-update [role=status]');
      new globalThis.MutationObserver(() => globalThis.__live.push(live.textContent)).observe(
        live,
        {
          childList: true,
          characterData: true,
          subtree: true,
        },
      );
    });
    const heightBefore = (await banner(page).boundingBox()).height;
    await touch85(page, UPDATE);
    const go = banner(page).locator('.btn-primary');
    await expect(go).toHaveText('Updating…');
    // The visible title and body stay, and the card does not change height.
    await expect(banner(page).locator('.hb-t')).toHaveText('Update ready');
    await expect(banner(page).locator('.hb-b')).toHaveText(
      'Reloads HomeBody. Your history is kept.',
    );
    expect((await banner(page).boundingBox()).height).toBe(heightBefore);
    await expect(go).toHaveAttribute('aria-disabled', 'true');
    await expect(go).toHaveCSS('opacity', '1');
    await expect(go).toHaveCSS('pointer-events', 'none');
    await expect(go).toHaveJSProperty('disabled', false); // aria-disabled, not the attribute
    await expect(banner(page).locator('.btn-secondary')).toBeDisabled();
    await expect(banner(page).locator('[role=status]')).toHaveText('Updating…');
    await go.focus();
    await page.keyboard.press('Enter'); // aria-disabled must not re-fire
    expect(await page.evaluate(() => globalThis.__posts)).toBe(1);
    await expect(go).toHaveText('Update', { timeout: 15000 }); // quietly restored after 10 s
    await expect(go).not.toHaveAttribute('aria-disabled', 'true');
    await expect(banner(page).locator('.hb-t')).toHaveText('Update ready');
    // Announced once: "Updating…" appears in the live region once, and restoring only clears it.
    const live = await page.evaluate(() => globalThis.__live);
    expect(live.filter((t) => t === 'Updating…')).toHaveLength(1);
    expect(live.at(-1)).toBe('');
    await expect(banner(page).locator('[role=status]')).toHaveText('');

    // The tap was given up on: a later takeover is not mistaken for it, so the page does not reload.
    await page.evaluate(() => globalThis.__marker === undefined && (globalThis.__marker = 'alive'));
    await page.evaluate(() => {
      const [w, m] = globalThis.__held;
      globalThis.__origPost.call(w, m);
    });
    await expect.poll(async () => (await versions(page)).active).toBe(builds.v2.version);
    await expect(banner(page).locator('.hb-t')).toHaveText('HomeBody updated');
    expect(await page.evaluate(() => globalThis.__marker)).toBe('alive');
  });

  test('after Later or Escape focus returns to where it was, else the active nav tab', async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await page.evaluate(() => globalThis.mShowPage('progress'));
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    // No earlier focus: the active bottom-nav tab (named, always present); page containers get nothing.
    await page.locator(LATER).focus();
    await page.keyboard.press('Escape');
    await expect(banner(page)).toBeHidden();
    expect(await page.evaluate(() => globalThis.document.activeElement.id)).toBe('tab-progress');
    expect(
      await page.evaluate(
        () =>
          [...globalThis.document.querySelectorAll('.page')].filter(
            (p) =>
              p.hasAttribute('role') || p.hasAttribute('aria-label') || p.hasAttribute('tabindex'),
          ).length,
      ),
    ).toBe(0);
  });

  test('after Later, focus returns to the element that had it', async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    await page.locator('#tab-progress').focus();
    await page.locator(LATER).focus();
    await page.locator(LATER).press('Enter');
    await expect(banner(page)).toBeHidden();
    expect(await page.evaluate(() => globalThis.document.activeElement.id)).toBe('tab-progress');
  });
});

// ---- Amendment 3: principle 5 at tap time and at controllerchange, a11y structure, hygiene ----

const ACTIVE_KEY = 'hb_active_workout';
const startWorkoutKey = (page) =>
  page.evaluate(
    ([k, v]) => globalThis.localStorage.setItem(k, v),
    [ACTIVE_KEY, JSON.stringify({ ...ACTIVE, name: 'Late Workout' })],
  );

/** Count SKIP_WAITING posts; `hold` keeps them back so the test decides when the takeover happens. */
const watchSkipWaiting = (page, { hold = false } = {}) =>
  page.evaluate((holdIt) => {
    globalThis.__posts = 0;
    const o = globalThis.ServiceWorker.prototype.postMessage;
    globalThis.__origPost = o;
    globalThis.ServiceWorker.prototype.postMessage = function (m, t) {
      if (m && m.type === 'SKIP_WAITING') {
        globalThis.__posts++;
        if (holdIt) {
          globalThis.__held = [this, m];
          return;
        }
      }
      return o.call(this, m, t);
    };
  }, hold);

test.describe('principle 5: a workout that appears after the card is up', () => {
  test('tap time: a workout started while the card is showing blocks Update', async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await page.evaluate(() => (globalThis.__marker = 'alive'));
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    await watchSkipWaiting(page);
    await startWorkoutKey(page); // same tab: no storage event, the card is still on screen
    await expect(banner(page)).toBeVisible();
    await banner(page).getByRole('button', { name: 'Update' }).click();
    await expect(banner(page)).toBeHidden();
    expect(await page.evaluate(() => globalThis.__posts)).toBe(0);
    expect(await page.evaluate(() => globalThis.__marker)).toBe('alive');
    expect(await versions(page)).toEqual({ active: builds.v1.version, waiting: builds.v2.version });
    expect(
      await page.evaluate((k) => globalThis.localStorage.getItem(k) !== null, ACTIVE_KEY),
    ).toBe(true);
  });

  test('the workout layer appearing hides the card at once and Update is never posted', async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await page.evaluate(() => (globalThis.__marker = 'alive'));
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    await watchSkipWaiting(page);
    await page.evaluate(() => {
      const d = globalThis.document.createElement('div');
      d.id = 'wm-overlay';
      globalThis.document.body.appendChild(d);
    });
    await expect(banner(page)).toBeHidden();
    expect(await page.evaluate(() => globalThis.__posts)).toBe(0);
    expect(await page.evaluate(() => globalThis.__marker)).toBe('alive');
  });

  test('controllerchange: Update tapped, then a workout starts before the takeover: no reload, notice held then offered', async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await page.evaluate(() => (globalThis.__marker = 'alive'));
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    await watchSkipWaiting(page, { hold: true });
    await banner(page).getByRole('button', { name: 'Update' }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__posts)).toBe(1);
    await startWorkoutKey(page); // the workout begins while the takeover is pending
    await page.evaluate(() => {
      const [w, m] = globalThis.__held;
      globalThis.__origPost.call(w, m); // now the new worker takes over
    });
    await expect.poll(async () => (await versions(page)).active).toBe(builds.v2.version);
    await expect(banner(page)).toBeHidden();
    // The workout ends; the page was not reloaded and now asks for a reload.
    await page.evaluate((k) => {
      globalThis.localStorage.removeItem(k);
      globalThis.document.body.appendChild(globalThis.document.createElement('i')); // wakes the observer
    }, ACTIVE_KEY);
    await expect(banner(page).locator('.hb-t')).toHaveText('HomeBody updated', { timeout: 15000 });
    expect(await page.evaluate(() => globalThis.__marker)).toBe('alive');
  });
});

test('the status node is always in the DOM and the card is hidden by visibility and inert', async ({
  context,
  page,
  site,
  builds,
}) => {
  await launch(context, page, site);
  const state = () =>
    page.evaluate(() => {
      const b = globalThis.document.getElementById('hb-update');
      return {
        hiddenAttr: b.hasAttribute('hidden'),
        inert: b.inert,
        visibility: globalThis.getComputedStyle(b).visibility,
        status: !!b.querySelector('[role=status]'),
      };
    });
  expect(await state()).toEqual({
    hiddenAttr: false,
    inert: true,
    visibility: 'hidden',
    status: true,
  });
  await deployAndSettle(page, site, builds.v2);
  await expect(banner(page)).toBeVisible();
  expect(await state()).toMatchObject({ inert: false, visibility: 'visible', status: true });
  // The text reaches the live region after the card is shown.
  await expect(banner(page).locator('[role=status]')).toHaveText(
    'Update ready. Reloads HomeBody. Your history is kept.',
  );
});

test.describe('large text on a small screen', () => {
  test.use({ viewport: { width: 375, height: 400 } });

  test('the card is at most half the screen, scrolls, and Later stays reachable', async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    await page.evaluate(() => (globalThis.document.documentElement.style.fontSize = '36px'));
    const box = await banner(page).boundingBox();
    expect(box.height).toBeLessThanOrEqual(200 + 1);
    expect(await banner(page).evaluate((el) => globalThis.getComputedStyle(el).overflowY)).toBe(
      'auto',
    );
    await page.locator(LATER).scrollIntoViewIfNeeded();
    const later = await page.locator(LATER).boundingBox();
    expect(later.y).toBeGreaterThanOrEqual(0);
    expect(later.y + later.height).toBeLessThanOrEqual(400);
  });
});

test.describe('offline setup that fails', () => {
  test('a precache file that 404s on first install: About says so', async ({
    context,
    page,
    site,
  }) => {
    await blockExternal(context, site.url);
    await rm(join(site.dir, 'fonts', 'inter-latin.woff2'));
    await page.goto(site.url + 'index.html');
    await showProfile(page);
    await expect(page.locator('#hb-about-offline-text')).toHaveText(
      'Setup failed, reconnect and reopen',
    );
    // Not colour alone: the marker is a diamond, not the round dot.
    await expect(page.locator('#hb-about-dot')).toHaveCSS('border-radius', '1px');
  });

  test('a registration that is rejected: About says so', async ({ context, page, site }) => {
    await blockExternal(context, site.url);
    await rm(join(site.dir, 'sw.js'));
    await page.goto(site.url + 'index.html');
    await showProfile(page);
    await expect(page.locator('#hb-about-offline-text')).toHaveText(
      'Setup failed, reconnect and reopen',
    );
  });
});

test('after an update elsewhere the old page still shows the version it booted with', async ({
  context,
  page,
  site,
  builds,
}) => {
  await launch(context, page, site);
  await deployAndSettle(page, site, builds.v2);
  await page.evaluate(async () => {
    (await globalThis.navigator.serviceWorker.getRegistration()).waiting.postMessage({
      type: 'SKIP_WAITING',
    });
  });
  await expect(banner(page).locator('.hb-t')).toHaveText('HomeBody updated');
  await showProfile(page);
  await expect(page.locator('#hb-about-version')).toHaveText(builds.v1.version);
});

// ---- Amendment 4 ----

test('aria-current marks the active bottom-nav tab and follows mShowPage', async ({
  context,
  page,
  site,
}) => {
  await launch(context, page, site);
  const current = () =>
    page.evaluate(() =>
      [...globalThis.document.querySelectorAll('.nav-tab')]
        .filter((t) => t.getAttribute('aria-current') === 'page')
        .map((t) => t.id),
    );
  expect(await current()).toEqual(['tab-train']);
  for (const id of ['progress', 'plans', 'profile', 'train']) {
    await page.evaluate((p) => globalThis.mShowPage(p), id);
    expect(await current()).toEqual([`tab-${id}`]);
  }
});

test.describe('landscape at 200% text', () => {
  test.use({ viewport: { width: 812, height: 375 } });

  test('the button row is pinned: both buttons are fully visible without scrolling the card', async ({
    context,
    page,
    site,
    builds,
  }) => {
    await launch(context, page, site);
    await deployAndSettle(page, site, builds.v2);
    await expect(banner(page)).toBeVisible();
    await page.evaluate(() => (globalThis.document.documentElement.style.fontSize = '32px'));
    const m = await page.evaluate(() => {
      const d = globalThis.document;
      const card = d.getElementById('hb-update');
      const c = card.getBoundingClientRect();
      const out = {
        scrollTop: card.scrollTop,
        card: [c.top, c.bottom],
        overflows: card.scrollHeight > card.clientHeight,
      };
      for (const q of ['.btn-secondary', '.btn-primary']) {
        const r = card.querySelector(q).getBoundingClientRect();
        const el = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out[q] = { top: r.top, bottom: r.bottom, hit: card.querySelector(q).contains(el) };
      }
      return out;
    });
    expect(m.overflows).toBe(true); // the body really does need to scroll at this size
    expect(m.scrollTop).toBe(0);
    for (const q of ['.btn-secondary', '.btn-primary']) {
      expect(m[q].top).toBeGreaterThanOrEqual(m.card[0]);
      expect(m[q].bottom).toBeLessThanOrEqual(m.card[1]);
      expect(m[q].bottom).toBeLessThanOrEqual(375);
      expect(m[q].hit).toBe(true);
    }
  });
});

test('a toast on screen when the card is due: the card waits until the stack is empty', async ({
  context,
  page,
  site,
  builds,
}) => {
  await launch(context, page, site);
  // A toast that stays for 7 s, longer than the 4 s settle time.
  await page.evaluate(() => {
    const t = globalThis.document.createElement('div');
    t.className = 'm-toast show';
    t.textContent = 'Test toast';
    globalThis.document.getElementById('m-toasts').appendChild(t);
    setTimeout(() => {
      globalThis.__toastGone = globalThis.performance.now();
      t.remove();
    }, 7000);
  });
  await deployAndSettle(page, site, builds.v2);
  await expect(banner(page)).toBeVisible({ timeout: 20000 });
  const [shown] = await bannerLog(page);
  expect(shown.toasts).toBe(0);
  expect(shown.t).toBeGreaterThanOrEqual(await page.evaluate(() => globalThis.__toastGone));
});
