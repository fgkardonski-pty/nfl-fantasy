/**
 * Sleeper public API.
 *
 * Free, keyless, and generous. Used for three things Yahoo does not give us
 * cheaply: a full NFL player index with depth-chart position and injury status,
 * league-wide "trending adds" (a genuine market signal for who the rest of the
 * fantasy world is chasing), and the current NFL week/season state.
 *
 * https://docs.sleeper.com — no authentication required.
 */
import { getJson } from '../util/http.mjs';
import { upsertMany, get } from '../db/index.mjs';
import { logger } from '../util/log.mjs';

const log = logger('sleeper');
const BASE = 'https://api.sleeper.app/v1';

export async function nflState() {
  const j = await getJson(`${BASE}/state/nfl`, { source: 'sleeper', cache: true, maxAgeMs: 36e5 });
  if (!j) return null;
  return {
    season: Number(j.season),
    week: Number(j.week ?? j.display_week ?? 1),
    seasonType: j.season_type,
    leg: Number(j.leg ?? 1),
  };
}

/**
 * The full NFL player index (~5MB). Cached aggressively — it changes daily at
 * most, and Sleeper explicitly asks callers not to poll it.
 */
export async function playerIndex() {
  const j = await getJson(`${BASE}/players/nfl`, {
    source: 'sleeper', cache: true, maxAgeMs: 12 * 36e5, timeoutMs: 60000,
  });
  if (!j) return [];
  return Object.values(j)
    .filter((p) => p && p.player_id && p.position && ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(p.position))
    .map((p) => ({
      sleeper_id: String(p.player_id),
      name: p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
      pos: p.position,
      nfl_team: p.team ?? null,
      status: mapStatus(p.injury_status),
      injury_note: p.injury_notes ?? p.injury_body_part ?? null,
      age: p.age ?? null,
      years_exp: p.years_exp ?? null,
      depth_rank: p.depth_chart_order ?? null,
      search_name: (p.search_full_name ?? '').toLowerCase(),
    }));
}

function mapStatus(s) {
  if (!s) return '';
  const m = { Questionable: 'Q', Doubtful: 'D', Out: 'O', IR: 'IR', PUP: 'PUP', Sus: 'SUSP', COV: 'COV', 'Sus.': 'SUSP' };
  return m[s] ?? String(s).slice(0, 4).toUpperCase();
}

/**
 * What the wider fantasy market is adding right now.
 * This is a leading indicator of waiver competition in your own league.
 */
export async function trendingAdds({ hours = 24, limit = 50 } = {}) {
  const j = await getJson(`${BASE}/players/nfl/trending/add?lookback_hours=${hours}&limit=${limit}`, {
    source: 'sleeper', cache: true, maxAgeMs: 18e5,
  });
  return Array.isArray(j) ? j.map((x) => ({ sleeper_id: String(x.player_id), count: Number(x.count) })) : [];
}

export async function trendingDrops({ hours = 24, limit = 50 } = {}) {
  const j = await getJson(`${BASE}/players/nfl/trending/drop?lookback_hours=${hours}&limit=${limit}`, {
    source: 'sleeper', cache: true, maxAgeMs: 18e5,
  });
  return Array.isArray(j) ? j.map((x) => ({ sleeper_id: String(x.player_id), count: Number(x.count) })) : [];
}

/**
 * Match Sleeper players onto our existing player rows by normalised name and
 * position, and backfill injury status, age, experience and depth-chart order.
 * Only fields we do not already have from Yahoo are overwritten.
 */
export async function enrichPlayers() {
  const index = await playerIndex();
  if (!index.length) return { matched: 0, total: 0, note: 'Sleeper index unavailable' };

  const bySearch = new Map();
  for (const p of index) {
    const k = `${normaliseName(p.name)}|${p.pos}`;
    if (!bySearch.has(k)) bySearch.set(k, p);
  }

  const { all } = await import('../db/index.mjs');
  const locals = all('SELECT player_id, name, pos, status, sleeper_id FROM players');
  const updates = [];
  for (const local of locals) {
    const hit = bySearch.get(`${normaliseName(local.name)}|${local.pos}`);
    if (!hit) continue;
    updates.push({
      player_id: local.player_id,
      sleeper_id: hit.sleeper_id,
      // Yahoo's designation is authoritative when present; Sleeper fills gaps.
      status: local.status || hit.status,
      injury_note: hit.injury_note,
      age: hit.age,
      years_exp: hit.years_exp,
      depth_rank: hit.depth_rank,
      updated_at: Date.now(),
    });
  }
  if (updates.length) {
    upsertMany('players',
      ['player_id', 'sleeper_id', 'status', 'injury_note', 'age', 'years_exp', 'depth_rank', 'updated_at'],
      updates, ['player_id']);
  }
  log.info(`enriched ${updates.length}/${locals.length} players from Sleeper`);
  return { matched: updates.length, total: locals.length };
}

