// Static file server for local tests: serves the repo root like GitHub Pages
// does under /leek-nook/. `node tests/serve.mjs [port]`
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/leek-nook/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function serve(port = 18777, { overrides = {} } = {}) {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') { res.writeHead(302, { location: BASE }); return res.end(); }
    if (!path.startsWith(BASE)) { res.writeHead(404); return res.end('not found'); }
    path = path.slice(BASE.length) || 'index.html';
    if (path.endsWith('/')) path += 'index.html';
    if (overrides[path] != null) {
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/plain', 'cache-control': 'no-cache' });
      return res.end(overrides[path]);
    }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT) || /[\\/](\.git|\.secrets|node_modules|tests|tools|bell)[\\/]/.test(file.slice(ROOT.length))) { res.writeHead(404); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.argv[2] || 18777);
  await serve(port);
  console.log(`serving http://localhost:${port}${BASE}`);
}
