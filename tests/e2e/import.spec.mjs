// T7a: import, Undo and export through the console API (HB.io), in a real browser. No UI yet (T7b).
// The lazy modules load in the page, offline too; nothing is written until apply().
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, seedStorage, seedData } from './helpers/seed.mjs';
import { SYNTHETIC_DIR, loadRealExport } from '../unit/helpers/load-fixtures.mjs';

const REAL_TEXT = JSON.stringify(loadRealExport());
const OLD_TEXT = readFileSync(join(SYNTHETIC_DIR, 'homebody_v1.json'), 'utf8'); // two workouts
const OLD = JSON.parse(OLD_TEXT);
const N = seedData().workouts.length;
const HOSTILE = readFileSync(join(SYNTHETIC_DIR, 'import', 'hostile_strings_allowed.json'), 'utf8');

const ready = async (page) => {
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!window.HB && state.workouts.length > 0,
  );
  await page.evaluate(() => HB.storage.ready());
};
const open = async (page, siteURL, data = OLD_TEXT) => {
  await seedStorage(page, { vaultfit_v1: data, hb_seen_guide: '1' });
  await page.goto(siteURL + 'index.html');
  await ready(page);
};
const idbWorkouts = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = globalThis.indexedDB.open('homebody');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['workouts', 'snapshots'], 'readonly');
          const out = {};
          tx.objectStore('workouts').getAll().onsuccess = (e) => (out.workouts = e.target.result);
          tx.objectStore('snapshots').getAll().onsuccess = (e) =>
            (out.snaps = e.target.result.map((s) => s.reason));
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
        };
      }),
  );
const mirror = (page) =>
  page.evaluate(() => {
    const { hbSeq, ...rest } = JSON.parse(localStorage.getItem('vaultfit_v1')); // eslint-disable-line no-unused-vars
    return rest;
  });