const normaliseName = (n) => String(n ?? '')
  .toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
  .replace(/[^a-z]/g, '');

export { normaliseName };

// ---------------------------------------------------------------------------
// Weekly stats and projections
// ---------------------------------------------------------------------------

/**
 * Sleeper's stat keys -> this platform's canonical scoring keys.
 *
 * Deliberately explicit rather than a fuzzy prefix match. Sleeper publishes
 * around 300 keys and several near-homonyms mean different things: `rec_fd`
 * and `rec_td` differ by one letter and by six points, `pts_allow` is a raw
 * count while `pts_allow_0` is a boolean flag for the bucket. A wrong guess
 * here is not a crash, it is a silently wrong projection for a whole position,
 * which is exactly the class of error that already cost us a draft.
 *
 * Left unmapped on purpose: anything this league does not score. Adding a key
 * that no scoring rule reads costs nothing but noise.
 */
export const SLEEPER_STAT_MAP = {
  // Passing
  pass_cmp: 'pass_cmp',
  pass_yd: 'pass_yd',
  pass_td: 'pass_td',
  pass_int: 'pass_int',
  pass_fd: 'pass_first_down',
  pass_cmp_40p: 'pass_cmp_40',
  pass_td_40p: 'pass_td_40',
  pass_int_td: 'pick_six_thrown',   // interception returned for a touchdown
  pass_2pt: 'two_pt',

  // Rushing
  rush_att: 'rush_att',
  rush_yd: 'rush_yd',
  rush_td: 'rush_td',
  rush_fd: 'rush_first_down',
  rush_40p: 'rush_40',
  rush_td_40p: 'rush_td_40',
  rush_2pt: 'two_pt',

  // Receiving
  rec: 'rec',
  rec_yd: 'rec_yd',
  rec_td: 'rec_td',
  rec_fd: 'rec_first_down',
  rec_40p: 'rec_40',
  rec_td_40p: 'rec_td_40',
  rec_2pt: 'two_pt',

  // Misc offence
  fum_lost: 'fum_lost',
  fum_rec_td: 'fum_ret_td',

  // Kicking
  fgm_0_19: 'fg_0_19',
  fgm_20_29: 'fg_20_29',
  fgm_30_39: 'fg_30_39',
  fgm_40_49: 'fg_40_49',
  fgm_50p: 'fg_50p',
  fgmiss_0_19: 'fg_miss_0_19',
  xpm: 'pat_made',

  // Team defence / special teams
  sack: 'def_sack',
  int: 'def_int',
  fum_rec: 'def_fum_rec',
  // A fumble recovered on special teams counts the same as one on defence in
  // this league — Yahoo does not split them.
  def_st_fum_rec: 'def_fum_rec',
  def_td: 'def_td',
  safe: 'def_safety',
  blk_kick: 'def_block',
  def_st_td: 'def_ret_td',
  st_td: 'def_ret_td',
  tkl_loss: 'def_tfl',
  def_4_and_stop: 'def_4th_down_stop',
  def_forced_punts: null,          // known key, this league does not score it
  blk_kick_ret_yd: 'def_ret_yd',
  def_st_ff: null,

  // Points allowed, as Sleeper's own bucket flags. These are the exact tier a
  // defence landed in for a game that has been played, and they map straight
  // onto this league's scoring. The raw `pts_allow` total is carried too, but
  // only the projection path can use that — it has to be converted through a
  // distribution, and there is no `def_pts_allowed` rate for the scoring loop
  // to multiply by. Without these flags a real defensive week scored ZERO for
  // points allowed: sixteen points for a shutout, silently dropped.
  pts_allow_0: 'def_pa_0',
  pts_allow_1_6: 'def_pa_1_6',
  pts_allow_7_13: 'def_pa_7_13',
  pts_allow_14_20: 'def_pa_14_20',
  pts_allow_21_27: 'def_pa_21_27',
  pts_allow_28_34: 'def_pa_28_34',
  pts_allow_35p: 'def_pa_35p',
};

/**
 * Keys that need arithmetic rather than a rename.
 *
 * Return yards are the clearest case: Sleeper splits them into kick and punt
 * returns, and this league scores the SUM, for the defence only. Points allowed
 * arrives as a raw total that the valuation model turns into a tier, so it is
 * carried through under its own name rather than pre-bucketed here.
 */
