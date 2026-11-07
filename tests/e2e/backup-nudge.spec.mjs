// T8 (simplified): backup nudge on Train, last-backup line and snapshots on Profile -> Data.
import { test, expect, openSeeded, seedStorage, seedData } from './helpers/seed.mjs';

test.describe('backup nudge', () => {
  test('shows when never exported and history is old enough; Snooze hides it', async ({
    appPage,
    siteURL,
  }) => {
    await openSeeded(appPage, siteURL);
    const nudge = appPage.locator('#hb-nudge');
    await expect(nudge).toBeVisible();
    await expect(nudge).toContainText('Back up your data');
    await nudge.getByRole('button', { name: /Remind me in 7 days/ }).click();
    await expect(nudge).toBeHidden();
    const until = await appPage.evaluate(() => Number(localStorage.getItem('hb_backup_snooze')));
    expect(until).toBe(Date.parse('2026-11-01T12:00:00Z') + 7 * 86400000);
  });

  test('hidden when a backup was recorded after the last workout', async ({ appPage, siteURL }) => {
    await openSeeded(appPage, siteURL);
    await expect(appPage.locator('#hb-nudge')).toBeVisible();
    await appPage.evaluate(() => window.HB.storage.markBackup(Date.now()));
    await expect(appPage.locator('#hb-nudge')).toBeHidden();
  });

  test('never shown during an active workout', async ({ appPage, siteURL }) => {
    await seedStorage(appPage, {
      hb_active_workout: JSON.stringify({ exercises: [{ name: 'Squat', sets: [] }] }),
    });
    await openSeeded(appPage, siteURL);
    await expect(appPage.locator('#hb-nudge')).toBeHidden();
  });

  test('no history: no nudge', async ({ appPage, siteURL }) => {
    await openSeeded(appPage, siteURL, { ...seedData(), workouts: [] });
    await expect(appPage.locator('#hb-nudge')).toBeHidden();
  });
});

test.describe('Profile -> Data', () => {
  test('shows last backup and the snapshots section', async ({ appPage, siteURL }) => {
    await openSeeded(appPage, siteURL);
    await appPage.evaluate(() => mShowPage('profile'));
    const card = appPage.locator('#hb-data-card');
    await expect(card).toContainText('Last backup: never');
    await expect(card).toContainText('Automatic snapshots');
    await appPage.evaluate(() => window.HB.storage.markBackup(Date.now()));
    await expect(card).toContainText('Last backup: 1 Nov 2026');
  });
});
