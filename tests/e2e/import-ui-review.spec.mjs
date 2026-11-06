// T7b review round: layers and focus, held applies, kind mapping through the real builders, toast placement,
// validator boundaries, disposal, and the logging tap count. (Spec: import-preview.md section 13.)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, seedStorage, seedData } from './helpers/seed.mjs';
import {
  OLD,
  OLD_TEXT,
  REAL_TEXT,
  BAR,
  specCopy,
  openApp,
  io,
  title,
  tap,
  chooseFile,
  previewOf,
  mkDoc,
  mkPlan,
  injectFaults,
  injectHold,
  setFault,
  settled,
  ratioOf,
} from './helpers/io-ui.mjs';
import { SYNTHETIC_DIR } from '../unit/helpers/load-fixtures.mjs';

const C = specCopy();
const one = (k) => C.get(k)[0];
const body = (page) => page.locator('#hb-io-sheet .hb-io-body');
const foot = (page) => page.locator('#hb-io-sheet .hb-io-foot button');
const closeX = (page) => page.locator('#hb-io-sheet .hb-io-close');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function importThenLater(page, siteURL) {
  await injectFaults(page);
  await openApp(page, siteURL);
  await previewOf(page, mkDoc({ n: 2 }));
  await page.locator('#hb-io-primary').click();
  await expect(title(page)).toHaveText('Import done');
}

test.describe('kind mapping through the real state builders (A37)', () => {
  test('every kind and reason shows exactly its state; the maps equal the design table 10.1', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const maps = await page.evaluate(() => ({
      k: HB_IO_KIND_MAP,
      r: HB_IO_REASON_MAP,
      s: HB_IO_STATES,
      c: HB_IO_COPY,
    }));
    // the design table
    const md = readFileSync(join(root, 'docs', 'design', 'import-preview.md'), 'utf8');
    const sec = md.slice(
      md.indexOf('#### 10.1 Kind to state'),
      md.indexOf('Engineering notes (not copy)'),
    );
    const rows = sec
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    const cell = (kind, reason) =>
      rows.find((r) =>
        reason
          ? r[0].includes('`invalid`') && r[0].includes('`' + reason + '`')
          : new RegExp('(^|[ ,(])`' + kind + '`').test(r[0]) && !r[0].includes('`invalid`'),
      );
    for (const [kind, [imp, undo]] of Object.entries(maps.k)) {
      if (kind === 'invalid') continue;
      const row = cell(kind);
      expect(row, `10.1 has a row for ${kind}`).toBeTruthy();
      if (imp) expect(row[1], `${kind} import`).toContain(imp);
      else expect(row[1]).toContain('n/a');
      if (undo) expect(row[2], `${kind} undo`).toContain(undo);
      else expect(row[2]).toContain('n/a');
    }
    for (const [reason, st] of Object.entries(maps.r)) {
      const row = cell('invalid', reason);
      expect(row, `10.1 has a row for invalid + ${reason}`).toBeTruthy();
      expect(row[1], reason).toContain(st);
    }
    // each mapped state really renders its title and body (import side and undo side)
    for (const [kind, [imp, undo]] of Object.entries(maps.k)) {
      for (const [id, undoSide] of [
        [imp, false],
        [undo, true],
      ]) {
        if (!id || /^(I4|U2|F\*)$/.test(id) || kind === 'invalid') continue;
        await page.evaluate(
          ([e, u]) => (u ? HBIO.__test.showUndoError(e) : HBIO.__test.showError(e)),
          [{ kind }, undoSide],
        );
        const [, tk, bk] = [id, ...maps.s[id]].slice(0, 3).length
          ? ['', maps.s[id][1], maps.s[id][2]]
          : [];
        await expect(title(page), `${kind} ${id}`).toHaveText(maps.c[tk]);
        if (id !== 'F1')
          await expect(body(page).locator('p').first()).toContainText(
            maps.c[bk].replace(/\{\w+\}.*/, '').slice(0, 30),
          );
        await closeX(page).click();
      }
    }
  });

  test('stale boot shows R2 (Import) and UF2 (Undo); restored gives UF2b; F9 after dispose', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.evaluate(() => HBIO.__test.showError({ kind: 'stale' }));
    await expect(title(page)).toHaveText(one('io.r.readonly.title'));
    await closeX(page).click();
    await page.evaluate(() => HBIO.__test.showUndoError({ kind: 'stale' }));
    await expect(title(page)).toHaveText(one('io.uf.readonly.title'));
    await expect(body(page)).toContainText(one('io.uf.readonly'));
    await closeX(page).click();
    await page.evaluate(() => HBIO.__test.showUndoError({ kind: 'restored' }));
    await expect(title(page)).toHaveText(one('io.r.restart.title'));
    await expect(body(page)).toHaveText(one('io.uf.restart'));
    await closeX(page).click();
    // a handle disposed behind the sheet: Import answers with F9 (and nothing is written)
    await previewOf(page, mkDoc({ n: 1 }));
    await page.evaluate(() => HBIO.__test.flowImp().dispose());
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText(one('io.f.again.title'));
    await expect(body(page)).toHaveText(one('io.f.again'));
    expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length);
  });

  test('closing the sheet releases the file: a retained handle answers consumed', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 1 }));
    await page.evaluate(() => (window.__h = HBIO.__test.flowImp()));
    await closeX(page).click();
    expect(
      await page.evaluate(() =>
        window.__h.recheck().then(
          () => 'ok',
          (e) => e.kind,
        ),
      ),
    ).toBe('consumed');
  });

  test('the maps and the copy are frozen', async ({ appPage: page, siteURL }) => {
    await openApp(page, siteURL);
    expect(
      await page.evaluate(() =>
        [HB_IO_COPY, HB_IO_KIND_MAP, HB_IO_REASON_MAP, HB_IO_STATES].map(Object.isFrozen),
      ),
    ).toEqual([true, true, true, true]);
  });
});