function derivedStats(raw, pos) {
  const out = {};

  // Return yards live under DIFFERENT keys for a team unit than for a player.
  // `kr_yd`/`pr_yd` are one player's returns; `def_kr_yd`/`def_pr_yd` are the
  // team's, and only the team keys appear on a DST row. Reading the player keys
  // for a defence — which the first cut did — left def_ret_yd unset on every
  // defence in the league, so the per-yard rate and the +1 at thirty yards both
  // scored nothing.
  if (pos === 'DEF') {
    const kr = Number(raw.def_kr_yd ?? raw.kr_yd ?? 0);
    const pr = Number(raw.def_pr_yd ?? raw.pr_yd ?? 0);
    if (kr || pr) out.def_ret_yd = kr + pr;
    const krTd = Number(raw.kr_td ?? 0), prTd = Number(raw.pr_td ?? 0);
    if (krTd || prTd) out.def_ret_td = krTd + prTd;
    // Carried for the projection path only. Nothing multiplies it in the
    // scoring loop, so it cannot double-count against the bucket flags above.
    if (raw.pts_allow != null) out.def_pts_allowed = Number(raw.pts_allow);
    if (raw.yds_allow != null) out.def_yds_allowed = Number(raw.yds_allow);
    return out;
  }

  // Skill players score nothing for return yards in this league (RB/WR/TE 0,
  // and quarterbacks do not return kicks). Kept under ret_yd so the value is
  // not lost, and priced at whatever the scoring config says — currently zero.
  const kr = Number(raw.kr_yd ?? 0), pr = Number(raw.pr_yd ?? 0);
  if (kr || pr) out.ret_yd = kr + pr;
  const krTd = Number(raw.kr_td ?? 0), prTd = Number(raw.pr_td ?? 0);
  if (krTd || prTd) out.ret_td = krTd + prTd;
  return out;
}

/** Translate one Sleeper stat blob into canonical scoring keys. */
export function mapSleeperStats(raw, pos) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = SLEEPER_STAT_MAP[k];
    if (!key) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) continue;
    // Several Sleeper keys collapse onto one of ours (three flavours of two-point
    // conversion, two of return touchdown), so accumulate rather than overwrite.
    out[key] = (out[key] ?? 0) + n;
  }
  Object.assign(out, derivedStats(raw, pos));
  return out;
}

/** Usage signals, which live in the same blob but are not scoring stats. */
export function mapSleeperUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (k) => (raw[k] == null ? null : Number(raw[k]));
  const offSnp = num('off_snp'), tmOffSnp = num('tm_off_snp');
  const tgt = num('rec_tgt'), tmTgt = num('tm_pass_att');
  const att = num('rush_att'), tmAtt = num('tm_rush_att');
  const u = {
    snap_pct: offSnp != null && tmOffSnp ? offSnp / tmOffSnp : null,
    route_pct: null,
    target_share: tgt != null && tmTgt ? tgt / tmTgt : null,
    rush_share: att != null && tmAtt ? att / tmAtt : null,
    air_yard_share: null,
    rz_touches: num('rush_rz_att'),
    // Sleeper does not publish goal-line carries or route participation in the
    // free feed. Left null rather than approximated: a made-up usage number
    // propagates straight into a start/sit call.
    gl_carries: null,
  };
  return Object.values(u).some((v) => v != null) ? u : null;
}

/**
 * Raw weekly stat blobs, keyed by Sleeper player id.
 * @param {'stats'|'projections'} kind
 */
export async function weeklyBlobs({ season, week, kind = 'stats', seasonType = 'regular' } = {}) {
  const url = `${BASE}/${kind}/nfl/${seasonType}/${season}/${week}`;
  const j = await getJson(url, {
    source: 'sleeper', cache: true,
    // Completed weeks never change; the current week does, all Sunday long.
    maxAgeMs: kind === 'projections' ? 6 * 36e5 : 36e5,
    timeoutMs: 45000,
  });
  if (!j || typeof j !== 'object') return null;
  return j;
}

/**
 * The NFL schedule for a season.
 *
 * NOT part of Sleeper's documented v1 surface — it sits outside /v1 and its
 * shape is not contractual, so every field is read defensively and the caller
 * is told plainly when nothing usable came back. Worth the uncertainty because
 * the alternative is no schedule at all: without one every player projects
 * matchup-neutral, the defense streamer cannot rank, and there is no way to
 * separate a modelling error from a hard week.
 *
 * It carries no betting lines. Those still have to come from an odds feed.
 */
export async function nflSchedule({ season, seasonType = 'regular' } = {}) {
  const j = await getJson(`https://api.sleeper.app/schedule/nfl/${seasonType}/${season}`, {
    source: 'sleeper', cache: true, maxAgeMs: 24 * 36e5, timeoutMs: 45000,
  });
  if (!Array.isArray(j)) return null;

  const games = [];
  for (const g of j) {
    const week = Number(g?.week);
    const home = g?.home ?? g?.home_team ?? null;
    const away = g?.away ?? g?.away_team ?? null;
    if (!Number.isFinite(week) || !home || !away) continue;
    games.push({
      season, week,
      home: String(home).toUpperCase(),
      away: String(away).toUpperCase(),
      kickoff: g?.date ? Date.parse(g.date) : null,
      status: g?.status ?? null,
    });
  }
  return games.length ? games : null;
}
