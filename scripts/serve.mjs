// Zero-dependency static file server for tests and local use.
//   node scripts/serve.mjs [dir] [port]     (port 0 or omitted = random free port)
// Serves only files under the given directory; relative URLs work from any sub-path.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = normalize(decodeURIComponent(url.pathname));
      if (rel.endsWith(sep) || rel === '/') rel = join(rel, 'index.html');
      const file = join(base, rel);
      if (file !== base && !file.startsWith(base + sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
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
