/**
 * Configuration. Reads .env (no dependency — a 20-line parser is enough) and
 * layers process.env on top so container env vars always win.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const fileEnv = loadDotEnv(path.join(ROOT, '.env'));
const env = (k, d = '') => process.env[k] ?? fileEnv[k] ?? d;
const num = (k, d) => { const v = Number(env(k, '')); return Number.isFinite(v) && env(k, '') !== '' ? v : d; };

export const config = {
  root: ROOT,
  port: num('ORACLE_PORT', 4317),
  host: env('ORACLE_HOST', '127.0.0.1'),
  dbPath: path.resolve(ROOT, env('ORACLE_DB', './data/oracle.db')),
  cacheDir: path.resolve(ROOT, './data/cache'),
  secret: env('ORACLE_SECRET', ''),

  yahoo: {
    clientId: env('YAHOO_CLIENT_ID'),
    clientSecret: env('YAHOO_CLIENT_SECRET'),
    redirectUri: env('YAHOO_REDIRECT_URI', `http://localhost:${num('ORACLE_PORT', 4317)}/auth/yahoo/callback`),
    authUrl: 'https://api.login.yahoo.com/oauth2/request_auth',
    tokenUrl: 'https://api.login.yahoo.com/oauth2/get_token',
    apiBase: 'https://fantasysports.yahooapis.com/fantasy/v2',
    get configured() { return Boolean(this.clientId && this.clientSecret); },
  },

  oddsApiKey: env('ODDS_API_KEY'),
  anthropicKey: env('ANTHROPIC_API_KEY'),
  llmModel: env('ORACLE_LLM_MODEL', 'claude-sonnet-5'),

  sims: {
    week: num('ORACLE_SIMS_WEEK', 20000),
    season: num('ORACLE_SIMS_SEASON', 5000),
    draft: num('ORACLE_SIMS_DRAFT', 400),
  },
  seed: num('ORACLE_SEED', 8675309),

  /** Current NFL season, rolling over in March when the league year starts. */
  get season() {
    const explicit = num('ORACLE_SEASON', 0);
    if (explicit) return explicit;
    const now = new Date();
    return now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  },
};

export default config;
