/**
 * Real-data bootstrap for when Yahoo access is not yet available.
 *
 * The draft engine needs three things, and none of them require the Yahoo API:
 *
 *   1. A real player universe       — free from Sleeper's public player index.
 *   2. Real draft rankings (ADP)    — Yahoo does not expose this without OAuth
 *      either, so it is imported from whatever consensus rankings the operator
 *      can view in a browser and paste into a text file.
 *   3. The league's real scoring    — visible in Yahoo's UI without an API
 *      call, so it is entered by hand from a small JSON config.
 *
 * What Yahoo access actually gates is rosters, transactions and live scores —
 * none of which a draft-night tool needs. The live draft state itself (who
 * has been picked) is tracked interactively in the UI as it happens, the same
 * way a human tracks any live draft.
 */
import { upsertMany, run, get, meta, all } from './db/index.mjs';
import * as sleeper from './providers/sleeper.mjs';
import * as fantasypros from './providers/fantasypros.mjs';
import * as fpcsv from './providers/fpcsv.mjs';
import { normaliseName } from './providers/sleeper.mjs';
import { DEFAULT_SCORING } from './engine/scoring.mjs';
import { logger } from './util/log.mjs';

const log = logger('realdata');

/** Stable local id for a Sleeper-sourced player, distinct from demo (dp#) and Yahoo (y#) ids. */
const pid = (sleeperId) => `sl${sleeperId}`;

/**
 * Seed the real NFL player universe from Sleeper's free, keyless player index.
 * Safe to re-run — it upserts, so injury/depth-chart updates just refresh the
 * existing rows.
 */
/**
 * Remove the synthetic demo world.
 *
 * Demo players are fictional and carry `dp` ids. Once real players are loaded
 * they must not coexist: the draft board scores the whole player table, so a
 * mixed pool would rank invented names alongside real ones with no visible
 * distinction — the single worst failure mode for a tool someone is trusting
 * live on draft night.
 *
 * Safe to run: everything it deletes is regenerable with `oracle demo`.
 */
export function clearDemoData() {
  const leagues = all("SELECT league_key FROM leagues WHERE is_demo = 1");
  for (const l of leagues) {
    run('DELETE FROM teams WHERE league_key = ?', [l.league_key]);
    run('DELETE FROM rosters WHERE league_key = ?', [l.league_key]);
    run('DELETE FROM matchups WHERE league_key = ?', [l.league_key]);
    run('DELETE FROM transactions WHERE league_key = ?', [l.league_key]);
    run('DELETE FROM ownership WHERE league_key = ?', [l.league_key]);
    run('DELETE FROM draft_picks WHERE league_key = ?', [l.league_key]);
    run('DELETE FROM projections WHERE league_key = ?', [l.league_key]);
    run('DELETE FROM opponent_profiles WHERE league_key = ?', [l.league_key]);
    run('DELETE FROM leagues WHERE league_key = ?', [l.league_key]);
  }
  // Demo players, and every row keyed to them.
  run("DELETE FROM player_stats WHERE player_id LIKE 'dp%'");
  run("DELETE FROM player_usage WHERE player_id LIKE 'dp%'");
  run("DELETE FROM adp WHERE player_id LIKE 'dp%'");
  run("DELETE FROM players WHERE player_id LIKE 'dp%'");
  const remaining = get("SELECT COUNT(*) c FROM players WHERE player_id LIKE 'dp%'")?.c ?? 0;
  log.info(`cleared ${leagues.length} demo league(s) and their fictional players`);
  return { leagues: leagues.length, remainingDemoPlayers: remaining };
}

/** How many fictional demo players are currently mixed into the pool. */
export function demoPlayerCount() {
  return get("SELECT COUNT(*) c FROM players WHERE player_id LIKE 'dp%'")?.c ?? 0;
}

export async function seedRealPlayers() {
  const index = await sleeper.playerIndex();
  if (!index.length) {
    throw new Error(
      'Sleeper returned no players. Check your network connection — ' +
      'https://api.sleeper.app/v1/players/nfl should be reachable with no login or key.'
    );
  }
  const rows = index.map((p) => ({
    player_id: pid(p.sleeper_id),
    name: p.name,
    pos: p.pos,
    nfl_team: p.nfl_team,
    bye_week: null,
    status: p.status || '',
    injury_note: p.injury_note,
    age: p.age,
    years_exp: p.years_exp,
    depth_rank: p.depth_rank,
    yahoo_key: null,
    sleeper_id: p.sleeper_id,
    headshot: null,
    updated_at: Date.now(),
  }));
  upsertMany('players', Object.keys(rows[0]), rows, ['player_id']);
  log.info(`seeded ${rows.length} real players from Sleeper`);
  return { players: rows.length };
}

