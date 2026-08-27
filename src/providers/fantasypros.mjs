/**
 * FantasyPros public API v2 — consensus rankings and projected stat lines.
 *
 * Written against the published OpenAPI specification, so the endpoint shapes,
 * required parameters and enum values below are taken from the spec rather than
 * inferred.
 *
 * WHY BOTH ENDPOINTS. Rankings give a positional order, which the draft board
 * needs to tell players apart and to model what opponents will do. Projections
 * give actual projected STAT LINES, which is strictly better: they can be
 * scored through the league's own rules instead of approximated from a
 * positional archetype. A league paying 0.5 per completion cares enormously
 * about the difference between a 380-completion quarterback and a 300-completion
 * one, and only the projections carry that.
 *
 * TERMS. Keys are issued for PERSONAL, NON-COMMERCIAL use. This platform is
 * self-hosted, single-operator, and redistributes nothing. Two obligations are
 * stated here because they are easy to breach by accident: do not build a
 * service competing with FantasyPros, and credit them when publishing derived
 * analysis. Player image URLs are licensed to them by a third party and are
 * deliberately not imported.
 */
import config from '../config.mjs';
import { request } from '../util/http.mjs';
import { logger } from '../util/log.mjs';

const log = logger('fantasypros');

export const ATTRIBUTION = 'Rankings and projections: FantasyPros.com';

/** Spec: securitySchemes.api_key = apiKey in header, name x-api-key. */
const AUTH_HEADER = 'x-api-key';

/** Spec: servers[0].url */
const DEFAULT_BASE = 'https://api.fantasypros.com/public/v2/json';

/**
 * Spec: NFLRankingTypes. These are UPPERCASE — sending a lowercase value fails
 * API Gateway's request validation with a 403 that reads like an auth failure,
 * which is exactly how this was first mis-diagnosed.
 */
export const RANKING_TYPES = ['DRAFT', 'ADP', 'PRESEASON', 'ROS', 'WW', 'DYNASTY'];

/** Spec: NFLScoringTypes. */
export const SCORING_TYPES = ['STD', 'PPR', 'HALF'];

export const isConfigured = () => Boolean(config.fantasyProsKey);

const base = () => (config.fantasyProsBase || DEFAULT_BASE).replace(/\/+$/, '');

