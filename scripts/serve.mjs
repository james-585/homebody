// Zero-dependency static file server for tests and local use.
//   node scripts/serve.mjs [dir] [port]     (port 0 or omitted = random free port)
// Serves only files under the given directory; relative URLs work from any sub-path.
import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export function startServer(root, port = 0) {
  const base = resolve(root);
  let realBase;
  let listenPort = port;
  const forbidden = (res) => res.writeHead(403).end('Forbidden');
  const server = http.createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this server (blocks DNS-rebinding style Host values).
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${listenPort}` && host !== `localhost:${listenPort}`) {
        return forbidden(res);
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const decoded = decodeURIComponent(url.pathname);
      // No dotfiles or dot-directories (.git, .env, .claude, ...), and no traversal segments.
      if (decoded.split('/').some((seg) => seg.startsWith('.'))) return forbidden(res);
      let rel = normalize(decoded);
      if (rel.endsWith(sep) || rel === '/') rel = join(rel, 'index.html');
      const file = join(base, rel);
      if (file !== base && !file.startsWith(base + sep)) return forbidden(res);
      // Resolve symlinks and re-check, so a link inside the root cannot point outside it.
      realBase ??= await realpath(base);
      const real = await realpath(file);
      if (real !== realBase && !real.startsWith(realBase + sep)) return forbidden(res);
      const info = await stat(real);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(real);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(real)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      listenPort = actual;
      ok({
        url: `http://127.0.0.1:${actual}/`,
        port: actual,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? '.';
  const port = Number(process.argv[3] ?? 0);
  const s = await startServer(dir, port);
  console.log(`Serving ${resolve(dir)} at ${s.url}`);
}
