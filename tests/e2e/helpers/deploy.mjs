// Helpers for update-flow tests (T4a): two builds of the shell served from ONE site directory, so
// registration, caches and localStorage persist across "deploys" (one origin; two ports would be
// two origins and could not test an upgrade). A deploy copies a build over the site directory,
// sw.js last, like publishing a release. Nothing here touches the repo's own files.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../scripts/serve.mjs';
import { listShellFiles, run as stamp } from '../../../scripts/stamp-sw.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The VERSION stamped into a directory's sw.js. */
export async function versionOf(dir) {
  const text = await readFile(join(dir, 'sw.js'), 'utf8');
  return /const VERSION = '([0-9a-f]{12})';/.exec(text)[1];
}

async function copyShell(from, to) {
  const files = [...(await listShellFiles(from)), 'sw.js'];
  for (const f of files) {
    await mkdir(dirname(join(to, f)), { recursive: true });
    await cp(join(from, f), join(to, f));
  }
}

/** A copy of the repo's shipped shell (release "v1"). */
export async function buildCurrent() {
  const dir = await mkdtemp(join(tmpdir(), 'hb-build-cur-'));
  await copyShell(root, dir);
  return {
    dir,
    version: await versionOf(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** The shell with one HTML comment appended to index.html and sw.js restamped in the copy ("v2"). */
export async function buildVariant() {
  const dir = await mkdtemp(join(tmpdir(), 'hb-build-var-'));
  await copyShell(root, dir);
  const html = await readFile(join(dir, 'index.html'), 'utf8');
  await writeFile(join(dir, 'index.html'), html + '\n<!-- hb-test-variant: next release -->\n');
  const result = await stamp(dir);
  if (result.code !== 0) throw new Error(result.message);
  return {
    dir,
    version: await versionOf(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function deployInto(buildDir, siteDir) {
  const files = (await listShellFiles(buildDir)).filter((f) => f !== 'sw.js');
  for (const f of files) {
    await mkdir(dirname(join(siteDir, f)), { recursive: true });
    await cp(join(buildDir, f), join(siteDir, f));
  }
  await cp(join(buildDir, 'sw.js'), join(siteDir, 'sw.js')); // last: the browser sees a complete release
}

/** One static site on one origin. `deploy(buildDir)` publishes a build over it. */
export async function createSite(buildDir) {
  const dir = await mkdtemp(join(tmpdir(), 'hb-site-'));
  await deployInto(buildDir, dir);
  const server = await startServer(dir, 0);
  return {
    dir,
    url: server.url,
    deploy: (build) => deployInto(build, dir),
    /** Replace sw.js with different bytes but the same VERSION (a rebuilt, identical release). */
    async redeploySameVersion(build) {
      await deployInto(build, dir);
      const sw = await readFile(join(dir, 'sw.js'), 'utf8');
      await writeFile(join(dir, 'sw.js'), sw + '\n// same release, different bytes\n');
    },
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Abort every request that is not for the site origin and remember it (principle 4). */
export async function blockExternal(context, siteURL) {
  const external = [];
  const origin = new URL(siteURL).origin;
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('data:') || u.startsWith('blob:') || new URL(u).origin === origin) {
      return route.continue();
    }
    external.push(u);
    return route.abort();
  });
  return external;
}

/** Write localStorage on the site origin before the app (and its worker) has ever loaded. */
export async function seedOrigin(page, siteURL, entries) {
  await page.goto(siteURL + 'manifest.json'); // same origin, no app script, no worker
  await page.evaluate((items) => {
    for (const [k, v] of Object.entries(items)) globalThis.localStorage.setItem(k, v);
  }, entries);
}

/**
 * Observers installed in every document before the app runs. They only watch: `__log` gets an
 * entry when the update banner is shown (with whether a workout was active and how many toasts
 * were on screen) and when the workout layer is removed; `__toasts` collects toast texts;
 * `__replies` counts GET_VERSION answers the page received; `__updates` counts reg.update().
 */
export async function installProbes(page) {
  await page.addInitScript(() => {
    const g = globalThis;
    g.__log = [];
    g.__toasts = [];
    g.__replies = 0;
    g.__updates = 0;
    const OrigMC = g.MessageChannel;
    g.__RawMC = OrigMC; // the tests' own probes use this one, so they are not counted
    g.MessageChannel = class extends OrigMC {
      constructor() {
        super();
        this.port1.addEventListener('message', () => g.__replies++);
      }
    };
    const origUpdate = g.ServiceWorkerRegistration?.prototype.update;
    if (origUpdate) {
      g.ServiceWorkerRegistration.prototype.update = function (...a) {
        g.__updates++;
        return origUpdate.apply(this, a);
      };
    }
    const active = () =>
      g.localStorage.getItem('hb_active_workout') !== null ||
      !!g.document.getElementById('wm-overlay');
    new g.MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target.id === 'hb-update' && !r.target.hidden) {
          const toasts = g.document.getElementById('m-toasts')?.childElementCount ?? 0;
          g.__log.push({ e: 'banner-shown', t: g.performance.now(), active: active(), toasts });
        }
        for (const n of r.removedNodes) {
          if (n.id === 'wm-overlay') g.__log.push({ e: 'overlay-removed', t: g.performance.now() });
        }
        for (const n of r.addedNodes) {
          if (n.classList?.contains('m-toast')) g.__toasts.push(n.textContent);
        }
      }
    }).observe(g.document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
  });
}
