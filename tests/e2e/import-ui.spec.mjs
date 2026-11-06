// T7b: the import, Undo and export UI (docs/design/import-preview.md, acceptance checks A1 to A38).
// Chromium runs everything; the @smoke tests also run in WebKit. Taps that matter use real touch.
import { test, expect } from './helpers/seed.mjs';
import {
  OLD,
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
  bodyText,
  mirror,
  idbDoc,
  mkDoc,
  mkPlan,
  fileOf,
} from './helpers/io-ui.mjs';

const N = REAL.workouts.length;

test.describe('copy, card and mapping', () => {
  test('every string in the page is a string of the approved design (no invented copy)', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const copy = await page.evaluate(() => HB_IO_COPY);
    const spec = specCopy();
    // the labels of 6.4 and a few row names are in the spec as tables without keys
    const own = /^io\.(btn\.exportSaved|path|why|row\.(workouts|prs|bodyMetrics|plans|favs|profile))/;
    for (const [key, v] of Object.entries(copy)) {
      if (own.test(key)) continue;
      expect(spec.has(key), `${key} is in the design doc`).toBe(true);
      for (const s of Array.isArray(v) ? v : [v]) {
        expect(spec.get(key), `${key}: ${s}`).toContain(s);
      }
    }
    // and the other way: every key of the design doc has its string in the page
    for (const key of spec.keys()) {
      if (key === 'io.card.title') continue;
      expect(Object.hasOwn(copy, key), `${key} is in the page`).toBe(true);
    }
  });

  test('A37: every kind, read-only kind and validator reason has exactly one mapped state', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const r = await page.evaluate(async () => {
      const m = await import('./src/storage/validate.js');
      return {
        kinds: HBStorage.IMPORT_KINDS,
        reasons: m.REASONS,
        kindMap: HB_IO_KIND_MAP,
        reasonMap: HB_IO_REASON_MAP,
        states: Object.keys(HB_IO_STATES),
        copyKeys: Object.keys(HB_IO_COPY),
        stateCopy: Object.fromEntries(
          Object.entries(HB_IO_STATES).map(([k, v]) => [k, [v[1], v[2]]]),
        ),
      };
    });
    const readonly = [
      'corrupt',
      'future',
      'unavailable',
      'stale',
      'restoring',
      'importing',
      'restored',
    ];
    for (const k of [...r.kinds, ...readonly]) {
      expect(Object.hasOwn(r.kindMap, k), `kind ${k}`).toBe(true);
    }
    expect(Object.keys(r.kindMap).sort()).toEqual([...new Set([...r.kinds, ...readonly])].sort());
    for (const k of r.reasons) {
      expect(Object.hasOwn(r.reasonMap, k), `reason ${k}`).toBe(true);
    }
    // every mapped state exists (or is a state built without a table row) and its copy keys exist
    const built = ['I4', 'U2', 'F*', 'F5'];
    for (const [kind, [imp, undo]] of Object.entries(r.kindMap)) {
      for (const s of [imp, undo]) {
        if (s && !built.includes(s)) expect(r.states, `${kind} -> ${s}`).toContain(s);
      }
    }
    for (const s of Object.values(r.reasonMap)) expect(r.states).toContain(s);
    for (const [s, [t, b]] of Object.entries(r.stateCopy)) {
      expect(r.copyKeys, `${s} title`).toContain(t);
      expect(r.copyKeys, `${s} body`).toContain(b);
    }
  });

  test('A1, A2: the card shows the approved lines; the file name equals the download name @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const c = specCopy();
    const text = await page.locator('#hb-data-card').innerText();
    expect(text).toContain(c.get('io.card.intro')[0]);
    expect(text).toContain(c.get('io.health.label')[0]);
    expect(text).toContain(c.get('io.card.importNote')[0]);
    expect(text).toMatch(/File name: HomeBody_2026-11-01\.vaultfit/);
    const btns = await page.locator('#hb-data-card button').allTextContents();
    expect(btns.map((t) => t.trim())).toEqual([
      'Export backup',
      'Import backup',
      'Import plans only',
      'Replay App Tutorial',
    ]);
    for (const t of btns) expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
    // every line is the --text colour (no muted text, K11)
    const text0 = await page.evaluate(() => getComputedStyle(document.body).color);
    const colours = await page
      .locator('#hb-data-card .hb-io-p')
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
    for (const col of colours) expect(col).toBe(text0);
    // the named file is exactly the download
    await page.evaluate(() => {
      window.__dl = [];
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        window.__dl.push(this.download);
        return orig.apply(this, arguments);
      };
    });
    const [dl] = await Promise.all([page.waitForEvent('download'), io(page, 'export').click()]);
    expect(dl.suggestedFilename()).toMatch(/^HomeBody_\d{4}-\d{2}-\d{2}\.vaultfit$/);
    expect(await page.evaluate(() => window.__dl)).toEqual(['HomeBody_2026-11-01.vaultfit']);
    expect(dl.suggestedFilename()).not.toContain('Test');
    await expect(page.locator('.m-toast').last()).toContainText(
      'Backup saved: 2 workouts. Keep the file private.',
    );
    await expect(page.locator('#hb-io-status')).toHaveText(
      'Backup saved: 2 workouts. Keep the file private.',
    );
  });
});