/**
 * Parse a pasted rankings/ADP list into ordered player names.
 *
 * Deliberately lenient: accepts one name per line, tolerates a leading rank
 * number, trailing team/position noise in parentheses or after a dash or
 * comma, and blank lines. The exact numeric ADP matters far less than the
 * relative ORDER for a snake draft, so line position becomes the ADP value —
 * this is a good approximation of a real cheat sheet, not a claim of
 * Yahoo-precision data.
 *
 * Examples all parse to "Ja'Marr Chase":
 *   "1. Ja'Marr Chase, WR - CIN"
 *   "Ja'Marr Chase (WR, CIN)"
 *   "Ja'Marr Chase"
 */
export function parseRankingLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    // Strip a leading rank: "12.", "12)", "12 -", "12\t"
    line = line.replace(/^\d+[.)\-\s]+\s*/, '');
    // Cut at the first parenthetical, comma, tab, en/em dash, or a HYPHEN
    // SURROUNDED BY SPACES — whatever comes first is almost always
    // team/position/bye noise, not part of the name.
    //
    // A bare hyphen must NOT trigger the cut on its own: plenty of real player
    // names contain one with no surrounding space ("Amon-Ra St. Brown",
    // "JuJu Smith-Schuster", "De'Von Achane" uses an apostrophe but the same
    // risk applies) — cutting there truncated "Amon-Ra St. Brown" to "Amon" in
    // testing. A separator hyphen, by contrast, is always written with spaces
    // around it in every rankings format seen ("WR - CIN"), so requiring
    // whitespace on both sides is what tells the two apart.
    const cut = line.search(/[\(,\t–—]|\s-\s/);
    if (cut > 0) line = line.slice(0, cut);
    line = line.trim();
    if (line.length >= 2) out.push(line);
  }
  return out;
}

/**
 * Import ADP from a plain-text rankings list, matching each name against the
 * player universe by normalised name (and position, when a position hint is
 * present in the source line — disambiguates the occasional shared surname).
 *
 * @param {string} text  raw pasted rankings content
 * @returns {{matched:number, total:number, unmatched:string[]}}
 */
export function importAdpFromText(text, { season, source = 'manual' } = {}) {
  const names = parseRankingLines(text);
  if (!names.length) {
    return { matched: 0, total: 0, unmatched: [], note: 'No names parsed from that file.' };
  }

  const players = all('SELECT player_id, name, pos FROM players');
  const byName = new Map();
  for (const p of players) {
    const key = normaliseName(p.name);
    // A name can belong to more than one player (rare); keep the first and
    // let position-aware lookup below disambiguate when possible.
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  }

  const rows = [];
  const unmatched = [];
  names.forEach((name, i) => {
    const candidates = byName.get(normaliseName(name));
    if (!candidates || !candidates.length) { unmatched.push(name); return; }
    const player = candidates[0];
    rows.push({
      player_id: player.player_id,
      season,
      source,
      adp: i + 1,
      adp_sd: null,
    });
  });

  if (rows.length) {
    upsertMany('adp', ['player_id', 'season', 'source', 'adp', 'adp_sd'], rows, ['player_id', 'season', 'source']);
  }
  log.info(`ADP import: ${rows.length}/${names.length} matched`);
  return { matched: rows.length, total: names.length, unmatched };
}

/**
 * Create or update a real (non-demo) league from hand-entered settings — the
 * scoring rules and roster construction visible in Yahoo's league settings
 * page in a browser, no API access required.
 *
 * @param {Object} cfg
 * @param {string} cfg.name
 * @param {number} cfg.season
 * @param {number} cfg.numTeams
 * @param {Object} cfg.scoring        stat key -> points, e.g. {rec:0.5, pass_td:4, ...}
 * @param {Array}  cfg.rosterSlots    [{slot:'QB',count:1}, ...]
 * @param {string} cfg.myTeamName
 */
