import { defineConfig, devices } from '@playwright/test';

// Fixed locale and timezone so goldens do not depend on the machine (T1 plan, Q2).
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    locale: 'en-GB',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // WebKit runs only the smoke subset (tagged @smoke); goldens are recorded in Chromium.
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@smoke/ },
  ],
});
