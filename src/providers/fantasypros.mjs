/**
 * FantasyPros public API — consensus rankings and ADP.
 *
 * Why this matters: the draft engine keys its archetype curves off a player's
 * positional rank, and models what opponents will do off ADP. Both come from
 * here. Without them every player at a position is priced identically and the
 * board is meaningless (see the draft board's coverage warning).
 *
 * TERMS. FantasyPros issues these keys for PERSONAL, NON-COMMERCIAL use. This
 * platform is self-hosted, single-operator, and never redistributes what it
 * fetches — which is squarely inside those terms. Two obligations are worth
 * stating in code because they are easy to violate by accident:
 *   - Do not use the data to build a service competing with FantasyPros.
 *   - Credit FantasyPros when publishing analysis derived from it. The war room
 *     shows an attribution line wherever these rankings are used.
 * Player image URLs are licensed to FantasyPros from a third party and are
 * deliberately NOT imported here.
 *
 * ENDPOINT UNCERTAINTY. This client was written without live access to the API,
 * so the exact response shape is not confirmed. Rather than hardcode a guess
 * that fails silently, every request path is overridable and `probe()` reports
 * exactly what came back. Run the probe once after getting a key; if the
 * default path is wrong, set FANTASYPROS_RANKINGS_PATH and nothing else has to
 * change.
 */
import config from '../config.mjs';
import { request } from '../util/http.mjs';
import { logger } from '../util/log.mjs';

const log = logger('fantasypros');

export const ATTRIBUTION = 'Rankings and ADP: FantasyPros.com';

/** Candidate rankings paths, tried in order by probe(). */
const CANDIDATE_PATHS = [
  '/json/nfl/{season}/consensus-rankings?type=draft&scoring={scoring}&position=ALL&week=0',
  '/json/nfl/{season}/consensus-rankings?type=adp&scoring={scoring}&position=ALL&week=0',
  '/json/nfl/consensus-rankings?type=draft&scoring={scoring}&position=ALL',
];

export const isConfigured = () => Boolean(config.fantasyProsKey);

