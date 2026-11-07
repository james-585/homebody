// Profile -> Appearance: theme switch and the four-colour accent picker (design canvas, K55).
import { test, expect, openSeeded } from './helpers/seed.mjs';

const accent = (page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  );

test('accent picker changes --accent, survives a reload, and follows the theme', async ({
  appPage,
  siteURL,
}) => {
  await openSeeded(appPage, siteURL);
  await appPage.evaluate(() => mShowPage('profile'));
  expect((await accent(appPage)).toLowerCase()).toBe('#6aa7ff');
  await appPage.getByRole('radio', { name: 'Green' }).click();
  expect((await accent(appPage)).toLowerCase()).toBe('#5dbe8a');
  await expect(appPage.getByRole('radio', { name: 'Green' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await appPage.getByRole('radio', { name: 'Light' }).click();
  expect((await accent(appPage)).toLowerCase()).toBe('#1f7a4a'); // deep ink partner in light
  await appPage.reload();
  await appPage.waitForFunction(() => typeof state !== 'undefined');
  expect((await accent(appPage)).toLowerCase()).toBe('#1f7a4a');
  await appPage.evaluate(() => mShowPage('profile'));
  await appPage.getByRole('radio', { name: 'Blue' }).click();
  expect((await accent(appPage)).toLowerCase()).toBe('#2559a8');
});
