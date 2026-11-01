// T6a: the IndexedDB engine in a real browser. Migration and the v1 mirror, the shared contract
// suite on real IndexedDB, fallback to localStorage, restore from the console, write failure, a
// kill between the mirror write and the commit, and versionchange. Goldens, update and offline
// specs run unchanged beside this file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, seedStorage, seedData } from './helpers/seed.mjs';
import { test as base } from '@playwright/test';
import { SYNTHETIC_DIR } from '../unit/helpers/load-fixtures.mjs';
import { buildCurrent, createSite } from './helpers/deploy.mjs';
import { buildPreM1 } from './helpers/snapshot.mjs';

const SEED = seedData();
const SEED_TEXT = JSON.stringify(SEED);
const N = SEED.workouts.length;
const ACTIVE = readFileSync(join(SYNTHETIC_DIR, 'hb_active_workout.json'), 'utf8');
const BAR = '#hb-save';

/** The app is up AND the storage engine has been attached (IndexedDB opens after first paint). */
const ready = async (page) => {
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!window.HB && state.workouts.length > 0,
  );
  await page.evaluate(() => HB.storage.ready());
};

/** Read every IndexedDB store of the app database, then close the connection. */
const dump = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = globalThis.indexedDB.open('homebody');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const names = ['workouts', 'records', 'meta', 'snapshots'];
          const tx = db.transaction(names, 'readonly');
          const out = {};
          const keys = {};
          for (const n of names) {
            const s = tx.objectStore(n);
            s.getAll().onsuccess = (e) => (out[n] = e.target.result);
            s.getAllKeys().onsuccess = (e) => (keys[n] = e.target.result);
          }
          tx.oncomplete = () => {
            db.close();
            const meta = Object.fromEntries(keys.meta.map((k, i) => [k, out.meta[i]]));
            resolve({ workouts: out.workouts, meta, snapshots: out.snapshots });
          };
        };
      }),
  );

const mirror = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('vaultfit_v1')));

/** Force IndexedDB trouble per session (survives reloads through sessionStorage). */
async function idbMode(page) {
  await page.addInitScript(() => {
    const mode = sessionStorage.getItem('hb_test_idb');
    if (mode === 'missing') Object.defineProperty(window, 'indexedDB', { value: undefined });
    if (mode === 'hang') globalThis.IDBFactory.prototype.open = () => ({}); // never answers
    if (mode === 'error') {
      globalThis.IDBFactory.prototype.open = () => {
        const r = {};
        setTimeout(() => r.onerror && r.onerror(), 0);
        return r;
      };
    }
  });
}
const setMode = (page, m) =>
  page.evaluate(
    (x) =>
      x ? sessionStorage.setItem('hb_test_idb', x) : sessionStorage.removeItem('hb_test_idb'),
    m,
  );

/** Capture opened connections and let a test make writes fail like a full disk. */
async function idbProbes(page) {
  await page.addInitScript(() => {
    window.__dbs = [];
    window.__txFail = false;
    const open = globalThis.IDBFactory.prototype.open;
    globalThis.IDBFactory.prototype.open = function (...a) {
      const r = open.apply(this, a);
      r.addEventListener('success', () => {
        const db = r.result;
        window.__dbs.push(db);
        const tx = db.transaction.bind(db);
        db.transaction = (names, mode) => {
          if (window.__txFail && mode === 'readwrite') {
            throw new DOMException('quota', 'QuotaExceededError');
          }
          return tx(names, mode);
        };
      });
      return r;
    };
  });
}

async function openApp(page, siteURL, seed = { vaultfit_v1: SEED_TEXT, hb_seen_guide: '1' }) {
  await seedStorage(page, seed);
  await page.goto(siteURL + 'index.html');
  await ready(page);
}

