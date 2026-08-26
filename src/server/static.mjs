/** Static file serving for the war room UI. No dependencies, path-traversal safe. */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.mjs';

const PUBLIC_DIR = path.join(config.root, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Resolve inside PUBLIC_DIR and reject anything that escapes it.
  const full = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return true;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;

  const ext = path.extname(full).toLowerCase();
  const stat = fs.statSync(full);
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304); res.end(); return true;
  }
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    etag,
    // The UI is developed live; do not let a browser pin a stale bundle.
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
  });
  fs.createReadStream(full).pipe(res);
  return true;
}
