// Characterisation of the shipped app (T1). These goldens pin what users see and what legacy
// functions return, using the real-shape fixture and a frozen clock. Later tasks must keep them
// unchanged; only T11/T12 may change them, and only with a drift report.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  test,
  expect,
  openSeeded,
  seedData,
  checkGolden,
  stableStringify,
  FROZEN_ISO,
} from './helpers/seed.mjs';

const LAST_PERFORMANCE_NAMES = [
  'Dead Bug',
  'DB Overhead Press',
  'KB Goblet Squat',
  'Plank',
  'DB Single-Arm Row (Left)',
  'DB Single-Arm Row',
  'KB Lunge (Right)',
  'KB Calf Raise',
  'DB Floor Press',
  "Farmer's Walk",
];
// Edge cases kept apart from the ten named exercises above.
const LAST_PERFORMANCE_EDGES = ['dead bug', 'Not A Real Exercise'];

/** Everything the goldens record, read from the live page. Render functions are read-only. */
async function collect(page) {
  return page.evaluate(
    ({ names, edges }) => {
      const text = (id) =>
        (document.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      mRenderPRs();
      mRenderProgress();
      mRenderLog();
      mRenderMuscleRecovery();
      mRenderWeeklyVolumeChart();
      const log = [...document.querySelectorAll('#m-log-list .log-entry')].map((e) =>
        e.textContent.replace(/\s+/g, ' ').trim(),
      );
      return {
        history: {
          count: state.workouts.length,
          firstId: state.workouts[0]?.id ?? null,
          lastId: state.workouts[state.workouts.length - 1]?.id ?? null,
          entries: state.workouts.reduce((n, w) => n + w.exercises.length, 0),
          totalSets: state.workouts.reduce((n, w) => n + (w.totalSets || 0), 0),
          calories: state.workouts.reduce((n, w) => n + (w.calories || 0), 0),
        },
        prs: {
          state: state.personalRecords,
          count: Object.keys(state.personalRecords).length,
          renderedText: text('m-prs'),
        },
        lastPerformance: Object.fromEntries(
          [...names, ...edges].map((n) => [n, mGetLastPerformance(n)]),
        ),
        weeklySets: { renderedText: text('m-weekly-volume-chart') },
        recovery: { renderedText: text('m-muscle-recovery') },
        progress: {
          homeWorkouts: text('hm-workouts'),
          homeStreak: text('hm-streak'),
          progressWorkouts: text('hm-workouts-p'),
          progressCalories: text('hm-calories-p'),
          weekBars: text('m-week-bars'),
          weekBarsHtml: document.getElementById('m-week-bars').innerHTML,
          weekLabels: text('m-week-labels'),
          adherence: text('m-adherence-badge'),
          grade: text('m-grade-content'),
          milestones: text('m-milestones'),
          logEntryCount: log.length,
          logFirstFive: log.slice(0, 5),
        },
      };
    },
    { names: LAST_PERFORMANCE_NAMES, edges: LAST_PERFORMANCE_EDGES },
  );
}

async function exportPayload(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => mExportData()),
  ]);
  const path = await download.path();
  return {
    filename: download.suggestedFilename(),
    payload: JSON.parse(readFileSync(path, 'utf8')),
  };
}

// Fonts are self-hosted since T3, so the app asks for no external host at all.
function expectNoExternalHosts(blocked) {
  const hosts = new Set(blocked.map((u) => new URL(u).hostname));
  expect([...hosts]).toEqual([]);
}

test.describe('characterisation', () => {
  test('app boots on the seeded profile with no external requests @smoke', async ({
    appPage,
    siteURL,
    blocked,
  }) => {
    const errors = [];
    appPage.on('pageerror', (e) => errors.push(String(e)));
    await openSeeded(appPage, siteURL);
    expect(await appPage.evaluate(() => state.workouts.length)).toBe(149);
    expect(await appPage.evaluate(() => new Date().toISOString())).toBe('2026-11-01T12:00:00.000Z');
    expect(errors).toEqual([]);
    expectNoExternalHosts(blocked);
  });

  test('goldens: history, PRs, last performance, weekly sets, recovery, progress', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    const c = await collect(appPage);
    checkGolden('history', c.history);
    checkGolden('prs', c.prs);
    checkGolden('last-performance', c.lastPerformance);
    checkGolden('weekly-sets', c.weeklySets);
    checkGolden('recovery', c.recovery);
    checkGolden('progress', c.progress);
  });

  test('golden: streak and week bars on a day with a 4-day streak', async ({
    appPage,
    siteURL,
  }) => {
    // 2026-04-10 is the last day of the fixture's longest run of consecutive training days (4).
    await appPage.clock.setFixedTime(Date.parse('2026-04-10T12:00:00Z'));
    await openSeeded(appPage, siteURL);
    const c = await appPage.evaluate(() => {
      mRenderHome();
      mRenderProgress();
      const text = (id) =>
        (document.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        now: new Date().toISOString(),
        homeStreak: text('hm-streak'),
        weekBarsHtml: document.getElementById('m-week-bars').innerHTML,
        weekLabels: text('m-week-labels'),
        adherence: text('m-adherence-badge'),
      };
    });
    expect(c.homeStreak).toBe('4');
    checkGolden('progress-streak', c);
  });

  test('golden: export payload and filename', async ({ appPage, siteURL }) => {
    await openSeeded(appPage, siteURL);
    const { filename, payload } = await exportPayload(appPage);
    // The full payload is pinned by hash (and proven equal to the fixture by the round-trip test)
    // so the golden stays small and reviewable.
    const header = Object.fromEntries(Object.entries(payload).filter(([k]) => k.startsWith('_')));
    checkGolden('export', {
      filename,
      header,
      keyOrder: Object.keys(payload),
      // Readable digest next to the hash, so a mismatch shows what moved.
      digest: Object.fromEntries(
        Object.entries(payload)
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => [
            k,
            Array.isArray(v)
              ? { type: 'array', length: v.length }
              : { type: 'object', keys: Object.keys(v).length },
          ]),
      ),
      entryCount: payload.workouts.reduce((n, w) => n + w.exercises.length, 0),
      payloadSha256: createHash('sha256').update(stableStringify(payload)).digest('hex'),
    });
  });

  test('export round-trip: export after load deep-equals seeded data plus header @smoke', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    const { payload } = await exportPayload(appPage);
    expect(payload).toEqual({
      _vaultfit: true,
      _version: 1,
      _exported: new Date(FROZEN_ISO).toISOString(),
      _name: 'Test User',
      ...seedData(),
    });
  });

  test('determinism: two fresh loads give identical results', async ({
    browser,
    siteURL,
    blocked,
  }) => {
    const run = async () => {
      const ctx = await browser.newContext({
        locale: 'en-GB',
        timezoneId: 'UTC',
        serviceWorkers: 'block',
      });
      const page = await ctx.newPage();
      await page.clock.setFixedTime(Date.parse(FROZEN_ISO));
      await page.route('**/*', (r) =>
        r.request().url().startsWith(siteURL)
          ? r.continue()
          : (blocked.push(r.request().url()), r.abort()),
      );
      await openSeeded(page, siteURL);
      const out = { collected: await collect(page), exported: (await exportPayload(page)).payload };
      await ctx.close();
      return out;
    };
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
    expectNoExternalHosts(blocked);
  });

  test('state survives reload unchanged (load does not mutate stored data)', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    await appPage.reload();
    await appPage.waitForFunction(() => typeof state !== 'undefined');
    const stored = await appPage.evaluate(() => JSON.parse(localStorage.getItem('vaultfit_v1')));
    expect(stored).toEqual(seedData());
  });
});
