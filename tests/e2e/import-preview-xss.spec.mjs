// Hotfix: import previews must treat file values as data (principle 8), never as HTML.
import { test, expect, openSeeded } from './helpers/seed.mjs';

const PAYLOAD = '<img src=x onerror="window.__xss=1">';
const file = (obj) => ({
  name: 'x.vaultfit',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({ _vaultfit: true, ...obj })),
});

test.describe('import preview escapes file data', () => {
  test('backup preview: hostile counts, names and date inject nothing', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    await appPage.setInputFiles(
      '#m-import-input',
      file({
        _name: PAYLOAD,
        _exported: PAYLOAD,
        workouts: { length: PAYLOAD },
        userPlans: { length: PAYLOAD },
        favourites: { length: PAYLOAD },
        personalRecords: { length: PAYLOAD },
      }),
    );
    await expect(appPage.locator('#m-import-summary')).toContainText('Workouts');
    await appPage.waitForTimeout(200);
    expect(await appPage.evaluate(() => window.__xss)).toBeUndefined();
    expect(await appPage.locator('#m-import-summary img').count()).toBe(0);
  });

  test('backup preview: valid file still shows real counts', async ({ appPage, siteURL }) => {
    await openSeeded(appPage, siteURL);
    await appPage.setInputFiles(
      '#m-import-input',
      file({ _name: 'Sam', workouts: [{}, {}, {}], favourites: ['a'] }),
    );
    await expect(appPage.locator('#m-import-summary')).toContainText('Sam');
    const text = await appPage.locator('#m-import-summary').innerText();
    expect(text).toMatch(/3\s*\n?\s*🏋️ Workouts/);
  });

  test('plan preview: hostile name and session count inject nothing', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    await appPage.setInputFiles(
      '#m-import-plan-input',
      file({
        userPlans: [
          { id: 1, name: PAYLOAD, planDays: { length: PAYLOAD } },
          { id: 2, name: 'Ok plan', days: [{}, {}] },
        ],
      }),
    );
    const modal = appPage.locator('#m-plan-import-modal');
    await expect(modal).toContainText('Ok plan');
    await appPage.waitForTimeout(200);
    expect(await appPage.evaluate(() => window.__xss)).toBeUndefined();
    expect(await modal.locator('img').count()).toBe(0);
    await expect(modal).toContainText('2 sessions');
  });

  test('backup preview: non-string _name and _exported render as text', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    await appPage.setInputFiles(
      '#m-import-input',
      file({ _name: { a: PAYLOAD }, _exported: { b: PAYLOAD }, workouts: [] }),
    );
    await expect(appPage.locator('#m-import-summary')).toContainText('Workouts');
    await appPage.waitForTimeout(200);
    expect(await appPage.evaluate(() => window.__xss)).toBeUndefined();
    expect(await appPage.locator('#m-import-summary img').count()).toBe(0);
  });
});

