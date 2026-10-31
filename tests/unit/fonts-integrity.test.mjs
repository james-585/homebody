// Self-hosted fonts match their provenance record (fonts/SOURCES.md) and nothing external remains.
// This proves "unchanged since commit", not authenticity; see fonts/SOURCES.md for how to re-fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFile(join(root, p));

async function records() {
  const md = (await read('fonts/SOURCES.md')).toString('utf8');
  const table = md.split('<!-- fonts-table:begin -->')[1].split('<!-- fonts-table:end -->')[0];
  const rows = table
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| File') && !l.startsWith('| ---'))
    .map((l) => l.split('|').map((c) => c.trim()));
  return rows.map((c) => ({ file: c[1], bytes: Number(c[4]), sha: c[5] }));
}

test('every file in SOURCES.md exists with the recorded size and SHA-256', async () => {
  const recs = await records();
  assert.equal(recs.length, 4);
  for (const r of recs) {
    const data = await read(`fonts/${r.file}`);
    assert.equal(data.length, r.bytes, r.file);
    assert.equal(createHash('sha256').update(data).digest('hex'), r.sha, r.file);
  }
});

test('woff2 files have the wOF2 magic and a plausible size', async () => {
  for (const r of (await records()).filter((x) => x.file.endsWith('.woff2'))) {
    const data = await read(`fonts/${r.file}`);
    assert.equal(data.subarray(0, 4).toString('latin1'), 'wOF2', r.file);
    assert.ok(data.length > 5_000 && data.length < 150_000, `${r.file} ${data.length}`);
  }
});

test('both licence files exist and are the SIL OFL 1.1', async () => {
  for (const f of ['fonts/OFL-Oswald.txt', 'fonts/OFL-Inter.txt']) {
    assert.match((await read(f)).toString('utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i, f);
  }
});

test('every @font-face url in index.html exists locally', async () => {
  const html = (await read('index.html')).toString('utf8');
  const urls = [...html.matchAll(/@font-face\{[^}]*?url\(([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 2);
  for (const u of urls) {
    assert.match(u, /^fonts\/[A-Za-z0-9._-]+\.woff2$/, u);
    assert.ok((await read(u)).length > 0, u);
  }
});

test('no Google Fonts host remains in index.html or sw.js', async () => {
  for (const f of ['index.html', 'sw.js']) {
    assert.doesNotMatch((await read(f)).toString('utf8'), /googleapis|gstatic/, f);
  }
});