test.describe('import: preview, apply, Undo', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

  test('A10, A15, A16: Merge preview numbers, import, then Undo restores the state exactly @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const before = await mirror(page);
    await previewOf(page, REAL_TEXT);
    const sm = await page.evaluate(() => null); // (numbers are read from the sheet below)
    expect(sm).toBeNull();
    // Merge is selected, native radio group of two
    await expect(page.locator('#hb-io-sheet input[type=radio]')).toHaveCount(2);
    await expect(page.locator('#hb-io-sheet input[value=merge]')).toBeChecked();
    const sum = await page.locator('#hb-io-summary').innerText();
    const newW = N - 0; // the two seeded workouts are not in the fixture
    expect(sum).toBe(
      `Adds ${newW} workouts, 71 personal records, 7 body measurements and 1 plan. Nothing of yours is changed or removed.`,
    );
    expect(await page.locator('#hb-io-summary').getAttribute('aria-live')).toBe('polite');
    const rows = await page.locator('.hb-io-rowitem').allInnerTexts();
    expect(rows[0]).toContain(`${N} in file · ${N} new`);
    expect(rows[0]).toContain('17 Mar 2026 to 31 Oct 2026');
    expect(rows[1]).toContain('74 in file · 71 new · 3 already here');
    expect(rows[1]).toContain('Where both have one, yours is kept.');
    // Import (real touch on the pinned footer's primary button)
    await tap(page, page.locator('#hb-io-primary'));
    await expect(title(page)).toHaveText('Import done');
    // Undo is in the body, at least 24 px above the footer, not in it
    const undo = page.locator('#hb-io-sheet .hb-io-body [data-io=undo]');
    await expect(undo).toBeVisible();
    await expect(page.locator('#hb-io-sheet .hb-io-foot button')).toHaveText(['Done']);
    const ub = await undo.boundingBox();
    const fb = await page.locator('#hb-io-sheet .hb-io-foot').boundingBox();
    expect(fb.y - (ub.y + ub.height)).toBeGreaterThanOrEqual(24);
    // current workouts are all still present
    const names = await page.evaluate(() => state.workouts.map((w) => w.name));
    for (const w of OLD.workouts) expect(names).toContain(w.name);
    expect(await page.evaluate(() => state.workouts.length)).toBe(N + OLD.workouts.length);
    expect((await idbDoc(page)).snaps).toContain('pre-import');
    // Undo: nothing saved since, so U1 (no later-changes warning), then Restart
    await tap(page, undo);
    const dlg = page.locator('#hb-io-dlg [role=alertdialog]');
    await expect(dlg).toContainText('Undo the import?');
    await expect(dlg).toContainText(
      'HomeBody goes back to exactly how it was before the import at',
    );
    await expect(page.locator('#hb-io-dlg button').first()).toBeFocused(); // Keep import
    await page.getByRole('button', { name: 'Undo import', exact: true }).last().click();
    await expect(title(page)).toHaveText('Import undone');
    await expect(page.locator('#hb-io-sheet .hb-io-close')).toBeHidden();
    await expect(page.locator('#hb-io-sheet .hb-io-foot button')).toHaveText(['Restart']);
    await expect(title(page)).toBeFocused();
    await page.locator('#hb-io-sheet .hb-io-foot button').click();
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await page.evaluate(() => HB.storage.ready());
    expect(await mirror(page)).toEqual(before);
    expect((await idbDoc(page)).workouts).toHaveLength(OLD.workouts.length);
  });

  test('A11: Replace rewrites the summary, shows the danger row and a dialog that starts on Keep my data', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await previewOf(page, REAL_TEXT);
    await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click();
    await expect(page.locator('#hb-io-summary')).toHaveText(
      'Removes your 2 workouts, 3 personal records, 1 body measurement and 1 favourite exercise and uses the backup from 31 Oct 2026 instead.',
    );
    await expect(page.locator('.hb-io-danger-row')).toContainText(
      'This removes your current data: 2 workouts, 3 personal records, 1 body measurement and 1 favourite exercise.',
    );
    await expect(page.locator('.hb-io-danger-row')).toContainText(
      'Your profile (Synthetic User) is replaced by the one in the file (Test User).',
    );
    await expect(page.locator('#hb-io-primary')).toHaveText('Replace my data…');
    await page.locator('#hb-io-primary').click();
    await expect(page.locator('#hb-io-dlg')).toContainText('Replace all your data?');
    await expect(page.locator('#hb-io-dlg')).toContainText(
      'A copy of your data from before is kept on this device',
    );
    await expect(page.locator('#hb-io-dlg button', { hasText: 'Keep my data' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#hb-io-dlg')).toBeHidden();
    await expect(title(page)).toHaveText('Check before importing');
    expect(await page.evaluate(() => state.workouts.length)).toBe(OLD.workouts.length); // nothing changed
    // confirm: replaced
    await page.locator('#hb-io-primary').click();
    await page.getByRole('button', { name: 'Replace my data', exact: true }).last().click();
    await expect(title(page)).toHaveText('Import done');
    await expect(page.locator('#hb-io-sheet .hb-io-body')).toContainText(
      'Your data now comes from the backup made 31 Oct 2026.',
    );
    expect(await page.evaluate(() => state.workouts.length)).toBe(N);
  });

  test('Merge with nothing new: the sentence and a Done button, and state is untouched (A35a)', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL, { data: JSON.stringify(REAL.workouts ? { ...REAL } : REAL) });
    const ident = await page.evaluate(() => state.workouts);
    expect(ident.length).toBe(N);
    await previewOf(page, REAL_TEXT);
    // the profile in the file is the one already here, the PRs and plans are present
    await expect(page.locator('#hb-io-summary')).toHaveText(
      'Nothing new to add. Everything in this file is already in HomeBody.',
    );
    await expect(page.locator('#hb-io-primary')).toHaveText('Done');
    const keep = await page.evaluate(() => {
      window.__w = state.workouts;
      return true;
    });
    expect(keep).toBe(true);
    await page.locator('#hb-io-primary').click();
    await expect(page.locator('#hb-io-sheet')).toBeHidden();
    expect(await page.evaluate(() => window.__w === state.workouts)).toBe(true); // same object
    expect((await idbDoc(page)).snaps).not.toContain('pre-import');
  });

  test('A12: a partial file shows its warning and Replace cannot be chosen', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const partial = JSON.parse(mkDoc({ n: 2 }));
    partial._partial = true;
    partial._partialReason = 'unreadable';
    await previewOf(page, JSON.stringify(partial));
    await expect(page.locator('.hb-io-warns')).toContainText(
      'Partial backup. It was made when HomeBody',
    );
    const rep = page.locator('#hb-io-sheet input[value=replace]');
    await expect(rep).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#hb-io-replace-why')).toBeVisible();
    await expect(page.locator('#hb-io-replace-why')).toHaveText(
      "Not available: this is a partial backup, so it could remove history that isn't in it.",
    );
    expect(await rep.getAttribute('aria-describedby')).toBe('hb-io-replace-why');
    await page.locator('.hb-io-opt-off').click({ force: true });
    await expect(rep).not.toBeChecked();
    await page.locator('#hb-io-sheet input[value=merge]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(rep).not.toBeChecked();
    await expect(page.locator('#hb-io-summary')).toContainText('Adds 2 workouts');
    await expect(page.locator('#hb-io-status')).toHaveText(
      /Not available: this is a partial backup/,
    );
  });

  test('A13: each warning shows for its crafted file and not otherwise', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    // a clean file: none of the warnings
    await previewOf(page, mkDoc({ n: 2 }));
    await expect(page.locator('.hb-io-warn')).toHaveCount(0);
    await page.locator('#hb-io-sheet .hb-io-foot button').first().click();
    // future date + colliding id + in-file duplicate + unknown key
    const d = JSON.parse(mkDoc({ n: 3, idBase: OLD.workouts[0].id }));
    d.workouts[2].date = new Date(Date.UTC(2026, 11, 1)).toISOString(); // a month after the frozen day
    d.workouts[1].id = d.workouts[0].id; // duplicate id inside the file
    d.workouts[0].mystery = 'x'; // unknown key is dropped
    await page.evaluate(() => mShowPage('profile'));
    await previewOf(page, JSON.stringify(d));
    const warns = await page.locator('.hb-io-warns').innerText();
    expect(warns).toContain('1 workout or measurement is dated after today');
    expect(warns).toContain("workouts will be renumbered so they don't clash with yours");
    expect(warns).toContain('1 workout appears twice in the file');
    expect(warns).toContain("1 extra detail in the file isn't used by HomeBody");
    expect(warns).not.toContain('Partial backup');
    expect(warns).not.toContain('Large history');
  });

  test('A13: a document over the mirror ceiling shows the large-history warning', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const d = JSON.parse(mkDoc({ n: 400 }));
    for (const w of d.workouts) w.notes = 'n'.repeat(1500);
    await previewOf(page, JSON.stringify(d));
    await expect(page.locator('.hb-io-warns')).toContainText(
      'Large history. Everything will be saved',
    );
  });

  test('A14: the profile row for each case, names only inside bidi-isolated spans', async ({
    appPage: page,
    siteURL,
  }) => {
    // kept: you have a profile, the file has none
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 1 }));
    await expect(page.locator('.hb-io-rowitem', { hasText: 'Profile' })).toContainText(
      'Yours is kept.',
    );
    await page.locator('.hb-io-opt', { hasText: 'Replace my data' }).click();
    await expect(page.locator('.hb-io-rowitem', { hasText: 'Profile' })).toContainText(
      'The file has no profile, so yours is cleared.',
    );
    await page.locator('#hb-io-sheet .hb-io-foot button').first().click();
    // adopt: no profile of yours, the file has one with a name; and the replace case with two names
    await page.evaluate(() => {
      state.profile = null;
      return persistSave();
    });
    await page.evaluate(() => mShowPage('profile'));
    const withName = JSON.parse(mkDoc({ n: 1 }));
    withName.profile = { name: 'Alex' };
    await previewOf(page, JSON.stringify(withName));
    await expect(page.locator('.hb-io-rowitem', { hasText: 'Profile' })).toContainText(
      'You have no profile yet, so the one in the file is used (Alex).',
    );
    const spans = await page
      .locator('#hb-io-sheet .hb-io-name')
      .evaluateAll((e) => e.map((x) => [x.textContent, x.getAttribute('dir')]));
    expect(spans).toEqual([['Alex', 'auto']]);
    await page.locator('#hb-io-sheet .hb-io-foot button').first().click();
    const noName = JSON.parse(mkDoc({ n: 1 }));
    noName.profile = { weight: 70 };
    await page.evaluate(() => mShowPage('profile'));
    await previewOf(page, JSON.stringify(noName));
    await expect(page.locator('.hb-io-rowitem', { hasText: 'Profile' })).toContainText(
      'You have no profile yet, so the one in the file is used.',
    );
  });

  test('A17, A18: Undo after later changes warns; Keep import changes nothing; the row stays until reload', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await previewOf(page, mkDoc({ n: 2 }));
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText('Import done');
    await page.locator('#hb-io-sheet .hb-io-foot button').click(); // Done
    // later change: log a workout
    await page.evaluate(async () => {
      state.workouts.unshift({
        id: 777,
        name: 'Later',
        date: new Date().toISOString(),
        exercises: [],
      });
      await persistSave();
    });
    await expect(page.locator('#hb-data-card .hb-io-undo-row')).toContainText(/Imported today at/);
    const count = await page.evaluate(() => state.workouts.length);
    await io(page, 'undo').click();
    const dlg = page.locator('#hb-io-dlg');
    await expect(dlg).toContainText('Undo will also remove later changes');
    await expect(dlg.locator('button')).toHaveText(['Export backup', 'Keep import', 'Undo anyway']);
    await dlg.getByRole('button', { name: 'Keep import' }).click();
    await expect(dlg).toBeHidden();
    expect(await page.evaluate(() => state.workouts.length)).toBe(count);
    await expect(page.locator('#hb-data-card .hb-io-undo-row')).toBeVisible();
    // a workout in progress: UF1, nothing changed
    await page.evaluate(() =>
      localStorage.setItem(
        'hb_active_workout',
        '{"name":"x","exercises":[{"name":"a","sets":[]}]}',
      ),
    );
    await io(page, 'undo').click();
    await expect(title(page)).toHaveText('Finish your workout first');
    await expect(page.locator('#hb-io-sheet .hb-io-body')).toContainText(
      "You can't undo an import while a workout is in progress.",
    );
    await page.locator('#hb-io-sheet .hb-io-close').click();
    await page.evaluate(() => localStorage.removeItem('hb_active_workout'));
    await page.reload();
    await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
    await page.evaluate(() => mShowPage('profile'));
    await expect(page.locator('#hb-data-card .hb-io-undo-row')).toHaveCount(0);
  });

  test('A19: plans only: New and Already in your plans, then all present and Done', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const present = OLD.userPlans && OLD.userPlans[0] ? OLD.userPlans[0] : null;
    const plans = [mkPlan(5001, 'Kettlebell basics', 3), mkPlan(5002, 'Full body A/B', 2)];
    if (present) plans.push({ ...mkPlan(present.id, 'Already here', 1) });
    const file = mkDoc({ n: 4, plans });
    const before = await page.evaluate(() => ({
      w: state.workouts.length,
      pr: Object.keys(state.personalRecords).length,
      bm: state.bodyMetrics.length,
      pf: state.profile,
    }));
    await previewOf(page, file, 'plans');
    await expect(page.locator('#hb-io-summary')).toContainText(
      present
        ? 'Adds 2 plans to My plans. Your workouts, records, measurements and profile are not changed.'
        : 'Adds 2 plans',
    );
    const rows = await page.locator('.hb-io-rowitem').allInnerTexts();
    expect(rows[0]).toContain('Kettlebell basics');
    expect(rows[0]).toContain('3 days · New');
    if (present) expect(rows[2]).toContain('1 day · Already in your plans');
    await expect(page.locator('#hb-io-primary')).toHaveText('Add 2 plans');
    await page.locator('#hb-io-primary').click();
    await expect(title(page)).toHaveText('Plans added');
    await expect(page.locator('#hb-io-sheet .hb-io-body')).toContainText(
      'Added 2 plans to My plans. Nothing else was changed.',
    );
    expect(await page.evaluate(() => state.userPlans.length)).toBe((present ? 1 : 0) + 2);
    const after = await page.evaluate(() => ({
      w: state.workouts.length,
      pr: Object.keys(state.personalRecords).length,
      bm: state.bodyMetrics.length,
      pf: state.profile,
    }));
    expect(after).toEqual(before);
    await expect(page.locator('#hb-io-sheet .hb-io-body [data-io=undo]')).toBeVisible();
    await page.locator('#hb-io-primary, #hb-io-sheet .hb-io-foot button').first().click(); // Show my plans
    await expect(page.locator('#m-browse-mine')).toContainText('Kettlebell basics');
    // the same file again: all present
    await page.evaluate(() => mShowPage('profile'));
    await chooseFile(page, file, 'plans');
    await expect(page.locator('#hb-io-summary')).toContainText(
      /All \d+ plans are already in your plans\. Nothing to add\./,
    );
    await expect(page.locator('#hb-io-primary')).toHaveText('Done');
  });

  test('plans-only: a file with no plans is refused (P0)', async ({ appPage: page, siteURL }) => {
    await openApp(page, siteURL);
    await chooseFile(page, mkDoc({ n: 1 }), 'plans');
    await expect(title(page)).toHaveText('No plans in this file');
    await expect(page.locator('#hb-io-sheet .hb-io-body')).toHaveText(
      'This file has no plans to add. Nothing was changed.',
    );
  });
});

// keep the compiler honest about helpers used only in later groups
void [expectNoChooser, bodyText, fileOf, BAR];
