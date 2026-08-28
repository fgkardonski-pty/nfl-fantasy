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
import { get, run, meta } from '../../db/index.mjs';
import { encrypt, decrypt, pkcePair, randomToken, timingSafeEqual } from '../../util/crypto.mjs';
import { request } from '../../util/http.mjs';
import { logger } from '../../util/log.mjs';

const log = logger('yahoo-oauth');

/**
 * Pending authorisation attempts: state -> {verifier, createdAt}.
 *
 * Held in memory AND persisted, because the two halves of the flow do not
 * always happen in the same process: you can start the connection in the web UI
 * and finish it on the command line, or restart the server between the two. The
 * PKCE verifier is a single-use, short-lived nonce — not a credential — and it
 * is deleted the moment it is redeemed or expires.
 */
const pending = new Map();
const STATE_TTL_MS = 15 * 60 * 1000;
const PENDING_KEY = 'yahoo_oauth_pending';

function loadPending() {
  const stored = meta.getJson(PENDING_KEY, {});
  const now = Date.now();
  for (const [state, entry] of Object.entries(stored)) {
    if (entry && now - entry.createdAt <= STATE_TTL_MS && !pending.has(state)) {
      pending.set(state, entry);
    }
  }
}

function savePending() {
  const out = {};
  for (const [state, entry] of pending) out[state] = entry;
  meta.set(PENDING_KEY, out);
}

function sweepPending() {
  loadPending();
  const now = Date.now();
  let changed = false;
  for (const [k, v] of pending) {
    if (now - v.createdAt > STATE_TTL_MS) { pending.delete(k); changed = true; }
  }
  if (changed) savePending();
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
  savePending();

  const params = new URLSearchParams({
    client_id: config.yahoo.clientId,
    redirect_uri: config.yahoo.redirectUri,
    response_type: 'code',
    // Spec values for the Fantasy Sports API. Overridable because the scope a
    // Yahoo approval actually grants is not something this code can verify, and
    // a scope change should not require editing source.
    scope: config.yahoo.scope || (access === 'write' ? 'fspt-w' : 'fspt-r'),
    state,
    code_challenge: challenge,
    code_challenge_method: method,
  });
  return { url: `${config.yahoo.authUrl}?${params}`, state };
}

/**
 * Pull the code and state out of whatever the operator pasted.
 *
 * Yahoo may refuse to redirect to a plain-HTTP localhost callback, in which case
 * the browser lands on an error page whose ADDRESS BAR still contains the
 * authorisation code. Accepting the whole pasted URL — or just the bare code —
 * means that restriction can never strand someone mid-setup.
 */
export function parseCallbackInput(input) {
  const text = String(input ?? '').trim();
  if (!text) return { code: null, state: null, error: null, errorDescription: null };
  if (text.includes('?') || text.includes('code=') || text.includes('error=')) {
    try {
      const url = new URL(text.startsWith('http') ? text : `http://x/?${text.replace(/^\?/, '')}`);
      return {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        // Yahoo reports a REFUSAL in the same redirect, as an error parameter
        // rather than a code. Without reading it, a refusal was indistinguishable
        // from a typo — the operator was told no code was found, which is true
        // and useless, when the URL plainly said why.
        error: url.searchParams.get('error'),
        errorDescription: url.searchParams.get('error_description'),
      };
    } catch { /* fall through to treating it as a bare code */ }
  }
  return { code: text, state: null, error: null, errorDescription: null };
}

/**
 * Turn a Yahoo OAuth error code into something worth acting on.
 *
 * These arrive as bare slugs in a redirect URL, and each one has exactly one
 * likely cause and one fix. Saying so beats making someone search for it while
 * the flow is half finished.
 */
export function explainOAuthError(error, description = null) {
  const known = {
    invalid_scope:
      'Your Yahoo application is not approved for the Fantasy Sports API yet.\n'
      + '  This is the access request that takes Yahoo one to two weeks to review — it is not a\n'
      + '  problem with this software, your credentials, or the redirect URI. Nothing you change\n'
      + '  locally will get past it. When the approval email arrives, run the connect step again\n'
      + '  and it will work unchanged.',
    invalid_client:
      'Yahoo does not recognise the client ID and secret.\n'
      + '  Check YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in .env against the app at\n'
      + '  https://developer.yahoo.com/apps/ — a trailing space or a truncated paste does this.',
    redirect_uri_mismatch:
      'The redirect URI does not match the one registered on the Yahoo app.\n'
      + '  It must match EXACTLY, including https:// and any trailing slash.',
    access_denied:
      'The authorisation was declined on the Yahoo consent screen. Run the connect step again\n'
      + '  and choose to allow access.',
    invalid_grant:
      'That authorisation code was already used or has expired. Codes are single-use and\n'
      + '  short-lived — start the connection again for a fresh one.',
  };
  const detail = description ? `\n  Yahoo said: ${description}` : '';
  return (known[error] ?? `Yahoo refused the authorisation with "${error}".`) + detail;
}

/**
 * Exchange an authorisation code for tokens and store them encrypted.
 * `state` is optional: when only one authorisation is in flight — the normal
 * case for a single-operator tool — the pending verifier is unambiguous.
 */
export async function exchangeCode(code, state) {
  sweepPending();
  let verifier = null;
  let matchedState = null;

  if (state) {
    for (const [k, v] of pending) {
      if (timingSafeEqual(k, state)) { verifier = v.verifier; matchedState = k; break; }
    }
    if (!verifier) {
      throw new Error(
        'That authorisation state does not match any connection this server started. ' +
        'Start the connection again — the link is valid for 15 minutes.'
      );
    }
  } else if (pending.size === 1) {
    // Manual paste of a bare code: exactly one attempt is in flight, so there
    // is no ambiguity about which verifier belongs to it.
    [matchedState] = [...pending.keys()];
    verifier = pending.get(matchedState).verifier;
  } else if (pending.size === 0) {
    throw new Error('No Yahoo connection is in progress. Start one first, then paste the code.');
  } else {
    throw new Error(
      `${pending.size} Yahoo connections are in progress. Paste the full redirect URL ` +
      '(which carries the state), or start a fresh connection.'
    );
  }

  pending.delete(matchedState);
  savePending();

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
  pending.clear();
  meta.set(PENDING_KEY, {});
  return { disconnected: true };
}

/** How many authorisations are waiting to be completed. */
export const pendingCount = () => { sweepPending(); return pending.size; };