export function setupRealLeague(cfg) {
  const leagueKey = cfg.leagueKey ?? `real.l.${cfg.season}`;
  const scoring = { ...DEFAULT_SCORING, ...(cfg.scoring ?? {}) };

  const league = {
    league_key: leagueKey,
    league_id: leagueKey,
    name: cfg.name ?? 'My League',
    season: cfg.season,
    num_teams: cfg.numTeams,
    scoring_type: 'head',
    scoring: JSON.stringify(scoring),
    roster_slots: JSON.stringify(cfg.rosterSlots),
    waiver_type: cfg.waiverType ?? 'FAAB',
    faab_budget: cfg.faabBudget ?? 100,
    trade_deadline: null,
    playoff_start_week: cfg.playoffStartWeek ?? 15,
    end_week: cfg.endWeek ?? 17,
    num_playoff_teams: cfg.numPlayoffTeams ?? 6,
    current_week: 1,
    is_demo: 0,
    synced_at: Date.now(),
  };
  upsertMany('leagues', Object.keys(league), [league], ['league_key']);

  const teamKey = `${leagueKey}.t.1`;
  const team = {
    league_key: leagueKey, team_key: teamKey, team_id: 1,
    name: cfg.myTeamName ?? 'My Team', manager: 'You', is_mine: 1,
    faab_remaining: cfg.faabBudget ?? 100, waiver_priority: null,
    wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0,
    moves: 0, trade_count: 0, logo: null,
  };
  upsertMany('teams', Object.keys(team), [team], ['league_key', 'team_key']);

  meta.set('active_league', leagueKey);
  log.info(`real league configured: ${league.name} (${league.num_teams} teams)`);
  return { league_key: leagueKey };
}

/**
 * Import rankings from the FantasyPros API.
 *
 * Preferred over the pasted-text path: it carries POSITION alongside the name,
 * so players sharing a surname are matched unambiguously rather than guessed
 * at, and it refreshes on demand through preseason as rankings move on news.
 */
export async function importRankingsFromFantasyPros({ season, scoring = 'HALF', type = 'DRAFT' } = {}) {
  const ranked = await fantasypros.fetchRankings({ season, scoring, type });
  if (!ranked.length) {
    return { matched: 0, total: 0, unmatched: [], note: 'FantasyPros returned no players.' };
  }
  const { rows, unmatched } = matchToLocalPlayers(ranked, (r, i) => ({
    adp: r.adp ?? r.rank ?? i + 1,
  }));

  if (rows.length) {
    upsertMany('adp', ['player_id', 'season', 'source', 'adp', 'adp_sd'],
      rows.map((r) => ({ player_id: r.player_id, season, source: 'fantasypros', adp: r.adp, adp_sd: null })),
      ['player_id', 'season', 'source']);
  }
  log.info(`FantasyPros rankings: ${rows.length}/${ranked.length} matched`);
  return {
    matched: rows.length,
    total: ranked.length,
    estimatedRanks: ranked.filter((r) => r.estimatedRank).length,
    truncated: ranked.truncated ?? [],
    unmatched,
    attribution: fantasypros.ATTRIBUTION,
  };
}

/**
 * Import a FantasyPros draft-rankings CSV export.
 *
 * This is the primary rankings path, not a fallback. The API returns ten
 * players per request with no working paging parameter, while the export
 * carries the full five-hundred-player board, and it carries more per player
 * besides: the positional rank, the publisher's own tiers, and bye weeks.
 *
 * Three things are stored, and they answer different questions:
 *
 *   pos_rank  how good the experts think he is. This is what gets turned into
 *             an archetype stat line and priced through the league's scoring.
 *   adp       when the market will actually take him. This is what the draft
 *             board uses to decide whether a player will still be there next
 *             time round, which is the whole basis of VONA.
 *   tier      where the cliffs are, as the publisher drew them.
 *
 * Conflating the first two is the classic mistake. A kicker ranked 183rd who
 * goes at pick 124 is not a better kicker for going early; he is a worse pick,
 * and only keeping the two numbers separate shows that.
 */
