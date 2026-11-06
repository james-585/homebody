// T7b: refusals and failures (R1 to R5, F1 to F9, M1, M2, C1, W1), text safety, layers, focus, large text,
// reduced motion, contrast, export outcomes, the save bar's rules, offline.
import { readFileSync } from 'node:fs';
import { test, expect, seedStorage } from './helpers/seed.mjs';
import {
  OLD,
  OLD_TEXT,
  REAL,
  REAL_TEXT,
  BAR,
  specCopy,
  openApp,
  io,
  title,
  tap,
  chooseFile,
  previewOf,
  expectNoChooser,
  mirror,
  idbDoc,
  mkDoc,
  mkPlan,
  injectFaults,
  injectHold,
  setFault,
  settled,
} from './helpers/io-ui.mjs';

const C = specCopy();
const one = (key) => C.get(key)[0];
const body = (page) => page.locator('#hb-io-sheet .hb-io-body');
const closeX = (page) => page.locator('#hb-io-sheet .hb-io-close');
const foot = (page) => page.locator('#hb-io-sheet .hb-io-foot button');
const CORRUPT = '{"workouts": [oops';
const FUTURE = JSON.stringify({
  workouts: [{ id: 1, name: 'x', exercises: [] }],
  schemaVersion: 99,
});

async function expectState(page, titleKey, bodyKey, buttons) {
  await expect(title(page)).toHaveText(one(titleKey));
  if (bodyKey)
    await expect(body(page)).toContainText(
      one(bodyKey)
        .replace(/\{\w+\}/g, '')
        .trim()
        .slice(0, 40),
    );
  if (buttons) await expect(foot(page)).toHaveText(buttons);
}
async function unchanged(page, before) {
  expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(before.text);
  expect((await idbDoc(page)).workouts).toHaveLength(before.n);
}
async function snapshotOf(page) {
  return {
    text: await page.evaluate(() => localStorage.getItem('vaultfit_v1')),
    n: (await idbDoc(page)).workouts.length,
  };
}

test.describe('A4: pre-checks refuse before the file picker', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

  test('R1: a workout in progress (both import buttons) @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.evaluate(() =>
      localStorage.setItem(
        'hb_active_workout',
        '{"name":"x","exercises":[{"name":"a","sets":[]}]}',
      ),
    );
    await page.evaluate(() => window.mShowPage('profile'));
    await expect(page.locator('#hb-data-card')).toContainText('Your workout in progress');
    for (const kind of ['import', 'plans']) {
      await expectNoChooser(page, kind);
      await expectState(page, 'io.r.workout.title', 'io.r.workout', []);
      await expect(body(page)).toHaveText(one('io.r.workout'));
      await closeX(page).click();
    }
  });

  for (const [name, seed, expectKey] of [
    ['R2 corrupt', CORRUPT, 'io.r.readonly'],
    ['R2 newer', FUTURE, 'io.r.readonly'],
  ]) {
    test(`${name}: refused with the read-only copy, nothing opens the picker`, async ({
      appPage: page,
      siteURL,
    }) => {
      await openApp(page, siteURL, { data: seed });
      await page.waitForFunction(() => HB.storage.status().state === 'readonly');
      for (const kind of ['import', 'plans']) {
        await expectNoChooser(page, kind);
        await expect(title(page)).toHaveText(one('io.r.readonly.title'));
        await expect(body(page)).toHaveText(one(expectKey));
        await closeX(page).click();
      }
      expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(seed);
    });
  }

  test('R3: the localStorage fallback engine', async ({ appPage: page, siteURL }) => {
    await page.addInitScript(() =>
      Object.defineProperty(window, 'indexedDB', { value: undefined }),
    );
    await openApp(page, siteURL);
    await page.waitForFunction(() => !!HB.storage.status().fallback);
    await expectNoChooser(page, 'import');
    await expect(title(page)).toHaveText(one('io.r.fallback.title'));
    await expect(body(page)).toHaveText(one('io.r.fallback'));
  });

  test('R2 not R4: the storage script never loaded and the bar says so', async ({
    appPage: page,
    siteURL,
  }) => {
    await page.route('**/src/hb-storage.js', (r) => r.abort());
    await seedStorage(page, { vaultfit_v1: OLD_TEXT, hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await expect(page.locator(BAR)).toBeVisible();
    await page.evaluate(() => window.mShowPage('profile'));
    await expectNoChooser(page, 'import');
    await expect(title(page)).toHaveText(one('io.r.readonly.title'));
    await expect(body(page)).toHaveText(one('io.r.readonly'));
  });

  test('R4: while boot is still in progress (13.2)', async ({ appPage: page, siteURL }) => {
    await openApp(page, siteURL);
    await page.evaluate(() => {
      hbLoadedOk = false;
    });
    await expectNoChooser(page, 'import');
    await expect(title(page)).toHaveText(one('io.r.loading.title'));
    await expect(body(page)).toHaveText(one('io.r.loading'));
  });
});