async function get(path, params, { noCache = false } = {}) {
  if (!isConfigured()) {
    throw new Error(
      'FANTASYPROS_API_KEY is not set in .env. Request a personal key at https://api.fantasypros.com'
    );
  }
  const url = new URL(`${base()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await request(url.toString(), {
    source: 'fantasypros',
    headers: { [AUTH_HEADER]: config.fantasyProsKey },
    cache: !noCache,
    maxAgeMs: noCache ? 0 : 6 * 36e5,
    retries: noCache ? 0 : 2,
  });
  return { url: url.toString(), res };
}

/**
 * Which consensus board to start from. The league's own scoring is applied
 * downstream regardless; matching the reception value just makes the starting
 * order closest to right.
 */
export function scoringCodeFor(leagueScoring) {
  const ppr = Number(leagueScoring?.rec ?? 0);
  if (ppr >= 0.75) return 'PPR';
  if (ppr >= 0.25) return 'HALF';
  return 'STD';
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

/**
 * Consensus rankings. Spec: GET /{sport}/{season}/consensus-rankings
 * `position` is REQUIRED; ALL is a valid NFLPositions value.
 */
export async function fetchRankings({ season, scoring = 'HALF', type = 'DRAFT' } = {}) {
  const { res, url } = await get(`/nfl/${season}/consensus-rankings`, {
    position: 'ALL',
    type: String(type).toUpperCase(),
    scoring: String(scoring).toUpperCase(),
    week: 0,
  });
  if (!res.ok) {
    throw new Error(
      `FantasyPros rankings failed: HTTP ${res.status}${res.error ? ` — ${res.error}` : ''}\n` +
      `  ${redact(url)}\n` +
      (res.status === 403
        ? '  A 403 here usually means an invalid parameter value rather than a bad key — ' +
          'the ranking type and scoring values are case-sensitive and uppercase.'
        : '')
    );
  }
  const players = extractPlayers(res.json);
  log.info(`rankings: ${players.length} players (${scoring}/${type}, season ${season})`);
  return players;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * FantasyPros projection field -> our canonical stat key.
 * Their names differ from ours in small ways (`pass_yds` vs `pass_yd`,
 * `rec_rec` vs `rec`), and mapping them explicitly is what lets the league's
 * own scoring table price them without any special cases downstream.
 */
const STAT_MAP = {
  pass_att: 'pass_att',
  pass_cmp: 'pass_cmp',
  pass_yds: 'pass_yd',
  pass_tds: 'pass_td',
  pass_ints: 'pass_int',
  rush_att: 'rush_att',
  rush_yds: 'rush_yd',
  rush_tds: 'rush_td',
  rec_rec: 'rec',
  rec_yds: 'rec_yd',
  rec_tds: 'rec_td',
  ret_tds: 'ret_td',
  '2pt_tds': 'two_pt',
  fumbles: 'fum_lost',
  fg: 'fg_made',
  xpt: 'pat_made',
  def_sack: 'def_sack',
  def_int: 'def_int',
  def_td: 'def_td',
  def_pa_a: 'def_pts_allowed',
};

/**
 * Season projections. Spec: GET /nfl/{season}/projections, `position` required.
 * Omitting `week` yields season totals rather than a single week.
 */
export async function fetchProjections({ season, position = 'ALL', week = null } = {}) {
  const { res, url } = await get(`/nfl/${season}/projections`, { position, week });
  if (!res.ok) {
    throw new Error(
      `FantasyPros projections failed: HTTP ${res.status}${res.error ? ` — ${res.error}` : ''}\n  ${redact(url)}`
    );
  }
  const rows = extractPlayers(res.json);
  log.info(`projections: ${rows.length} players (season ${season}${week ? `, week ${week}` : ', season totals'})`);
  return rows;
}

/**
 * Convert a projection row into a canonical per-game stat line.
 *
 * Two deliberate adjustments:
 *  - Season totals are divided by the games played, because every engine in
 *    this platform reasons in per-game terms.
 *  - First downs are DERIVED, because FantasyPros does not project them and a
 *    league scoring 0.5 per first down would otherwise lose a large, real
 *    scoring category. The rates come from the same place the archetype curves
 *    use them, and the derivation is flagged so it is never mistaken for a
 *    projected figure.
 */
export function toStatLine(row, { gamesPlayed = 17 } = {}) {
  const per = gamesPlayed > 0 ? gamesPlayed : 17;
  const out = {};
  for (const [their, ours] of Object.entries(STAT_MAP)) {
    const v = Number(row.stats?.[their] ?? row[their]);
    if (Number.isFinite(v) && v !== 0) out[ours] = v / per;
  }
  // Derived, not projected — FantasyPros does not publish first downs.
  if (out.pass_cmp) out.pass_first_down = out.pass_cmp * 0.55;
  if (out.rush_att) out.rush_first_down = out.rush_att * 0.24;
  if (out.rec) out.rec_first_down = out.rec * 0.57;
  return out;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Pull the player array out of the response.
 *
 * The spec documents `players`, but this stays tolerant of wrapper changes: it
 * picks whichever array yields the most recognisable player records. An earlier
 * version demanded that nearly every entry parse, which meant one malformed row
 * could discard an entire valid list and report zero silently.
 */
export function extractPlayers(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [];
  const visit = (node, depth = 0) => {
    if (depth > 5 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length && node.every((x) => x && typeof x === 'object')) candidates.push(node);
      return;
    }
    for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(payload);

  let best = [];
  let bestScore = 0;
  for (const arr of candidates) {
    const mapped = arr.map(normalisePlayer).filter((p) => p.name);
    if (!mapped.length) continue;
    const score = mapped.length + mapped.filter((p) => p.pos).length;
    if (score > bestScore) { bestScore = score; best = mapped; }
  }
  return best.map((p, i) => ({ ...p, rank: p.rank ?? i + 1 }));
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function normalisePlayer(raw) {
  const name = raw.player_name ?? raw.name ?? raw.fantasypros_player_name ?? raw.full_name ?? null;
  const pos = String(raw.player_position_id ?? raw.position_id ?? raw.position ?? raw.pos ?? '')
    .toUpperCase().replace(/[0-9]/g, '').trim();
  return {
    name: typeof name === 'string' ? name.trim() : null,
    pos: pos === 'DST' || pos === 'D/ST' ? 'DEF' : pos,
    team: raw.player_team_id ?? raw.team_id ?? raw.team ?? null,
    rank: num(raw.rank_ecr ?? raw.rank ?? raw.ecr),
    adp: num(raw.rank_ave ?? raw.adp ?? raw.average_rank),
    tier: num(raw.tier),
    games: num(raw.games ?? raw.g),
    stats: raw.stats ?? raw,
  };
}

function redact(url) {
  const key = config.fantasyProsKey;
  return key ? url.split(key).join('***') : url;
}

/**
 * Diagnostic across seasons and ranking types, reporting what each combination
 * actually returned. Kept because the API answers an invalid enum value with a
 * 403 that is easy to misread as an authentication problem.
 */
export async function probe({ season, scoring = 'HALF' } = {}) {
  const results = [];
  for (const yr of [season, season - 1]) {
    for (const type of ['DRAFT', 'ADP']) {
      const { url, res } = await get(`/nfl/${yr}/consensus-rankings`, {
        position: 'ALL', type, scoring: String(scoring).toUpperCase(), week: 0,
      }, { noCache: true });
      const players = res.ok ? extractPlayers(res.json) : [];
      results.push({
        kind: 'rankings', season: yr, type, status: res.status,
        playersFound: players.length,
        sample: players.slice(0, 3).map((p) => `${p.name} (${p.pos}) rank ${p.rank}`),
        body: typeof res.body === 'string' ? res.body.slice(0, 140) : null,
        url: redact(url),
      });
    }
    const { url: pUrl, res: pRes } = await get(`/nfl/${yr}/projections`, { position: 'ALL' }, { noCache: true });
    const proj = pRes.ok ? extractPlayers(pRes.json) : [];
    results.push({
      kind: 'projections', season: yr, type: '-', status: pRes.status,
      playersFound: proj.length,
      sample: proj.slice(0, 2).map((p) => `${p.name} (${p.pos}) ${JSON.stringify(p.stats).slice(0, 90)}`),
      body: typeof pRes.body === 'string' ? pRes.body.slice(0, 140) : null,
      url: redact(pUrl),
    });
  }
  return results;
}
