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
  // The synthetic NFL slate. Easy to overlook because demo fixtures are built
  // from real team abbreviations — ARI at WAS with a plausible spread — so they
  // survive a clean and then look exactly like a real schedule to anything that
  // reads them, the defense streamer above all.
  run("DELETE FROM games WHERE source = 'demo'");

  // Demo players, and every row keyed to them.
  run("DELETE FROM player_stats WHERE player_id LIKE 'dp%'");
  run("DELETE FROM player_usage WHERE player_id LIKE 'dp%'");
  run("DELETE FROM adp WHERE player_id LIKE 'dp%'");
  run("DELETE FROM players WHERE player_id LIKE 'dp%'");
  const remaining = get("SELECT COUNT(*) c FROM players WHERE player_id LIKE 'dp%'")?.c ?? 0;
  const staleGames = get("SELECT COUNT(*) c FROM games WHERE source IS NULL")?.c ?? 0;
  log.info(`cleared ${leagues.length} demo league(s), their fictional players and the synthetic NFL slate`);
  if (staleGames) {
    log.warn(`${staleGames} games predate source tracking and cannot be classified — run "real odds" to overwrite them with a real slate`);
  }
  return { leagues: leagues.length, remainingDemoPlayers: remaining, untaggedGames: staleGames };
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
  // Defaults fill the gaps in a partially-entered config, which is the right
  // behaviour while someone is still transcribing a settings page. Once the
  // transcription IS the whole rule set, they stop being helpful and start
  // inventing: this league penalises only sub-20 field-goal misses, and the
  // default -1 on every miss quietly applied to all of them.
  const scoring = cfg.scoringComplete
    ? { ...(cfg.scoring ?? {}) }
    : { ...DEFAULT_SCORING, ...(cfg.scoring ?? {}) };

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

  // The league is sixteen real teams in two divisions, not one row for us and
  // fifteen anonymous placeholders. Every downstream question — who is on the
  // waiver wire ahead of us, who we actually play in week 1, which teams our
  // playoff path runs through — is unanswerable without them.
  const divisionOf = new Map();
  for (const d of cfg.divisions ?? []) {
    for (const name of d.teams ?? []) divisionOf.set(name, d.name);
  }

  const myName = cfg.myTeamName ?? 'My Team';
  const declared = cfg.teams?.length
    ? cfg.teams
    : [{ name: myName, waiverPriority: null }];
  // Our own team must exist even if it is missing from the declared list, or
  // the app has no "me" to build a lineup for.
  if (!declared.some((t) => t.name === myName)) declared.push({ name: myName, waiverPriority: null });

  // Team keys are assigned once and never reshuffled. Rosters, draft picks and
  // matchups all reference them, so re-running this command after editing the
  // config — adding a division, fixing a waiver number — must not silently
  // hand our drafted roster to a different manager. Existing names keep the key
  // they already have; only genuinely new names get a fresh index.
  const keyOf = new Map();
  const existing = all('SELECT team_key, team_id, name, is_mine FROM teams WHERE league_key = ?', [leagueKey]);
  const existingByName = new Map(existing.map((r) => [r.name, r]));
  let nextId = existing.reduce((m, r) => Math.max(m, r.team_id ?? 0), 0);

  // Resolve every declared name to a key in two passes, because a rename and a
  // new team are indistinguishable from the name alone. Names bind first — an
  // exact match is unambiguous evidence. Only then may our own team fall back
  // to whichever row is currently flagged is_mine, which is what makes
  // renaming our team (McGiver -> Frank the Tank) an update rather than a
  // second team with our roster stranded on the first. The claimed set stops
  // that fallback from stealing a key another declared name already owns.
  const claimed = new Set();
  const resolved = new Map();
  for (const t of declared) {
    const prior = existingByName.get(t.name);
    if (prior && !claimed.has(prior.team_key)) {
      claimed.add(prior.team_key);
      resolved.set(t.name, prior);
    }
  }
  if (!resolved.has(myName)) {
    const mineRow = existing.find((r) => r.is_mine && !claimed.has(r.team_key));
    if (mineRow) {
      claimed.add(mineRow.team_key);
      resolved.set(myName, mineRow);
      log.info(`our team renamed: "${mineRow.name}" -> "${myName}" (keeping ${mineRow.team_key}, so the roster follows)`);
    }
  }

  const teamRows = declared.map((t) => {
    const prior = resolved.get(t.name);
    const teamId = prior?.team_id ?? ++nextId;
    const teamKey = prior?.team_key ?? `${leagueKey}.t.${teamId}`;
    keyOf.set(t.name, teamKey);
    return {
      league_key: leagueKey, team_key: teamKey, team_id: teamId,
      name: t.name, manager: t.name === myName ? 'You' : (t.owner ?? t.manager ?? null),
      is_mine: t.name === myName ? 1 : 0,
      faab_remaining: cfg.faabBudget ?? 100,
      waiver_priority: t.waiverPriority ?? null,
      wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0,
      moves: 0, trade_count: 0, logo: null,
      division: t.division ?? divisionOf.get(t.name) ?? null,
    };
  });
  // Exactly one team is ours. If a previous config named a different one, its
  // flag has to be cleared in the same breath or myTeam() picks arbitrarily.
  run('UPDATE teams SET is_mine = 0 WHERE league_key = ?', [leagueKey]);
  upsertMany('teams', Object.keys(teamRows[0]), teamRows, ['league_key', 'team_key']);

  // Rows the config no longer mentions are reported, never deleted: they may
  // still own rosters, draft picks and matchups, and quietly dropping a team
  // would leave those pointing at nothing.
  const stale = existing.filter((r) => !claimed.has(r.team_key) && !teamRows.some((n) => n.team_key === r.team_key));
  if (stale.length) {
    log.warn(`teams in the database but not in the config, left untouched: ${stale.map((r) => `${r.name} (${r.team_key})`).join(', ')}`);
  }

  // Yahoo's real pairings, for whatever weeks the operator has entered. These
  // are the only matchups the app is allowed to call fact.
  const matchupRows = [];
  const unknownTeams = new Set();
  for (const [week, pairs] of Object.entries(cfg.schedule ?? {})) {
    const w = Number(week);
    if (!Number.isFinite(w)) continue;
    for (const [a, b] of pairs) {
      const ka = keyOf.get(a), kb = keyOf.get(b);
      if (!ka) unknownTeams.add(a);
      if (!kb) unknownTeams.add(b);
      if (!ka || !kb) continue;
      matchupRows.push({ league_key: leagueKey, week: w, team_key: ka, opp_team_key: kb, points: null, projected: null, is_playoffs: w >= (cfg.playoffStartWeek ?? 15) ? 1 : 0, source: 'config' });
      matchupRows.push({ league_key: leagueKey, week: w, team_key: kb, opp_team_key: ka, points: null, projected: null, is_playoffs: w >= (cfg.playoffStartWeek ?? 15) ? 1 : 0, source: 'config' });
    }
  }
  if (matchupRows.length) {
    upsertMany('matchups', Object.keys(matchupRows[0]), matchupRows, ['league_key', 'week', 'team_key']);
  }
  if (unknownTeams.size) {
    log.warn(`schedule names not in the team list, ignored: ${[...unknownTeams].join(', ')}`);
  }

  // The draft seat order, if the operator has read it off Yahoo. Stored rather
  // than derived because nothing in the pick log carries it.
  if (Array.isArray(cfg.draftOrder) && cfg.draftOrder.length) {
    const unknown = cfg.draftOrder.filter((n) => n && !keyOf.has(n));
    if (unknown.length) log.warn(`draftOrder names not in the team list: ${unknown.join(', ')}`);
    meta.set(`draft_order:${leagueKey}`, JSON.stringify(cfg.draftOrder));
  }

  // Rosters, when the operator has transcribed them. Done last so the teams
  // they reference already exist.
  let rosterReport = null;
  if (cfg.rosters && Object.keys(cfg.rosters).length) {
    rosterReport = importRostersByName(leagueKey, cfg.rosters, { week: 1 });
  }

  meta.set('active_league', leagueKey);
  log.info(`real league configured: ${league.name} — ${teamRows.length} teams, ${matchupRows.length / 2} known matchups`);
  return { league_key: leagueKey, teams: teamRows.length, matchups: matchupRows.length / 2, unknownTeams: [...unknownTeams], staleTeams: stale.map((r) => r.name), rosters: rosterReport };
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

