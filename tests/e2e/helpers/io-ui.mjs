// Helpers for the import/export UI specs (T7b): the shared copy table from the approved design doc,
// opening the app on a seeded store, choosing files, and real-touch taps.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, seedStorage } from './seed.mjs';
import { SYNTHETIC_DIR, loadRealExport } from '../../unit/helpers/load-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const OLD_TEXT = readFileSync(join(SYNTHETIC_DIR, 'homebody_v1.json'), 'utf8'); // two workouts
export const OLD = JSON.parse(OLD_TEXT);
export const REAL_TEXT = JSON.stringify(loadRealExport());
export const REAL = loadRealExport();
export const BAR = '#hb-save';

/** Every `io.*` string in docs/design/import-preview.md (code spans in table rows), by key. */
export function specCopy() {
  const md = readFileSync(join(root, 'docs', 'design', 'import-preview.md'), 'utf8');
  const map = new Map();
  for (const line of md.split('\n')) {
    const m = /^\| `(io\.[\w.]+)`(?: \*\(12\)\*)? \|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const strs = [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    map.set(m[1], (map.get(m[1]) || []).concat(strs));
  }
  const sing = /singular is: `([^`]+)`/.exec(md);
  if (sing) map.set('io.xw.body', (map.get('io.xw.body') || []).concat(sing[1]));
  return map;
}

export const fileOf = (text, name = 'x.vaultfit') => ({
  name,
  mimeType: 'application/json',
  buffer: Buffer.from(text),
});

export async function openApp(page, siteURL, { data = OLD_TEXT, extra = {}, profile = true } = {}) {
  await seedStorage(page, {
    vaultfit_v1: data,
    hb_seen_guide: '1',
    hb_seen_tutorial: '1',
    ...extra,
  });
  await page.goto(siteURL + 'index.html');
  await page.waitForFunction(() => typeof state !== 'undefined' && !!window.HB);
  await page.evaluate(() => HB.storage.ready());
  if (profile) await page.evaluate(() => window.mShowPage('profile'));
}

export const io = (page, name) => page.locator(`[data-io="${name}"]`);
export const title = (page) => page.locator('#hb-io-title');
export const sheet = (page) => page.locator('#hb-io-sheet');

/** Real touch tap at `frac` across the target, vertical centre (never element.click()). */
export async function tap(page, loc, frac = 0.85) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  await page.touchscreen.tap(b.x + b.width * frac, b.y + b.height / 2);
}

/** Tap Import backup (or Import plans only) and choose a file. */
export async function chooseFile(page, text, kind = 'import', { touch = false } = {}) {
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    touch ? tap(page, io(page, kind)) : io(page, kind).click(),
  ]);
  await fc.setFiles(typeof text === 'string' ? fileOf(text) : text);
}

export async function previewOf(page, text, kind = 'import') {
  await chooseFile(page, text, kind);
  await expect(title(page)).toHaveText(kind === 'plans' ? 'Add plans' : 'Check before importing');
}

/** Tap that should open a refusal, proving no file chooser event fires. */
export async function expectNoChooser(page, kind) {
  let fired = false;
  const on = () => (fired = true);
  page.on('filechooser', on);
  await io(page, kind).click();
  await expect(sheet(page)).toBeVisible(); // the refusal is on screen: the picker did not open
  page.off('filechooser', on);
  expect(fired).toBe(false);
}

export const bodyText = (page) => page.locator('#hb-io-sheet .hb-io-body').innerText();

/** Fault injection for IndexedDB writes (same recipe as storage.spec). */
export async function injectFaults(page) {
  await page.addInitScript(() => {
    window.__fail = { main: false };
    const origTx = globalThis.IDBDatabase.prototype.transaction;
    globalThis.IDBDatabase.prototype.transaction = function (names, mode) {
      if (window.__fail.main && mode === 'readwrite') {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return origTx.apply(this, arguments);
    };
  });
}
/** Hold every IndexedDB write transaction's completion until window.__release() (an apply "in progress"). */
export async function injectHold(page) {
  await page.addInitScript(() => {
    window.__hold = null;
    window.__readGateOn = () => {
      window.__readGate = new Promise((r) => (window.__readRelease = r));
    };
    window.__holdOn = () => {
      window.__hold = new Promise((r) => (window.__release = r));
    };
    const origTx = globalThis.IDBDatabase.prototype.transaction;
    globalThis.IDBDatabase.prototype.transaction = function (names, mode) {
      const tx = origTx.apply(this, arguments);
      if (mode === 'readonly' && window.__readGate) {
        const gate = window.__readGate;
        window.__readGate = null;
        let fn = null;
        Object.defineProperty(tx, 'oncomplete', {
          configurable: true,
          get: () => fn,
          set(f) {
            fn = f;
            tx.addEventListener('complete', (e) => gate.then(() => f.call(tx, e)));
          },
        });
      }
      if (mode === 'readwrite') {
        let fn = null;
        Object.defineProperty(tx, 'oncomplete', {
          configurable: true,
          get: () => fn,
          set(f) {
            fn = f;
            tx.addEventListener('complete', (e) => {
              const g = window.__hold;
              if (g) g.then(() => f.call(tx, e));
              else f.call(tx, e);
            });
          },
        });
      }
      return tx;
    };
  });
}
export const setFault = (page, f) => page.evaluate((x) => Object.assign(window.__fail, x), f);

/** The six sets as the store holds them in the mirror (without the counter). */
export const mirror = (page) =>
  page.evaluate(() => {
    const { hbSeq, ...rest } = JSON.parse(localStorage.getItem('vaultfit_v1')); // eslint-disable-line no-unused-vars
    return rest;
  });
export const idbDoc = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = globalThis.indexedDB.open('homebody');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['workouts', 'snapshots', 'meta'], 'readonly');
          const out = {};
          tx.objectStore('workouts').getAll().onsuccess = (e) => (out.workouts = e.target.result);
          tx.objectStore('snapshots').getAll().onsuccess = (e) =>
            (out.snaps = e.target.result.map((s) => s.reason));
          tx.objectStore('meta').getAll().onsuccess = (e) => (out.meta = e.target.result);
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
        };
      }),
  );

/** A small valid export with `n` workouts on distinct days, ids from `idBase`. */
export function mkDoc({ n = 1, idBase = 9000, plans = [], extra = {} } = {}) {
  const workouts = [];
  for (let i = 0; i < n; i++) {
    workouts.push({
      id: idBase + i,
      name: `Imported ${i}`,
      date: new Date(Date.UTC(2026, 5, 1 + (i % 28), 9, 0, 0)).toISOString(),
      exercises: [{ name: 'DB Bench Press', sets: 3, reps: 8, weight: 20, trackType: 'reps' }],
    });
  }
  return JSON.stringify({
    _vaultfit: true,
    _version: 2,
    _exported: '2026-10-30T10:00:00.000Z',
    workouts,
    personalRecords: {},
    bodyMetrics: [],
    userPlans: plans,
    profile: null,
    favourites: [],
    ...extra,
  });
}
export const mkPlan = (id, name = `Plan ${id}`, days = 2) => ({
  id,
  name,
  level: 'beginner',
  planDays: Array.from({ length: days }, (_, i) => ({
    name: `Day ${i + 1}`,
    exercises: [{ name: 'DB Bench Press', sets: 3, reps: 8, weight: 20, trackType: 'reps' }],
  })),
});

/** Wait until the sheet's slide-in has finished (measurements and real taps need a settled sheet). */
export async function settled(page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState === 'finished'),
  );
}

/** WCAG contrast ratio of an element's text colour against its first opaque background. */
export const ratioOf = (page, sel) =>
  page.evaluate((s) => {
    const lum = (c) => {
      const [r, g, b] = c
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const el = document.querySelector(s);
    let bg = 'rgb(0,0,0)';
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (c && !/rgba\(.*, 0\)|transparent/.test(c)) {
        bg = c;
        break;
      }
    }
    const [x, y] = [lum(getComputedStyle(el).color), lum(bg)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }, sel);
