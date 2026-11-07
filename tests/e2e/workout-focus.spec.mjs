// Workout mode: the one-exercise-at-a-time focus view, the Rest screen and the 60 s default.
import { test, expect, openSeeded } from './helpers/seed.mjs';

const start = async (page, siteURL) => {
  await page.addInitScript(() => localStorage.setItem('hb_wm_view', 'focus'));
  await openSeeded(page, siteURL);
  await page.evaluate(() => {
    const p = state.userPlans[0];
    mStartWorkoutMode(p.planDays[0], p.name);
  });
  await expect(page.locator('#wm-focus .wmf-log')).toBeVisible();
};
const closeRest = (page) => page.evaluate(() => mCloseModal('m-timer-modal'));

test.describe('focus view', () => {
  test('opens by default and shows one exercise, its set pills and steppers', async ({
    appPage: page,
    siteURL,
  }) => {
    await start(page, siteURL);
    await expect(page.locator('#wm-body')).toBeHidden();
    await expect(page.locator('.wmf-name')).toHaveText(/\S/);
    await expect(page.locator('.wmf-pill')).not.toHaveCount(0);
    await expect(page.locator('.wmf-step')).toHaveCount(4);
  });

  test('a unilateral exercise logs left then right, then moves to the next set and starts a 60 s rest', async ({
    appPage: page,
    siteURL,
  }) => {
    await start(page, siteURL);
    const first = await page.evaluate(() => wmState.exercises[0].unilateral);
    expect(first).toBe(true); // the seed plan's first exercise is one-sided
    await expect(page.locator('.wmf-log')).toContainText('left');
    await page.locator('.wmf-log').click();
    await expect(page.locator('.wmf-log')).toContainText('right');
    await page.locator('.wmf-log').click();
    expect(await page.evaluate(() => [mTs, mTt])).toEqual([60, 60]);
    await expect(page.locator('#m-rest-of')).toHaveText('of 1:00');
    await expect(page.locator('#m-rest-next')).toBeVisible();
    await closeRest(page);
    await expect(page.locator('.wmf-log')).toContainText('Log set 2');
  });

  test('the steppers change reps and weight in the workout state', async ({
    appPage: page,
    siteURL,
  }) => {
    await start(page, siteURL);
    const before = await page.evaluate(() => wmState.exercises[0].sets[0].reps);
    await page.getByRole('button', { name: 'Increase reps' }).click();
    expect(await page.evaluate(() => wmState.exercises[0].sets[0].reps)).toBe(before + 1);
    const w = await page.evaluate(() => wmState.exercises[0].sets[0].weight);
    await page.getByRole('button', { name: 'Increase weight' }).click();
    expect(await page.evaluate(() => wmState.exercises[0].sets[0].weight)).toBe(w + 2.5);
  });

  test('the rest chips set the exercise rest and the next log uses it', async ({
    appPage: page,
    siteURL,
  }) => {
    await start(page, siteURL);
    await page.getByRole('button', { name: '120s' }).click();
    await page.locator('.wmf-log').click();
    await page.locator('.wmf-log').click();
    expect(await page.evaluate(() => mTt)).toBe(120);
  });

  test('List and One at a time switch views and the choice is remembered', async ({
    appPage: page,
    siteURL,
  }) => {
    await start(page, siteURL);
    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.locator('#wm-body')).toBeVisible();
    await expect(page.locator('#wm-tick-0-0, #wm-tick-0-0-L').first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('hb_wm_view'))).toBe('list');
    await page.getByRole('button', { name: 'One at a time' }).click();
    await expect(page.locator('#wm-focus .wmf-log')).toBeVisible();
  });
});

test.describe('Rest screen', () => {
  test('closes by itself when the timer ends, whether auto-started or started by hand', async ({
    appPage: page,
    siteURL,
  }) => {
    await start(page, siteURL);
    const open = () =>
      page.evaluate(() => document.getElementById('m-timer-modal').classList.contains('open'));
    await page.locator('.wmf-log').click();
    await page.locator('.wmf-log').click();
    expect(await open()).toBe(true);
    await page.evaluate(() => {
      mTs = 2;
    });
    await expect.poll(open, { timeout: 6000 }).toBe(false);
    await page.evaluate(() => {
      mOpenModal('m-timer-modal');
      mTs = 2;
      mTt = 2;
      mTick();
      mToggleTimer();
    });
    expect(await open()).toBe(true);
    await expect.poll(open, { timeout: 6000 }).toBe(false);
  });

  test('+15 s adds time and Skip rest closes it', async ({ appPage: page, siteURL }) => {
    await start(page, siteURL);
    await page.locator('.wmf-log').click();
    await page.locator('.wmf-log').click();
    const t0 = await page.evaluate(() => mTs);
    await page.getByRole('button', { name: 'Add 15 seconds' }).click();
    expect(await page.evaluate(() => mTs)).toBeGreaterThanOrEqual(t0 + 14);
    await page.getByRole('button', { name: 'Skip rest' }).click();
    expect(
      await page.evaluate(() =>
        document.getElementById('m-timer-modal').classList.contains('open'),
      ),
    ).toBe(false);
  });
});