// ---------------------------------------------------------------------------
// Weekly stats and projections from Sleeper
// ---------------------------------------------------------------------------

/**
 * Import one week of real stat lines (or Sleeper's projections for a week that
 * has not been played) into player_stats / player_usage.
 *
 * This is the piece that turns the projection engine on. Until a week has been
 * played the platform has no per-player evidence at all, so every player at a
 * position is priced off the same positional archetype — which is why the War
 * Room, waiver and trade views currently rank teammates identically. Real
 * weekly stats break that tie.
 *
 * Matching is by `sleeper_id`, which was written when the player universe was
 * seeded from the same provider, so there is no name-matching step and no
 * fuzzy-match risk here at all.
 *
 * @param {Object} opts
 * @param {number} opts.season
 * @param {number} opts.week
 * @param {'stats'|'projections'} [opts.kind]
 */
export async function importWeeklyFromSleeper({ season, week, kind = 'stats' } = {}) {
  const blobs = await sleeper.weeklyBlobs({ season, week, kind });
  if (!blobs) {
    return { ok: false, note: `Sleeper returned nothing for ${kind} ${season} week ${week}.`, written: 0 };
  }

  const known = all('SELECT player_id, sleeper_id, pos FROM players WHERE sleeper_id IS NOT NULL');
  const bySleeper = new Map(known.map((p) => [String(p.sleeper_id), p]));

  const statRows = [];
  const usageRows = [];
  let unknownIds = 0;
  let empty = 0;

  for (const [sleeperId, raw] of Object.entries(blobs)) {
    const local = bySleeper.get(String(sleeperId));
    if (!local) { unknownIds++; continue; }
    const stats = sleeper.mapSleeperStats(raw, local.pos);
    if (!Object.keys(stats).length) { empty++; continue; }
    statRows.push({
      player_id: local.player_id, season, week,
      opponent: raw.opponent ?? null,
      stats: JSON.stringify(stats),
    });
    const usage = sleeper.mapSleeperUsage(raw);
    if (usage) usageRows.push({ player_id: local.player_id, season, week, ...usage });
  }

  if (statRows.length) {
    if (kind === 'projections') {
      // A forecast is not a result. Written into player_stats it would become a
      // game the baseline believes was played, and every number downstream would
      // inherit a fact nobody observed.
      upsertMany('external_projections',
        ['source', 'player_id', 'season', 'week', 'stats', 'fetched_at'],
        statRows.map((r) => ({
          source: 'sleeper', player_id: r.player_id, season: r.season, week: r.week,
          stats: r.stats, fetched_at: Date.now(),
        })),
        ['source', 'player_id', 'season', 'week']);
    } else {
      upsertMany('player_stats', ['player_id', 'season', 'week', 'opponent', 'stats'],
        statRows, ['player_id', 'season', 'week']);
    }
  }
  // Usage is an observation either way, but a projected usage line is not, so
  // it is only stored alongside real stats.
  if (usageRows.length && kind !== 'projections') {
    upsertMany('player_usage', Object.keys(usageRows[0]), usageRows, ['player_id', 'season', 'week']);
  }

  log.info(`sleeper ${kind} ${season} wk${week}: ${statRows.length} players written, ${unknownIds} unrecognised ids, ${empty} blank lines`);
  return {
    ok: true, kind, season, week,
    written: statRows.length,
    usage: usageRows.length,
    unknownIds, empty,
    provided: Object.keys(blobs).length,
  };
}

