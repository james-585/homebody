import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersion, run, renderBlock } from '../../scripts/stamp-sw.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SW_BODY = "const CACHE = 'homebody-' + VERSION;\nself.addEventListener('fetch', () => {});\n";
const swWith = (version, body = SW_BODY) => `// head\n${renderBlock(version)}\n${body}`;

/** A throwaway tree: files is { path: contents }, created in the given order. */
async function makeTree(files = {}, sw = swWith('x')) {
  const root = await mkdtemp(join(tmpdir(), 'stamp-sw-'));
  const base = {
    'index.html': '<html>app</html>',
    'manifest.json': '{"name":"x"}',
    'icon-192.png': Buffer.from([1, 2, 3]),
    'sw.js': sw,
    ...files,
  };
  for (const [p, c] of Object.entries(base)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

async function withTree(files, sw, fn) {
  const root = await makeTree(files, sw);
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('hash is stable across two runs', async () => {
  await withTree({}, undefined, async (root) => {
    assert.equal(await computeVersion(root), await computeVersion(root));
    assert.match(await computeVersion(root), /^[0-9a-f]{12}$/);
  });
});

test('hash does not depend on file creation order', async () => {
  const a = await makeTree({ 'src/a.js': 'a', 'src/b.js': 'b', 'fonts/f.woff2': 'f' });
  const b = await makeTree({ 'fonts/f.woff2': 'f', 'src/b.js': 'b', 'src/a.js': 'a' });
  try {
    assert.equal(await computeVersion(a), await computeVersion(b));
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test('hash ignores file mtimes', async () => {
  await withTree({}, undefined, async (root) => {
    const before = await computeVersion(root);
    await utimes(join(root, 'index.html'), new Date(0), new Date(0));
    assert.equal(await computeVersion(root), before);
  });
});

test('one changed byte in a shell file changes the hash', async () => {
  await withTree({}, undefined, async (root) => {
    const before = await computeVersion(root);
    await writeFile(join(root, 'index.html'), '<html>appX</html>');
    assert.notEqual(await computeVersion(root), before);
  });
});

test('a rename changes the hash', async () => {
  await withTree({ 'src/a.js': 'same' }, undefined, async (root) => {
    const before = await computeVersion(root);
    await rm(join(root, 'src/a.js'));
    await writeFile(join(root, 'src/b.js'), 'same');
    assert.notEqual(await computeVersion(root), before);
  });
});

test('adding a shell file changes the hash', async () => {
  for (const added of ['src/new.js', 'fonts/new.woff2', 'icon-512.png']) {
    await withTree({}, undefined, async (root) => {
      const before = await computeVersion(root);
      await mkdir(dirname(join(root, added)), { recursive: true });
      await writeFile(join(root, added), 'x');
      assert.notEqual(await computeVersion(root), before, added);
    });
  }
});

test('files outside the shell do not change the hash', async () => {
  await withTree({}, undefined, async (root) => {
    const before = await computeVersion(root);
    for (const p of ['docs/a.md', 'tests/t.js', 'node_modules/m/i.js', 'README.md', 'src/x.txt']) {
      await mkdir(dirname(join(root, p)), { recursive: true });
      await writeFile(join(root, p), 'noise');
    }
    assert.equal(await computeVersion(root), before);
  });
});

test('sw.js edits outside the block change the hash, edits inside do not', async () => {
  await withTree({}, undefined, async (root) => {
    const before = await computeVersion(root);
    await writeFile(join(root, 'sw.js'), swWith('x', SW_BODY + '// logic edit\n'));
    assert.notEqual(await computeVersion(root), before);
    await writeFile(join(root, 'sw.js'), swWith('somethingelse'));
    assert.equal(await computeVersion(root), before);
  });
});

test('restamping unchanged files is byte-identical and does not write (AC2)', async () => {
  await withTree({}, undefined, async (root) => {
    const first = await run(root);
    assert.equal(first.code, 0);
    assert.equal(first.wrote, true);
    const bytes = await readFile(join(root, 'sw.js'));
    const mtime = (await stat(join(root, 'sw.js'))).mtimeMs;
    const second = await run(root);
    assert.equal(second.code, 0);
    assert.equal(second.wrote, false);
    assert.deepEqual(await readFile(join(root, 'sw.js')), bytes);
    assert.equal((await stat(join(root, 'sw.js'))).mtimeMs, mtime);
  });
});

test('--check passes after stamp and fails on a stale block without writing (AC1)', async () => {
  await withTree({}, undefined, async (root) => {
    assert.equal((await run(root, { check: true })).code, 1); // initial 'x' block is stale
    await run(root);
    assert.equal((await run(root, { check: true })).code, 0);
    await writeFile(join(root, 'index.html'), '<html>changed</html>');
    const sw = await readFile(join(root, 'sw.js'));
    const res = await run(root, { check: true });
    assert.equal(res.code, 1);
    assert.match(res.message, /npm run stamp/);
    assert.deepEqual(await readFile(join(root, 'sw.js')), sw);
  });
});

test('--check fails on missing markers and duplicate markers, and never writes', async () => {
  const duplicated = `${renderBlock('a')}\n${renderBlock('b')}\n`;
  for (const sw of [
    'const CACHE = 1;\n',
    duplicated,
    '// <<< stamp-sw:end\n// >>> stamp-sw:begin\n',
  ]) {
    await withTree({}, sw, async (root) => {
      const res = await run(root, { check: true });
      assert.equal(res.code, 1);
      assert.match(res.message, /marker/);
      assert.equal(await readFile(join(root, 'sw.js'), 'utf8'), sw);
      // stamping refuses too
      assert.equal((await run(root)).code, 1);
      assert.equal(await readFile(join(root, 'sw.js'), 'utf8'), sw);
    });
  }
});

test('the real repo is stamped: a forgotten `npm run stamp` fails npm test too', async () => {
  const res = await run(repoRoot, { check: true });
  assert.equal(res.code, 0, res.message);
});
