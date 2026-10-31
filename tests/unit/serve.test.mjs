// scripts/serve.mjs is only for tests and local use, but it still must not leak files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../scripts/serve.mjs';

let outer;
let root;
let server;

/** Raw request so we can set the Host header and keep dot segments unnormalised. */
function get(path, host) {
  return new Promise((ok, fail) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        headers: { Host: host ?? `127.0.0.1:${server.port}` },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => ok({ status: res.statusCode, body }));
      },
    );
    req.on('error', fail);
    req.end();
  });
}

before(async () => {
  outer = mkdtempSync(join(tmpdir(), 'hb-serve-'));
  root = join(outer, 'site');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<p>ok</p>');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, '.git', 'config'), 'x');
  writeFileSync(join(outer, 'secret.txt'), 'outside');
  symlinkSync(join(outer, 'secret.txt'), join(root, 'link.txt'));
  server = await startServer(root, 0);
});

after(async () => {
  await server.close();
  rmSync(outer, { recursive: true, force: true });
});

test('serves a normal file and the index', async () => {
  assert.deepEqual(await get('/index.html'), { status: 200, body: '<p>ok</p>' });
  assert.equal((await get('/')).status, 200);
});

test('403 for dotfiles and dot-directories', async () => {
  assert.equal((await get('/.env')).status, 403);
  assert.equal((await get('/.git/config')).status, 403);
  assert.equal((await get('/%2eenv')).status, 403);
});

test('path traversal never reaches a file outside the root', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
    const r = await get(p);
    assert.notEqual(r.status, 200, p);
    assert.notEqual(r.body, 'outside', p);
  }
});

test('403 unless the Host header is this server', async () => {
  assert.equal((await get('/index.html', 'evil.example')).status, 403);
  assert.equal((await get('/index.html', '127.0.0.1:1')).status, 403);
  assert.equal((await get('/index.html', `localhost:${server.port}`)).status, 200);
});

test('403 for a symlink that points outside the root', async () => {
  const r = await get('/link.txt');
  assert.equal(r.status, 403);
  assert.notEqual(r.body, 'outside');
});

test('404 for a missing file', async () => {
  assert.equal((await get('/nope.html')).status, 404);
});