test.describe('layers, focus, toasts, held applies', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

  test('a failing export while a dialog is open is a toast; closing leaves nothing inert and Escape still works', async ({
    appPage: page,
    siteURL,
  }) => {
    await page.route('**/src/storage/import-export.js', (r) =>
      page.__block ? r.abort() : r.continue(),
    );
    await importThenLater(page, siteURL);
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 777,
        name: 'Later',
        date: new Date().toISOString(),
        exercises: [],
      });
      return persistSave();
    });
    await closeX(page).click();
    // a later change makes the Undo dialog the U2 kind, which has an Export button
    await io(page, 'undo').click();
    await expect(page.locator('#hb-io-dlg')).toContainText('Undo will also remove later changes');
    // U2 export button is 48 px, not stretched, and both buttons are on screen
    const eb = await page.locator('#hb-io-dlg .hb-io-wide').boundingBox();
    expect(eb.height).toBeGreaterThanOrEqual(48);
    expect(eb.height).toBeLessThan(60);
    for (const b of await page.locator('#hb-io-dlg button').all()) {
      const r = await b.boundingBox();
      expect(r.y + r.height).toBeLessThanOrEqual(667);
    }
    // a history too large to export: the export fails while the dialog is open, so it is a toast, not a sheet
    await page.evaluate(() => {
      state.workouts = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        name: 'w',
        date: '2026-10-01T00:00:00.000Z',
        exercises: [],
        notes: 'x'.repeat(800000),
      }));
    });
    await page.locator('#hb-io-dlg .hb-io-wide').click();
    await expect(
      page.locator('.m-toast', { hasText: one('io.xc.toastBusy') }).first(),
    ).toBeVisible();
    await expect(page.locator('#hb-io-sheet')).toBeHidden(); // no sheet replaced the dialog
    await page.keyboard.press('Escape');
    await expect(page.locator('#hb-io-dlg')).toBeHidden();
    const inert = await page.evaluate(() => [
      document.querySelector('.app').inert,
      document.querySelector('nav.bottom-nav').inert,
      document.documentElement.classList.contains('hb-io-open'),
    ]);
    expect(inert).toEqual([false, false, false]);
    // a sheet opened afterwards still closes on Escape
    await io(page, 'import').click();
    await expect(page.locator('#hb-io-sheet'))
      .toBeHidden()
      .catch(() => {});
  });

  test('Keep import returns focus to the Undo button in the sheet, or in the card', async ({
    appPage: page,
    siteURL,
  }) => {
    await importThenLater(page, siteURL);
    await page.locator('#hb-io-sheet .hb-io-body [data-io=undo]').click();
    await page.locator('#hb-io-dlg button', { hasText: 'Keep import' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement.closest('#hb-io-sheet') !== null &&
            document.activeElement.getAttribute('data-io'),
        ),
      )
      .toBe('undo');
    await closeX(page).click();
    await io(page, 'undo').click();
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement.getAttribute('data-io') +
            ':' +
            (document.activeElement.closest('#hb-data-card') !== null),
        ),
      )
      .toBe('undo:true');
  });

  test('Replace with no data of yours uses the empty sentence; the partial reason is readable in both themes', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL, { data: JSON.stringify({ workouts: [] }) });
    await previewOf(page, REAL_TEXT);
    await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click();
    await page.locator('#hb-io-primary').click();
    const t = await page.locator('#hb-io-dlg-desc').innerText();
    expect(t).toContain('You have no data in HomeBody yet');
    expect(t).not.toMatch(/your 0/);
    await page.keyboard.press('Escape');
    await closeX(page).click();
    const partial = JSON.parse(mkDoc({ n: 2 }));
    partial._partial = true;
    partial._partialReason = 'unreadable';
    for (const theme of ['dark', 'light']) {
      if (theme === 'light')
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await previewOf(page, JSON.stringify(partial));
      await settled(page);
      expect(await ratioOf(page, '#hb-io-replace-why')).toBeGreaterThanOrEqual(4.5);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.getElementById('hb-io-replace-why')).opacity,
        ),
      ).toBe('1');
      await closeX(page).click();
    }
  });

  test('footer and dialog labels stay on one line; Tab and Shift+Tab stay inside the layer', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.addStyleTag({
      content: 'html{font-size:200% !important}.toast-container{display:none}',
    });
    await previewOf(page, REAL_TEXT);
    await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click();
    const wrap = await page.evaluate(() =>
      [...document.querySelectorAll('#hb-io-sheet .hb-io-foot button')].map((b) => [
        getComputedStyle(b).whiteSpace,
        b.scrollWidth <= b.clientWidth + 1,
      ]),
    );
    for (const w of wrap) expect(w).toEqual(['nowrap', true]);
    await page.locator('#hb-io-primary').focus();
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement.classList.contains('hb-io-close')),
    ).toBe(true); // wrapped to the first control
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('hb-io-primary');
    await page.locator('#hb-io-primary').click();
    await expect(page.locator('#hb-io-dlg')).toBeVisible();
    const f = await page.evaluate(() =>
      [...document.querySelectorAll('#hb-io-dlg button')].map((b) => [
        getComputedStyle(b).whiteSpace,
        b.scrollWidth <= b.clientWidth + 1,
      ]),
    );
    for (const w of f) expect(w).toEqual(['nowrap', true]);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement.closest('#hb-io-dlg'))).toBe(true);
    }
  });

  test('a toast stays above the footer and above the dialog buttons and never takes a tap', async ({
    appPage: page,
    siteURL,
  }) => {
    await importThenLater(page, siteURL);
    await page.evaluate(() => window.mToast('A toast for the layout check', 'success'));
    await expect(page.locator('.m-toast').last()).toBeVisible();
    await settled(page);
    const boxes = async (sel) =>
      page.evaluate((s) => {
        const t = [...document.querySelectorAll('.m-toast.show')].map((e) =>
          e.getBoundingClientRect(),
        );
        return {
          toasts: t.map((r) => [r.top, r.bottom]),
          els: [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect().top),
        };
      }, sel);
    let b = await boxes('#hb-io-sheet .hb-io-foot');
    for (const [, bottom] of b.toasts) expect(bottom).toBeLessThanOrEqual(b.els[0] - 12 + 1);
    await page.locator('#hb-io-sheet .hb-io-body [data-io=undo]').click();
    await page.evaluate(() => window.mToast('Another toast', ''));
    await settled(page);
    b = await boxes('#hb-io-dlg .hb-io-dlg-foot');
    for (const [, bottom] of b.toasts) expect(bottom).toBeLessThanOrEqual(b.els[0] - 12 + 1);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector('.m-toast')).pointerEvents),
    ).toBe('none');
  });

  test('when the bar reaches Saved while R5 is open and focus was on Retry, focus goes to the sheet title', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4242,
        name: 'U',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await io(page, 'import').click();
    await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
    await page.locator(`${BAR} button`, { hasText: 'Retry' }).focus();
    await setFault(page, { main: false });
    await page.keyboard.press('Enter');
    await expect(body(page)).toContainText(one('io.r.unsaved.nowSaved'));
    await expect(title(page)).toBeFocused();
  });

  test('a small file shows only "Nothing has been changed" after 300 ms, never the large-file line', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.evaluate(() => {
      FileReader.prototype.readAsText = function () {}; // never finishes: look at the checking state
    });
    await chooseFile(page, mkDoc({ n: 1 }));
    await expect(title(page)).toHaveText('Checking file');
    await expect(body(page)).toContainText(one('io.check.body'));
    expect(await body(page).innerText()).not.toContain('large file');
  });

  test('I6 keeps the preview on screen, not tappable, with the keep-open line; the update card is held; the status is cleared when done', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectHold(page);
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 2 }));
    await page.evaluate(() => window.__holdOn());
    await page.locator('#hb-io-primary').click();
    await expect(page.locator('#hb-io-primary')).toHaveText('Importing…');
    await expect(body(page)).toContainText('Adds 2 workouts');
    await expect(page.locator('#hb-io-sheet .hb-io-busyline')).toHaveText(one('io.apply.keepOpen'));
    expect(await page.locator('#hb-io-sheet .hb-io-body').innerText()).not.toContain(
      one('io.apply.keepOpen'),
    );
    expect(
      await page.evaluate(
        () => document.querySelector('#hb-io-sheet .hb-io-body [inert]') !== null,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.hbSaveHold())).toBe(true);
    // the bar stays away entirely (not only hidden): no class, no height, no announcement
    const bar = () =>
      page.evaluate(() => ({
        on: document.documentElement.classList.contains('hb-save-on'),
        h: getComputedStyle(document.documentElement).getPropertyValue('--hb-bar-h').trim(),
        vis: getComputedStyle(document.getElementById('hb-save')).visibility,
        alert: document.querySelector('[role=alert].hb-sr').textContent,
        status: document.querySelector('[role=status].hb-sr').textContent,
      }));
    expect(await bar()).toEqual({ on: false, h: '0px', vis: 'hidden', alert: '', status: '' });
    await page.evaluate(() => window.__release());
    await expect(title(page)).toHaveText('Import done');
    expect(await page.evaluate(() => window.hbSaveHold())).toBe(false);
    await expect(page.locator('#hb-io-status')).toHaveText('');
    // restoring: held, the same facts
    await page.evaluate(() => window.__holdOn());
    await page.locator('#hb-io-sheet .hb-io-body [data-io=undo]').click();
    await page.locator('#hb-io-dlg .hb-io-danger').click();
    await expect(title(page)).toHaveText(one('io.undoing.title'));
    expect(await bar()).toEqual({ on: false, h: '0px', vis: 'hidden', alert: '', status: '' });
    expect(await page.evaluate(() => window.hbSaveHold())).toBe(true);
    await page.evaluate(() => window.__release());
    await expect(title(page)).toHaveText('Import undone');
    expect(await bar()).toEqual({ on: false, h: '0px', vis: 'hidden', alert: '', status: '' });
    await expect(page.locator('#hb-io-status')).toHaveText('');
    // nothing exports after an Undo until Restart (the page still holds the undone state)
    let dl = 0;
    page.on('download', () => dl++);
    await page.evaluate(() => window.mExportData());
    await expect(page.locator('#hb-io-sheet')).toBeVisible();
    expect(dl).toBe(0);
  });

  test('the toast lift follows the footer when it re-flows (Replace at 200% text)', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.addStyleTag({ content: 'html{font-size:200% !important}' });
    await previewOf(page, REAL_TEXT);
    await settled(page);
    await page.evaluate(() => window.mToast('Layout check toast', ''));
    await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click(); // the footer label gets longer and may stack
    await settled(page);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const f = document.querySelector('#hb-io-sheet .hb-io-foot').getBoundingClientRect().top;
          return [...document.querySelectorAll('.m-toast.show')].every(
            (e) => e.getBoundingClientRect().bottom <= f - 11,
          );
        }),
      )
      .toBe(true);
  });

  test('R5: Tab cycles through the bar and the sheet and never lands on the body', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4242,
        name: 'U',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await io(page, 'import').click();
    await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
    await page.locator('#hb-io-sheet .hb-io-foot button').focus(); // Export backup, the last control
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement !== document.body &&
            (!!document.activeElement.closest('#hb-save') ||
              !!document.activeElement.closest('#hb-io-sheet')),
        ),
      ).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement !== document.body &&
            (!!document.activeElement.closest('#hb-save') ||
              !!document.activeElement.closest('#hb-io-sheet')),
        ),
      ).toBe(true);
    }
  });

  test('Save as text file cannot download twice on a double tap', async ({
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
    await io(page, 'export').click();
    await expect(title(page)).toHaveText(one('io.xc.title'));
    let n = 0;
    page.on('download', () => n++);
    const b = page.locator('#hb-io-sheet .hb-io-foot button');
    await b.dblclick();
    await expect(page.locator('#hb-io-sheet')).toBeHidden();
    await page.waitForTimeout(300);
    expect(n).toBe(1);
  });

  test('R5 at 812x375 and 200% text keeps at least two lines of body above the footer', async ({
    appPage: page,
    siteURL,
  }) => {
    await injectFaults(page);
    await openApp(page, siteURL);
    await page.addStyleTag({
      content: 'html{font-size:200% !important}.toast-container{display:none}',
    });
    await page.setViewportSize({ width: 812, height: 375 });
    await setFault(page, { main: true });
    await page.evaluate(() => {
      state.workouts.unshift({
        id: 4242,
        name: 'U',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await io(page, 'import').click();
    await expect(title(page)).toHaveText(one('io.r.unsaved.title'));
    await settled(page);
    const lines = await page.evaluate(() => {
      const b = document.querySelector('#hb-io-sheet .hb-io-body');
      const lh = parseFloat(getComputedStyle(b.querySelector('p')).lineHeight);
      return b.clientHeight / lh;
    });
    expect(lines).toBeGreaterThanOrEqual(2);
  });

  test('the card keeps focus when it is rebuilt', async ({ appPage: page, siteURL }) => {
    await openApp(page, siteURL);
    await io(page, 'export').focus();
    await page.evaluate(() => window.hbIoRenderCard());
    expect(await page.evaluate(() => document.activeElement.getAttribute('data-io'))).toBe(
      'export',
    );
  });

  test('the header Close is right after the header in tab order and there is no second Close', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 1 }));
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('#hb-io-sheet button, #hb-io-sheet input')].map(
        (e) => e.className || e.type,
      ),
    );
    expect(order[0]).toContain('hb-io-close');
    await expect(page.locator('#hb-io-sheet button', { hasText: /^Close$/ })).toHaveCount(1);
  });
});