function buildUrl(pathTemplate, { season, scoring }) {
  const base = (config.fantasyProsBase || 'https://api.fantasypros.com/public/v2').replace(/\/+$/, '');
  const path = pathTemplate
    .replace('{season}', String(season))
    .replace('{scoring}', scoring);
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * FantasyPros scoring codes. Our league scoring is re-applied downstream, so
 * this only picks which consensus board to start from — matching the league's
 * reception value gets the ordering closest to right before we re-price it.
 */
export function scoringCodeFor(leagueScoring) {
  const ppr = Number(leagueScoring?.rec ?? 0);
  if (ppr >= 0.75) return 'PPR';
  if (ppr >= 0.25) return 'HALF';
  return 'STD';
}

async function fetchPath(pathTemplate, { season, scoring }) {
  const url = buildUrl(pathTemplate, { season, scoring });
  const res = await request(url, {
    source: 'fantasypros',
    headers: { 'x-api-key': config.fantasyProsKey },
    cache: true,
    maxAgeMs: 6 * 36e5,
    retries: 2,
  });
  return { url, res };
}

/**
 * Diagnostic. Tries each candidate path and reports what the API actually
 * returned, so the real shape can be adapted to instead of guessed at.
 */
export async function probe({ season, scoring = 'HALF' } = {}) {
  if (!isConfigured()) {
    throw new Error('FANTASYPROS_API_KEY is not set in .env. Request a key at https://api.fantasypros.com');
  }
  const attempts = [];
  for (const template of CANDIDATE_PATHS) {
    const { url, res } = await fetchPath(template, { season, scoring });
    const players = res.ok ? extractPlayers(res.json) : [];
    attempts.push({
      template,
      url: url.replace(config.fantasyProsKey ?? '', '***'),
      status: res.status,
      ok: res.ok,
      error: res.error ?? null,
      playersFound: players.length,
      sample: players.slice(0, 3).map((p) => ({ name: p.name, pos: p.pos, team: p.team, rank: p.rank })),
      topLevelKeys: res.json && typeof res.json === 'object' ? Object.keys(res.json).slice(0, 12) : null,
    });
    if (players.length) break; // found a working shape; no need to keep probing
  }
  return attempts;
}

/**
 * Pull a ranked player list.
 * @returns {Promise<Array<{name,pos,team,rank,adp}>>} ordered best-first
 */
export async function fetchRankings({ season, scoring = 'HALF' } = {}) {
  if (!isConfigured()) {
    throw new Error('FANTASYPROS_API_KEY is not set in .env. Request a key at https://api.fantasypros.com');
  }
  const templates = config.fantasyProsPath
    ? [config.fantasyProsPath, ...CANDIDATE_PATHS]
    : CANDIDATE_PATHS;

  const failures = [];
  for (const template of templates) {
    const { url, res } = await fetchPath(template, { season, scoring });
    if (!res.ok) {
      failures.push(`${template} -> HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`);
      continue;
    }
    const players = extractPlayers(res.json);
    if (players.length) {
      log.info(`fetched ${players.length} ranked players (${scoring})`);
      return players;
    }
    failures.push(`${template} -> 200 but no players recognised in the response`);
  }
  throw new Error(
    'FantasyPros returned no usable rankings. Tried:\n  ' + failures.join('\n  ') +
    '\nRun `oracle real fp-probe` to see the raw response shape, then set ' +
    'FANTASYPROS_RANKINGS_PATH in .env to the correct path.'
  );
}

/**
 * Pull the ranked player list out of whatever envelope the API used.
 *
 * Written to survive shape drift: it looks for the first array of objects that
 * carry something name-like, wherever it sits in the payload, rather than
 * assuming one fixed key. A rankings importer that breaks because a provider
 * renamed a wrapper field is a bad trade for a few lines of tolerance.
 */
export function extractPlayers(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [];
  const visit = (node, depth = 0) => {
    if (depth > 4 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length && node.every((x) => x && typeof x === 'object')) candidates.push(node);
      return;
    }
    for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(payload);

  // Pick the array that yields the MOST recognisable players, preferring ones
  // whose entries carry a position too — that combination is what a rankings
  // list looks like and other arrays in the payload rarely do.
  //
  // An earlier version required nearly every entry in an array to parse, which
  // meant one malformed row could cause a whole valid rankings list to be
  // discarded and the import to report zero silently. Choosing the best
  // candidate degrades far more gracefully than rejecting outright.
  let best = [];
  let bestScore = 0;
  for (const arr of candidates) {
    const mapped = arr.map(normalisePlayer).filter((p) => p.name);
    if (!mapped.length) continue;
    const withPos = mapped.filter((p) => p.pos).length;
    const score = mapped.length + withPos;
    if (score > bestScore) { bestScore = score; best = mapped; }
  }
  // Preserve the API's own ordering when it did not supply explicit ranks.
  return best.map((p, i) => ({ ...p, rank: p.rank ?? i + 1 }));
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function normalisePlayer(raw) {
  const name = raw.player_name ?? raw.name ?? raw.player ?? raw.full_name ?? null;
  const pos = String(raw.player_position_id ?? raw.position ?? raw.pos ?? raw.position_id ?? '')
    .toUpperCase().replace(/[0-9]/g, '').trim();
  return {
    name: typeof name === 'string' ? name.trim() : null,
    pos: pos === 'DST' || pos === 'D/ST' ? 'DEF' : pos,
    team: raw.player_team_id ?? raw.team ?? raw.team_id ?? null,
    rank: num(raw.rank_ecr ?? raw.rank ?? raw.ecr ?? raw.overall_rank),
    adp: num(raw.adp ?? raw.rank_ave ?? raw.average_rank),
    tier: num(raw.tier),
  };
}
