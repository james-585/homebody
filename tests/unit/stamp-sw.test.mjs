import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeVersion,
  listPrecache,
  listShellFiles,
  run,
  renderBlock,
} from '../../scripts/stamp-sw.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SW_BODY = "const CACHE = 'homebody-' + VERSION;\nself.addEventListener('fetch', () => {});\n";
const swWith = (version, body = SW_BODY) => `// head\n${renderBlock(version, [])}\n${body}`;

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

test('files are listed in byte order, not locale order', async () => {
  // Locale order would put a.js before B.js and 'é' next to 'e'; byte order is B, a, e, é.
  await withTree(
    { 'src/a.js': '1', 'src/B.js': '2', 'src/\u00e9.js': '3', 'src/e.js': '4' },
    undefined,
    async (root) => {
      assert.deepEqual(await listShellFiles(root), [
        'icon-192.png',
        'index.html',
        'manifest.json',
        'src/B.js',
        'src/a.js',
        'src/e.js',
        'src/\u00e9.js',
      ]);
    },
  );
});

test('golden hash pins the path/NUL/length/NUL/bytes framing', async () => {
  const sw = `// head\n${renderBlock('anything', [])}\nconst x = 1;\n`;
  const files = {
    'index.html': 'a',
    'manifest.json': 'bb',
    'src/m.js': 'ccc',
    'fonts/f.woff2': 'dddd',
  };
  const root = await mkdtemp(join(tmpdir(), 'stamp-sw-'));
  try {
    for (const [p, c] of Object.entries({ ...files, 'sw.js': sw })) {
      await mkdir(dirname(join(root, p)), { recursive: true });
      await writeFile(join(root, p), c);
    }
    // Computed independently (Python hashlib) from the documented framing; since T3 the hash
    // input also carries the rendered precache list as a 'stamp:precache' entry.
    assert.equal(await computeVersion(root), '5a7c6c993aef');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every regular file under src/ and fonts/ is hashed, whatever its extension', async () => {
  for (const added of ['src/data.json', 'src/deep/er/x.css', 'fonts/OFL.txt', 'src/noext']) {
    await withTree({}, undefined, async (root) => {
      const before = await computeVersion(root);
      await mkdir(dirname(join(root, added)), { recursive: true });
      await writeFile(join(root, added), 'x');
      assert.ok((await listShellFiles(root)).includes(added), added);
      assert.notEqual(await computeVersion(root), before, added);
    });
  }
});

test('symlinks under src/ are skipped', async (t) => {
  await withTree({ 'src/a.js': 'a' }, undefined, async (root) => {
    try {
      await symlink(join(root, 'src/a.js'), join(root, 'src/link.js'));
    } catch {
      return t.skip('symlinks not available');
    }
    assert.ok(!(await listShellFiles(root)).includes('src/link.js'));
  });
});

test('an unrecognised top-level asset fails loudly (exit 1) and never writes', async () => {
  for (const name of [
    'logo.svg',
    'pic.webp',
    'favicon.ico',
    'style.css',
    'other.html',
    'data.json',
    'app.js',
  ]) {
    await withTree({ [name]: 'x' }, undefined, async (root) => {
      const sw = await readFile(join(root, 'sw.js'), 'utf8');
      for (const check of [true, false]) {
        const res = await run(root, { check });
        assert.equal(res.code, 1, name);
        assert.match(res.message, /unrecognised top-level/);
        assert.ok(res.message.includes(name));
        assert.equal(await readFile(join(root, 'sw.js'), 'utf8'), sw);
      }
    });
  }
});

test('known non-shipped top-level files and dotfiles are ignored', async () => {
  const known = {
    'package.json': '{}',
    'package-lock.json': '{}',
    'eslint.config.mjs': '',
    'playwright.config.mjs': '',
    'CLAUDE.md': '',
    'README.md': '',
    '.prettierrc.json': '{}',
  };
  await withTree({}, undefined, async (root) => {
    const before = await computeVersion(root);
    for (const [p, c] of Object.entries(known)) await writeFile(join(root, p), c);
    assert.equal(await computeVersion(root), before);
  });
});

test('a CRLF sw.js restamps with CRLF block lines and is then stable', async () => {
  await withTree({}, swWith('x').replace(/\n/g, '\r\n'), async (root) => {
    assert.equal((await run(root)).code, 0);
    const text = await readFile(join(root, 'sw.js'), 'utf8');
    assert.ok(!/[^\r]\n/.test(text), 'no bare LF');
    assert.equal((await run(root)).wrote, false);
    assert.equal((await run(root, { check: true })).code, 0);
  });
});

test('PRECACHE entries are JSON-quoted and hostile names are rejected', () => {
  assert.match(
    renderBlock('abc', ['manifest.json', 'src/a-b_c.js']),
    /\["manifest.json", "src\/a-b_c.js"\];/,
  );
  for (const bad of [
    "a'b.js",
    'a"b.js',
    'a\nb.js',
    '../x.js',
    'a/../b.js',
    'https://x',
    '/abs.js',
    '',
    'a b.js',
  ]) {
    assert.throws(() => renderBlock('abc', [bad]), /not a safe relative path/, JSON.stringify(bad));
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
    for (const p of ['docs/a.md', 'tests/t.js', 'node_modules/m/i.js', 'README.md']) {
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
  const duplicated = `${renderBlock('a', [])}\n${renderBlock('b', [])}\n`;
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

test('PRECACHE is derived from the shell list: sorted, runtime types only, no licences or notes', async () => {
  await withTree(
    {
      'src/b.js': '1',
      'src/a.js': '2',
      'fonts/z.woff2': '3',
      'fonts/OFL-X.txt': '4',
      'fonts/SOURCES.md': '5',
      'src/data.json': '6',
    },
    undefined,
    async (root) => {
      assert.deepEqual(await listPrecache(root), [
        'fonts/z.woff2',
        'icon-192.png',
        'index.html',
        'manifest.json',
        'src/a.js',
        'src/b.js',
        'src/data.json',
      ]);
      await run(root);
      const sw = await readFile(join(root, 'sw.js'), 'utf8');
      assert.match(sw, /const PRECACHE = \["fonts\/z.woff2", "icon-192.png", "index.html"/);
      assert.ok(!sw.includes('OFL-X') && !sw.includes('SOURCES'));
    },
  );
});

test('adding a woff2 changes the cache list and the version; a licence only the version', async () => {
  await withTree({}, undefined, async (root) => {
    const v0 = await computeVersion(root);
    const l0 = await listPrecache(root);
    await mkdir(join(root, 'fonts'));
    await writeFile(join(root, 'fonts/OFL.txt'), 'x');
    const v1 = await computeVersion(root);
    assert.notEqual(v1, v0);
    assert.deepEqual(await listPrecache(root), l0);
    await writeFile(join(root, 'fonts/f.woff2'), 'x');
    assert.notEqual(await computeVersion(root), v1);
    assert.ok((await listPrecache(root)).includes('fonts/f.woff2'));
  });
});

test('the precache list itself is part of the hash (a changed filter changes VERSION)', async () => {
  // Same files, same sw.js, different rendered list => different hash. Simulated by the
  // pseudo-entry: a file that is hashed but not cached must not equal one that is cached.
  const a = await makeTree({ 'src/x.txt': 'same' });
  const b = await makeTree({ 'src/x.js': 'same' });
  try {
    assert.notEqual(await computeVersion(a), await computeVersion(b));
    assert.deepEqual(await listPrecache(a), ['icon-192.png', 'index.html', 'manifest.json']);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test('a hostile runtime filename fails the stamp instead of being skipped', async () => {
  for (const name of ['fonts/a b.woff2', "fonts/a'b.woff2", 'src/\u00e9.js']) {
    await withTree({ [name]: 'x' }, undefined, async (root) => {
      const sw = await readFile(join(root, 'sw.js'), 'utf8');
      for (const check of [true, false]) {
        const res = await run(root, { check });
        assert.equal(res.code, 1, name);
        assert.match(res.message, /not a safe relative path/);
        assert.equal(await readFile(join(root, 'sw.js'), 'utf8'), sw);
      }
    });
  }
});