test.describe('A5, A6: a file that cannot be imported changes nothing', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  const cases = [
    ['F2 empty', '', 'io.f.corrupt'],
    ['F2 truncated', '{"_vaultfit":true,"workouts":[', 'io.f.corrupt'],
    ['F3 empty object', '{}', 'io.f.notHb'],
    ['F3 not ours', '{"_vaultfit":false,"workouts":[]}', 'io.f.notHb'],
    ['F3 array', '[]', 'io.f.notHb'],
    ['F4 newer', '{"_vaultfit":true,"_version":99,"workouts":[]}', 'io.f.newer'],
    ['F5 version text', '{"_vaultfit":true,"_version":"2","workouts":[]}', 'io.f.corrupt'],
    ['F5 version fraction', '{"_vaultfit":true,"_version":1.5,"workouts":[]}', 'io.f.corrupt'],
  ];
  for (const [name, text, key] of cases) {
    test(`${name}`, async ({ appPage: page, siteURL }) => {
      await openApp(page, siteURL);
      const before = await snapshotOf(page);
      await chooseFile(page, text);
      const tk = key + '.title';
      await expect(title(page)).toHaveText(one(tk));
      await expect(body(page)).toHaveText(one(key));
      await expect(foot(page)).toHaveCount(0);
      await unchanged(page, before);
    });
  }

  test('F6: a name with markup is refused whole, positions only, no value in the page (A6)', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const before = await snapshotOf(page);
    const d = JSON.parse(mkDoc({ n: 6 }));
    d.workouts[4].name = '<b>ZZVALUEZZ</b>';
    d.workouts[2].exercises[0].sets = 'ZZVALUEZZ';
    d.personalRecords = { ZZKEYZZ: { value: 'ZZVALUEZZ', unit: 'kg' } };
    d.userPlans = [
      { id: 1, name: 'p', planDays: [{ name: 'd', exercises: [{ name: 'x<y', sets: 1 }] }] },
    ];
    await chooseFile(page, JSON.stringify(d));
    await expect(title(page)).toHaveText(one('io.f.invalid.title'));
    await expect(body(page)).toContainText(one('io.f.invalid'));
    const items = await page.locator('#hb-io-sheet .hb-io-list li').allInnerTexts();
    expect(items.length).toBeGreaterThanOrEqual(4);
    const why = [
      "has characters HomeBody doesn't accept, such as < or >",
      'is too long',
      "isn't the right kind of value",
      'is outside the allowed range',
      "isn't a valid date",
      "isn't one of the allowed choices",
      'is missing',
      "uses a name HomeBody can't accept",
      'has too many entries',
    ].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(
      `^(File details|Workout \\d+|Personal record \\d+|Body measurement \\d+|Plan \\d+|Favourite \\d+|Profile|Progress history \\d+|Workouts|Body measurements|Personal records|Plans|Favourites|Exercises in workout \\d+)( · [a-z][a-z ()0-9A-Z]*)*: (${why.join('|')})$`,
    );
    for (const it of items) expect(it, it).toMatch(re);
    expect(items).toContain(
      "Workout 5 · name: has characters HomeBody doesn't accept, such as < or >",
    );
    expect(items.some((i) => i.startsWith('Workout 3 · exercise 1'))).toBe(true);
    expect(items.some((i) => i.startsWith('Personal record 1 · value'))).toBe(true);
    const html = await page.content();
    expect(html).not.toContain('ZZVALUEZZ');
    expect(html).not.toContain('ZZKEYZZ');
    await unchanged(page, before);
  });

  test('F1: a file over 20 MB is refused before it is read', async ({ appPage: page, siteURL }) => {
    await openApp(page, siteURL);
    const before = await snapshotOf(page);
    await page.evaluate(() => {
      window.__read = false;
      const o = FileReader.prototype.readAsText;
      FileReader.prototype.readAsText = function () {
        window.__read = true;
        return o.apply(this, arguments);
      };
    });
    await chooseFile(page, {
      name: 'big.vaultfit',
      mimeType: 'application/json',
      buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 32),
    });
    await expect(title(page)).toHaveText(one('io.f.big.title'));
    await expect(body(page)).toHaveText(
      'HomeBody can import backups up to 20 MB. This file is 20.0 MB. Nothing was changed.',
    );
    expect(await page.evaluate(() => window.__read)).toBe(false);
    await unchanged(page, before);
  });

  test('F8: the browser cannot read the file', async ({ appPage: page, siteURL }) => {
    await openApp(page, siteURL);
    const before = await snapshotOf(page);
    await page.evaluate(() => {
      FileReader.prototype.readAsText = function () {
        setTimeout(() => this.onerror && this.onerror(new Event('error')), 0);
      };
    });
    await chooseFile(page, mkDoc({ n: 1 }));
    await expect(title(page)).toHaveText(one('io.f.read.title'));
    await expect(body(page)).toHaveText(one('io.f.read'));
    await unchanged(page, before);
  });

  test('a large file shows reading progress; Cancel leaves everything as it was', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const before = await snapshotOf(page);
    // hold the read open so the I2 state can be looked at
    await page.evaluate(() => {
      FileReader.prototype.readAsText = function () {
        const self = this;
        setTimeout(() => {
          self.onprogress &&
            self.onprogress({ lengthComputable: true, loaded: 5 * 1048576, total: 12 * 1048576 });
        }, 20);
      };
    });
    const d = Buffer.alloc(12 * 1024 * 1024, 32);
    await chooseFile(page, { name: 'big.vaultfit', mimeType: 'application/json', buffer: d });
    await expect(title(page)).toHaveText('Checking file');
    await expect(body(page)).toContainText('Reading 5.0 of 12.0 MB');
    const bar = page.locator('#hb-io-sheet [role=progressbar]');
    await expect(bar).toHaveAttribute('aria-valuenow', '42');
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
    await expect(body(page)).toContainText('Nothing has been changed.');
    // no animated element in this state
    const animated = await page.evaluate(
      () =>
        [...document.querySelectorAll('#hb-io-sheet .hb-io-body *')].filter(
          (e) => getComputedStyle(e).animationName !== 'none',
        ).length,
    );
    expect(animated).toBe(0);
    await foot(page).click(); // Cancel
    await expect(page.locator('#hb-io-sheet')).toBeHidden();
    await unchanged(page, before);
  });
});