test.describe('import through HB.io', () => {
  test('import the fixture over different data: replaced, snapshotted, mirrored, survives reload @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await open(page, siteURL);
    const before = await mirror(page);
    expect(before.workouts).toHaveLength(OLD.workouts.length);
    const out = await page.evaluate(async (text) => {
      const imp = await HB.io.importFile(new globalThis.File([text], 'x.vaultfit'));
      const summary = imp.summary;
      const res = await imp.apply({ mode: 'replace' });
      return { summary, n: res.doc.workouts.length, undo: await imp.checkUndo() };
    }, REAL_TEXT);
    expect(out.summary.current.workouts).toBe(OLD.workouts.length);
    expect(out.summary.replace.workoutsRemoved).toBe(OLD.workouts.length);
    expect(out.n).toBe(N);
    expect(out.undo).toEqual({ laterChanges: false });
    const mid = await idbWorkouts(page);
    expect(mid.workouts).toHaveLength(N);
    expect(mid.snaps).toContain('pre-import');
    expect((await mirror(page)).workouts).toHaveLength(N);

    await page.reload();
    await ready(page);
    expect((await mirror(page)).workouts).toHaveLength(N);
  });

  test('AC2: Undo restores the previous state exactly @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await open(page, siteURL);
    const before = await mirror(page);
    await page.evaluate(async (text) => {
      const imp = await HB.io.importFile(new globalThis.File([text], 'x.vaultfit'));
      await imp.apply({ mode: 'replace' });
      await imp.undo();
      globalThis.__undone = true;
    }, REAL_TEXT);
    // the store is read-only until reload; after it the state is exactly the earlier one
    await page.reload();
    await ready(page);
    expect(await mirror(page)).toEqual(before);
    expect((await idbWorkouts(page)).workouts).toHaveLength(OLD.workouts.length);
  });

  test('a v1 export imports; a current export re-imports to the identical state', async ({
    appPage: page,
    siteURL,
  }) => {
    await open(page, siteURL);
    const r = await page.evaluate(async (text) => {
      const imp = await HB.io.importFile(new globalThis.File([text], 'old.vaultfit'));
      const v = imp.summary.file.version; // the fixture is a v1 export
      const res = await imp.apply({ mode: 'replace' });
      const payload = res.doc; // the caller replaces its state from this (T7b does)
      const e = await HB.io.exportFile(payload);
      return { v, ok: e.ok, filename: e.filename, text: e.text, warnings: e.warnings };
    }, REAL_TEXT);
    expect(r.v).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.filename).toMatch(/^HomeBody_\d{4}-\d{2}-\d{2}\.vaultfit$/);
    expect(r.warnings).toEqual({ refused: [], dropped: 0 });
    const head = JSON.parse(r.text);
    expect(head._version).toBe(2);
    expect(head._containsHealthData).toBe(true);
    expect('_name' in head).toBe(false);
    // re-import that export over the same data: nothing new, then replace gives the same state
    const after = await page.evaluate(async (text) => {
      const imp = await HB.io.importFile(new globalThis.File([text], 'cur.vaultfit'));
      const s = imp.summary;
      await imp.apply({ mode: 'replace' });
      return {
        present: s.merge.workoutsPresent,
        added: s.merge.workoutsAdded,
        n: state.workouts.length,
      };
    }, r.text);
    expect(after.present).toBe(N);
    expect(after.added).toBe(0);
    const stored = await mirror(page);
    expect(stored.workouts).toEqual(seedData().workouts);
    expect(stored.userPlans).toEqual(seedData().userPlans);
    expect(stored.personalRecords).toEqual(seedData().personalRecords);
  });

  test('hostile files change nothing and run nothing; hostile-looking text is kept as data', async ({
    appPage: page,
    siteURL,
  }) => {
    await open(page, siteURL);
    const outcome = await page.evaluate(
      async ([hostile, protoKey]) => {
        const refusals = [];
        for (const t of [
          '{"_vaultfit":true,"workouts":[{"id":1,"name":"<img src=x onerror=window.__pwned=1>","date":"2026-10-01T00:00:00.000Z","exercises":[]}]}',
          protoKey,
          'not json',
          '{"_vaultfit":true,"_version":99,"workouts":[]}',
        ]) {
          try {
            await HB.io.importFile(new globalThis.File([t], 'x.vaultfit'));
            refusals.push('accepted');
          } catch (e) {
            refusals.push(`${e.kind}:${e.reason}`);
          }
        }
        const imp = await HB.io.importFile(new globalThis.File([hostile], 'h.vaultfit'));
        await imp.apply({ mode: 'merge' });
        return { refusals, pwned: window.__pwned, names: state.workouts.map((w) => w.name) };
      },
      [
        HOSTILE,
        '{"_vaultfit":true,"workouts":[],"personalRecords":{"__proto__":{"value":1,"unit":"kg"}}}',
      ],
    );
    expect(outcome.refusals).toEqual([
      'invalid:bad-chars',
      'invalid:bad-key',
      'invalid:not-json',
      'invalid:newer-version',
    ]);
    expect(outcome.pwned).toBeUndefined();
    expect(await page.evaluate(() => ({}).polluted)).toBeUndefined();
    const stored = await mirror(page);
    expect(stored.workouts.some((w) => w.name.includes('alert(1)'))).toBe(true);
    expect(stored.workouts).toHaveLength(OLD.workouts.length + 1);
  });

  test('refused while a workout is in progress; the size limit is checked before reading', async ({
    appPage: page,
    siteURL,
  }) => {
    await open(page, siteURL);
    const r = await page.evaluate(async (text) => {
      const imp = await HB.io.importFile(new globalThis.File([text], 'x.vaultfit'));
      localStorage.setItem('hb_active_workout', '{"name":"x"}');
      let kind = null;
      try {
        await imp.apply({ mode: 'replace' });
      } catch (e) {
        kind = e.kind;
      }
      localStorage.removeItem('hb_active_workout');
      const big = { size: 21 * 1024 * 1024, text: () => Promise.reject(new Error('read')) };
      let size = null;
      try {
        await HB.io.importFile(big);
      } catch (e) {
        size = `${e.kind}:${e.reason}`;
      }
      return { kind, size };
    }, REAL_TEXT);
    expect(r).toEqual({ kind: 'workout-active', size: 'invalid:too-large' });
    expect((await idbWorkouts(page)).workouts).toHaveLength(OLD.workouts.length);
  });

  test('the handle: recheck, dispose, plans-only, read failure', async ({
    appPage: page,
    siteURL,
  }) => {
    await open(page, siteURL);
    const r = await page.evaluate(async (text) => {
      const out = {};
      const imp = await globalThis.HB.io.importFile(new globalThis.File([text], 'x.vaultfit'));
      out.again = (await imp.recheck()).file.workouts; // "Check again": same file, fresh numbers
      out.plansListed = imp.summary.plans.total;
      const res = await imp.apply({ mode: 'plans' });
      out.plansOnly = { workouts: res.doc.workouts.length, plans: res.doc.userPlans.length };
      const again = await imp.recheck().then(
        (s) => s.onlyPlans.plansAdded,
        (e) => e.kind,
      );
      out.afterApply = again; // the text is dropped once applied
      const h2 = await globalThis.HB.io.importFile(new globalThis.File([text], 'x.vaultfit'));
      h2.dispose();
      out.disposed = await h2.apply({ mode: 'merge' }).then(
        () => 'applied',
        (e) => e.kind,
      );
      out.readFailed = await globalThis.HB.io
        .importFile({ size: 10, text: () => Promise.reject(new Error('gone')) })
        .then(
          () => 'ok',
          (e) => e.kind,
        );
      return out;
    }, REAL_TEXT);
    expect(r.again).toBe(N);
    expect(r.plansListed).toBe(1);
    expect(r.plansOnly).toEqual({ workouts: OLD.workouts.length, plans: 1 });
    expect(r.afterApply).toBe('consumed');
    expect(r.disposed).toBe('consumed');
    expect(r.readFailed).toBe('read-failed');
  });

  test('a plain export in an unreadable state is marked partial', async ({
    appPage: page,
    siteURL,
  }) => {
    await open(page, siteURL);
    await page.evaluate(() => {
      // simulate the store going read-only (newer data) the way the page would see it
      return new Promise((resolve) => {
        const r = globalThis.indexedDB.open('homebody');
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put(99, 'schemaVersion');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    });
    await page.reload();
    await page.waitForFunction(() => !!window.HB);
    await page.evaluate(() => HB.storage.ready());
    const e = await page.evaluate(() => HB.io.exportFile({ workouts: [] }));
    expect(e.partial).toBe(true);
    expect(e.filename).toMatch(/^HomeBody_partial_/);
    expect(JSON.parse(e.text)._partialReason).toBe('newer');
  });
});

