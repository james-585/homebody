// T7b step 1: the render sinks (docs/security.md "Sink inventory"). The state here is what an OLD, unvalidated
// import (or hand-edited storage) could have left behind, so every renderer must treat it as data on its own,
// not rely on the new importer's validation. Nothing may execute and no markup may be created from a value.
import { test, expect, seedStorage, seedData } from './helpers/seed.mjs';

const PAY = '"><img src=x onerror=window.__x=1>';
const NUM = '0"><img src=x onerror=window.__x=1>'; // a "number" that is really markup
const QUOTE = "x');window.__x=1;//"; // breaks out of a single-quoted JS string
const ENT = 'x&#39;);window.__x=1;//'; // entity-decoded to a quote before the JS parser runs
const IDP = '1);window.__x=1;//'; // breaks out of an unquoted numeric argument
// A backslash eats the escaping quote that an escape-and-replace pattern adds; &apos; and a bare & and a newline too
const BS1 = "\\');window.__x=1;//";
const BS2 = "\\\\');window.__x=1;//";
const APOS = 'x&apos;);window.__x=1;//';
const ODD = 'a\nb & c';

function hostile() {
  const ex = (name, tt) => ({
    name,
    sets: NUM,
    reps: NUM,
    time: NUM,
    weight: NUM,
    trackType: tt,
    supersetGroup: PAY,
  });
  return {
    workouts: [
      {
        id: IDP,
        name: PAY,
        date: '2026-10-30T10:00:00Z',
        exercises: [
          ex(QUOTE, 'reps'),
          ex(ENT, 'time'),
          ex(PAY, 'reps'),
          ex(BS1, 'reps'),
          ex(BS2, 'reps'),
          ex(APOS, 'reps'),
          ex(ODD, 'reps'),
        ],
        totalSets: NUM,
        totalVolume: NUM,
        calories: NUM,
        duration: NUM,
        rpe: NUM,
        grade: PAY,
        planId: NUM,
        bodyWeight: NUM,
      },
      { id: 22, name: 'ok', date: '2026-10-31T10:00:00Z', exercises: [ex(QUOTE, 'reps')] },
    ],
    personalRecords: {
      [QUOTE]: { value: NUM, unit: PAY },
      [ENT]: { value: NUM, unit: 'kg' },
      [BS1]: { value: 5, unit: 'kg' },
      [APOS]: { value: 5, unit: 'kg' },
      Squat: { value: IDP, unit: 'sec' },
    },
    bodyMetrics: [{ date: '2026-10-30T00:00:00Z', weight: NUM, waist: NUM, bodyfat: NUM }],
    userPlans: [
      {
        id: IDP,
        name: PAY,
        desc: PAY,
        level: PAY,
        weeks: NUM,
        daysPerWeek: NUM,
        planDays: [
          {
            name: 'Monday ' + PAY,
            note: PAY,
            exercises: [
              { ...ex(PAY, 'reps'), muscle: 'constructor' },
              ex(BS1, 'reps'),
              ex(APOS, 'reps'),
            ],
          },
        ],
      },
      { id: 3, name: 'c', level: 'constructor', planDays: [] },
      { id: 4, name: 'h', level: 'hidden', planDays: [] },
    ],
    profile: {
      name: PAY,
      goal: 'constructor',
      sex: 'hidden',
      activity: '__proto__',
      weight: 70,
      equipment: {
        dumbbells: [NUM, 10, IDP],
        barbell_plate_count: { 20: NUM, 10: IDP },
      },
    },
    favourites: [QUOTE, ENT, PAY, BS1, BS2, APOS, ODD],
  };
}

async function scan(page) {
  return page.evaluate(() => ({
    x: window.__x,
    imgs: document.querySelectorAll('img').length,
    onerrorAttrs: [...document.querySelectorAll('body *:not(script)')].filter((e) =>
      [...e.attributes].some((a) => /^on(error|load)$/i.test(a.name)),
    ).length,
    // a handler attribute that carries our breakout text in code position
    breakout: [...document.querySelectorAll('[onclick],[onchange]')].filter((e) =>
      /window\.__x/.test(e.getAttribute('onclick') || e.getAttribute('onchange') || ''),
    ).length,
  }));
}

