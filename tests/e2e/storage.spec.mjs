// T5a: storage module, async boot, legacy-key adoption, cold start. (The write-failure banner and
// persist() are T5b.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, openSeeded, seedStorage, seedData } from './helpers/seed.mjs';
import { SYNTHETIC_DIR } from '../unit/helpers/load-fixtures.mjs';

const N = seedData().workouts.length;
const fixtureText = (name) => readFileSync(join(SYNTHETIC_DIR, `${name}.json`), 'utf8');

test.describe('legacy keys (AC4)', () => {
  for (const key of ['homebody_v1', 'homebody_v0', 'vaultfit_v0']) {
    test(`${key} alone: workouts load, legacy key unchanged, vaultfit_v1 created @smoke`, async ({
      appPage,
      siteURL,
    }) => {
      const raw = fixtureText(key);
      const expected = JSON.parse(raw).workouts.length;
      await seedStorage(appPage, { [key]: raw });
      await appPage.goto(siteURL + 'index.html');
      await appPage.waitForFunction(
        () => typeof state !== 'undefined' && document.readyState === 'complete',
      );
      expect(await appPage.evaluate(() => state.workouts.length)).toBe(expected);
      const stored = await appPage.evaluate(
        (k) => [localStorage.getItem(k), localStorage.getItem('vaultfit_v1')],
        key,
      );
      expect(stored[0]).toBe(raw);
      expect(stored[1]).toBe(raw);
    });
  }
});

test.describe('boot (AC1, principle 5)', () => {
  test('no visible frame precedes the loaded state; hbStart ends before load', async ({
    appPage,
    siteURL,
  }) => {
    await appPage.addInitScript(() => {
      window.__frames = [];
      const tick = () => {
        const b = document.body;
        const visible = !!b && getComputedStyle(b).visibility !== 'hidden';
        const loaded = typeof state !== 'undefined' && state.workouts.length;
        window.__frames.push({ visible, loaded });
        if (window.__frames.length < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.addEventListener('load', () => {
        window.__booting = document.documentElement.classList.contains('hb-booting');
      });
    });
    await openSeeded(appPage, siteURL);
    const { frames, booting } = await appPage.evaluate(() => ({
      frames: window.__frames,
      booting: window.__booting,
    }));
    const visible = frames.filter((f) => f.visible);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((f) => f.loaded === N)).toBe(true);
    expect(booting).toBe(false);
  });

  test('module graph fails to load: app visible, empty state, stored data untouched', async ({
    appPage,
    siteURL,
  }) => {
    await appPage.route('**/src/hb-storage.js', (route) => route.abort());
    const raw = JSON.stringify({ workouts: [{ id: 1, name: 'keep', exercises: [] }] });
    await seedStorage(appPage, { vaultfit_v1: raw });
    await appPage.goto(siteURL + 'index.html');
    await appPage.waitForFunction(
      () => typeof state !== 'undefined' && document.readyState === 'complete',
    );
    await expect(appPage.locator('body')).toBeVisible();
    expect(
      await appPage.evaluate(() => document.documentElement.classList.contains('hb-booting')),
    ).toBe(false);
    expect(await appPage.evaluate(() => state.workouts.length)).toBe(0);
    const rejected = await appPage.evaluate(() =>
      persistSave().then(
        () => 'saved',
        () => 'rejected',
      ),
    );
    expect(rejected).toBe('rejected');
    expect(await appPage.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(raw);
  });

  test('persistSave stores exactly the six keys in the old order', async ({ appPage, siteURL }) => {
    await openSeeded(appPage, siteURL);
    const stored = await appPage.evaluate(async () => {
      await persistSave();
      return localStorage.getItem('vaultfit_v1');
    });
    expect(Object.keys(JSON.parse(stored))).toEqual([
      'workouts',
      'personalRecords',
      'bodyMetrics',
      'userPlans',
      'profile',
      'favourites',
    ]);
  });
});

test.describe('cold start (AC5)', () => {
  // Generous absolute budget; the 10% comparison with main is a one-off A/B reported in the PR.
  test('first visible frame on the fixture, median of 5, is within budget', async ({
    browser,
    siteURL,
  }) => {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        window.__first = null;
        const tick = () => {
          const b = document.body;
          if (
            b &&
            getComputedStyle(b).visibility !== 'hidden' &&
            typeof state !== 'undefined' &&
            state.workouts.length
          ) {
            window.__first = performance.now();
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await seedStorage(page, { vaultfit_v1: JSON.stringify(seedData()) });
      await page.goto(siteURL + 'index.html');
      await page.waitForFunction(() => window.__first !== null);
      times.push(await page.evaluate(() => window.__first));
      await ctx.close();
    }
    times.sort((a, b) => a - b);
    const median = times[2];
    test
      .info()
      .annotations.push({ type: 'cold-start-median-ms', description: String(Math.round(median)) });
    expect(median).toBeLessThan(2500);
  });
});

// ---- T5b: save-problem bar (docs/design/write-failure-banner.md) and persist() ---------------

const ACTIVE = readFileSync(join(SYNTHETIC_DIR, 'hb_active_workout.json'), 'utf8');
const BAR = '#hb-save';

/** Make setItem throw QuotaExceededError for the main blob and/or the active workout on demand. */
async function injectFaults(page) {
  await page.addInitScript(() => {
    window.__fail = { main: false, wm: false };
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (
        (k === 'vaultfit_v1' && window.__fail.main) ||
        (k === 'hb_active_workout' && window.__fail.wm)
      ) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return orig.call(this, k, v);
    };
  });
}
const setFault = (page, f) => page.evaluate((x) => Object.assign(window.__fail, x), f);
const box = (page) =>
  page.locator(BAR).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  });

