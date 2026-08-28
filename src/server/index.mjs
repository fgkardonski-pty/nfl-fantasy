/** The HTTP server: API + static war room. */
import http from 'node:http';
import config from '../config.mjs';
import { buildApi } from './api.mjs';
import { serveStatic } from './static.mjs';
import { send } from './router.mjs';
import { getDb } from '../db/index.mjs';
import { logger } from '../util/log.mjs';

const log = logger('server');

export function createServer() {
  getDb(); // fail fast if the database cannot be opened
  const api = buildApi();

  return http.createServer(async (req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      // Visible by default, and at a threshold a person would actually notice.
      // During a live draft the gap between marking a pick and seeing the next
      // recommendation is the only latency that costs anything, and "it feels
      // slow" is not something anyone can act on — a number in the console is.
      if (ms > 400) log.warn(`slow: ${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${ms}ms`);
      else log.debug(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${ms}ms`);
    });

    // The server binds to localhost by default and holds real credentials, so
    // it never advertises permissive CORS.
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('referrer-policy', 'no-referrer');

    try {
      if (await api.handle(req, res)) return;
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        // Single-page app: unknown non-API GETs fall through to the shell.
        if (serveStatic(req, res, '/index.html')) return;
      }
      send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
    } catch (err) {
      log.error(`unhandled: ${err.message}`);
      if (!res.writableEnded) send(res, 500, { error: 'Internal error' });
    }
  });
}

export function startServer({ port = config.port, host = config.host } = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Set ORACLE_PORT to a free port.`));
      } else reject(err);
    });
    server.listen(port, host, () => {
      log.info(`war room live at http://${host}:${port}`);
      resolve(server);
    });
  });
}