test.describe('render sinks treat stored and imported values as data', () => {
  test('every renderer: nothing executes, no markup from values @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await seedStorage(page, { vaultfit_v1: JSON.stringify(hostile()), hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await page.evaluate(() => HB.storage.ready());
    const threw = await page.evaluate(() => {
      const out = [];
      const t = (name, f) => {
        try {
          f();
        } catch (e) {
          out.push(name + ': ' + e.message);
        }
      };
      for (const p of ['train', 'progress', 'plans', 'profile'])
        t('page ' + p, () => window.mShowPage(p));
      t('home', () => window.mRenderHome());
      t('log', () => window.mRenderLog());
      t('prs', () => window.mRenderPRs());
      t('myplans', () => window.mRenderMyPlans());
      t('plan detail', () => window.mOpenPlanDetail(state.userPlans[0]));
      t('plan detail c', () => window.mOpenPlanDetail(state.userPlans[1]));
      t('plan detail h', () => window.mOpenPlanDetail(state.userPlans[2]));
      t('calendar', () => window.mRenderPlanCalendar());
      t('equip', () => window.mRenderEquipManager());
      t('favs', () => window.mRenderFavouritesList());
      t('bm chart', () => window.mRenderBodyMetricsChart());
      t('milestones', () => window.mRenderMilestones());
      t('weekly', () => window.mRenderWeeklyVolumeChart());
      t('recovery', () => window.mRenderMuscleRecovery());
      t('exercise progress', () => window.mShowExerciseProgress(QUOTE));
      t('exercise progress2', () => window.mShowExerciseProgress(PAY));
      t('show workout', () => window.mShowWorkout(22));
      t('edit workout', () => window.mOpenEdit(22));
      t('edit plan', () => window.mEditPlan(3));
      t('start from plan', () => window.mLoadDay(state.userPlans[0].planDays[0], 'p'));
      return out;
    });
    // Renderers may fail on malformed data (not a security issue) but must never run it.
    expect(threw.join('\n')).not.toMatch(/__x/);
    // Click every handler the hostile data produced (favourites, log buttons, plan buttons).
    await page.evaluate(() => {
      document.querySelectorAll('#m-favs-list button').forEach((b) => b.click());
    });
    await page.evaluate(() => {
      window.mRenderLog();
      window.mRenderMyPlans();
      document
        .querySelectorAll('#m-log-list button, #m-browse-mine button, #m-equip-manager .remove-x')
        .forEach((b) => {
          try {
            b.click();
          } catch {
            /* a handler may throw on bad data; it must not run our payload */
          }
        });
    });
    await page.waitForTimeout(200);
    const r = await scan(page);
    expect(r.x).toBeUndefined();
    expect(r.imgs).toBe(0);
    expect(r.onerrorAttrs).toBe(0);
    expect(r.breakout).toBe(0);
  });

  test('plan level and profile goal tokens: own-property lookups only @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await seedStorage(page, { vaultfit_v1: JSON.stringify(hostile()), hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await page.evaluate(() => HB.storage.ready());
    const r = await page.evaluate(() => {
      window.mShowPage('train');
      window.mRenderMyPlans();
      const badges = [...document.querySelectorAll('#m-browse-mine .plan-level-badge')].map(
        (b) => ({
          cls: b.className,
          text: b.textContent,
        }),
      );
      return {
        sub: document.getElementById('hm-sub').textContent,
        badges,
        goal: window.goalLabel('toString'),
      };
    });
    // 'constructor' and 'toString' are not goals: the fixed fallback (13.1), never the token or function text
    expect(r.sub).toBe('Ready to train?');
    expect(r.goal).toBe('Ready to train?');
    // PAY, 'constructor' and 'hidden' are not levels: no class, the fixed "unrecognised" label
    for (const b of r.badges) {
      expect(b.cls.trim()).toBe('plan-level-badge');
      expect(b.text).toBe("a setting HomeBody doesn't recognise");
    }
    expect(r.badges).toHaveLength(3);
  });

  test('known values still render as before', async ({ appPage: page, siteURL }) => {
    const d = hostile();
    d.userPlans = [
      {
        id: 5,
        name: 'Real',
        level: 'advanced',
        weeks: 6,
        planDays: [{ name: 'A', exercises: [] }],
      },
    ];
    d.workouts = [];
    d.profile = { goal: 'build_muscle', weight: 70 };
    await seedStorage(page, { vaultfit_v1: JSON.stringify(d), hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await page.evaluate(() => HB.storage.ready());
    const r = await page.evaluate(() => {
      window.mShowPage('train');
      window.mRenderMyPlans();
      const b = document.querySelector('#m-browse-mine .plan-level-badge');
      return {
        cls: b.className,
        text: b.textContent,
        weeks: document.querySelector('#m-browse-mine .plan-stat-val:nth-child(1)')
          ? [...document.querySelectorAll('#m-browse-mine .plan-stat-val')][1].textContent
          : null,
        sub: document.getElementById('hm-sub').textContent,
      };
    });
    expect(r.cls).toBe('plan-level-badge advanced');
    expect(r.text).toBe('advanced');
    expect(r.weeks).toBe('6');
    expect(r.sub).toContain('Muscle building goal');
  });
  test('known-good data: every renderer runs without throwing (the loop above swallows errors)', async ({
    appPage: page,
    siteURL,
  }) => {
    const d = seedData();
    await seedStorage(page, { vaultfit_v1: JSON.stringify(d), hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await page.evaluate(() => HB.storage.ready());
    const threw = await page.evaluate(() => {
      const out = [];
      const t = (name, f) => {
        try {
          f();
        } catch (e) {
          out.push(name + ': ' + e.message);
        }
      };
      const w = state.workouts[0];
      for (const p of ['train', 'progress', 'plans', 'profile'])
        t('page ' + p, () => window.mShowPage(p));
      t('log', () => window.mRenderLog());
      t('prs', () => window.mRenderPRs());
      t('myplans', () => window.mRenderMyPlans());
      t('plan detail', () => window.mOpenPlanDetail(state.userPlans[0]));
      t('calendar', () => window.mRenderPlanCalendar());
      t('equip', () => window.mRenderEquipManager());
      t('favs', () => window.mRenderFavouritesList());
      t('bm chart', () => window.mRenderBodyMetricsChart());
      t('milestones', () => window.mRenderMilestones());
      t('weekly', () => window.mRenderWeeklyVolumeChart());
      t('recovery', () => window.mRenderMuscleRecovery());
      t('exercise progress', () => window.mShowExerciseProgress(w.exercises[0].name));
      t('show workout', () => window.mShowWorkout(w.id));
      t('edit workout', () => window.mOpenEdit(w.id));
      t('edit plan', () => window.mEditPlan(state.userPlans[0].id));
      return out;
    });
    expect(threw).toEqual([]);
  });

  // The workout-mode path with stored hostile data: toasts that carry names, the info sheet, finish (PR toast),
  // plan edit and save, the calendar. (Ported from the preview spec that went with the old import path.)
  test('workout mode, toasts, plan edit and calendar with a hostile stored plan', async ({
    appPage: page,
    siteURL,
  }) => {
    test.setTimeout(60000);
    const EVIL = `x'"<img src=x onerror=window.__x=1>&#39;);window.__x=2;//\\`;
    const d = seedData();
    d.userPlans = [
      {
        id: 4242,
        name: `Plan ${EVIL}`,
        planDays: [
          {
            name: `Monday ${EVIL}`,
            exercises: [
              { name: `A ${EVIL}`, sets: 2, reps: 5, weight: 50, supersetGroup: `G${EVIL}` },
              { name: `B ${EVIL}`, sets: 3, reps: 5, weight: 40, supersetGroup: `G${EVIL}` },
              // names with no double quote, so a string-based info handler would break out cleanly
              { name: 'C x&#39;);window.__x=3;//', sets: 2, reps: 5, weight: 30 },
              { name: "D \\');window.__x=3;//", sets: 2, reps: 5, weight: 30 },
            ],
          },
        ],
      },
    ];
    d.profile = { ...(d.profile || {}), name: 'Sam' };
    await seedStorage(page, {
      vaultfit_v1: JSON.stringify(d),
      hb_seen_guide: '1',
      hb_seen_tutorial: '1',
    });
    await page.goto(siteURL + 'index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await page.evaluate(() => HB.storage.ready());
    const clean = async () => {
      expect(await page.evaluate(() => window.__x)).toBeUndefined();
      expect(await page.locator('img[src="x"]').count()).toBe(0);
    };
    await page.evaluate(() => {
      window.mShowPage('plans');
      window.mRenderMyPlans();
      window.mOpenPlanDetail(state.userPlans[0]);
    });
    await page.locator('#mpd-days button', { hasText: /load/i }).first().click();
    await expect(page.locator('#wm-overlay')).toBeAttached();
    // the superset mismatch toast carries the group name as text
    await expect(
      page.locator('.m-toast-text', { hasText: "set counts don't match" }).first(),
    ).toContainText('<img');
    await clean();
    await page.locator('#wm-overlay button[title="How to do this exercise"]').first().click();
    await clean();
    await page.evaluate(() => document.getElementById('wm-ex-info-modal')?.remove());
    // the info buttons of the quote-free names: clicking must not run anything
    for (const i of [2, 3]) {
      await page.locator('#wm-overlay button[title="How to do this exercise"]').nth(i).click();
      expect(await page.evaluate(() => window.__x)).toBeUndefined();
      await page.evaluate(() => document.getElementById('wm-ex-info-modal')?.remove());
    }
    await page.locator('#wm-tick-0-0').click();
    await page.locator('#wm-tick-1-0').click();
    await page.evaluate(() => window.mCloseModal('m-timer-modal'));
    await page.locator('.wm-finish-btn').click();
    await page.locator('.wm-finish-sheet button', { hasText: 'Save Workout' }).click();
    await expect(page.locator('.m-toast-text', { hasText: 'New PR' }).first()).toContainText(
      '<img',
    );
    await clean();
    await page.evaluate(() => {
      document.getElementById('wm-overlay')?.remove();
      window.mShowPage('plans');
      window.mEditPlan(4242);
    });
    await clean();
    await page.evaluate(() => window.mSavePlanEdits());
    await clean();
    await page.evaluate(() => {
      window.mSwitchPlanTab('calendar', document.querySelectorAll('.plan-tab')[0]);
      window.mRenderPlanCalendar();
    });
    await page.evaluate(() => {
      for (const b of document.querySelectorAll(
        '[onclick^="mCalLoadDay"],[onclick^="mShowWorkout"]',
      )) {
        try {
          b.click();
        } catch {
          /* a handler may throw; it must not run the payload */
        }
      }
    });
    await clean();
    const id = await page.evaluate(() => state.workouts[0].id);
    await page.evaluate((i) => {
      document.getElementById('wm-overlay')?.remove();
      window.mShowWorkout(i);
      window.mOpenEdit(i);
      window.mLoadPastWorkout(i);
    }, id);
    await clean();
  });

  test('a PR is recorded for exercise names that are also object property names', async ({
    appPage: page,
    siteURL,
  }) => {
    await seedStorage(page, { vaultfit_v1: JSON.stringify({ workouts: [] }), hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await page.evaluate(() => HB.storage.ready());
    const r = await page.evaluate(() => {
      const out = [];
      for (const n of ['constructor', 'toString', '__proto__']) {
        window.mShowPage('train');
        const rows = document.querySelectorAll('#m-ex-rows .ex-row-m');
        rows[0].querySelector('.ex-name-m').value = n;
        const inputs = rows[0].querySelectorAll('.mini-input');
        inputs[0].value = '3';
        inputs[1].value = '5';
        inputs[2].value = '40';
        window.mSaveWorkout();
        out.push(
          Object.prototype.hasOwnProperty.call(state.personalRecords, n) &&
            state.personalRecords[n].value,
        );
      }
      return { out, proto: Object.getPrototypeOf(state.personalRecords) === Object.prototype };
    });
    expect(r.out).toEqual([40, 40, 40]);
    expect(r.proto).toBe(true); // `__proto__` became a plain key, not the prototype
  });
});