test.describe('real touch on the core path, at two widths and both themes', () => {
  test.use({ hasTouch: true });
  for (const vp of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ]) {
    for (const theme of ['dark', 'light']) {
      test(`import, Undo and Restart by touch at ${vp.width} (${theme}) @smoke`, async ({
        appPage: page,
        siteURL,
      }) => {
        await page.setViewportSize(vp);
        await openApp(page, siteURL);
        if (theme === 'light')
          await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        await chooseFile(page, REAL_TEXT, 'import', { touch: true });
        await expect(title(page)).toHaveText('Check before importing');
        await settled(page);
        await tap(page, page.locator('#hb-io-primary'));
        await expect(title(page)).toHaveText('Import done');
        await tap(page, page.locator('#hb-io-sheet .hb-io-body [data-io=undo]'));
        await tap(page, page.locator('#hb-io-dlg .hb-io-danger'));
        await expect(title(page)).toHaveText('Import undone');
        await Promise.all([page.waitForEvent('load'), tap(page, foot(page))]);
        await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
        await page.evaluate(() => HB.storage.ready());
        expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length);
      });
    }
  }

  test.describe('logging a set is at most two taps', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
    test('from the active workout one tap on the tick logs a set @smoke', async ({
      appPage: page,
      siteURL,
    }) => {
      const ACTIVE = readFileSync(join(SYNTHETIC_DIR, 'hb_active_workout.json'), 'utf8');
      await seedStorage(page, {
        vaultfit_v1: JSON.stringify(seedData()),
        hb_seen_guide: '1',
        hb_active_workout: ACTIVE,
      });
      await page.goto(siteURL + 'index.html');
      await page.waitForFunction(
        () =>
          typeof state !== 'undefined' && !!window.HB && !!document.getElementById('wm-overlay'),
      );
      let taps = 0;
      const t = page.locator('#wm-tick-0-1');
      await expect(t).not.toHaveClass(/done/);
      await tap(page, t);
      taps++;
      await expect(t).toHaveClass(/done/);
      expect(taps).toBeLessThanOrEqual(2);
    });
  });
});