export function importRankingsFromCsv(text, { season, source = 'fantasypros-csv' } = {}) {
  const { rows: parsed, skipped } = fpcsv.parseRankingsCsv(text);
  if (!parsed.length) {
    return { matched: 0, total: 0, unmatched: [], note: 'No player rows found in that file.' };
  }

  const { rows, unmatched } = matchToLocalPlayers(parsed, (r) => ({
    adp: r.adp,
    ecr: r.rank,
    tier: r.tier,
    pos_rank: r.posRank,
    bye: r.bye,
  }));

  if (rows.length) {
    upsertMany('adp', ['player_id', 'season', 'source', 'adp', 'adp_sd', 'ecr', 'tier', 'pos_rank'],
      rows.map((r) => ({
        player_id: r.player_id, season, source,
        adp: r.adp, adp_sd: null, ecr: r.ecr, tier: r.tier, pos_rank: r.pos_rank,
      })),
      ['player_id', 'season', 'source']);

    // Bye weeks are on the player, not the ranking: they matter every week of
    // the season, and a roster that stacks them loses games it should not.
    const withBye = rows.filter((r) => Number.isFinite(r.bye));
    for (const r of withBye) {
      run('UPDATE players SET bye_week = ? WHERE player_id = ?', [r.bye, r.player_id]);
    }
    log.info(`FantasyPros CSV: ${rows.length} ranked, ${withBye.length} bye weeks set`);
  }

  const byPos = {};
  for (const r of parsed) byPos[r.pos ?? '?'] = (byPos[r.pos ?? '?'] ?? 0) + 1;

  return {
    matched: rows.length,
    total: parsed.length,
    skipped,
    byPos,
    unmatched,
    attribution: fpcsv.ATTRIBUTION,
  };
}

/**
 * Import PROJECTED STAT LINES and store them as week-0 stats.
 *
 * This is the meaningful upgrade over rankings. A ranking only says a player is
 * the seventh-best back, which has to be turned into value through a positional
 * archetype. A projection says what he will actually DO, and that can be priced
 * through the league's own scoring table directly.
 *
 * In a league paying per completion and per first down the gap is large: two
 * quarterbacks with identical yards and touchdowns can differ by more than five
 * points a game on completion volume alone — a difference no published ranking
 * expresses, because it does not exist in the scoring those rankings assume.
 *
 * Stored at week 0 to mark them as PROJECTED rather than observed, so real
 * results never get mixed in with forecasts once games are played.
 */
export async function importProjectionsFromFantasyPros({ season, week = null } = {}) {
  const rows = await fantasypros.fetchProjections({ season, week });
  if (!rows.length) {
    return { matched: 0, total: 0, unmatched: [], note: 'FantasyPros returned no projections.' };
  }

  const { rows: matched, unmatched } = matchToLocalPlayers(rows, (r) => ({
    statLine: fantasypros.toStatLine(r, { gamesPlayed: r.games ?? 17 }),
  }));

  const statRows = matched
    .filter((m) => m.statLine && Object.keys(m.statLine).length)
    .map((m) => ({
      player_id: m.player_id,
      season,
      week: 0,
      opponent: null,
      stats: JSON.stringify(m.statLine),
    }));

  if (statRows.length) {
    upsertMany('player_stats', ['player_id', 'season', 'week', 'opponent', 'stats'],
      statRows, ['player_id', 'season', 'week']);
  }
  log.info(`FantasyPros projections: ${statRows.length}/${rows.length} matched`);
  return {
    matched: statRows.length, total: rows.length, unmatched,
    truncated: rows.truncated ?? [],
    attribution: fantasypros.ATTRIBUTION,
  };
}

/**
 * Match provider rows onto local players by normalised name, disambiguating
 * with position where the provider supplies one.
 */
function matchToLocalPlayers(providerRows, buildExtra) {
  const locals = all('SELECT player_id, name, pos FROM players');
  const byNamePos = new Map();
  const byName = new Map();
  for (const p of locals) {
    const n = normaliseName(p.name);
    byNamePos.set(`${n}|${p.pos}`, p);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(p);
  }

  const rows = [];
  const unmatched = [];
  const seen = new Set();
  providerRows.forEach((r, i) => {
    const n = normaliseName(r.name);
    let hit = r.pos ? byNamePos.get(`${n}|${r.pos}`) : null;
    if (!hit) {
      const candidates = byName.get(n) ?? [];
      // Only accept a name-only match when it is unambiguous.
      hit = candidates.length === 1 ? candidates[0] : null;
    }
    if (!hit) { unmatched.push(`${r.name}${r.pos ? ` (${r.pos})` : ''}`); return; }
    if (seen.has(hit.player_id)) return;
    seen.add(hit.player_id);
    rows.push({ player_id: hit.player_id, ...buildExtra(r, i) });
  });
  return { rows, unmatched };
}
