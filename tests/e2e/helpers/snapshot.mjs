// T4b: assembles the frozen pre-M1 build (docs/reference/pre-m1-d642b2b/*.frozen) into a temp
// directory under its real file names, so it can be served as "release v1" by createSite().
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SNAPSHOT_DIR = join(root, 'docs', 'reference', 'pre-m1-d642b2b');
export const SNAPSHOT_FILES = [
  'index.html',
  'sw.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
];
export const SNAPSHOT_SHA256 = {
  'index.html': '2018b54cfcd50beb9e293b721a7b1150a42c13c514fb252e224be13f711ff191',
  'sw.js': 'fef3e6a3052d59621eb6e1f05791957231a1bfe1ff77fade2aea100db6cc1182',
  'manifest.json': '607908bd6b998d8cd198827258266b90cad73ba6ddcba5eb83bd0a5e77f5ca0c',
  'icon-192.png': '4ab4b4a7c631d1e3ec007c30bf1c740fa6a880a09a20856babd2432b8568d46a',
  'icon-512.png': 'b0cee395124c019438800d0e6165e5bddf0bf97a9cc39829a54046a9da2819a7',
};

/** A temp directory holding the pre-M1 build under its real names. */
export async function buildPreM1() {
  const dir = await mkdtemp(join(tmpdir(), 'hb-build-prem1-'));
  try {
    for (const f of SNAPSHOT_FILES) await copyFile(join(SNAPSHOT_DIR, f + '.frozen'), join(dir, f));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