test.describe('A7, A8, A9: modules, another tab, a failed write', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('A7: a module that will not load refuses with its copy and never reaches an older path', async ({
    appPage: page,
    siteURL,
  }) => {
    await page.route('**/src/storage/import-export.js', (r) => r.abort());
    await injectFaults(page);
    await openApp(page, siteURL);
    const before = await snapshotOf(page);
    await chooseFile(page, mkDoc({ n: 1 }));
    await expect(title(page)).toHaveText(one('io.m.load.title'));
    await expect(body(page)).toHaveText(one('io.m.load'));
    await expect(foot(page)).toHaveText(['Reload']);
    // the shipped import functions are gone
    for (const f of ['mConfirmImport', 'mShowImportConfirm', 'mImportPlanOnly', 'mImportData']) {
      expect(await page.evaluate((n) => typeof window[n], f)).toBe('undefined');
    }
    await unchanged(page, before);
    // a save fails while this is open: Reload waits (it would lose the unsaved change)
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4242,
        name: 'Unsaved',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await expect(page.locator(BAR)).toBeVisible();
    const reload = page.locator('#hb-io-reload');
    await expect(reload).toHaveText('Waiting to save…');
    await expect(reload).toHaveAttribute('aria-disabled', 'true');
    await page.evaluate(() => (window.__marker = 1));
    await reload.click({ force: true });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__marker)).toBe(1); // still the same page
    await setFault(page, { main: false });
    await page.locator(`${BAR} button`, { hasText: 'Retry' }).click();
    await expect(reload).toHaveText('Reload', { timeout: 6000 });
  });

  test('A7: version skew shows the reload copy', async ({ appPage: page, siteURL }) => {
    await page.route('**/src/storage/validate.js', async (route) => {
      const res = await route.fetch();
      const t = (await res.text()).replace(
        'export const IO_API_VERSION = 1;',
        'export const IO_API_VERSION = 2;',
      );
      await route.fulfill({ response: res, body: t });
    });
    await openApp(page, siteURL);
    await chooseFile(page, mkDoc({ n: 1 }));
    await expect(title(page)).toHaveText(one('io.m.skew.title'));
    await expect(body(page)).toHaveText(one('io.m.skew'));
  });

  test('A8: another tab commits while the import reads: C1, then Check again shows fresh numbers', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectHold(page);
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 2 }));
    await expect(page.locator('.hb-io-rowitem').first()).toContainText('2 in file · 2 new');
    // the apply reads the store; a second tab commits while that read is outstanding
    await page.evaluate(() => window.__readGateOn());
    await page.locator('#hb-io-primary').click();
    await expect(page.locator('#hb-io-primary')).toHaveText('Importing…');
    const p2 = await page.context().newPage();
    await seedStorage(p2, { hb_seen_guide: '1' });
    await p2.goto(siteURL + 'index.html');
    await p2.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await p2.evaluate(() => HB.storage.ready());
    await p2.evaluate(async () => {
      state.workouts.unshift({
        id: 31337,
        name: 'From tab two',
        date: new Date().toISOString(),
        exercises: [],
      });
      await persistSave();
    });
    await p2.close();
    await page.evaluate(() => window.__readRelease());
    await expect(title(page)).toHaveText(one('io.chg.title'));
    await expect(body(page)).toHaveText(one('io.chg.body'));
    await expect(foot(page)).toHaveText(['Check again']);
    expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length); // nothing imported
    await foot(page).last().click();
    await expect(title(page)).toHaveText(one('io.prev.title'));
    await expect(page.locator('#hb-io-sheet input[value=merge]')).toBeChecked();
    await expect(page.locator('.hb-io-rowitem').first()).toContainText('2 in file · 2 new');
    expect((await idbDoc(page)).workouts.map((w) => w.name)).toContain('From tab two');
    expect((await idbDoc(page)).snaps).not.toContain('pre-import');
  });

  test('A35a: the preview said there was something to add, but another tab imported it first: nothing is applied and state is untouched', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const doc = mkDoc({ n: 2 });
    await previewOf(page, doc);
    await page.evaluate(() => {
      window.__w = state.workouts; // the very array state holds now
    });
    const p2 = await page.context().newPage();
    await seedStorage(p2, { hb_seen_guide: '1' });
    await p2.goto(siteURL + 'index.html');
    await p2.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await p2.evaluate(() => HB.storage.ready());
    await p2.evaluate(async (t) => {
      const imp = await HB.io.importFile(new File([t], 'x.vaultfit'));
      await imp.apply({ mode: 'merge' });
    }, doc);
    await p2.close();
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText(one('io.prev.title'));
    await expect(body(page)).toHaveText(one('io.sum.mergeNothing'));
    await expect(foot(page)).toHaveText(['Done']);
    expect(await page.evaluate(() => window.__w === state.workouts)).toBe(true); // same object: not replaced from r.doc
    expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length);
    await expect(page.locator('#hb-data-card .hb-io-undo-row')).toHaveCount(0); // nothing was imported here
  });

  test('A9: a quota failure at apply shows W1; the store stays writable; Try again finishes it', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    const before = await snapshotOf(page);
    await previewOf(page, mkDoc({ n: 2 }));
    await setFault(page, { main: true });
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText(one('io.w.title'));
    await expect(body(page)).toHaveText(one('io.w.quota'));
    await expect(foot(page)).toHaveText(['Try again']);
    await setFault(page, { main: false });
    expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length);
    await unchanged(page, before);
    // writable afterwards: a normal save works
    expect(
      await page.evaluate(() =>
        persistSave().then(
          () => 'saved',
          () => 'failed',
        ),
      ),
    ).toBe('saved');
    await foot(page).last().click(); // Try again
    await expect(title(page)).toHaveText('Import done');
    expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length + 2);
  });

  test('F9: Check again after the file is let go shows the choose-again state', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 1 }));
    // the same handle, disposed behind the sheet's back (what closing the sheet does)
    const kind = await page.evaluate(async () => {
      const f = new File([JSON.stringify({ _vaultfit: true, workouts: [] })], 'y.vaultfit');
      const imp = await HB.io.importFile(f);
      imp.dispose();
      try {
        await imp.recheck();
      } catch (e) {
        return e.kind;
      }
      return 'no error';
    });
    expect(kind).toBe('consumed');
  });
});

