/**
 * Yahoo OAuth2 (three-legged) with PKCE.
 *
 * Flow:
 *   1. /auth/yahoo          -> redirect the operator to Yahoo's consent screen
 *   2. Yahoo redirects back -> /auth/yahoo/callback with ?code=...&state=...
 *   3. exchange the code    -> access + refresh token, encrypted at rest
 *   4. every API call       -> refreshAccessToken() transparently if expired
 *
 * The refresh token is a long-lived credential to a real Yahoo account. It is
 * AES-256-GCM encrypted with a key derived from ORACLE_SECRET before it is
 * written to the database, and it is never logged or returned over the API.
 */
import config from '../../config.mjs';
import { get, run } from '../../db/index.mjs';
import { encrypt, decrypt, pkcePair, randomToken, timingSafeEqual } from '../../util/crypto.mjs';
import { request } from '../../util/http.mjs';
import { logger } from '../../util/log.mjs';

const log = logger('yahoo-oauth');

/** Pending authorisation attempts: state -> {verifier, createdAt}. In-memory by design. */
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweepPending() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > STATE_TTL_MS) pending.delete(k);
}

/**
 * Build the Yahoo consent URL.
 * @param {'read'|'write'} access  'write' additionally permits submitting moves
 */
export function authorizeUrl({ access = 'read' } = {}) {
  if (!config.yahoo.configured) {
    throw new Error(
      'Yahoo is not configured. Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in .env — ' +
      'create an app at https://developer.yahoo.com/apps/create/ with the Fantasy Sports permission.'
    );
  }
  sweepPending();
  const state = randomToken(24);
  const { verifier, challenge, method } = pkcePair();
  pending.set(state, { verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: config.yahoo.clientId,
    redirect_uri: config.yahoo.redirectUri,
    response_type: 'code',
    scope: access === 'write' ? 'fspt-w' : 'fspt-r',
    state,
    code_challenge: challenge,
    code_challenge_method: method,
  });
  return { url: `${config.yahoo.authUrl}?${params}`, state };
}

/** Exchange an authorisation code for tokens and store them encrypted. */
export async function exchangeCode(code, state) {
  sweepPending();
  let verifier = null;
  for (const [k, v] of pending) {
    if (timingSafeEqual(k, state)) { verifier = v.verifier; pending.delete(k); break; }
  }
  if (!verifier) throw new Error('Invalid or expired OAuth state. Start the connection again from the dashboard.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: config.yahoo.redirectUri,
    code,
    code_verifier: verifier,
  });
  return tokenRequest(body, 'authorization_code');
}

/** Refresh an expired access token using the stored refresh token. */
export async function refreshAccessToken() {
  const row = get("SELECT * FROM oauth_tokens WHERE provider = 'yahoo'");
  if (!row?.refresh_token) throw new Error('No Yahoo refresh token stored. Connect your Yahoo account first.');
  const refresh = decrypt(row.refresh_token, config.secret);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    redirect_uri: config.yahoo.redirectUri,
    refresh_token: refresh,
  });
  return tokenRequest(body, 'refresh_token');
}

async function tokenRequest(body, kind) {
  const basic = Buffer.from(`${config.yahoo.clientId}:${config.yahoo.clientSecret}`).toString('base64');
  const res = await request(config.yahoo.tokenUrl, {
    source: 'yahoo-oauth',
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    retries: 2,
  });
  if (!res.ok || !res.json?.access_token) {
    throw new Error(`Yahoo token exchange failed (${kind}): ${res.error ?? 'no access_token in response'}`);
  }
  const t = res.json;
  const expiresAt = Date.now() + (Number(t.expires_in ?? 3600) - 60) * 1000;
  run(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, guid, updated_at)
     VALUES ('yahoo', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token=excluded.access_token,
       refresh_token=COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
       expires_at=excluded.expires_at, scope=excluded.scope,
       guid=excluded.guid, updated_at=excluded.updated_at`,
    [
      encrypt(t.access_token, config.secret),
      t.refresh_token ? encrypt(t.refresh_token, config.secret) : null,
      expiresAt,
      t.scope ?? null,
      t.xoauth_yahoo_guid ?? null,
      Date.now(),
    ]
  );
  log.info(`Yahoo token stored (${kind}), valid until ${new Date(expiresAt).toISOString()}`);
  return { expiresAt, scope: t.scope };
}

/** A currently-valid access token, refreshing transparently when needed. */
export async function accessToken() {
  const row = get("SELECT * FROM oauth_tokens WHERE provider = 'yahoo'");
  if (!row) throw new Error('Yahoo account is not connected. Open the dashboard and click Connect Yahoo.');
  if (Number(row.expires_at ?? 0) > Date.now()) {
    return decrypt(row.access_token, config.secret);
  }
  await refreshAccessToken();
  const fresh = get("SELECT * FROM oauth_tokens WHERE provider = 'yahoo'");
  return decrypt(fresh.access_token, config.secret);
}

export function connectionStatus() {
  const row = get("SELECT provider, expires_at, scope, guid, updated_at FROM oauth_tokens WHERE provider = 'yahoo'");
  return {
    configured: config.yahoo.configured,
    connected: !!row,
    expiresAt: row?.expires_at ?? null,
    expired: row ? Number(row.expires_at ?? 0) <= Date.now() : null,
    scope: row?.scope ?? null,
    canWrite: (row?.scope ?? '').includes('fspt-w'),
    updatedAt: row?.updated_at ?? null,
    redirectUri: config.yahoo.redirectUri,
  };
}

export function disconnect() {
  run("DELETE FROM oauth_tokens WHERE provider = 'yahoo'");
  return { disconnected: true };
}
