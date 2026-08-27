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

/**
 * Build the full request URL for a path and query.
 *
 * Exported so the exact path can be asserted in tests without any network I/O.
 * The /json segment lives in DEFAULT_BASE and nowhere else — a duplicated copy
 * in config once shadowed it, dropping the segment and turning every request
 * into a 403 that read as an authentication failure rather than a bad route.
 */
export function buildRequestUrl(path, params = {}) {
  const url = new URL(`${base()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

async function get(path, params, { noCache = false } = {}) {
  if (!isConfigured()) {
    throw new Error(
      'FANTASYPROS_API_KEY is not set in .env. Request a personal key at https://api.fantasypros.com'
    );
  }
  const url = buildRequestUrl(path, params);
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
 * Positions swept when building a full pool. Spec: NFLPositions.
 *
 * DST rather than DEF — the spec's enum uses the former; the response is
 * normalised back to DEF for us in normalisePlayer.
 */
export const POSITION_GROUPS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

/**
 * How this deployment pages through a long list.
 *
 * The API answers with a `count` in the hundreds and a `players` array of ten,
 * so it pages; the published spec just does not say how. Rather than hard-code
 * a guess, the control lives in configuration and `real fp-page` finds it:
 *
 *   FANTASYPROS_PAGE_PARAM=limit   FANTASYPROS_PAGE_STYLE=size
 *   FANTASYPROS_PAGE_PARAM=offset  FANTASYPROS_PAGE_STYLE=offset
 *   FANTASYPROS_PAGE_PARAM=page    FANTASYPROS_PAGE_STYLE=page
 *
 * With `size` one request asks for everything. With `offset` or `page` the
 * client walks the list a page at a time. Walking 941 players ten at a time is
 * 95 requests, which is a nuisance once before a draft and nothing after that.
 */
const pageParam = () => config.fantasyProsPageParam || null;
const pageStyle = () => config.fantasyProsPageStyle || 'size';

/** Hard ceiling so a misbehaving endpoint can never loop forever. */
const MAX_PAGES = 120;

/**
 * Read a whole list, paging if a paging parameter is configured.
 *
 * Stops on the first page that adds nobody new, which covers the case where the
 * parameter is silently ignored — better to return the first page once than to
 * fetch it a hundred times.
 */
async function fetchAll(path, params, label) {
  const param = pageParam();
  const first = await fetchOne(path, params, label);
  if (!param) return first;

  if (pageStyle() === 'size') {
    const sized = await fetchOne(path, { ...params, [param]: 500 }, label);
    return sized.players.length > first.players.length ? sized : first;
  }

  // offset / page styles: walk until we have everyone or nothing new arrives.
  const seen = new Map();
  for (const p of first.players) seen.set(nameKey(p), p);
  const perPage = Math.max(1, first.players.length);
  const target = first.reported ?? Infinity;

  for (let i = 1; i < MAX_PAGES && seen.size < target; i++) {
    const value = pageStyle() === 'page' ? i + 1 : i * perPage;
    let page;
    try {
      page = await fetchOne(path, { ...params, [param]: value }, label);
    } catch (err) {
      log.warn(`${label}: page ${i} failed — ${err.message.split('\n')[0]}`);
      break;
    }
    const before = seen.size;
    for (const p of page.players) {
      const k = nameKey(p);
      if (!seen.has(k)) seen.set(k, p);
    }
    if (seen.size === before) break; // nothing new — the parameter did nothing
  }

  return { players: [...seen.values()], reported: first.reported };
}

/** One request, returning the parsed players alongside the count the API itself reports. */
async function fetchOne(path, params, label) {
  const { res, url } = await get(path, params);
  if (!res.ok) {
    throw new Error(
      `FantasyPros ${label} failed: HTTP ${res.status}${res.error ? ` — ${res.error}` : ''}\n` +
      `  ${redact(url)}\n` +
      (res.status === 403
        ? '  A 403 here usually means an invalid parameter value rather than a bad key — ' +
          'the ranking type and scoring values are case-sensitive and uppercase.'
        : '')
    );
  }
  return {
    players: extractPlayers(res.json),
    reported: Number.isFinite(Number(res.json?.count)) ? Number(res.json.count) : null,
  };
}

async function fetchRankingPage(season, params) {
  return fetchAll(`/nfl/${season}/consensus-rankings`, params, 'rankings');
}

export const nameKey = (p) => `${String(p.name ?? '').toLowerCase().replace(/[^a-z]/g, '')}|${p.pos ?? ''}`;

/**
 * Consensus rankings for a whole draft pool.
 *
 * WHY THIS SWEEPS POSITIONS. The overall (position=ALL) board is a single
 * consensus list, and it is not guaranteed to run as deep as a 16-team draft
 * does — a 16x16 draft is 256 picks, and the tail of it is exactly where the
 * board earns its keep. Each positional call returns that position's own full
 * list, so sweeping them and merging fills in everyone the overall board stops
 * short of. Players already on the overall board keep their real overall rank;
 * only the ones it omitted get an estimated one, and they are flagged as such.
 *
 * The API reports its own `count` per response, so a truncated reply is
 * detected rather than silently imported as a short board — the failure mode
 * that would matter most here is a board that looks complete and is not.
 */
export async function fetchRankings({ season, scoring = 'HALF', type = 'DRAFT', sweep = true } = {}) {
  const common = {
    type: String(type).toUpperCase(),
    scoring: String(scoring).toUpperCase(),
    week: 0,
  };

  const overall = await fetchRankingPage(season, { ...common, position: 'ALL' });
  const merged = new Map();
  for (const p of overall.players) merged.set(nameKey(p), { ...p, estimatedRank: false });

  const truncated = [];
  if (overall.reported != null && overall.players.length < overall.reported) {
    truncated.push(`ALL (${overall.players.length} of ${overall.reported})`);
  }

  if (sweep) {
    for (const pos of POSITION_GROUPS) {
      let page;
      try {
        page = await fetchRankingPage(season, { ...common, position: pos });
      } catch (err) {
        log.warn(`rankings sweep: ${pos} failed — ${err.message.split('\n')[0]}`);
        continue;
      }
      if (page.reported != null && page.players.length < page.reported) {
        truncated.push(`${pos} (${page.players.length} of ${page.reported})`);
      }
      mergePositionalList(merged, page.players);
    }
  }

  const players = [...merged.values()].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const estimated = players.filter((p) => p.estimatedRank).length;
  log.info(
    `rankings: ${players.length} players (${scoring}/${type}, season ${season}` +
    `${estimated ? `, ${estimated} ranked by positional extrapolation` : ''})`
  );
  players.truncated = truncated;
  return players;
}

/**
 * Fold one position's full list into the merged pool.
 *
 * Players the overall board already carries are left exactly as they are. For
 * the ones it omitted, an overall rank has to come from somewhere, and the
 * honest construction is to extrapolate from the deepest players at that
 * position who DO appear on both lists: the gap in overall rank between the two
 * deepest shared players tells us roughly how many picks pass between
 * consecutive players at this position that late, and the tail is spaced by
 * that. It is an estimate, marked as one, and it only ever orders players the
 * overall board declined to rank at all.
 */
export function mergePositionalList(merged, list) {
  const ordered = [...list]
    .filter((p) => p.name && Number.isFinite(p.rank))
    .sort((a, b) => a.rank - b.rank);
  if (!ordered.length) return;

  // Anchors: players present on both lists, as (positional rank -> overall rank).
  const anchors = [];
  for (const p of ordered) {
    const known = merged.get(nameKey(p));
    if (known && Number.isFinite(known.rank) && !known.estimatedRank) {
      anchors.push({ posRank: p.rank, overall: known.rank });
    }
  }

  const last = anchors[anchors.length - 1];
  const prev = anchors[anchors.length - 2];
  // Picks between consecutive players at this position, near the tail.
  let slope = 8;
  if (last && prev && last.posRank > prev.posRank) {
    slope = Math.max(1, (last.overall - prev.overall) / (last.posRank - prev.posRank));
  }

  for (const p of ordered) {
    const key = nameKey(p);
    if (merged.has(key)) continue;
    const overall = last
      ? last.overall + Math.max(1, p.rank - last.posRank) * slope
      : null;
    merged.set(key, { ...p, rank: overall, adp: overall, estimatedRank: true });
  }
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
 *
 * Swept per position for the same reason the rankings are: the projections are
 * the input the league's own scoring table gets applied to, so a short list
 * here means players priced off a generic positional archetype instead of off
 * what they are actually projected to do. Sweeping costs six requests once.
 */
export async function fetchProjections({ season, week = null, positions = POSITION_GROUPS } = {}) {
  const merged = new Map();
  const truncated = [];
  let any = false;

  for (const position of positions) {
    let page;
    try {
      page = await fetchAll(`/nfl/${season}/projections`, { position, week }, 'projections');
    } catch (err) {
      // A single position failing should not cost the other five.
      log.warn(`projections: ${position} failed — ${err.message.split('\n')[0]}`);
      continue;
    }
    any = true;
    if (page.reported != null && page.players.length < page.reported) {
      truncated.push(`${position} (${page.players.length} of ${page.reported})`);
    }
    for (const r of page.players) {
      const key = nameKey(r);
      if (!merged.has(key)) merged.set(key, r);
    }
  }

  if (!any) {
    throw new Error(
      `FantasyPros projections failed: every position request errored for season ${season}.`
    );
  }

  const out = [...merged.values()];
  out.truncated = truncated;
  log.info(`projections: ${out.length} players (season ${season}${week ? `, week ${week}` : ', season totals'})`);
  return out;
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
 * Candidate paging parameters, in the order they are worth trying.
 *
 * The published spec documents none of these on the rankings or projections
 * endpoints, yet those endpoints answer with a `count` in the hundreds and a
 * `players` array of exactly ten. Something is paginating, and the control for
 * it is simply undocumented. API Gateway rejects a bad value for a parameter it
 * knows about, but passes unknown parameters through to the backend, so trying
 * a battery of conventional names is safe and costs one request each.
 *
 * Both halves matter. A page-SIZE parameter is the clean fix. But an OFFSET
 * parameter is just as good in practice: 941 players at ten a page is 95
 * requests, done once before a draft, which is nothing.
 */
const PAGE_SIZE_PARAMS = ['limit', 'max_results', 'per_page', 'page_size', 'pageSize', 'max', 'results', 'num'];
const OFFSET_PARAMS = ['offset', 'start', 'page', 'skip', 'from'];

const nameSetOf = (players) => players.map((p) => p.name).join('|');

/**
 * Find whichever paging control this API actually honours.
 *
 * Reports, for each candidate, whether it enlarged the page or moved it. A
 * candidate that does neither is silently ignored by the backend and useless.
 */
export async function probePaging({ season, scoring = 'HALF' } = {}) {
  const path = `/nfl/${season}/consensus-rankings`;
  const common = { position: 'ALL', type: 'DRAFT', scoring: String(scoring).toUpperCase(), week: 0 };

  const { res: baseRes } = await get(path, common, { noCache: true });
  if (!baseRes.ok) throw new Error(`baseline request failed: HTTP ${baseRes.status}`);
  const basePlayers = extractPlayers(baseRes.json);
  const baseSet = nameSetOf(basePlayers);
  const reported = Number(baseRes.json?.count) || null;

  const findings = [];

  for (const param of PAGE_SIZE_PARAMS) {
    const { res } = await get(path, { ...common, [param]: 200 }, { noCache: true });
    const players = res.ok ? extractPlayers(res.json) : [];
    findings.push({
      param, kind: 'page-size', value: 200, status: res.status,
      players: players.length,
      effect: !res.ok ? 'rejected'
        : players.length > basePlayers.length ? 'ENLARGED'
        : 'ignored',
    });
    if (players.length > basePlayers.length) break; // found it; stop spending calls
  }

  // Only bother with offsets if nothing enlarged the page.
  if (!findings.some((f) => f.effect === 'ENLARGED')) {
    for (const param of OFFSET_PARAMS) {
      // page/offset differ in origin: page 2 is the second page, offset 10 is
      // the eleventh row. Both land past the first ten either way.
      const value = param === 'page' ? 2 : basePlayers.length;
      const { res } = await get(path, { ...common, [param]: value }, { noCache: true });
      const players = res.ok ? extractPlayers(res.json) : [];
      findings.push({
        param, kind: 'offset', value, status: res.status,
        players: players.length,
        effect: !res.ok ? 'rejected'
          : players.length && nameSetOf(players) !== baseSet ? 'MOVED'
          : 'ignored',
        sample: players.slice(0, 2).map((p) => `${p.name} (${p.pos}) rank ${p.rank}`),
      });
      if (players.length && nameSetOf(players) !== baseSet) break;
    }
  }

  return { reported, baseline: basePlayers.length, findings };
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
        reported: res.ok ? (Number(res.json?.count) || null) : null,
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
      reported: pRes.ok ? (Number(pRes.json?.count) || null) : null,
      sample: proj.slice(0, 2).map((p) => `${p.name} (${p.pos}) ${JSON.stringify(p.stats).slice(0, 90)}`),
      body: typeof pRes.body === 'string' ? pRes.body.slice(0, 140) : null,
      url: redact(pUrl),
    });
  }

  // One positional call, to show directly whether ALL is the short list.
  const { url: rbUrl, res: rbRes } = await get(`/nfl/${season}/consensus-rankings`, {
    position: 'RB', type: 'DRAFT', scoring: String(scoring).toUpperCase(), week: 0,
  }, { noCache: true });
  const rbs = rbRes.ok ? extractPlayers(rbRes.json) : [];
  results.push({
    kind: 'rankings', season, type: 'DRAFT/RB-only', status: rbRes.status,
    playersFound: rbs.length,
    reported: rbRes.ok ? (Number(rbRes.json?.count) || null) : null,
    sample: rbs.slice(0, 3).map((p) => `${p.name} (${p.pos}) rank ${p.rank}`),
    body: typeof rbRes.body === 'string' ? rbRes.body.slice(0, 140) : null,
    url: redact(rbUrl),
  });

  return results;
}