test.describe('A20 to A23: imported text is data', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  const NAMES = [
    '&#39;);window.__x=1;//',
    'it\'s "quoted" \\ back`tick`',
    'x'.repeat(500),
    'שלום עולם '.repeat(8),
    '👍🏽'.repeat(45),
  ];

  test('hostile-looking names render as clipped text; nothing runs; no toast or log carries them', async ({
    appPage: page,
    siteURL,
  }) => {
    await page.addInitScript(() => {
      window.__logs = [];
      for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
        const o = console[k];
        console[k] = (...a) => {
          window.__logs.push(a.map(String).join(' '));
          return o.apply(console, a);
        };
      }
      window.__toasts = [];
    });
    await openApp(page, siteURL);
    await page.evaluate(() => {
      const o = window.mToast;
      window.mToast = (m, t) => {
        window.__toasts.push(String(m));
        return o(m, t);
      };
    });
    const d = JSON.parse(mkDoc({ n: 1 }));
    d.profile = { name: NAMES[0], goal: 'build_muscle' };
    d.userPlans = NAMES.map((n, i) => ({ ...mkPlan(7000 + i, n, 1) }));
    d.userPlans[0].name = NAMES[1];
    d.userPlans[1].name = NAMES[2];
    d.userPlans[2].name = NAMES[3];
    d.userPlans[3].name = NAMES[4];
    d.userPlans[4].name = NAMES[0];
    const text = JSON.stringify(d);
    await previewOf(page, text);
    await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click();
    const names = await page
      .locator('#hb-io-sheet .hb-io-name')
      .evaluateAll((e) => e.map((x) => ({ t: x.textContent, d: x.getAttribute('dir') })));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.d).toBe('auto');
    // profile name is the first
    expect(names.some((n) => n.t === NAMES[0])).toBe(true);
    await page.locator('#hb-io-sheet .hb-io-foot button').first().click(); // Cancel
    await page.evaluate(() => window.mShowPage('profile'));
    await chooseFile(page, text, 'plans');
    await expect(title(page)).toHaveText('Add plans');
    const pn = await page
      .locator('#hb-io-sheet .hb-io-rowname .hb-io-name')
      .evaluateAll((e) => e.map((x) => x.textContent));
    expect(pn).toHaveLength(5);
    const seg = await page.evaluate((arr) => {
      const sg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return arr.map((s) => [...sg.segment(s.replace(/…$/, ''))].length);
    }, pn);
    for (const n of seg) expect(n).toBeLessThanOrEqual(40);
    expect(pn[1]).toBe('x'.repeat(40) + '…'); // 500 characters, clipped (the validator's cap for a name)
    expect(pn[3]).toBe('👍🏽'.repeat(40) + '…'); // 40 graphemes, never mid-emoji
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText('Plans added');
    // nothing ran, nothing was made, no attribute carries a name, no toast or log either
    expect(await page.evaluate(() => window.__x)).toBeUndefined();
    expect(await page.locator('#hb-io-sheet img, #hb-data-card img').count()).toBe(0);
    const attrs = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .flatMap((e) => [...e.attributes].map((a) => a.value))
        .filter((v) => v.includes('__x') || v.includes('quoted')),
    );
    expect(attrs).toEqual([]);
    const toasts = await page.evaluate(() => window.__toasts);
    for (const t of toasts) {
      expect(t).not.toContain('__x');
      expect(t).not.toContain('quoted');
    }
    const logs = await page.evaluate(() => window.__logs);
    for (const l of logs) expect(l).not.toContain('__x');
    // the stored plan keeps the whole name as data
    expect(await page.evaluate(() => state.userPlans.some((p) => p.name === 'x'.repeat(500)))).toBe(
      true,
    );
  });

  test('A35c: unrecognised settings import, show the fixed label, and add no class or id', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const baseline = await page.evaluate(() => {
      const bad = ['constructor', 'hidden', 'prototype', 'active'];
      return {
        hits: [...document.querySelectorAll('body *')].filter((e) =>
          bad.some((b) => String(e.className).split(/\s+/).includes(b) || e.id === b),
        ).length,
      };
    });
    const d = JSON.parse(mkDoc({ n: 1 }));
    d.profile = { name: 'T', goal: 'constructor', sex: 'hidden', activity: 'prototype' };
    d.userPlans = [{ ...mkPlan(8100, 'Odd level', 1), level: 'active' }];
    await previewOf(page, JSON.stringify(d));
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText('Import done');
    await page.locator('#hb-io-sheet .hb-io-foot button').click();
    await page.evaluate(() => window.mShowPage('plans'));
    await page.evaluate(() => window.mRenderMyPlans());
    const r = await page.evaluate(() => {
      const bad = ['constructor', 'hidden', 'prototype', 'active'];
      const hits = [...document.querySelectorAll('body *')].filter((e) =>
        bad.some(
          (b) =>
            String(e.className).split(/\s+/).includes(b) ||
            e.id === b ||
            e.getAttribute('data-x') === b,
        ),
      ).length;
      return {
        hits,
        sub: document.getElementById('hm-sub').textContent,
        badge: [...document.querySelectorAll('#m-browse-mine .plan-level-badge')].map(
          (b) => b.textContent,
        ),
      };
    });
    expect(r.hits).toBe(baseline.hits); // the same elements as before the import: no new class or id
    expect(r.sub).toBe('Ready to train?'); // 13.1: the home subtitle never shows the token or the unknown label
    expect(r.badge).toContain(one('io.enum.unknown'));
  });
});

