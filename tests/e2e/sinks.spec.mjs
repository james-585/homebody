// T7b step 1: the render sinks (docs/security.md "Sink inventory"). The state here is what an OLD, unvalidated
// import (or hand-edited storage) could have left behind, so every renderer must treat it as data on its own,
// not rely on the new importer's validation. Nothing may execute and no markup may be created from a value.
import { test, expect, seedStorage } from './helpers/seed.mjs';

const PAY = '"><img src=x onerror=window.__x=1>';
const NUM = '0"><img src=x onerror=window.__x=1>'; // a "number" that is really markup
const QUOTE = "x');window.__x=1;//"; // breaks out of a single-quoted JS string
const ENT = 'x&#39;);window.__x=1;//'; // entity-decoded to a quote before the JS parser runs
const IDP = '1);window.__x=1;//'; // breaks out of an unquoted numeric argument

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
        exercises: [ex(QUOTE, 'reps'), ex(ENT, 'time'), ex(PAY, 'reps')],
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
            exercises: [{ ...ex(PAY, 'reps'), muscle: 'constructor' }],
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
    favourites: [QUOTE, ENT, PAY],
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
      t('progress log', () => window.mRenderProgressLog());
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
    // 'constructor' and 'toString' are not goals: the fixed "unrecognised" label, never the token or function text
    expect(r.sub).toBe("a setting HomeBody doesn't recognise");
    expect(r.goal).toBe("a setting HomeBody doesn't recognise");
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
});
