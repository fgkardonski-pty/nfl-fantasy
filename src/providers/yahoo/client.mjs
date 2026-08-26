/**
 * Yahoo Fantasy Sports API client.
 *
 * Thin, rate-limited, and always returns NORMALISED data — callers never see
 * Yahoo's raw nesting. Every method degrades to a thrown Error with an
 * actionable message rather than returning half-parsed junk.
 */
import config from '../../config.mjs';
import { accessToken } from './oauth.mjs';
import { request } from '../../util/http.mjs';
import { root, extractList } from './parse.mjs';
import { logger } from '../../util/log.mjs';

const log = logger('yahoo');

/** Raw GET against the Fantasy API, returning the normalised fantasy_content. */
export async function api(pathAndQuery, { cache = false, maxAgeMs = 0 } = {}) {
  const token = await accessToken();
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${config.yahoo.apiBase}${pathAndQuery}${sep}format=json`;
  const res = await request(url, {
    source: 'yahoo',
    headers: { authorization: `Bearer ${token}` },
    cache,
    maxAgeMs,
    retries: 3,
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('Yahoo rejected the access token (401). Reconnect your Yahoo account.');
    if (res.status === 999) throw new Error('Yahoo is rate limiting this client (999). Wait a few minutes and retry.');
    throw new Error(`Yahoo API error on ${pathAndQuery}: ${res.error}`);
  }
  if (!res.json) throw new Error(`Yahoo returned a non-JSON response for ${pathAndQuery}`);
  return root(res.json);
}

/** The NFL game key for a season (Yahoo's per-sport, per-year identifier). */
export async function nflGameKey(season = config.season) {
  const r = await api(`/game/nfl`, { cache: true, maxAgeMs: 864e5 });
  const games = extractList(r, 'game');
  const match = games.find((g) => String(g.season) === String(season));
  return match?.game_key ?? games[0]?.game_key ?? 'nfl';
}

/** All NFL leagues the authenticated user belongs to. */
export async function myLeagues() {
  const r = await api('/users;use_login=1/games;game_keys=nfl/leagues');
  return extractList(r, 'league')
    .filter((l) => l.league_key)
    .map((l) => ({
      league_key: l.league_key,
      league_id: l.league_id,
      name: l.name,
      season: Number(l.season),
      num_teams: Number(l.num_teams),
      scoring_type: l.scoring_type,
      current_week: Number(l.current_week ?? 1),
      start_week: Number(l.start_week ?? 1),
      end_week: Number(l.end_week ?? 17),
      url: l.url,
      is_finished: Number(l.is_finished ?? 0) === 1,
    }));
}

export async function leagueSettings(leagueKey) {
  const r = await api(`/league/${leagueKey}/settings`);
  const league = extractList(r, 'league')[0] ?? {};
  const settings = extractList(r, 'settings')[0] ?? {};
  return {
    league,
    settings,
    rosterPositions: extractList(r, 'roster_position'),
    statModifiers: extractList(r, 'stat'),
  };
}

export async function leagueTeams(leagueKey) {
  const r = await api(`/league/${leagueKey}/teams`);
  return extractList(r, 'team').filter((t) => t.team_key);
}

export async function leagueStandings(leagueKey) {
  const r = await api(`/league/${leagueKey}/standings`);
  return extractList(r, 'team').filter((t) => t.team_key);
}

export async function teamRoster(teamKey, week) {
  const suffix = week ? `;week=${week}` : '';
  const r = await api(`/team/${teamKey}/roster${suffix}`);
  return extractList(r, 'player').filter((p) => p.player_id);
}

export async function scoreboard(leagueKey, week) {
  const suffix = week ? `;week=${week}` : '';
  const r = await api(`/league/${leagueKey}/scoreboard${suffix}`);
  return { matchups: extractList(r, 'matchup'), teams: extractList(r, 'team') };
}

/**
 * The full transaction log. Yahoo paginates at 25; we walk until exhausted so
 * the opponent model sees the entire season, not the last page.
 */
export async function transactions(leagueKey, { max = 500 } = {}) {
  const out = [];
  for (let start = 0; start < max; start += 25) {
    const r = await api(`/league/${leagueKey}/transactions;start=${start};count=25`);
    const batch = extractList(r, 'transaction').filter((t) => t.transaction_key);
    if (!batch.length) break;
    out.push(...batch.map((t) => ({ ...t, __players: extractPlayersFor(r, t) })));
    if (batch.length < 25) break;
  }
  return out;
}

/**
 * Yahoo nests each transaction's players inside the transaction node, but
 * extractList flattens across the whole payload, so re-walk the raw tree to
 * associate players with their own transaction.
 */
function extractPlayersFor(rootNode, txn) {
  const found = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const isThis = n.transaction_key === txn.transaction_key || n.transaction_id === txn.transaction_id;
    if (isThis) {
      found.push(...extractList(n, 'player'));
      return;
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(rootNode);
  return found;
}

/**
 * The league player universe. `status` filters: A=available, T=taken,
 * W=waivers, FA=free agents. Paginated 25 at a time.
 */
export async function leaguePlayers(leagueKey, { status = null, count = 300, sort = 'AR' } = {}) {
  const out = [];
  const statusFilter = status ? `;status=${status}` : '';
  for (let start = 0; start < count; start += 25) {
    const r = await api(`/league/${leagueKey}/players${statusFilter};sort=${sort};start=${start};count=25/ownership`);
    const batch = extractList(r, 'player').filter((p) => p.player_id);
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 25) break;
  }
  return out;
}

export async function draftResults(leagueKey) {
  const r = await api(`/league/${leagueKey}/draftresults`);
  return extractList(r, 'draft_result');
}

/** Weekly stats for a batch of players (Yahoo caps player_keys at 25). */
export async function playerWeekStats(leagueKey, playerKeys, week) {
  const out = [];
  for (let i = 0; i < playerKeys.length; i += 25) {
    const batch = playerKeys.slice(i, i + 25);
    const r = await api(
      `/league/${leagueKey}/players;player_keys=${batch.join(',')}/stats;type=week;week=${week}`
    );
    out.push(...extractList(r, 'player').filter((p) => p.player_id));
  }
  return out;
}

/** Submit a waiver claim / add-drop. Requires the fspt-w (write) scope. */
export async function submitAddDrop(leagueKey, { addPlayerKey, dropPlayerKey, teamKey, faabBid = null }) {
  const token = await accessToken();
  const xml = buildAddDropXml({ addPlayerKey, dropPlayerKey, teamKey, faabBid });
  const url = `${config.yahoo.apiBase}/league/${leagueKey}/transactions`;
  const res = await request(url, {
    source: 'yahoo-write',
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/xml' },
    body: xml,
    retries: 1,
    json: false,
  });
  if (!res.ok) throw new Error(`Yahoo rejected the transaction: ${res.error}`);
  return { submitted: true, response: res.body };
}

function buildAddDropXml({ addPlayerKey, dropPlayerKey, teamKey, faabBid }) {
  const players = [];
  if (addPlayerKey) {
    players.push(`<player><player_key>${esc(addPlayerKey)}</player_key><transaction_data><type>add</type><destination_team_key>${esc(teamKey)}</destination_team_key></transaction_data></player>`);
  }
  if (dropPlayerKey) {
    players.push(`<player><player_key>${esc(dropPlayerKey)}</player_key><transaction_data><type>drop</type><source_team_key>${esc(teamKey)}</source_team_key></transaction_data></player>`);
  }
  const type = addPlayerKey && dropPlayerKey ? 'add/drop' : addPlayerKey ? 'add' : 'drop';
  const faab = faabBid != null ? `<faab_bid>${Number(faabBid)}</faab_bid>` : '';
  return `<?xml version="1.0"?><fantasy_content><transaction><type>${type}</type>${faab}<players>${players.join('')}</players></transaction></fantasy_content>`;
}

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