async function openWorkout(page, siteURL, { active = false } = {}) {
  await injectFaults(page);
  await seedStorage(page, {
    vaultfit_v1: JSON.stringify(seedData()),
    hb_seen_guide: '1',
    ...(active ? { hb_active_workout: ACTIVE } : {}),
  });
  await page.goto(siteURL + 'index.html');
  await page.waitForFunction(
    () => typeof state !== 'undefined' && document.readyState === 'complete',
  );
}

test.describe('save-problem bar (AC2)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('Finish with a quota fault: bar with Retry and Export, nothing under it, Retry cycle, then Saved @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await openWorkout(page, siteURL, { active: true });
    await setFault(page, { main: true });
    const before = await page.evaluate(() => state.workouts.length);
    await page.locator('.wm-finish-btn').click();
    await page.getByRole('button', { name: 'Save Workout' }).click();
    await expect(page.locator(BAR)).toBeVisible();
    await expect(page.locator(BAR)).toContainText('Not saved. Keep HomeBody open.');
    await expect(page.locator(BAR)).toContainText('out of space in this browser');
    await expect(page.locator(`${BAR} button:visible`)).toHaveText(['Retry', 'Export']);
    expect(await page.evaluate(() => state.workouts.length)).toBe(before + 1);
    await expect(page.locator('[role=alert]')).toHaveText(/Not saved\. Keep HomeBody open\./);

    // Nothing is under the bar: every hit inside its rectangle is the bar.
    const b = await box(page);
    const strays = await page.evaluate((r) => {
      const bar = document.getElementById('hb-save');
      const bad = [];
      for (let y = 4; y < r.bottom; y += 10)
        for (let x = 4; x < innerWidth; x += 10)
          if (!bar.contains(document.elementFromPoint(x, y))) bad.push([x, y]);
      return bad;
    }, b);
    expect(strays).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.app')).top)).toBe(
      `${Math.ceil(b.height)}px`,
    );

    // Retry while still faulted: busy, then "Still not saved", same size, alert not rewritten.
    const alertText = await page.locator('[role=alert]').textContent();
    const retry = page.locator(`${BAR} button`).first();
    const rb = await retry.boundingBox();
    await page.touchscreen.tap(rb.x + rb.width * 0.85, rb.y + rb.height / 2);
    await expect(retry).toHaveText('Still not saved');
    expect(await box(page)).toEqual(b);
    expect(await page.locator('[role=alert]').textContent()).toBe(alertText);
    await expect(retry).toHaveText('Retry', { timeout: 4000 });

    // Clear the fault: Retry saves, bar says Saved, the blob holds the workout, and it goes away.
    await setFault(page, { main: false });
    await page.touchscreen.tap(rb.x + rb.width * 0.85, rb.y + rb.height / 2);
    await expect(page.locator(BAR)).toContainText('Everything is saved on this device.');
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('vaultfit_v1')).workouts.length),
    ).toBe(before + 1);
    await expect(page.locator(BAR)).toBeHidden({ timeout: 6000 });
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--hb-bar-h').trim(),
      ),
    ).toBe('0px');
    await page.reload();
    expect(await page.evaluate(() => state.workouts.length)).toBe(before + 1);
  });

  test('Export by real touch downloads the unsaved workout and leaves the bar up', async ({
    appPage: page,
    siteURL,
  }) => {
    await openWorkout(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.push({
        id: 424242,
        name: 'Unsaved Probe',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await expect(page.locator(BAR)).toBeVisible();
    const ex = page.locator(BAR).getByRole('button', { name: 'Export', exact: true });
    const eb = await ex.boundingBox();
    expect(eb.height).toBeGreaterThanOrEqual(48);
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.touchscreen.tap(eb.x + eb.width * 0.85, eb.y + eb.height / 2),
    ]);
    expect(readFileSync(await dl.path(), 'utf8')).toContain('Unsaved Probe');
    await expect(page.locator(BAR)).toContainText('Not saved. Keep HomeBody open.');
  });

  test('mid-workout: Retry only, the workout header stays visible, sets still tick, and Saved needs every write', async ({
    appPage: page,
    siteURL,
  }) => {
    await openWorkout(page, siteURL, { active: true });
    await setFault(page, { wm: true });
    await page.locator('#wm-tick-0-1').click();
    await expect(page.locator(BAR)).toContainText('Workout not saved yet');
    await expect(page.locator(`${BAR} button:visible`)).toHaveText(['Retry']);
    const b = await box(page);
    const hdr = await page.locator('.wm-header').boundingBox();
    expect(hdr.y).toBeGreaterThanOrEqual(b.bottom - 1);
    await expect(page.locator('#wm-tick-0-1')).toBeVisible();
    // A failed Retry changes the label but never the bar's size (nothing jumps under the thumb).
    const first = page.locator(`${BAR} button`).first();
    await first.click();
    await expect(first).toHaveText('Still not saved');
    expect(await box(page)).toEqual(b);
    await expect(first).toHaveText('Retry', { timeout: 4000 });
    expect(await page.evaluate(() => localStorage.getItem('hb_active_workout'))).toContain(
      'Synthetic Plan',
    );

    // Both writes failed (main via persistSave), then only the main one recovers: not Saved.
    await setFault(page, { main: true });
    await page.evaluate(() => persistSave().catch(() => {}));
    await expect(page.locator(BAR)).toContainText('Not saved. Keep HomeBody open.');
    await setFault(page, { main: false });
    await page.locator(`${BAR} button`).first().click();
    await expect(page.locator(BAR)).not.toContainText('Everything is saved');
    await expect(page.locator(BAR)).toContainText(/Workout not saved yet|Not saved/);
    // The workout can still be finished: the user is never blocked.
    await setFault(page, { wm: false });
    await expect(page.locator(`${BAR} button`).first()).toHaveText('Retry', { timeout: 4000 });
    await page.locator(`${BAR} button`).first().click();
    await expect(page.locator(BAR)).toBeHidden({ timeout: 7000 });
  });

  test('a save problem holds the update card and About Update (T4 widening)', async ({
    appPage: page,
    siteURL,
  }) => {
    await openWorkout(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => persistSave().catch(() => {}));
    await expect(page.locator(BAR)).toBeVisible();
    expect(await page.evaluate(() => window.hbSaveHold())).toBe(true);
    await setFault(page, { main: false });
    await page.evaluate(() => persistSave().catch(() => {}));
    await expect(page.locator(BAR)).toContainText('Everything is saved');
    expect(await page.evaluate(() => window.hbSaveHold())).toBe(false);
  });
});

