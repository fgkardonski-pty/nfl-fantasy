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
