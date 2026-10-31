// T5a: storage module, async boot, legacy-key adoption, cold start. (The write-failure banner and
// persist() are T5b.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, openSeeded, seedStorage, seedData } from './helpers/seed.mjs';
import { SYNTHETIC_DIR } from '../unit/helpers/load-fixtures.mjs';

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
    expect(visible.every((f) => f.loaded === 149)).toBe(true);
    expect(booting).toBe(false);
  });

  test('module graph fails to load: app visible, empty state, stored data untouched', async ({
    appPage,
    siteURL,
  }) => {
    await appPage.route('**/src/storage/store.js', (route) => route.abort());
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
