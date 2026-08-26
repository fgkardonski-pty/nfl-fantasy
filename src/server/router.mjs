/**
 * A tiny express-style router over node:http. Zero dependencies.
 * Supports path params (/api/player/:id), query parsing, JSON bodies, and
 * per-route error isolation so one broken handler cannot take down the server.
 */
import { logger } from '../util/log.mjs';

const log = logger('http');

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[A-Za-z_]\w*/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }).replace(/\*/g, '.*') + '$'
    );
    this.routes.push({ method, pattern, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const found = this.match(req.method, url.pathname);
    if (!found) return false;

    const query = Object.fromEntries(url.searchParams);
    let body = null;
    if (req.method === 'POST') {
      body = await readJsonBody(req);
    }

    const ctx = { req, res, url, query, params: found.params, body };
    try {
      const result = await found.route.handler(ctx);
      if (res.writableEnded) return true;
      if (result === undefined) { send(res, 204, null); return true; }
      send(res, 200, result);
      return true;
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname} -> ${err.message}`, err.stack?.split('\n')[1]?.trim());
      else log.debug(`${req.method} ${url.pathname} -> ${status} ${err.message}`);
      if (!res.writableEnded) {
        send(res, status, { error: err.message, hint: err.hint ?? undefined });
      }
      return true;
    }
  }
}

export function send(res, status, payload, headers = {}) {
  const body = payload == null ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

export function html(res, status, markup) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(markup);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw httpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw httpError(400, 'Request body is not valid JSON'); }
}

export function httpError(status, message, hint) {
  const e = new Error(message);
  e.status = status;
  if (hint) e.hint = hint;
  return e;
}