test.describe('migration and the v1 mirror', () => {
  test('first boot: IndexedDB holds the data, the snapshot is the seeded text, vaultfit_v1 is intact @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    const d = await dump(page);
    expect(d.workouts).toHaveLength(N);
    expect(d.meta.schemaVersion).toBe(2);
    expect(d.snapshots).toHaveLength(1);
    expect(d.snapshots[0].reason).toBe('pre-migration');
    expect(d.snapshots[0].payload).toBe(SEED_TEXT); // byte for byte
    // the source key is left exactly as found (the app has not saved yet)
    expect(await page.evaluate(() => localStorage.getItem('vaultfit_v1'))).toBe(SEED_TEXT);
    expect(await page.evaluate(() => HB.storage.status())).toMatchObject({
      engine: 'indexedDB',
      snapshots: true,
      mirror: 'ok',
    });
    // the first save stamps the mirror with the commit counter and the sidecar remembers it
    await page.evaluate(() => persistSave());
    await expect.poll(async () => (await dump(page)).meta.seq).toBe(2);
    expect((await mirror(page)).hbSeq).toBe(2);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('hb_storage_meta')).idbSeq),
    ).toBe(2);
    // running the app again does not migrate again
    await page.reload();
    await ready(page);
    const again = await dump(page);
    expect(again.snapshots).toHaveLength(1);
    expect(again.meta.migratedAt).toBe(d.meta.migratedAt);
    // every localStorage key the app uses is on the single list
    const extra = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => !globalThis.HBStorage.KEYS.localStorage.includes(k)),
    );
    expect(extra).toEqual([]);
  });

  test('legacy key alone is adopted into IndexedDB and left unchanged @smoke', async ({
    appPage: page,
    siteURL,
  }) => {
    const raw = readFileSync(join(SYNTHETIC_DIR, 'homebody_v1.json'), 'utf8');
    const n = JSON.parse(raw).workouts.length;
    await seedStorage(page, { homebody_v1: raw, hb_seen_guide: '1' });
    await page.goto(siteURL + 'index.html');
    await page.waitForFunction(() => !!window.HB && state.workouts.length > 0);
    expect((await dump(page)).workouts).toHaveLength(n);
    expect(await page.evaluate(() => localStorage.getItem('homebody_v1'))).toBe(raw);
  });
});

base.describe('AC4: the pre-M1 build sees the history after migration', () => {
  base.use({ locale: 'en-GB', timezoneId: 'UTC' });
  base('log a workout, then run the pre-M1 index.html on the same profile', async ({ browser }) => {
    const old = await buildPreM1();
    const cur = await buildCurrent();
    const site = await createSite(cur.dir);
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await ctx.newPage();
      await ctx.route('**/*', (route) =>
        route.request().url().startsWith(site.url) ? route.continue() : route.abort(),
      );
      await page.goto(site.url + 'manifest.json');
      await page.evaluate(
        ([k, v]) => {
          localStorage.setItem(k, v);
          localStorage.setItem('hb_seen_guide', '1');
        },
        ['vaultfit_v1', SEED_TEXT],
      );
      await page.goto(site.url + 'index.html');
      await ready(page);
      await page.evaluate(() => {
        state.workouts.push({
          id: 5150,
          name: 'Logged after migration',
          date: new Date().toISOString(),
          exercises: [],
        });
        return persistSave();
      });
      expect((await dump(page)).workouts).toHaveLength(N + 1);
      await site.deploy(old.dir); // the same origin and profile now serves the frozen pre-M1 build
      await page.goto(site.url + 'index.html');
      await page.waitForFunction(
        () => typeof state !== 'undefined' && document.readyState === 'complete',
      );
      expect(await page.evaluate(() => state.workouts.length)).toBe(N + 1);
      expect(await page.evaluate(() => state.workouts.some((w) => w.id === 5150))).toBe(true);
    } finally {
      await ctx.close();
      await site.close().catch(() => {});
      await old.cleanup();
      await cur.cleanup();
    }
  });
});