test.describe('layout, focus, layers (A24 to A30)', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

  test('A24, A26, A27: the sheet sits above the FAB; focus, Escape and roles @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await previewOf(page, REAL_TEXT);
    await expect(title(page)).toBeFocused();
    expect(
      await page.evaluate(() => getComputedStyle(document.getElementById('hb-io-sheet')).zIndex),
    ).toBe('9800');
    expect(await page.evaluate(() => document.querySelector('.app').inert)).toBe(true);
    // a real tap at 92% across the primary lands on it, not on the FAB under the scrim (K23)
    await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click();
    const pb = await page.locator('#hb-io-primary').boundingBox();
    await page.touchscreen.tap(pb.x + pb.width * 0.92, pb.y + pb.height / 2);
    await expect(page.locator('#hb-io-dlg')).toContainText(one('io.rep.title'));
    expect(
      await page.evaluate(() => document.querySelector('#m-fab-tray .m-fab-child')?.style.opacity),
    ).not.toBe('1');
    await page.keyboard.press('Escape');
    await expect(page.locator('#hb-io-dlg')).toBeHidden();
    await expect(page.locator('#hb-io-primary')).toBeFocused();
    // no alert role and no assertive live region anywhere in the UI
    expect(
      await page
        .locator(
          '#hb-io-sheet [role=alert], #hb-io-dlg [role=alert], #hb-data-card [role=alert], #hb-io-sheet [aria-live=assertive]',
        )
        .count(),
    ).toBe(0);
    // Escape closes a preview and focus returns to the opener, never to <body>
    await page.keyboard.press('Escape');
    await expect(page.locator('#hb-io-sheet')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement.getAttribute('data-io'))).toBe(
      'import',
    );
    // the sheet is gone from the page: no file name or count left in the DOM
    expect(await page.locator('#hb-io-sheet .hb-io-body').innerHTML()).toBe('');
  });

  test('A25: with the save bar showing the sheet starts below it and nothing sits under the bar', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4242,
        name: 'Unsaved',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await expect(page.locator(BAR)).toBeVisible();
    await io(page, 'import').click();
    await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
    const bar = await page.locator(BAR).boundingBox();
    const top = await page.locator('.hb-io-panel').boundingBox();
    expect(top.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    const strays = await page.evaluate((r) => {
      const b = document.getElementById('hb-save');
      const bad = [];
      for (let y = 4; y < r.y + r.height; y += 12)
        for (let x = 4; x < innerWidth; x += 12)
          if (!b.contains(document.elementFromPoint(x, y))) bad.push([x, y]);
      return bad;
    }, bar);
    expect(strays).toEqual([]);
  });

  test('A34: R5 while a save has failed: the bar stays tappable, Export keeps the edit, Saved is announced', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    const before = await snapshotOf(page);
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4242,
        name: 'Unsaved Probe',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await expect(page.locator(BAR)).toBeVisible();
    for (const kind of ['import', 'plans']) {
      await expectNoChooser(page, kind);
      await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
      await expect(body(page)).toHaveText(one('io.r.unsaved'));
      await expect(foot(page)).toHaveText(['Export backup']);
      if (kind === 'import') {
        // Export backup downloads the unsaved edit and R5 stays open
        const [dl] = await Promise.all([page.waitForEvent('download'), foot(page).last().click()]);
        expect(readFileSync(await dl.path(), 'utf8')).toContain('Unsaved Probe');
        await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
        break;
      }
    }
    expect(await page.locator('#hb-io-sheet button', { hasText: 'Retry' }).count()).toBe(0);
    expect(await page.locator('#hb-io-sheet [role=alert]').count()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1') !== null)).toBe(true);
    // the bar is neither inert nor under the scrim: a real tap on Retry works
    await setFault(page, { main: false });
    const retry = page.locator(`${BAR} button`, { hasText: 'Retry' });
    await tap(page, retry);
    await expect(body(page)).toContainText(one('io.r.unsaved.nowSaved'));
    await expect(page.locator('#hb-io-status')).toHaveText(one('io.r.unsaved.nowSaved'));
    expect((await idbDoc(page)).workouts).toHaveLength(before.n + 1);
  });

  test('A34: no bar showing: the "no bar" wording', async ({ appPage: page, siteURL }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4243,
        name: 'Unsaved',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await expect(page.locator(BAR)).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.remove('hb-save-on'));
    await io(page, 'import').click();
    await expect(body(page)).toHaveText(one('io.r.unsavedNoBar'));
  });

  test('A34: a save fails between the preview and Import: R5 at apply, the edit stays in memory', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 2 }));
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4244,
        name: 'Edit in memory',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
    expect(await page.evaluate(() => state.workouts.map((w) => w.name))).toContain(
      'Edit in memory',
    );
    expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length + 1);
    await setFault(page, { main: false });
    await page.locator(`${BAR} button`, { hasText: 'Retry' }).click();
    await expect
      .poll(async () => (await idbDoc(page)).workouts.length)
      .toBe(OLD.workouts.length + 1);
  });

  test('A28: 200% text: the footer stays visible, stacked with the primary lowest, targets at least 48', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.addStyleTag({
      content: 'html{font-size:200% !important}.toast-container{display:none}',
    });
    for (const vp of [
      { width: 375, height: 667 },
      { width: 812, height: 375 },
    ]) {
      await page.setViewportSize(vp);
      await previewOf(page, REAL_TEXT);
      await settled(page);
      const info = await page.evaluate(() => {
        const f = [...document.querySelectorAll('#hb-io-sheet .hb-io-foot button')].map((b) => {
          const r = b.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, h: r.height, left: r.left, right: r.right };
        });
        return { f, vh: window.innerHeight, vw: innerWidth };
      });
      for (const b of info.f) {
        expect(b.h).toBeGreaterThanOrEqual(48);
        expect(b.bottom).toBeLessThanOrEqual(info.vh + 1);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(info.vw + 1);
      }
      // side by side (primary on the right) or stacked (primary lowest): never a wrapped label inside a button
      if (Math.abs(info.f[1].top - info.f[0].top) < 2)
        expect(info.f[1].left).toBeGreaterThan(info.f[0].left);
      else expect(info.f[1].top).toBeGreaterThan(info.f[0].top);
      // a real tap at 85% across each footer button lands on that button (the FAB is under the scrim)
      const hits = await page.evaluate(() =>
        [...document.querySelectorAll('#hb-io-sheet .hb-io-foot button')].map((b) => {
          const r = b.getBoundingClientRect();
          const el = document.elementFromPoint(r.left + r.width * 0.85, r.top + r.height / 2);
          return b.contains(el);
        }),
      );
      expect(hits).toEqual([true, true]);
      await page.locator('#hb-io-sheet .hb-io-foot button').first().click();
      await page.evaluate(() => window.mShowPage('profile'));
    }
  });

  test('A29: reduced motion: no animation on the sheet or the dialog', async ({
    appPage: page,
    siteURL,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, siteURL);
    await previewOf(page, REAL_TEXT);
    await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click();
    await page.locator('#hb-io-primary').click();
    const r = await page.evaluate(() => ({
      sheet: getComputedStyle(document.querySelector('.hb-io-panel')).animationName,
      dlg: getComputedStyle(document.querySelector('.hb-io-dlg')).animationName,
      bar: getComputedStyle(document.querySelector('.hb-io-prog-fill') || document.body)
        .transitionDuration,
    }));
    expect(r.sheet).toBe('none');
    expect(r.dlg).toBe('none');
  });

  for (const theme of ['dark', 'light']) {
    test(`A30: contrast of the sheet, buttons, markers and the danger confirm (${theme})`, async ({
      appPage: page,
      siteURL,
    }) => {
      await openApp(page, siteURL);
      if (theme === 'light')
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await previewOf(page, REAL_TEXT);
      await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click();
      await page.locator('#hb-io-primary').click();
      const res = await page.evaluate(() => {
        const lum = (c) => {
          const [r, g, b] = c
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map((v) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (x + 0.05) / (y + 0.05);
        };
        const bgOf = (el) => {
          for (let e = el; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor;
            if (c && !/rgba\(.*, 0\)|transparent/.test(c)) return c;
          }
          return 'rgb(0,0,0)';
        };
        const pair = (sel) => {
          const el = document.querySelector(sel);
          const cs = getComputedStyle(el);
          return ratio(cs.color, bgOf(el));
        };
        const edge = (sel, prop) => {
          const el = document.querySelector(sel);
          return ratio(
            getComputedStyle(el)[prop],
            getComputedStyle(document.querySelector('.hb-io-panel')).backgroundColor,
          );
        };
        return {
          title: pair('#hb-io-title'),
          body: pair('#hb-io-summary'),
          secondary: pair('#hb-io-sheet .hb-io-foot .btn-secondary'),
          primary: pair('#hb-io-primary'),
          danger: pair('#hb-io-dlg .hb-io-danger'),
          dlgText: pair('#hb-io-dlg-desc p'),
          optEdge: edge('.hb-io-opt:not(.sel)', 'borderTopColor'),
          selEdge: edge('.hb-io-opt.sel', 'borderTopColor'),
          mark: edge('.hb-io-danger-row .hb-io-mk, .hb-io-opt .hb-io-mk', 'borderTopColor'),
        };
      });
      expect(res.title).toBeGreaterThanOrEqual(4.5);
      expect(res.body).toBeGreaterThanOrEqual(4.5);
      expect(res.secondary).toBeGreaterThanOrEqual(4.5);
      expect(res.primary).toBeGreaterThanOrEqual(4.5);
      expect(res.danger).toBeGreaterThanOrEqual(4.5);
      expect(res.dlgText).toBeGreaterThanOrEqual(4.5);
      expect(res.optEdge).toBeGreaterThanOrEqual(3);
      expect(res.selEdge).toBeGreaterThanOrEqual(3);
      expect(res.mark).toBeGreaterThanOrEqual(3);
    });
  }
});

