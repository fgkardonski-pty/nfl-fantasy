/**
 * HTTP client for outbound data fetches.
 *
 * Every external call in this platform goes through here so that rate limiting,
 * retry/backoff, conditional requests and provenance logging are applied
 * uniformly. "Where did this number come from" is answerable because every
 * fetch writes a provenance row before the data is used.
 *
 * Note on proxies: Node's built-in fetch ignores HTTPS_PROXY unless the process
 * is started with NODE_USE_ENV_PROXY=1 (Node >= 22.21). If you are behind a
 * corporate proxy, start the server with that variable set.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.mjs';
import { recordProvenance } from '../db/index.mjs';
import { logger } from './log.mjs';

const log = logger('http');

/** Per-host token buckets so we never hammer a provider. */
const buckets = new Map();

const DEFAULT_LIMITS = {
  'fantasysports.yahooapis.com': { perMinute: 90 },
  'api.sleeper.app': { perMinute: 300 },
  'api.the-odds-api.com': { perMinute: 20 },
  'api.open-meteo.com': { perMinute: 60 },
  'github.com': { perMinute: 60 },
  'raw.githubusercontent.com': { perMinute: 90 },
  default: { perMinute: 120 },
};

function limiterFor(host) {
  if (!buckets.has(host)) {
    const cfg = DEFAULT_LIMITS[host] ?? DEFAULT_LIMITS.default;
    buckets.set(host, { tokens: cfg.perMinute, perMinute: cfg.perMinute, last: Date.now() });
  }
  return buckets.get(host);
}

async function acquire(host) {
  const b = limiterFor(host);
  for (;;) {
    const now = Date.now();
    const elapsed = (now - b.last) / 60000;
    b.tokens = Math.min(b.perMinute, b.tokens + elapsed * b.perMinute);
    b.last = now;
    if (b.tokens >= 1) { b.tokens -= 1; return; }
    const waitMs = Math.ceil(((1 - b.tokens) / b.perMinute) * 60000);
    await sleep(Math.min(waitMs, 5000));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Conditional-request cache (ETag / Last-Modified) on disk.
// ---------------------------------------------------------------------------

function cachePath(url) {
  const h = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  return path.join(config.cacheDir, `${h}.json`);
}

function readCache(url) {
  try {
    const p = cachePath(url);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function writeCache(url, entry) {
  try {
    fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(cachePath(url), JSON.stringify(entry));
  } catch (err) { log.debug(`cache write failed: ${err.message}`); }
}

/**
 * Fetch with rate limiting, retry with exponential backoff, conditional
 * requests, and provenance logging.
 *
 * @param {string} url
 * @param {Object} opts
 * @param {string} opts.source        provenance label
 * @param {boolean} opts.cache        use ETag/Last-Modified revalidation
 * @param {number} opts.retries
 * @param {number} opts.timeoutMs
 * @returns {Promise<{ok:boolean,status:number,body:string|null,json:any,fromCache:boolean,error:string|null}>}
 */
export async function request(url, {
  source = 'unknown', method = 'GET', headers = {}, body = null,
  cache = false, retries = 3, timeoutMs = 20000, json = true, maxAgeMs = 0,
} = {}) {
  const host = safeHost(url);
  const cached = cache ? readCache(url) : null;

  // Serve straight from cache when it is fresh enough to skip the network.
  if (cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs) {
    return { ok: true, status: 200, body: cached.body, json: parseMaybe(cached.body, json), fromCache: true, error: null };
  }

  const reqHeaders = { 'user-agent': 'gridiron-oracle/1.0', accept: 'application/json', ...headers };
  if (cached?.etag) reqHeaders['if-none-match'] = cached.etag;
  if (cached?.lastModified) reqHeaders['if-modified-since'] = cached.lastModified;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter — 1s, 2s, 4s, 8s.
      const wait = Math.min(8000, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      await sleep(wait);
    }
    await acquire(host);

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers: reqHeaders, body, signal: controller.signal });
      clearTimeout(timer);
      const ms = Date.now() - started;

      if (res.status === 304 && cached) {
        safeProvenance({ source, endpoint: url, status: 304, ok: 1, bytes: 0, ms, etag: cached.etag, note: 'not modified' });
        return { ok: true, status: 304, body: cached.body, json: parseMaybe(cached.body, json), fromCache: true, error: null };
      }

      const text = await res.text();
      safeProvenance({
        source, endpoint: url, status: res.status, ok: res.ok ? 1 : 0,
        bytes: text.length, ms, etag: res.headers.get('etag'),
        note: res.ok ? null : text.slice(0, 200),
      });

      if (res.ok) {
        if (cache) {
          writeCache(url, {
            at: Date.now(), body: text,
            etag: res.headers.get('etag'),
            lastModified: res.headers.get('last-modified'),
          });
        }
        return { ok: true, status: res.status, body: text, json: parseMaybe(text, json), fromCache: false, error: null };
      }

      // 4xx other than 429 will not succeed on retry.
      if (res.status !== 429 && res.status < 500) {
        return { ok: false, status: res.status, body: text, json: null, fromCache: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
      safeProvenance({ source, endpoint: url, status: 0, ok: 0, bytes: 0, ms: Date.now() - started, note: lastError });
    }
  }

  // Stale cache is better than nothing, and we say so rather than pretending
  // the data is current.
  if (cached) {
    log.warn(`${source}: ${lastError} — serving stale cache from ${new Date(cached.at).toISOString()}`);
    return { ok: true, status: 0, body: cached.body, json: parseMaybe(cached.body, json), fromCache: true, stale: true, error: lastError };
  }
  return { ok: false, status: 0, body: null, json: null, fromCache: false, error: lastError };
}

function parseMaybe(text, wantJson) {
  if (!wantJson || text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'invalid'; }
}

function safeProvenance(row) {
  try { recordProvenance(row); } catch { /* provenance must never break a fetch */ }
}

/** Convenience wrapper that returns parsed JSON or null. */
export async function getJson(url, opts = {}) {
  const r = await request(url, { ...opts, json: true });
  return r.ok ? r.json : null;
}