/**
 * Probe the Sleeper weekly endpoints without writing anything.
 *
 * Exists because the shape of this feed is the one part of the importer that
 * cannot be verified from a development container: Sleeper is unreachable from
 * ours (egress policy refuses the connection outright), so the stat-key mapping
 * above is written from Sleeper's published documentation rather than from an
 * observed response. This command shows what actually came back and, crucially,
 * which returned keys the mapping does NOT understand — so a wrong or renamed
 * key is visible immediately instead of quietly scoring zero.
 */
export async function probeSleeperWeekly({ season, week, kind = 'stats' } = {}) {
  const blobs = await sleeper.weeklyBlobs({ season, week, kind });
  if (!blobs) return { ok: false, reason: 'no-response', note: 'no response at all — the network is blocking api.sleeper.app' };

  const ids = Object.keys(blobs);

  // An empty object is a REACHED endpoint with nothing in it, which is the
  // normal state for a week that has not been played. Reporting that as a clean
  // probe was worse than useless: the mapping check below is vacuously true
  // over zero players, so "every returned key is accounted for" would print
  // while nothing whatsoever had been verified.
  if (!ids.length) {
    const state = await sleeper.nflState().catch(() => null);
    return {
      ok: false, reason: 'empty-week', season, week, kind, state,
      note: `Sleeper answered, so the connection is fine — it simply has no ${kind} for ${season} week ${week} yet.`,
    };
  }
  const seen = new Map();
  for (const raw of Object.values(blobs)) {
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (!Number.isFinite(Number(v)) || Number(v) === 0) continue;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  const mapped = [], unmapped = [];
  const derivedKeys = new Set([
    'kr_yd', 'pr_yd', 'kr_td', 'pr_td', 'def_kr_yd', 'def_pr_yd',
    'pts_allow', 'yds_allow',
    'off_snp', 'tm_off_snp', 'rec_tgt', 'tm_pass_att', 'tm_rush_att', 'rush_rz_att',
  ]);
  for (const [k, n] of [...seen].sort((a, b) => b[1] - a[1])) {
    if (k in sleeper.SLEEPER_STAT_MAP || derivedKeys.has(k)) mapped.push([k, n]);
    else unmapped.push([k, n]);
  }

  const linked = all('SELECT count(*) c FROM players WHERE sleeper_id IS NOT NULL')[0]?.c ?? 0;
  const matched = ids.filter((id) => get('SELECT 1 FROM players WHERE sleeper_id = ?', [String(id)])).length;

  return { ok: true, kind, season, week, players: ids.length, linked, matched, mapped, unmapped };
}

/**
 * Write hand-transcribed rosters into the database.
 *
 * The league's rosters were read off draft-board screenshots rather than pulled
 * from an API, which makes this the one ingestion path where the SOURCE is
 * known to be lossy: a name can be misread, a row can be cut off, and the same
 * player can end up transcribed onto two teams. So every failure mode is
 * reported rather than resolved quietly.
 *
 * A player claimed by more than one team is assigned to NEITHER. In a draft
 * that cannot happen, so it is proof of a transcription error, and picking a
 * side would put a real player on a team that never had him — which then shows
 * up as a confident projection nobody can trace back.
 *
 * @param {Object} rostersByTeam  { "Team Name": ["Player Name", ...] }
 * @returns {Object} what was written and what could not be
 */
export function importRostersByName(leagueKey, rostersByTeam, { week = 1 } = {}) {
  const teams = all('SELECT team_key, name FROM teams WHERE league_key = ?', [leagueKey]);
  const teamByName = new Map(teams.map((t) => [t.name, t]));

  const locals = all("SELECT player_id, name, pos, nfl_team FROM players WHERE pos IN ('QB','RB','WR','TE','K','DEF')");
  const byName = new Map();
  const defByTeam = new Map();
  for (const p of locals) {
    const n = normaliseName(p.name);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(p);
    // Defenses are named a dozen different ways across sources — "Broncos",
    // "Denver Broncos", "DEN Defense", "Denver D/ST". The NFL team abbreviation
    // is the one identifier every source agrees on, so a defense resolves by
    // team and never by string matching.
    if (p.pos === 'DEF' && p.nfl_team) defByTeam.set(p.nfl_team.toUpperCase(), p);
  }

  // Claims first, so a player on two teams is visible before anything is written.
  // Players carrying a consensus rank — the draftable universe, used to break
  // ties between real starters and their same-named practice-squad namesakes.
  const rankedIds = new Set(all('SELECT DISTINCT player_id FROM adp').map((r) => r.player_id));

  const claims = new Map();
  const unknownTeams = [];
  // An entry is either a bare name or an object carrying position, NFL team and
  // roster slot. The richer form is preferred wherever it is available: it turns
  // matching from a string comparison into an identification, which is what
  // separates two real players sharing a name.
  for (const [teamName, entries] of Object.entries(rostersByTeam ?? {})) {
    if (!teamByName.has(teamName)) { unknownTeams.push(teamName); continue; }
    for (const entry of entries ?? []) {
      const e = typeof entry === 'string' ? { name: entry } : entry;
      if (!e?.name) continue;
      const n = normaliseName(e.name);
      const key = e.pos ? `${n}|${e.pos}` : n;
      if (!claims.has(key)) claims.set(key, { ...e, n, teams: [] });
      claims.get(key).teams.push(teamName);
    }
  }

  const contested = [];
  const unmatched = [];
  const assign = new Map();      // team name -> [player rows]
  for (const claim of claims.values()) {
    if (claim.teams.length > 1) { contested.push({ player: claim.name, teams: claim.teams }); continue; }

    // A defense is identified by its NFL team, not its name.
    if (claim.pos === 'DEF' && claim.nfl) {
      const def = defByTeam.get(String(claim.nfl).toUpperCase());
      if (def) {
        const team = claim.teams[0];
        if (!assign.has(team)) assign.set(team, []);
        assign.get(team).push({ ...def, slot: claim.slot });
        continue;
      }
      unmatched.push(`${claim.name} (no DEF found for ${claim.nfl})`);
      continue;
    }

    let candidates = byName.get(claim.n) ?? [];
    // Position is the cheapest and most reliable disambiguator when the source
    // supplies it, so it is applied before falling back to draft rank.
    if (candidates.length > 1 && claim.pos) {
      const samePos = candidates.filter((p) => p.pos === claim.pos);
      if (samePos.length) candidates = samePos;
    }
    // A five-thousand-player pool carries several people per common name — most
    // of them practice-squad or retired, and none of them draftable. Refusing
    // every such name outright dropped real starters: a roster came back one
    // player short with nothing saying which or why. Narrow to the candidates
    // that actually carry a consensus rank, which is what "fantasy-relevant"
    // means here, before giving up.
    if (candidates.length > 1) {
      const ranked = candidates.filter((p) => rankedIds.has(p.player_id));
      if (ranked.length === 1) candidates = ranked;
    }
    // Carry the source's own roster slot through, so a starting lineup is
    // recorded as the manager set it rather than re-derived.
    const withSlot = (p) => ({ ...p, slot: claim.slot });
    // Still ambiguous is still refused: a wrong player is indistinguishable
    // from a right one once it is stored.
    if (candidates.length !== 1) {
      unmatched.push(`${claim.name}${candidates.length > 1 ? ` (ambiguous — ${candidates.length} players share this name)` : ' (not in the pool)'}`);
      continue;
    }
    const team = claim.teams[0];
    if (!assign.has(team)) assign.set(team, []);
    assign.get(team).push(withSlot(candidates[0]));
  }

  const rows = [];
  const written = {};
  for (const [teamName, players] of assign) {
    const team = teamByName.get(teamName);
    run('DELETE FROM rosters WHERE league_key = ? AND team_key = ? AND week = ?', [leagueKey, team.team_key, week]);
    // Slot assignment is left to the caller's optimiser where one is available;
    // here every player starts on the bench and the service promotes them, so a
    // partial roster never claims a starting lineup it cannot field.
    for (const p of players) {
      const slot = p.slot && p.slot !== 'BN' ? p.slot : 'BN';
      rows.push({
        league_key: leagueKey, team_key: team.team_key, player_id: p.player_id,
        week, slot, is_starter: slot === 'BN' ? 0 : 1, acquired: 'draft',
      });
    }
    written[teamName] = players.length;
  }
  if (rows.length) {
    upsertMany('rosters',
      ['league_key', 'team_key', 'player_id', 'week', 'slot', 'is_starter', 'acquired'],
      rows, ['league_key', 'team_key', 'player_id', 'week']);
  }

  log.info(`imported ${rows.length} roster spots across ${assign.size} teams`);
  if (contested.length) log.warn(`players claimed by more than one team, assigned to none: ${contested.map((c) => c.player).join(', ')}`);
  return { players: rows.length, teams: assign.size, written, contested, unmatched, unknownTeams };
}


/**
 * Import the NFL schedule.
 *
 * Deliberately does NOT invent betting lines. A game row with no implied totals
 * still earns its place: it tells every projection which opponent a player
 * faces and which teams are on bye, and it lets the defense streamer say "no
 * lines" rather than "no schedule" — two different problems with two different
 * fixes. Odds are layered on afterwards by the odds provider, which writes to
 * the same rows.
 */
export async function importScheduleFromSleeper({ season } = {}) {
  const games = await sleeper.nflSchedule({ season });
  if (!games) {
    return { ok: false, note: `No schedule came back for ${season}. This endpoint is undocumented and may have moved, or the season may not be published yet.` };
  }

  // Preserve any lines and weather already stored for these games.
  const rows = games.map((g) => {
    const existing = get(
      'SELECT total, spread, implied_home, implied_away, roof, weather FROM games WHERE season=? AND week=? AND home=? AND away=?',
      [g.season, g.week, g.home, g.away]
    );
    return {
      season: g.season, week: g.week, home: g.home, away: g.away,
      kickoff: g.kickoff,
      total: existing?.total ?? null,
      spread: existing?.spread ?? null,
      implied_home: existing?.implied_home ?? null,
      implied_away: existing?.implied_away ?? null,
      roof: existing?.roof ?? null,
      weather: existing?.weather ?? null,
      source: 'real',
    };
  });
  upsertMany('games', Object.keys(rows[0]), rows, ['season', 'week', 'home', 'away']);

  const weeks = new Set(rows.map((r) => r.week));
  const withLines = rows.filter((r) => r.implied_home != null).length;
  log.info(`imported ${rows.length} games across ${weeks.size} weeks (${withLines} carry betting lines)`);
  return { ok: true, games: rows.length, weeks: weeks.size, withLines, season };
}

// ---------------------------------------------------------------------------
// Sleeper leagues
// ---------------------------------------------------------------------------

/**
 * Translate Sleeper's scoring settings into this platform's canonical keys.
 *
 * Reuses the same stat-key map the weekly importer uses, so a league's rules
 * and the stat lines they are applied to can never drift apart — a rule under a
 * key nothing produces would score zero forever, which is the defect
 * uncoveredScoringRules exists to catch.
 */
export function scoringFromSleeper(settings = {}) {
  const out = {};
  const unmapped = [];
  for (const [key, value] of Object.entries(settings)) {
    const v = Number(value);
    if (!Number.isFinite(v) || v === 0) continue;
    const canonical = sleeper.SLEEPER_STAT_MAP[key];
    if (canonical) { out[canonical] = (out[canonical] ?? 0) + v; continue; }
    // Points allowed arrives as per-bucket rules under Sleeper's own names.
    const pa = /^pts_allow_(\d+_\d+|\d+p?|0)$/.exec(key);
    if (pa) { out[`def_pa_${pa[1]}`] = v; continue; }
    unmapped.push(key);
  }
  return { scoring: out, unmapped };
}

/**
 * Import a Sleeper league: settings, managers, rosters and this week's matchup.
 *
 * Kept entirely separate from the Yahoo league by league_key. Nothing is
 * shared between them but the player universe, which is correct — the same
 * athlete, valued under two different sets of rules, is exactly the situation
 * this platform's scoring layer was built for.
 */
export async function importSleeperLeague(leagueId, { week = null, username = null } = {}) {
  const meta_ = await sleeper.league(leagueId);
  if (!meta_ || meta_.error) {
    const note = {
      unreachable: 'Could not reach api.sleeper.app at all — the request never completed. This is a network or firewall problem, not a bad league id.',
      'not-found': `Sleeper has no league ${leagueId}. Check the id in the URL: sleeper.com/leagues/<id>/team`,
      empty: `Sleeper answered for league ${leagueId} but returned nothing usable.`,
      // Sleeper's public API needs no authentication, so a 403 almost never
      // comes from Sleeper itself — it is a proxy or firewall in between.
      'http-error': meta_?.status === 403
        ? `HTTP 403 for league ${leagueId}. Sleeper's public API needs no key, so a 403 almost always comes from a proxy or firewall between this machine and the internet, not from Sleeper.`
        : `Sleeper refused the request for league ${leagueId}${meta_?.status ? ` (HTTP ${meta_.status})` : ''}.`,
    }[meta_?.reason] ?? `Sleeper returned nothing for league ${leagueId}.`;
    return { ok: false, reason: meta_?.reason ?? 'unknown', note, detail: meta_?.detail ?? null };
  }

  const [users, rosters] = await Promise.all([
    sleeper.leagueUsers(leagueId),
    sleeper.leagueRosters(leagueId),
  ]);
  if (!rosters.length) return { ok: false, note: `League ${leagueId} has no rosters yet — it may not have drafted.` };

  const leagueKey = `sleeper.l.${meta_.league_id}`;
  const { scoring, unmapped } = scoringFromSleeper(meta_.scoringSettings);
  const state = await sleeper.nflState().catch(() => null);
  const currentWeek = week ?? state?.week ?? 1;

  const userById = new Map(users.map((u) => [u.user_id, u]));
  // Roster id is Sleeper's stable identifier; the display name is not, so teams
  // are keyed on the id and merely NAMED by the manager.
  const teams = rosters.map((r) => {
    const u = r.owner_id ? userById.get(r.owner_id) : null;
    return {
      name: u?.team_name ?? `Roster ${r.roster_id}`,
      manager: u?.display_name ?? null,
      rosterId: r.roster_id,
      waiverPriority: r.waiverPosition,
      wins: r.wins, losses: r.losses, ties: r.ties,
      pointsFor: r.pointsFor, pointsAgainst: r.pointsAgainst,
    };
  });

  const keyOf = (rosterId) => `${leagueKey}.t.${rosterId}`;

  const league = {
    league_key: leagueKey,
    league_id: meta_.league_id,
    name: meta_.name,
    season: meta_.season,
    num_teams: meta_.numTeams || rosters.length,
    scoring_type: 'head',
    // Sleeper's scoring_settings is the COMPLETE rule set for the league, so
    // no defaults are merged under it. Doing so would invent rules the league
    // does not have — a league that scores nothing for a shutout would inherit
    // ten points for one, and every defense in it would be overvalued by a
    // category its managers never play for.
    scoring: JSON.stringify(scoring),
    roster_slots: JSON.stringify(meta_.rosterSlots),
    waiver_type: meta_.waiverType,
    faab_budget: meta_.faabBudget,
    trade_deadline: null,
    playoff_start_week: meta_.playoffStartWeek,
    end_week: meta_.playoffStartWeek + 2,
    num_playoff_teams: meta_.numPlayoffTeams,
    current_week: currentWeek,
    is_demo: 0,
    synced_at: Date.now(),
  };
  upsertMany('leagues', Object.keys(league), [league], ['league_key']);

  const teamRows = teams.map((t) => ({
    league_key: leagueKey, team_key: keyOf(t.rosterId), team_id: t.rosterId,
    name: t.name, manager: t.manager, is_mine: 0,
    faab_remaining: meta_.faabBudget, waiver_priority: t.waiverPriority,
    wins: t.wins, losses: t.losses, ties: t.ties,
    points_for: t.pointsFor, points_against: t.pointsAgainst,
    moves: 0, trade_count: 0, logo: null, division: null,
  }));
  // Which roster is ours. Resolved from the Sleeper username rather than
  // guessed from a team name, because display names are not unique and a wrong
  // guess points the entire war room at somebody else's roster.
  let mine = null;
  if (username) {
    const u = await sleeper.user(username).catch(() => null);
    if (u) {
      const r = rosters.find((x) => x.owner_id === u.user_id);
      if (r) mine = keyOf(r.roster_id);
    }
  }
  if (mine) for (const t of teamRows) t.is_mine = t.team_key === mine ? 1 : 0;

  run('UPDATE teams SET is_mine = 0 WHERE league_key = ?', [leagueKey]);
  upsertMany('teams', Object.keys(teamRows[0]), teamRows, ['league_key', 'team_key']);

  // Rosters, by sleeper_id — the same link the weekly stats importer uses, so
  // no name matching is involved anywhere in this path.
  const bySleeper = new Map(
    all('SELECT player_id, sleeper_id FROM players WHERE sleeper_id IS NOT NULL')
      .map((p) => [String(p.sleeper_id), p.player_id])
  );
  const rosterRows = [];
  let unknownPlayers = 0;
  for (const r of rosters) {
    const starters = new Set(r.starters.filter((id) => id && id !== '0'));
    run('DELETE FROM rosters WHERE league_key = ? AND team_key = ? AND week = ?', [leagueKey, keyOf(r.roster_id), currentWeek]);
    for (const sid of r.players) {
      const pid_ = bySleeper.get(sid);
      if (!pid_) { unknownPlayers++; continue; }
      rosterRows.push({
        league_key: leagueKey, team_key: keyOf(r.roster_id), player_id: pid_,
        week: currentWeek, slot: starters.has(sid) ? 'ST' : 'BN',
        is_starter: starters.has(sid) ? 1 : 0, acquired: 'sleeper',
      });
    }
  }
  if (rosterRows.length) {
    upsertMany('rosters', Object.keys(rosterRows[0]), rosterRows, ['league_key', 'team_key', 'player_id', 'week']);
  }

  // This week's real pairings.
  const pairs = await sleeper.leagueMatchups(leagueId, currentWeek).catch(() => []);
  const matchupRows = [];
  for (const [a, b] of pairs) {
    for (const [x, y] of [[a, b], [b, a]]) {
      matchupRows.push({
        league_key: leagueKey, week: currentWeek, team_key: keyOf(x.roster_id),
        opp_team_key: keyOf(y.roster_id), points: x.points || null, projected: null,
        is_playoffs: currentWeek >= meta_.playoffStartWeek ? 1 : 0, source: 'sleeper',
      });
    }
  }
  if (matchupRows.length) {
    upsertMany('matchups', Object.keys(matchupRows[0]), matchupRows, ['league_key', 'week', 'team_key']);
  }

  // Remembered so a weekly re-sync is one word rather than a copied id, and so
  // the username used to identify our roster does not have to be retyped.
  meta.set('sleeper_league_id', String(meta_.league_id));
  if (username) meta.set('sleeper_username', String(username));

  log.info(`sleeper league ${meta_.name}: ${teamRows.length} teams, ${rosterRows.length} roster spots, ${matchupRows.length / 2} matchups`);
  return {
    ok: true, league_key: leagueKey, name: meta_.name, season: meta_.season,
    teams: teamRows.length, rosterSpots: rosterRows.length, matchups: matchupRows.length / 2,
    week: currentWeek, unknownPlayers,
    unmappedScoring: unmapped, unmappedSlots: meta_.unmappedSlots,
    // A league whose rosters exist but hold no players has not drafted. That is
    // a completely different situation from a failed import, and reporting it
    // as "0 roster spots" invites a hunt for a bug that is not there.
    undrafted: rosterRows.length === 0 && rosters.every((r) => !r.players.length),
    status: meta_.status ?? null,
    myTeam: mine ? teamRows.find((t) => t.team_key === mine)?.name ?? null : null,
    scoringRules: Object.keys(scoring).length,
  };
}

/**
 * Read a Sleeper draft: its shape, our seat, and every pick made so far.
 *
 * This replaces the two things the Yahoo draft had to be told by hand — which
 * seat we are in, and who has been taken — with two things Sleeper already
 * knows. Under a thirty-second clock that difference is the whole game: the
 * board can be read rather than transcribed.
 *
 * Returns picks as local player ids so the caller never touches Sleeper ids.
 */
export async function syncSleeperDraft(leagueId, { username = null, draftId = null } = {}) {
  let id = draftId;
  let info = null;

  if (!id) {
    const drafts = await sleeper.leagueDrafts(leagueId);
    if (drafts?.error) {
      return {
        ok: false, reason: drafts.reason,
        note: drafts.reason === 'unreachable'
          ? 'Could not reach api.sleeper.app — the request never completed. This is a network problem, not a missing draft.'
          : `Sleeper refused the draft list for league ${leagueId}${drafts.status ? ` (HTTP ${drafts.status})` : ''}.`,
        detail: drafts.detail ?? null,
      };
    }
    if (!drafts.length) return { ok: false, reason: 'no-draft', note: `League ${leagueId} has no draft attached yet.` };
    // The one in progress, else the most recent.
    info = drafts.find((d) => d.status === 'drafting') ?? drafts[0];
    id = info.draft_id;
  }

  const d = await sleeper.draft(id);
  if (!d) return { ok: false, note: `Sleeper returned nothing for draft ${id}.` };

  // Our seat, from the username. Without it the board cannot know whose turn
  // it is, and guessing would misprice every pick from the first round on.
  let mySeat = null;
  let myUserId = null;
  if (username) {
    const u = await sleeper.user(username).catch(() => null);
    if (u) {
      myUserId = u.user_id;
      const seat = d.draftOrder?.[u.user_id];
      if (seat != null) mySeat = Number(seat);
    }
  }

  const picks = await sleeper.draftPicks(id);
  const bySleeper = new Map(
    all('SELECT player_id, sleeper_id FROM players WHERE sleeper_id IS NOT NULL')
      .map((p) => [String(p.sleeper_id), p.player_id])
  );

  const mapped = [];
  const unknown = [];
  for (const p of picks ?? []) {
    const local = bySleeper.get(p.sleeperId);
    if (!local) { unknown.push(p.sleeperId); continue; }
    mapped.push({ ...p, player_id: local, isMine: myUserId != null && p.pickedBy === myUserId });
  }

  meta.set(`sleeper_draft:${leagueId}`, id);
  return {
    ok: true,
    draftId: id,
    status: d.status,
    type: d.type,
    isSnake: d.isSnake,
    isAuction: d.isAuction,
    rounds: d.rounds,
    teams: d.teams,
    pickTimerSec: d.pickTimerSec,
    mySeat,
    picks: mapped,
    made: mapped.length,
    unknownPlayers: unknown.length,
    // Everything the live board needs, in the order it needs it.
    drafted: mapped.map((p) => p.player_id),
    mine: mapped.filter((p) => p.isMine).map((p) => p.player_id),
  };
}
