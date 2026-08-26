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