test.describe('export outcomes (A3, A33, 5.2 to 5.5)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  for (const [seed, label] of [
    [CORRUPT, 'unreadable'],
    [FUTURE, 'newer'],
  ]) {
    test(`A3: ${label} data: the bar and the card say "Export this session" and the file is partial`, async ({
      appPage: page,
      siteURL,
    }) => {
      await openApp(page, siteURL, { data: seed });
      await page.waitForFunction(() => HB.storage.status().state === 'readonly');
      await expect(page.locator(`${BAR} button:visible`)).toHaveText([
        'Export saved file',
        'Export this session',
      ]);
      const text = await page.locator('#hb-data-card').innerText();
      expect(text).toContain(one('io.card.rawNote'));
      await expect(page.locator('#hb-data-card [data-io=raw]')).toHaveText('Export saved file');
      expect(await page.locator('#hb-data-card [data-io=export]').textContent()).toBe(
        'Export this session',
      );
      const [dl] = await Promise.all([page.waitForEvent('download'), io(page, 'export').click()]);
      expect(dl.suggestedFilename()).toMatch(/^HomeBody_partial_\d{4}-\d{2}-\d{2}\.vaultfit$/);
      const f = JSON.parse(readFileSync(await dl.path(), 'utf8'));
      expect(f._partial).toBe(true);
      expect(f._partialReason).toBe(label);
      await expect(page.locator('.m-toast', { hasText: one('io.xp.toast') }).first()).toBeVisible();
      // the bar's own button does the same, by real touch
      const [dl2] = await Promise.all([
        page.waitForEvent('download'),
        tap(page, page.locator(`${BAR} button`, { hasText: 'Export this session' })),
      ]);
      expect(dl2.suggestedFilename()).toMatch(/^HomeBody_partial_/);
      // the raw as-found file carries the health-data label
      const [dl3] = await Promise.all([page.waitForEvent('download'), io(page, 'raw').click()]);
      expect(dl3.suggestedFilename()).toBe('homebody-saved-data-as-found.txt');
      await expect(
        page.locator('.m-toast', { hasText: one('io.raw.toast') }).first(),
      ).toBeVisible();
      await expect(page.locator('#hb-io-status')).toHaveText(one('io.raw.toast'));
      // Import and Import plans only stay tappable and show the read-only refusal
      await expectNoChooser(page, 'import');
      await expect(title(page)).toHaveText(one('io.r.readonly.title'));
    });
  }

  test('A3: bar states 2 and 4 keep the label "Export"', async ({ appPage: page, siteURL }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4245,
        name: 'U',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await expect(page.locator(`${BAR} button:visible`)).toHaveText(['Retry', 'Export']);
    await setFault(page, { main: false });
    await page.locator(`${BAR} button`, { hasText: 'Retry' }).click();
    await expect(page.locator(BAR)).toContainText('Everything is saved on this device.');
  });

  test('5.2: entries the importer would refuse: the file still downloads, the sheet lists positions', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.evaluate(() => {
      state.workouts[1].name = 'a<b';
      state.workouts[0].notes = 'n'.repeat(30000);
    });
    const [dl] = await Promise.all([page.waitForEvent('download'), io(page, 'export').click()]);
    expect(dl.suggestedFilename()).toMatch(/^HomeBody_\d{4}/);
    await expect(title(page)).toHaveText(one('io.xw.title'));
    await expect(body(page)).toContainText('Your backup was saved, but 2 entries in it');
    const items = await page.locator('#hb-io-sheet .hb-io-list li').allInnerTexts();
    expect(items).toEqual(
      expect.arrayContaining([
        "Workout 2 · name: has characters HomeBody doesn't accept, such as < or >",
        'Workout 1 · notes: is too long',
      ]),
    );
    await expect(foot(page)).toHaveText(['Done']);
    await foot(page).click();
    // during a workout the sheet is not shown: a toast only, and the card offers the details afterwards
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'wm-overlay';
      document.body.append(d);
    });
    await Promise.all([page.waitForEvent('download'), io(page, 'export').click()]);
    await expect(
      page.locator('.m-toast', { hasText: one('io.xw.toastWorkout') }).first(),
    ).toBeVisible();
    await expect(page.locator('#hb-io-sheet')).toBeHidden();
    await page.evaluate(() => document.getElementById('wm-overlay').remove());
    await page.evaluate(() => window.mShowPage('profile'));
    await expect(page.locator('#hb-data-card')).toContainText(one('io.card.lastExportWarn'));
    await io(page, 'seedetails').click();
    await expect(title(page)).toHaveText(one('io.xw.title'));
  });

  test('A33: too large: a sheet first, then one text file named HomeBody_full_<date>.txt with the full export', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.evaluate(() => {
      state.workouts = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        name: 'w',
        date: '2026-10-01T00:00:00.000Z',
        exercises: [],
        notes: 'x'.repeat(800000),
      }));
    });
    let downloads = 0;
    page.on('download', () => downloads++);
    await io(page, 'export').click();
    await expect(title(page)).toHaveText(one('io.xc.title'));
    await expect(body(page)).toContainText(one('io.xc.body'));
    await expect(body(page)).toContainText(one('io.health.short'));
    expect(downloads).toBe(0);
    const [dl] = await Promise.all([page.waitForEvent('download'), foot(page).last().click()]);
    expect(dl.suggestedFilename()).toMatch(/^HomeBody_full_\d{4}-\d{2}-\d{2}\.txt$/);
    const full = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    expect(full._vaultfit).toBe(true);
    expect(full._version).toBe(2);
    expect(full._containsHealthData).toBe(true);
    expect(full.workouts).toHaveLength(30);
    expect(full.profile).toEqual(await page.evaluate(() => state.profile));
    await expect(page.locator('.m-toast', { hasText: one('io.xc.toastSaved') })).toHaveCount(1);
    await expect(page.locator('#hb-io-sheet')).toBeHidden();
    expect(downloads).toBe(1);
  });

  test('XM1: no module and no store: the sheet offers the saved file', async ({
    appPage: page,
    siteURL,
  }) => {
    await page.route('**/src/hb-storage.js', (r) => r.abort());
    await seedStorage(page, { vaultfit_v1: OLD_TEXT, hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await expect(page.locator(BAR)).toBeVisible();
    await page.locator(`${BAR} button`, { hasText: 'Export this session' }).click();
    await expect(title(page)).toHaveText(one('io.m.loadExport.title'));
    await expect(body(page)).toContainText(one('io.m.loadExport'));
    await expect(body(page).getByRole('button', { name: 'Export saved file' })).toBeVisible();
    await expect(foot(page)).toHaveText(['Reload']);
  });
});