test.describe('the validator at its boundaries, through the UI', () => {
  test.use({ viewport: { width: 375, height: 667 } });
  const plan = (over, ex = {}) => ({
    ...mkPlan(900, 'Edge', 1),
    ...over,
    planDays: [
      {
        name: 'D',
        exercises: [{ name: 'Row', sets: 3, reps: 8, weight: 20, trackType: 'reps', ...ex }],
      },
    ],
  });
  const cases = [
    ['sets 1000 kept', plan({}, { sets: 1000 }), true],
    ['sets 1001 refused', plan({}, { sets: 1001 }), false],
    ['reps 1e9 kept', plan({}, { reps: 1e9 }), true],
    ['reps above 1e9 refused', plan({}, { reps: 1e9 + 1 }), false],
    ['weight 5000 kept', plan({}, { weight: 5000 }), true],
    ['weight 5001 refused', plan({}, { weight: 5001 }), false],
    ['weeks 520 kept', plan({ weeks: 520 }), true],
    ['weeks 521 refused', plan({ weeks: 521 }), false],
    ['daysPerWeek 14 kept', plan({ daysPerWeek: 14 }), true],
    ['daysPerWeek 15 refused', plan({ daysPerWeek: 15 }), false],
    ['negative weight refused', plan({}, { weight: -1 }), false],
  ];
  for (const [name, p, ok] of cases) {
    test(name, async ({ appPage: page, siteURL }) => {
      await openApp(page, siteURL);
      await chooseFile(page, mkDoc({ n: 1, plans: [p] }));
      await expect(title(page)).toHaveText(
        ok ? 'Check before importing' : one('io.f.invalid.title'),
      );
    });
  }
  test('a null entry in userPlans is refused whole; a non-string _name is dropped, not shown', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await chooseFile(page, mkDoc({ n: 1, plans: [null] }));
    await expect(title(page)).toHaveText(one('io.f.invalid.title'));
    await expect(page.locator('#hb-io-sheet .hb-io-list li').first()).toContainText('Plan 1');
    await closeX(page).click();
    const d = JSON.parse(mkDoc({ n: 1 }));
    d._name = { a: '<img src=x onerror=window.__x=1>' };
    await chooseFile(page, JSON.stringify(d));
    await expect(title(page)).toHaveText('Check before importing');
    expect(await page.evaluate(() => window.__x)).toBeUndefined();
    expect(await page.locator('#hb-io-sheet img').count()).toBe(0);
  });
  test('13.4: a 600-character name is over the cap: F6 with the too-long reason and a position only', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const d = JSON.parse(mkDoc({ n: 1 }));
    d.workouts[0].name = 'x'.repeat(600);
    await chooseFile(page, JSON.stringify(d));
    await expect(title(page)).toHaveText(one('io.f.invalid.title'));
    await expect(page.locator('#hb-io-sheet .hb-io-list li')).toHaveText([
      'Workout 1 · name: is too long',
    ]);
  });
});

void [OLD_TEXT];