test.describe('load-time bars (AC2, principle 1)', () => {
  const cases = [
    ['corrupt', '{"workouts": [oops', 'Saved data could not be read'],
    [
      'future',
      JSON.stringify({ workouts: [{ id: 1 }], schemaVersion: 99 }),
      'Saved by a newer version',
    ],
  ];
  for (const [name, raw, title] of cases) {
    test(`${name} blob: bar in the first visible frame, Export only, blob untouched`, async ({
      appPage: page,
      siteURL,
    }) => {
      await page.addInitScript(() => {
        window.__first = null;
        const tick = () => {
          const b = document.body;
          if (b && getComputedStyle(b).visibility !== 'hidden') {
            const bar = document.getElementById('hb-save');
            window.__first = !!bar && bar.classList.contains('hb-on');
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await seedStorage(page, { vaultfit_v1: raw, hb_seen_guide: '1' });
      await page.goto(siteURL + 'index.html');
      await page.waitForFunction(() => window.__first !== null);
      expect(await page.evaluate(() => window.__first)).toBe(true);
      await expect(page.locator(BAR)).toContainText(title);
      await expect(page.locator(`${BAR} button:visible`)).toHaveText([
        'Export saved file',
        'Export',
      ]);
      await page.evaluate(() => persistSave().catch(() => {}));
      expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(raw);
    });
  }

  test('boot failure shows "Saving is not working" and never writes', async ({
    appPage: page,
    siteURL,
  }) => {
    await page.route('**/src/hb-storage.js', (route) => route.abort());
    const raw = JSON.stringify({ workouts: [{ id: 1, name: 'keep', exercises: [] }] });
    await seedStorage(page, { vaultfit_v1: raw, hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await expect(page.locator(BAR)).toContainText('Saving is not working');
    await expect(page.locator(`${BAR} button:visible`)).toHaveText(['Export saved file', 'Export']);
    expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(raw);
  });
});

test.describe('persist() (AC3)', () => {
  test('requested once after the first workout save; result readable via status()', async ({
    appPage: page,
    siteURL,
  }) => {
    await page.addInitScript(() => {
      window.__persistCalls = Number(sessionStorage.getItem('pc') || 0);
      if (navigator.storage) {
        navigator.storage.persist = async () => {
          window.__persistCalls++;
          sessionStorage.setItem('pc', String(window.__persistCalls));
          return true;
        };
      }
    });
    await seedStorage(page, { vaultfit_v1: JSON.stringify(seedData()), hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    expect(await page.evaluate(() => window.__persistCalls)).toBe(0);
    await page.evaluate(() => persistSave().catch(() => {}));
    await expect.poll(() => page.evaluate(() => window.__persistCalls)).toBe(1);
    await expect.poll(() => page.evaluate(() => HB.storage.status().persistGranted)).toBe(true);
    expect(await page.evaluate(() => HB.storage.status().persistAsked)).toBe(true);
    await page.reload();
    await page.waitForFunction(() => !!window.HB);
    await page.evaluate(() => persistSave().catch(() => {}));
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__persistCalls)).toBe(1);
  });
});

test.describe('T5b review fixes', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('Export saved file downloads the stored text exactly and writes nothing', async ({
    appPage: page,
    siteURL,
  }) => {
    const raw = '{"workouts": [oops, "keep me"';
    await seedStorage(page, { vaultfit_v1: raw, hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    const btn = page.locator(`${BAR} button`, { hasText: 'Export saved file' });
    const bb = await btn.boundingBox();
    expect(bb.height).toBeGreaterThanOrEqual(48);
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.touchscreen.tap(bb.x + bb.width * 0.85, bb.y + bb.height / 2),
    ]);
    expect(readFileSync(await dl.path(), 'utf8')).toBe(raw);
    expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(raw);
  });

  test('keyboard: after a successful Retry focus is not on <body> and the alert has no double full stop', async ({
    appPage: page,
    siteURL,
  }) => {
    await openWorkout(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => persistSave().catch(() => {}));
    await expect(page.locator(BAR)).toBeVisible();
    expect(await page.locator('[role=alert]').textContent()).not.toContain('..');
    await page.locator(`${BAR} button`).first().focus();
    await setFault(page, { main: false });
    await page.keyboard.press('Enter');
    await expect(page.locator(BAR)).toContainText('Everything is saved');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await expect(page.locator(BAR)).toBeHidden({ timeout: 6000 });
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    expect(await page.locator('[role=alert]').textContent()).toBe('');
  });

  test('a storage script that arrives late: app visible after the failsafe, no write until it loads', async ({
    appPage: page,
    siteURL,
  }) => {
    const raw = JSON.stringify(seedData());
    await page.route('**/src/hb-storage.js', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await seedStorage(page, { vaultfit_v1: raw, hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html', { waitUntil: 'commit' });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('hb-booting')), {
        timeout: 2200,
      })
      .toBe(false);
    expect(
      await page.evaluate(() =>
        persistSave().then(
          () => 'saved',
          () => 'rejected',
        ),
      ),
    ).toBe('rejected');
    expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(raw);
    await page.waitForFunction((n) => state.workouts.length === n, N, { timeout: 8000 });
    await expect(page.locator(BAR)).toBeHidden();
    expect(
      await page.evaluate(() =>
        persistSave().then(
          () => 'saved',
          () => 'rejected',
        ),
      ),
    ).toBe('saved');
  });

  test('at 200% text the inline bar falls back to the row layout and nothing is clipped', async ({
    appPage: page,
    siteURL,
  }) => {
    await openWorkout(page, siteURL, { active: true });
    await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
    await setFault(page, { wm: true });
    await page.locator('#wm-tick-0-1').click();
    await expect(page.locator(BAR)).toContainText('Workout not saved yet');
    const r = await page.locator(BAR).evaluate((e) => ({
      clipped: e.scrollHeight > e.clientHeight + 1,
      btn: e.querySelector('button:not([hidden])').getBoundingClientRect().toJSON(),
      h: e.getBoundingClientRect().height,
    }));
    expect(r.clipped).toBe(false);
    expect(r.btn.right).toBeLessThanOrEqual(390);
    expect(r.h).toBeLessThanOrEqual(844 * 0.4 + 1);
  });

  test('HB present but the load not finished: persistSave refuses, blob untouched, no false bar', async ({
    appPage: page,
    siteURL,
  }) => {
    await openWorkout(page, siteURL);
    const before = await page.evaluate(() => localStorage.getItem('vaultfit_v1'));
    await page.evaluate(() => {
      hbLoadedOk = false; // the window between the store existing and persistLoad finishing
    });
    expect(
      await page.evaluate(() =>
        persistSave().then(
          () => 'saved',
          () => 'rejected',
        ),
      ),
    ).toBe('rejected');
    expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(before);
    await expect(page.locator(BAR)).toBeHidden();
    await page.evaluate(() => {
      hbLoadedOk = true;
    });
    expect(
      await page.evaluate(() =>
        persistSave().then(
          () => 'saved',
          () => 'rejected',
        ),
      ),
    ).toBe('saved');
  });

  test('a storage script that throws at top level: failed-boot bar, empty state, blob untouched', async ({
    appPage: page,
    siteURL,
  }) => {
    const raw = JSON.stringify(seedData());
    await page.route('**/src/hb-storage.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("boom");' }),
    );
    await seedStorage(page, { vaultfit_v1: raw, hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await expect(page.locator(BAR)).toContainText('Saving is not working');
    expect(await page.evaluate(() => state.workouts.length)).toBe(0);
    expect(
      await page.evaluate(() =>
        persistSave().then(
          () => 'saved',
          () => 'rejected',
        ),
      ),
    ).toBe('rejected');
    expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(raw);
  });

  test('a late error from hb-storage.js after a good boot does not show the hard bar', async ({
    appPage: page,
    siteURL,
  }) => {
    await openWorkout(page, siteURL);
    await page.evaluate(() =>
      window.dispatchEvent(
        new ErrorEvent('error', {
          filename: location.origin + '/src/hb-storage.js',
          message: 'late',
        }),
      ),
    );
    await page.waitForTimeout(100);
    await expect(page.locator(BAR)).toBeHidden();
    expect(
      await page.evaluate(() =>
        persistSave().then(
          () => 'saved',
          () => 'rejected',
        ),
      ),
    ).toBe('saved');
  });

  for (const [w, h] of [
    [375, 667],
    [320, 568],
  ]) {
    test(`load-time bar at 200% text, ${w}px wide: the explanation is not covered and the buttons are reachable`, async ({
      appPage: page,
      siteURL,
    }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript(() => {
        document.addEventListener(
          'DOMContentLoaded',
          () => (document.documentElement.style.fontSize = '32px'),
        );
      });
      await seedStorage(page, { vaultfit_v1: '{"workouts": [oops', hb_seen_guide: '1' });
      await page.goto(siteURL + 'index.html');
      await expect(page.locator(BAR)).toContainText('Saved data could not be read');
      const r = await page.locator(BAR).evaluate((bar) => {
        const b = bar.querySelector('.hb-b').getBoundingClientRect();
        const hit = document.elementFromPoint(
          b.left + b.width / 2,
          b.top + Math.min(b.height, 20) / 2,
        );
        const covered = !hit || !hit.closest('.hb-b');
        bar.scrollTop = bar.scrollHeight;
        const btns = [...bar.querySelectorAll('button:not([hidden])')].map((x) =>
          x.getBoundingClientRect().toJSON(),
        );
        return { covered, h: bar.getBoundingClientRect().height, btns };
      });
      expect(r.covered).toBe(false);
      expect(r.h).toBeLessThanOrEqual(h * 0.5 + 1);
      expect(r.btns).toHaveLength(2);
      for (const b of r.btns) {
        expect(b.right).toBeLessThanOrEqual(w);
        expect(b.bottom).toBeLessThanOrEqual(h);
      }
    });
  }
});
