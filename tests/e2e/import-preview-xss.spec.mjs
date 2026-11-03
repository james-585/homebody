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
});