test.describe('the shared engine contract on real IndexedDB (AC1)', () => {
  test('every case passes', async ({ appPage: page, siteURL }) => {
    await openApp(page, siteURL);
    const results = await page.evaluate(async () => {
      const { cases } = await import('/tests/contract/engine-contract.mjs');
      const out = [];
      for (const c of cases) {
        const name = 'hbtest-' + Math.random().toString(36).slice(2);
        let quota = false;
        const factory = {
          open(n, v) {
            const r = globalThis.indexedDB.open(n, v);
            r.addEventListener('success', () => {
              const db = r.result;
              const tx = db.transaction.bind(db);
              db.transaction = (...a) => {
                if (quota) throw new DOMException('quota', 'QuotaExceededError');
                return tx(...a);
              };
            });
            return r;
          },
        };
        const engine = globalThis.HBStorage.createIdbEngine({ factory, name, timeoutMs: 5000 });
        await engine.open();
        const ctx = {
          engine,
          project: globalThis.HBStorage.projectToV1,
          poison: () => () => 1,
          faults: {
            quota: (on) => (quota = on),
            seedFuture: () =>
              engine.writeDoc({ workouts: [], schemaVersion: 99 }, { seq: 1, schema: 99 }),
            seedCorrupt: () =>
              new Promise((res, rej) => {
                const r = globalThis.indexedDB.open(name);
                r.onsuccess = () => {
                  const db = r.result;
                  const t = db.transaction('workouts', 'readwrite');
                  t.objectStore('workouts').put({ id: 1 }, 0);
                  t.oncomplete = () => (db.close(), res());
                  t.onabort = () => rej(t.error);
                };
              }),
          },
        };
        try {
          await c.run(ctx);
          out.push({ name: c.name, ok: true });
        } catch (e) {
          out.push({ name: c.name, ok: false, err: String(e) });
        } finally {
          engine.close();
          globalThis.indexedDB.deleteDatabase(name);
        }
      }
      return out;
    });
    expect(results.length).toBeGreaterThanOrEqual(9);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
});

test.describe('IndexedDB unavailable (AC5)', () => {
  for (const [mode, reason] of [
    ['missing', 'idb-unavailable'],
    ['error', 'idb-unavailable'],
    ['hang', 'idb-timeout'],
  ]) {
    test(`${mode}: the app runs on localStorage, finishes a workout, and the next good boot imports it ${mode === 'missing' ? '@smoke' : ''}`, async ({
      appPage: page,
      siteURL,
    }) => {
      await idbMode(page);
      await page.goto(siteURL + 'manifest.json'); // same origin; nothing of the app has loaded
      await page.evaluate(
        ([a, b]) => {
          localStorage.setItem('vaultfit_v1', a);
          localStorage.setItem('hb_seen_guide', b);
        },
        [SEED_TEXT, '1'],
      );
      await page.goto(siteURL + 'index.html'); // a normal boot first: IndexedDB now holds the history
      await ready(page);
      await setMode(page, mode);
      await page.evaluate((c) => localStorage.setItem('hb_active_workout', c), ACTIVE);
      await page.reload();
      await page.waitForFunction(
        () => typeof state !== 'undefined' && !!window.HB && state.workouts.length > 0,
      );
      await page.evaluate(() => HB.storage.ready());
      expect(
        await page.evaluate(() => document.documentElement.classList.contains('hb-booting')),
      ).toBe(false);
      expect(await page.evaluate(() => HB.storage.status())).toMatchObject({
        engine: 'localStorage',
        fallback: reason,
        snapshots: false,
      });
      await page.locator('.wm-finish-btn').click();
      await page.getByRole('button', { name: 'Save Workout' }).click();
      await expect.poll(() => page.evaluate(() => state.workouts.length)).toBe(N + 1);
      const blob = await mirror(page);
      expect(blob.workouts).toHaveLength(N + 1);
      expect(blob.hbSeq).toBeUndefined(); // an unmarked blob: the next IndexedDB boot imports it
      await setMode(page, null);
      await page.reload();
      await ready(page);
      expect(await page.evaluate(() => state.workouts.length)).toBe(N + 1);
      const d = await dump(page);
      expect(d.workouts).toHaveLength(N + 1);
      const rec = d.snapshots.find((x) => x.reason === 'pre-reconcile');
      expect(rec).toBeTruthy(); // the state IndexedDB held is recoverable
      expect(JSON.parse(rec.payload).workouts).toHaveLength(N);
    });
  }
});

test.describe('snapshots, failure and the boot rule', () => {
  test('AC6: restore(id) from the console, then reload: history equals the snapshot', async ({
    appPage: page,
    siteURL,
  }) => {
    await openApp(page, siteURL);
    await page.evaluate(() => {
      state.workouts.length = 3;
      return persistSave();
    });
    const list = await page.evaluate(() => HB.storage.snapshots());
    expect(list[0]).toMatchObject({ reason: 'pre-migration', schemaVersion: 1 });
    expect(list[0].payload).toBeUndefined();
    await page.evaluate((id) => HB.storage.restore(id), list[0].id);
    await page.reload();
    await ready(page);
    expect(await page.evaluate(() => state.workouts.length)).toBe(N);
    const after = await page.evaluate(() => HB.storage.snapshots());
    expect(after.map((s) => s.reason)).toEqual(['pre-migration', 'pre-restore']);
    const m = await mirror(page);
    expect(m.workouts).toHaveLength(N);
  });

  test('restore refuses while a workout is in progress', async ({ appPage: page, siteURL }) => {
    await openApp(page, siteURL, {
      vaultfit_v1: SEED_TEXT,
      hb_seen_guide: '1',
      hb_active_workout: ACTIVE,
    });
    const id = (await page.evaluate(() => HB.storage.snapshots()))[0].id;
    const kind = await page.evaluate(
      (i) =>
        HB.storage.restore(i).then(
          () => 'restored',
          (e) => e.kind,
        ),
      id,
    );
    expect(kind).toBe('workout-active');
  });

  test('forced quota on the IndexedDB write: the bar shows, the data stays in memory and the mirror, Retry saves', async ({
    appPage: page,
    siteURL,
  }) => {
    await idbProbes(page);
    await openApp(page, siteURL);
    await page.evaluate(() => {
      window.__txFail = true;
      state.workouts.push({
        id: 6001,
        name: 'Quota probe',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    await expect(page.locator(BAR)).toBeVisible();
    await expect(page.locator(BAR)).toContainText('Not saved. Keep HomeBody open.');
    expect(await page.evaluate(() => state.workouts.length)).toBe(N + 1);
    expect((await mirror(page)).workouts).toHaveLength(N + 1);
    await page.evaluate(() => (window.__txFail = false));
    await page.locator(`${BAR} button`).first().click();
    await expect(page.locator(BAR)).toContainText('Everything is saved on this device.');
    expect((await dump(page)).workouts).toHaveLength(N + 1);
  });

  test('an IndexedDB write failure shows the bar; a mirror-only failure does not', async ({
    appPage: page,
    siteURL,
  }) => {
    await idbProbes(page);
    await page.addInitScript(() => {
      window.__mirrorFail = false;
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'vaultfit_v1' && window.__mirrorFail) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        return orig.call(this, k, v);
      };
    });
    await openApp(page, siteURL);
    await page.evaluate(() => {
      window.__mirrorFail = true;
      return persistSave();
    });
    await expect(page.locator(BAR)).toBeHidden();
    expect(await page.evaluate(() => HB.storage.status())).toMatchObject({ mirror: 'stale' });
    await page.evaluate(() => {
      window.__mirrorFail = false;
      window.__txFail = true;
      persistSave();
    });
    await expect(page.locator(BAR)).toBeVisible();
  });

  test('killed between the mirror write and the IndexedDB commit: the next boot adopts the mirror', async ({
    appPage: page,
    siteURL,
  }) => {
    await idbProbes(page);
    await openApp(page, siteURL);
    await page.evaluate(() => {
      window.__txFail = true; // the commit never happens
      state.workouts.push({
        id: 6002,
        name: 'Kill probe',
        date: new Date().toISOString(),
        exercises: [],
      });
      persistSave();
    });
    expect((await mirror(page)).hbSeq).toBe(2);
    expect((await dump(page)).workouts).toHaveLength(N);
    await page.reload(); // the "OS kill": a fresh page, no fault
    await ready(page);
    expect(await page.evaluate(() => state.workouts.some((w) => w.id === 6002))).toBe(true);
    const d = await dump(page);
    expect(d.workouts).toHaveLength(N + 1);
    expect(d.snapshots.map((s) => s.reason)).toContain('pre-reconcile');
  });

  test('onversionchange closes the connection; the next save reopens it', async ({
    appPage: page,
    siteURL,
  }) => {
    await idbProbes(page);
    await openApp(page, siteURL);
    const opened = await page.evaluate(() => window.__dbs.length);
    const closed = await page.evaluate(() => {
      window.__dbs[0].dispatchEvent(new globalThis.Event('versionchange'));
      try {
        window.__dbs[0].transaction('meta');
        return false;
      } catch (e) {
        return e.name === 'InvalidStateError';
      }
    });
    expect(closed).toBe(true);
    await page.evaluate(() => {
      state.workouts.push({
        id: 6003,
        name: 'After versionchange',
        date: new Date().toISOString(),
        exercises: [],
      });
      return persistSave();
    });
    expect(await page.evaluate(() => window.__dbs.length)).toBe(opened + 1);
    expect((await dump(page)).workouts).toHaveLength(N + 1);
  });
});