test.describe('lazy modules and offline', () => {
  test.use({ serviceWorkers: 'allow' });

  test('first paint does not fetch the import modules; they load on first use, offline too @smoke', async ({
    context,
    page,
    siteURL,
  }) => {
    const requests = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await seedStorage(page, { vaultfit_v1: OLD_TEXT, hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await ready(page);
    expect(requests.some((p) => p.includes('/src/storage/'))).toBe(false);
    // wait for the service worker to hold the modules, then go offline
    await page.waitForFunction(() => !!globalThis.navigator.serviceWorker.controller);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const names = (await globalThis.caches.keys()).filter((n) => n.startsWith('homebody-'));
          if (!names.length) return false;
          const keys = (await (await globalThis.caches.open(names[0])).keys()).map(
            (k) => new URL(k.url).pathname,
          );
          return (
            keys.includes('/src/storage/import-export.js') &&
            keys.includes('/src/storage/validate.js')
          );
        }),
      )
      .toBe(true);
    await context.setOffline(true);
    const s = await page.evaluate(async (text) => {
      const imp = await HB.io.importFile(new globalThis.File([text], 'x.vaultfit'));
      return imp.summary.file.workouts;
    }, REAL_TEXT);
    expect(s).toBe(N);
    expect(requests.some((p) => p.includes('/src/storage/import-export.js'))).toBe(true);
  });
});