test.describe('plan import confirm normalises stored plans', () => {
  const hostileExercise = {
    name: PAYLOAD,
    sets: PAYLOAD,
    reps: { length: PAYLOAD },
    time: PAYLOAD,
    weight: PAYLOAD,
    supersetGroup: PAYLOAD,
    trackType: PAYLOAD,
  };
  const hostile = {
    id: '987654);window.__xss=1;(',
    name: 'Shared plan',
    desc: PAYLOAD,
    level: PAYLOAD,
    weeks: PAYLOAD,
    daysPerWeek: PAYLOAD,
    planDays: [
      null,
      7,
      { name: PAYLOAD, exercises: [null, 'x', hostileExercise] },
      { name: 'Day two', exercises: { length: PAYLOAD } },
    ],
  };
  const valid = {
    id: 5,
    name: 'Valid plan',
    desc: 'Plain',
    level: 'advanced',
    weeks: 6,
    daysPerWeek: 2,
    planDays: [
      {
        name: 'Day A',
        exercises: [{ name: 'Squat', sets: 3, reps: 5, weight: 100, trackType: 'reps' }],
      },
    ],
  };

  test('hostile plan: nothing runs at confirm, in My Plans, detail or day list', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    const before = await appPage.evaluate(() => state.userPlans.length);
    await appPage.setInputFiles('#m-import-plan-input', file({ userPlans: [hostile, valid] }));
    await appPage.locator('#m-plan-import-confirm').click();
    await expect(appPage.locator('#m-plan-import-modal')).toHaveCount(0);
    expect(await appPage.evaluate(() => window.__xss)).toBeUndefined();

    const [h, v] = await appPage.evaluate(() => state.userPlans.slice(-2));
    expect(typeof h.id).toBe('number');
    expect(Number.isFinite(h.id)).toBe(true);
    expect(h.level).toBe('beginner');
    expect(h.weeks).toBeUndefined();
    expect(h.planDays).toHaveLength(2);
    const ex = h.planDays[0].exercises[0];
    expect([ex.sets, ex.reps, ex.time, ex.weight]).toEqual([1, 0, 0, 0]);
    expect(ex.trackType).toBe('reps');
    expect(h.planDays[1].exercises).toEqual([]);
    expect(v.level).toBe('advanced');
    expect(v.weeks).toBe(6);
    expect(v.planDays[0].exercises[0]).toMatchObject({
      name: 'Squat',
      sets: 3,
      reps: 5,
      weight: 100,
    });
    expect(await appPage.evaluate(() => state.userPlans.length)).toBe(before + 2);

    // Render My Plans, open "View" on the hostile plan, expand its day exercise list.
    await appPage.evaluate(() => {
      window.mShowPage('plans');
      window.mSwitchPlanTab('browse', document.querySelectorAll('.plan-tab')[1]);
      document.getElementById('m-firstrun-modal')?.remove();
      window.mSwitchBrowseTab('mine');
      window.mRenderMyPlans();
    });
    await appPage
      .locator('#m-browse-mine .plan-card', { hasText: 'Shared plan' })
      .locator('button', { hasText: 'View' })
      .click();
    await appPage.evaluate(() =>
      document.querySelectorAll('.day-acc-body').forEach((b) => b.classList.add('open')),
    );
    await appPage.waitForTimeout(200);
    expect(await appPage.evaluate(() => window.__xss)).toBeUndefined();
    expect(await appPage.locator('#m-browse-mine img, #m-plan-modal img').count()).toBe(0);
    await expect(appPage.locator('#mpd-days')).toContainText(PAYLOAD);

    // The valid plan next to it renders as before.
    await appPage.evaluate(() => window.mCloseModal('m-plan-modal'));
    const card = appPage.locator('#m-browse-mine .plan-card', { hasText: 'Valid plan' });
    await expect(card).toContainText('advanced');
    await expect(card).toContainText('6');
  });

  test('a null entry in the list does not half-apply; valid plans still import', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    const before = await appPage.evaluate(() => state.userPlans.length);
    await appPage.setInputFiles('#m-import-plan-input', file({ userPlans: [valid, null, valid] }));
    await appPage.locator('#m-plan-import-confirm').click();
    await expect(appPage.locator('#m-plan-import-modal')).toHaveCount(0);
    const ids = await appPage.evaluate(() => state.userPlans.map((p) => p.id));
    expect(ids).toHaveLength(before + 2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => Number.isFinite(i))).toBe(true);
  });

  test('a file with only invalid entries changes nothing', async ({ appPage, siteURL }) => {
    await openSeeded(appPage, siteURL);
    const before = await appPage.evaluate(() => JSON.stringify(state.userPlans));
    await appPage.setInputFiles('#m-import-plan-input', file({ userPlans: [null, 3, 'x'] }));
    await appPage.locator('#m-plan-import-confirm').click();
    await expect(appPage.locator('.m-toast-text', { hasText: 'No valid plans' })).toHaveCount(1);
    expect(await appPage.evaluate(() => JSON.stringify(state.userPlans))).toBe(before);
  });

  test('numeric fields are clamped to real ranges and the success toast shows', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    await appPage.setInputFiles(
      '#m-import-plan-input',
      file({
        userPlans: [
          {
            id: 777001,
            name: 'Big',
            weeks: 9999,
            daysPerWeek: 99,
            planDays: [
              {
                name: 'D',
                exercises: [{ name: 'X', sets: 100000, reps: 1e9, weight: 1e9, time: 1e9 }],
              },
            ],
          },
        ],
      }),
    );
    await appPage.locator('#m-plan-import-confirm').click();
    await expect(
      appPage.locator('.m-toast-text', { hasText: '1 plan added to My Plans' }),
    ).toHaveCount(1);
    const p = await appPage.evaluate(() => state.userPlans.at(-1));
    expect(p.id).toBe(777001);
    expect([p.weeks, p.daysPerWeek]).toEqual([52, 7]);
    expect(p.planDays[0].exercises[0]).toMatchObject({
      sets: 20,
      reps: 1000,
      weight: 1000,
      time: 3600,
    });
    // The Plans page is left on the My Plans list, not blank.
    await expect(appPage.locator('#m-browse-mine .plan-card', { hasText: 'Big' })).toBeVisible();
  });

  test('oversized files and plan counts are refused with nothing applied', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    const before = await appPage.evaluate(() => JSON.stringify(state.userPlans));
    const many = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, name: 'p' + i }));
    await appPage.setInputFiles('#m-import-plan-input', file({ userPlans: many }));
    await expect(appPage.locator('.m-toast-text', { hasText: 'too large to import' })).toHaveCount(
      1,
    );
    await expect(appPage.locator('#m-plan-import-modal')).toHaveCount(0);
    await appPage.setInputFiles('#m-import-plan-input', {
      name: 'big.vaultfit',
      mimeType: 'application/json',
      buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 32),
    });
    await expect(appPage.locator('.m-toast-text', { hasText: 'limit 2 MB' })).toHaveCount(1);
    expect(await appPage.evaluate(() => JSON.stringify(state.userPlans))).toBe(before);
  });
});