test.describe('A36, A38: Undo refusals and the save bar for deliberate locks', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  async function imported(page, siteURL, mutate) {
    await injectFaults(page);
    await injectHold(page);
    await openApp(page, siteURL);
    if (mutate) await mutate();
    await previewOf(page, mkDoc({ n: 2 }));
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText('Import done');
  }

  test('A36: Undo is refused while a save has failed: neither confirm opens, nothing changes', async ({
    appPage: page,
    siteURL,
  }) => {
    await imported(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4246,
        name: 'Unsaved',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await expect(page.locator(BAR)).toBeVisible();
    const n = await page.evaluate(() => state.workouts.length);
    await page.locator('#hb-io-sheet .hb-io-body [data-io=undo]').click();
    await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
    await expect(body(page)).toHaveText(one('io.uf.unsaved'));
    await expect(page.locator('#hb-io-dlg')).toBeHidden();
    await expect(foot(page)).toHaveText(['Export backup']);
    expect(await page.evaluate(() => state.workouts.length)).toBe(n);
    await setFault(page, { main: false });
    await page
      .locator(`${BAR} button`, { hasText: 'Retry' })
      .click({ timeout: 1500 })
      .catch(() => {}); // or the store's own retry got there first
    await expect(body(page)).toContainText(one('io.uf.unsaved.nowSaved'));
    await closeX(page).click();
    await expect(page.locator('#hb-data-card .hb-io-undo-row')).toBeVisible(); // the row stays
  });

  test('A36: a save fails after the confirm opened: restore refuses, UF5, nothing undone', async ({
    appPage: page,
    siteURL,
  }) => {
    await imported(page, siteURL);
    await foot(page).click(); // Done
    await io(page, 'undo').click();
    await expect(page.locator('#hb-io-dlg')).toContainText('Undo the import?');
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4247,
        name: 'Late edit',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await page.locator('#hb-io-dlg .hb-io-danger').click();
    await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
    await expect(body(page)).toHaveText(one('io.uf.unsaved'));
    expect(await page.evaluate(() => state.workouts.map((w) => w.name))).toContain('Late edit');
    expect(await page.evaluate(() => window.HB.storage.status().state)).not.toBe('readonly');
  });

  test('A38a: after Undo (store locked on purpose) the bar stays away and never announces', async ({
    appPage: page,
    siteURL,
  }) => {
    await imported(page, siteURL);
    await page.locator('#hb-io-sheet .hb-io-body [data-io=undo]').click();
    await page.locator('#hb-io-dlg .hb-io-danger').click();
    await expect(title(page)).toHaveText('Import undone');
    await expect(title(page)).toBeFocused();
    const r = await page.evaluate(() => ({
      on: document.documentElement.classList.contains('hb-save-on'),
      h: getComputedStyle(document.documentElement).getPropertyValue('--hb-bar-h').trim(),
      shown: getComputedStyle(document.getElementById('hb-save')).visibility,
      alert: document.querySelector('[role=alert].hb-sr').textContent,
      status: document.querySelector('[role=status].hb-sr').textContent,
      kind: HB.storage.status().state,
    }));
    expect(r).toEqual({
      on: false,
      h: '0px',
      shown: 'hidden',
      alert: '',
      status: '',
      kind: 'readonly',
    });
    // another path reaching the store before Restart: R2b, and the card is back to its normal labels
    await expect(page.locator('#hb-data-card [data-io=export]')).toHaveText('Export backup');
  });

  test('A38b: during an apply (importing) and an undo (restoring) the bar is absent and nothing moves', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectFaults(page);
    await injectHold(page);
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 2 }));
    await page.evaluate(() => window.__holdOn());
    await page.locator('#hb-io-primary').click();
    await expect(page.locator('#hb-io-primary')).toHaveText('Importing…');
    await settled(page);
    const top0 = (await page.locator('.hb-io-panel').boundingBox()).y;
    await expect(page.locator('#hb-io-primary')).toHaveAttribute('aria-disabled', 'true');
    // Escape, scrim and Close do nothing; no Check again control exists
    await page.keyboard.press('Escape');
    await page.locator('#hb-io-sheet').click({ position: { x: 5, y: 5 }, force: true });
    await page.locator('.hb-io-close').click({ force: true });
    await expect(page.locator('#hb-io-sheet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check again' })).toHaveCount(0);
    await expect(body(page)).toContainText(one('io.apply.keepOpen'));
    expect(await page.locator(BAR).evaluate((e) => getComputedStyle(e).visibility)).toBe('hidden');
    await page.waitForTimeout(300);
    const top1 = (await page.locator('.hb-io-panel').boundingBox()).y;
    expect(Math.abs(top1 - top0)).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.__release());
    await expect(title(page)).toHaveText('Import done');
    // undo, held
    await page.evaluate(() => window.__holdOn());
    await page.locator('#hb-io-sheet .hb-io-body [data-io=undo]').click();
    await page.locator('#hb-io-dlg .hb-io-danger').click();
    await expect(title(page)).toHaveText(one('io.undoing.title'));
    await page.keyboard.press('Escape');
    await expect(page.locator('#hb-io-sheet')).toBeVisible();
    expect(await page.locator(BAR).evaluate((e) => getComputedStyle(e).visibility)).toBe('hidden');
    await page.evaluate(() => window.__release());
    await expect(title(page)).toHaveText('Import undone');
  });

  test('A38c, d: an import that finds newer data locks the store: bar state 7 and the R2 sheet', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 1 }));
    // another version wrote a newer schema while the preview was open
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const r = globalThis.indexedDB.open('homebody');
          r.onsuccess = () => {
            const db = r.result;
            const tx = db.transaction('meta', 'readwrite');
            tx.objectStore('meta').put(99, 'schemaVersion');
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText(one('io.r.readonly.title'));
    await expect(body(page)).toHaveText(one('io.r.readonly'));
    await expect(page.locator(BAR)).toBeVisible();
    await expect(page.locator(BAR)).toContainText('Saved by a newer version');
    // the alert was written once
    await expect(page.locator('[role=alert].hb-sr')).toHaveText(/Saved by a newer version\./);
  });
});

test.describe('offline (A32)', () => {
  test.use({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });

  test('after the first load the full import, Undo and export work with no network', async ({
    page,
    context,
    baseURL,
  }, info) => {
    void baseURL;
    void info;
    const { startServer } = await import('../../scripts/serve.mjs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const server = await startServer(root, 0);
    try {
      await seedStorage(page, { vaultfit_v1: OLD_TEXT, hb_seen_guide: '1', hb_seen_tutorial: '1' });
      await page.goto(server.url + 'index.html');
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const names = await globalThis.caches.keys();
            const c = await globalThis.caches.open(names.find((n) => n.startsWith('homebody-')));
            const keys = (await c.keys()).map((r) => new URL(r.url).pathname);
            return (
              keys.includes('/src/storage/import-export.js') &&
              keys.includes('/src/storage/validate.js')
            );
          }),
        )
        .toBe(true);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
      await page.evaluate(() => HB.storage.ready());
      await page.evaluate(() => window.mShowPage('profile'));
      const before = await mirror(page);
      await previewOf(page, mkDoc({ n: 2 }));
      await page.locator('#hb-io-primary').click();
      await expect(title(page)).toHaveText('Import done');
      expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length + 2);
      await page.locator('#hb-io-sheet .hb-io-body [data-io=undo]').click();
      await page.locator('#hb-io-dlg .hb-io-danger').click();
      await expect(title(page)).toHaveText('Import undone');
      await page.reload();
      await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
      await page.evaluate(() => HB.storage.ready());
      expect(await mirror(page)).toEqual(before);
      await page.evaluate(() => window.mShowPage('profile'));
      const [dl] = await Promise.all([page.waitForEvent('download'), io(page, 'export').click()]);
      expect(dl.suggestedFilename()).toMatch(/^HomeBody_/);
    } finally {
      await server.close();
    }
  });
});

void [REAL, mkPlan];