// Principle 8 end to end: plan-file strings reach toasts, workout mode, the finish flow and the
// plan editor. None of them may run script or inject markup.
test.describe('plan-file strings through workout mode', () => {
  const EVIL = `x'"<img src=x onerror=window.__xss=1>`;
  const plan = {
    id: 4242,
    name: `Plan ${EVIL}`,
    planDays: [
      {
        name: `Monday ${EVIL}`,
        exercises: [
          { name: `A ${EVIL}`, sets: 2, reps: 5, weight: 50, supersetGroup: `G${EVIL}` },
          { name: `B ${EVIL}`, sets: 3, reps: 5, weight: 40, supersetGroup: `G${EVIL}` },
        ],
      },
    ],
  };

  const clean = async (page) => {
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
  };

  test('import, view, load, tick, finish (PR toast), edit and save, calendar load', async ({
    appPage,
    siteURL,
  }) => {
    test.setTimeout(60000);
    await openSeeded(appPage, siteURL);
    await appPage.setInputFiles('#m-import-plan-input', file({ userPlans: [plan] }));
    await appPage.locator('#m-plan-import-confirm').click();
    await expect(appPage.locator('#m-plan-import-modal')).toHaveCount(0);
    await appPage.evaluate(() => document.getElementById('m-firstrun-modal')?.remove());
    await clean(appPage);

    await appPage
      .locator('#m-browse-mine .plan-card', { hasText: 'Plan x' })
      .locator('button', { hasText: 'View' })
      .click();
    await clean(appPage);
    await appPage.locator('#mpd-days button', { hasText: /load/i }).first().click();

    await expect(appPage.locator('#wm-overlay')).toBeAttached();
    await expect(
      appPage.locator('.m-toast-text', { hasText: "set counts don't match" }).first(),
    ).toContainText(EVIL);
    await clean(appPage);
    expect(await appPage.locator('#wm-overlay img, #m-toasts img').count()).toBe(0);

    // The info button passes an index, so the handler text never contains the name.
    const handler = await appPage
      .locator('#wm-overlay button[title="How to do this exercise"]')
      .first()
      .getAttribute('onclick');
    expect(handler).not.toContain('onerror');
    await appPage.locator('#wm-overlay button[title="How to do this exercise"]').first().click();
    await clean(appPage);
    await appPage.evaluate(() => document.getElementById('wm-ex-info-modal')?.remove());

    await appPage.locator('#wm-tick-0-0').click();
    await appPage.locator('#wm-tick-1-0').click();
    await appPage.evaluate(() => window.mCloseModal('m-timer-modal'));
    await appPage.locator('.wm-finish-btn').click();
    await appPage.locator('.wm-finish-sheet button', { hasText: 'Save Workout' }).click();
    await expect(appPage.locator('.m-toast-text', { hasText: 'New PR' }).first()).toContainText(
      EVIL,
    );
    await clean(appPage);

    await appPage.evaluate(() => {
      document.getElementById('wm-overlay')?.remove();
      window.mShowPage('plans');
      window.mEditPlan(4242);
    });
    await clean(appPage);
    await appPage.evaluate(() => window.mSavePlanEdits());
    await expect(appPage.locator('.m-toast-text', { hasText: 'saved' }).first()).toContainText(
      EVIL,
    );
    await clean(appPage);

    // Calendar Weekly Schedule: render, then load Monday.
    await appPage.evaluate(() => {
      window.mSwitchPlanTab('calendar', document.querySelectorAll('.plan-tab')[0]);
      window.mCalLoadDay(1);
    });
    await expect(appPage.locator('#wm-overlay')).toBeAttached();
    await clean(appPage);
  });
});
