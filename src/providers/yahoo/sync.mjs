/**
 * Yahoo -> local database synchronisation.
 *
 * Pulls a league's full state into the local schema so every engine runs
 * against the operator's real league: real scoring rules, real rosters, real
 * transaction history, real FAAB balances.
 *
 * Each stage is independently fault-tolerant. If the transaction endpoint fails
 * we still keep the rosters we already fetched, and the sync report says exactly
 * what succeeded and what did not — a partial sync is reported as partial, never
 * dressed up as a success.
 */
import * as Y from './client.mjs';
import { num, str, normalisePosition, normaliseStatus } from './parse.mjs';
import { upsertMany, run, meta, recordJob, get } from '../../db/index.mjs';
import { scoringFromYahoo, YAHOO_STAT_IDS as YAHOO_STAT_KEY } from '../../engine/scoring.mjs';
import { logger } from '../../util/log.mjs';
import config from '../../config.mjs';

const log = logger('yahoo-sync');

/** Stable local player id derived from Yahoo's, so re-syncs are idempotent. */
const pid = (yahooPlayerId) => `y${yahooPlayerId}`;

/**
 * Full league sync.
 * @param {string} leagueKey
 * @param {Object} opts
 * @param {boolean} opts.includePlayers  pull the league player universe (slow)
 * @param {boolean} opts.includeHistory  pull weekly stats for prior weeks
 */
export async function syncLeague(leagueKey, { includePlayers = true, includeHistory = true, onProgress = () => {} } = {}) {
  const started = Date.now();
  const report = { leagueKey, stages: {}, errors: [], startedAt: started };

  const stage = async (name, fn) => {
    onProgress({ stage: name, status: 'running' });
    try {
      const result = await fn();
      report.stages[name] = { ok: true, ...result };
      onProgress({ stage: name, status: 'ok', ...result });
      return result;
    } catch (err) {
      log.warn(`${name} failed: ${err.message}`);
      report.stages[name] = { ok: false, error: err.message };
      report.errors.push(`${name}: ${err.message}`);
      onProgress({ stage: name, status: 'error', error: err.message });
      return null;
    }
  };

  const settings = await stage('settings', () => syncSettings(leagueKey));
  const week = settings?.currentWeek ?? 1;
  const season = settings?.season ?? config.season;

  await stage('teams', () => syncTeams(leagueKey));
  await stage('rosters', () => syncRosters(leagueKey, week));
  await stage('matchups', () => syncMatchups(leagueKey, week));
  await stage('transactions', () => syncTransactions(leagueKey, season));
  if (includePlayers) await stage('players', () => syncPlayerUniverse(leagueKey, week));
  await stage('draft', () => syncDraft(leagueKey));
  if (includeHistory && week > 1) {
    await stage('history', () => syncHistory(leagueKey, season, week));
  }

  report.finishedAt = Date.now();
  report.ms = report.finishedAt - started;
  report.ok = report.errors.length === 0;
  report.partial = !report.ok && Object.values(report.stages).some((s) => s.ok);

  recordJob('yahoo-sync', started, report.ok, JSON.stringify({ leagueKey, errors: report.errors }));
  run('UPDATE leagues SET synced_at = ? WHERE league_key = ?', [Date.now(), leagueKey]);
  return report;
}

// ---------------------------------------------------------------------------

export async function syncSettings(leagueKey) {
  const { league, settings, rosterPositions, statModifiers } = await Y.leagueSettings(leagueKey);

  const scoring = scoringFromYahoo(statModifiers);
  const rosterSlots = rosterPositions
    .filter((rp) => rp.position)
    .map((rp) => ({ slot: normalisePosition(rp.position) === 'DEF' && rp.position !== 'DEF' ? rp.position : rp.position, count: num(rp.count, 1) }));

  const row = {
    league_key: leagueKey,
    league_id: str(league.league_id),
    name: str(league.name, 'Yahoo League'),
    season: num(league.season, config.season),
    num_teams: num(league.num_teams, 12),
    scoring_type: str(league.scoring_type, 'head'),
    scoring: JSON.stringify(scoring),
    roster_slots: JSON.stringify(rosterSlots),
    waiver_type: num(settings.uses_faab, 0) ? 'FAAB' : str(settings.waiver_type, 'priority'),
    faab_budget: num(settings.faab_budget, num(settings.uses_faab, 0) ? 100 : null),
    trade_deadline: str(settings.trade_end_date),
    playoff_start_week: num(settings.playoff_start_week, 15),
    end_week: num(league.end_week, 17),
    num_playoff_teams: num(settings.num_playoff_teams, 6),
    current_week: num(league.current_week, 1),
    is_demo: 0,
    synced_at: Date.now(),
  };
  upsertMany('leagues', Object.keys(row), [row], ['league_key']);
  meta.set('active_league', leagueKey);
  log.info(`settings: ${row.name} (${row.num_teams} teams, week ${row.current_week})`);
  return { currentWeek: row.current_week, season: row.season, slots: rosterSlots.length, scoringKeys: Object.keys(scoring).length };
}

export async function syncTeams(leagueKey) {
  const [teams, standings] = await Promise.all([
    Y.leagueTeams(leagueKey),
    Y.leagueStandings(leagueKey).catch(() => []),
  ]);
  const standingsByKey = new Map(standings.map((t) => [t.team_key, t]));

  const rows = teams.map((t) => {
    const s = standingsByKey.get(t.team_key) ?? t;
    const st = s.team_standings ?? {};
    const totals = st.outcome_totals ?? {};
    const manager = firstManager(t);
    return {
      league_key: leagueKey,
      team_key: t.team_key,
      team_id: num(t.team_id),
      name: str(t.name, 'Team'),
      manager: manager?.nickname ?? null,
      is_mine: isMine(t, manager) ? 1 : 0,
      faab_remaining: num(t.faab_balance),
      waiver_priority: num(t.waiver_priority),
      wins: num(totals.wins, 0),
      losses: num(totals.losses, 0),
      ties: num(totals.ties, 0),
      points_for: num(st.points_for, 0),
      points_against: num(st.points_against, 0),
      moves: num(t.number_of_moves, 0),
      trade_count: num(t.number_of_trades, 0),
      logo: teamLogo(t),
    };
  });
  upsertMany('teams', Object.keys(rows[0] ?? { league_key: 1 }), rows, ['league_key', 'team_key']);
  const mine = rows.filter((r) => r.is_mine).length;
  if (!mine) log.warn('Could not determine which team is yours — set it manually from the dashboard.');
  return { teams: rows.length, mine };
}

function firstManager(team) {
  const m = team.managers;
  if (!m) return null;
  if (Array.isArray(m)) {
    const first = m[0];
    return first?.manager ?? first ?? null;
  }
  return m.manager ?? m;
}

function isMine(team, manager) {
  if (num(team.is_owned_by_current_login, 0) === 1) return true;
  if (manager && num(manager.is_current_login, 0) === 1) return true;
  return false;
}

function teamLogo(team) {
  const logos = team.team_logos;
  if (!logos) return null;
  const arr = Array.isArray(logos) ? logos : [logos];
  const first = arr[0]?.team_logo ?? arr[0];
  return first?.url ?? null;
}

export async function syncRosters(leagueKey, week) {
  const teams = await Y.leagueTeams(leagueKey);
  const playerRows = [];
  const rosterRows = [];
  let fetched = 0;

  for (const t of teams) {
    let players;
    try {
      players = await Y.teamRoster(t.team_key, week);
    } catch (err) {
      log.warn(`roster for ${t.team_key} failed: ${err.message}`);
      continue;
    }
    fetched++;
    for (const p of players) {
      playerRows.push(toPlayerRow(p));
      const slot = selectedSlot(p);
      rosterRows.push({
        league_key: leagueKey,
        team_key: t.team_key,
        player_id: pid(p.player_id),
        week,
        slot,
        is_starter: slot && !['BN', 'IR', 'IR+', 'NA'].includes(slot) ? 1 : 0,
        acquired: null,
      });
    }
  }
  if (playerRows.length) upsertMany('players', Object.keys(playerRows[0]), dedupe(playerRows, 'player_id'), ['player_id']);
  if (rosterRows.length) {
    run('DELETE FROM rosters WHERE league_key = ? AND week = ?', [leagueKey, week]);
    upsertMany('rosters', Object.keys(rosterRows[0]), rosterRows, ['league_key', 'team_key', 'player_id', 'week']);
  }
  return { teams: fetched, players: rosterRows.length };
}

function selectedSlot(p) {
  const sp = p.selected_position;
  if (!sp) return 'BN';
  if (Array.isArray(sp)) {
    const found = sp.find((x) => x?.position);
    return found?.position ?? 'BN';
  }
  return sp.position ?? 'BN';
}

/**
 * Yahoo's position fields, handled precisely:
 *
 *   primary_position   a single code — the player's actual position
 *   display_position   a COMMA LIST for multi-eligible players ("WR,RB")
 *   eligible_positions the authoritative list of slots he may fill
 *
 * Storing display_position as `pos` is wrong: "WR,RB" matches no slot, so a
 * multi-eligible player becomes unstartable everywhere and silently disappears
 * from the lineup. `pos` takes the primary position (falling back to the first
 * token of the display list), and the full eligibility list is kept alongside.
 */
function positionsFor(p) {
  const eligible = [];
  const raw = p.eligible_positions;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const item of list) {
    const code = typeof item === 'string' ? item : (item?.position ?? item?.eligible_position?.position);
    if (code) eligible.push(normalisePosition(code));
  }

  const display = String(p.display_position ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const primary = normalisePosition(p.primary_position ?? display[0] ?? eligible[0] ?? '');

  // Fold the display list into eligibility so a multi-position player is still
  // handled correctly even when eligible_positions is missing.
  for (const d of display) {
    const code = normalisePosition(d);
    if (code && !eligible.includes(code)) eligible.push(code);
  }
  if (primary && !eligible.includes(primary)) eligible.unshift(primary);

  return { pos: primary, eligible };
}

function toPlayerRow(p) {
  const { pos, eligible } = positionsFor(p);
  return {
    player_id: pid(p.player_id),
    name: p.name?.full ?? str(p.name, 'Unknown'),
    pos,
    eligible_positions: eligible.length ? JSON.stringify(eligible) : null,
    nfl_team: str(p.editorial_team_abbr ?? p.editorial_team_key)?.toUpperCase() ?? null,
    bye_week: num(p.bye_weeks?.week ?? p.bye_weeks),
    status: normaliseStatus(p.status),
    injury_note: str(p.status_full ?? p.injury_note),
    age: null,
    years_exp: null,
    depth_rank: null,
    yahoo_key: str(p.player_key),
    sleeper_id: null,
    headshot: p.headshot?.url ?? p.image_url ?? null,
    updated_at: Date.now(),
  };
}

const dedupe = (rows, key) => [...new Map(rows.map((r) => [r[key], r])).values()];

export async function syncMatchups(leagueKey, currentWeek) {
  const rows = [];
  // Pull the current week plus a look-ahead so the season simulator has a real
  // schedule instead of a synthetic round robin.
  const league = get('SELECT playoff_start_week FROM leagues WHERE league_key = ?', [leagueKey]);
  const lastWeek = num(league?.playoff_start_week, 15) - 1;
  for (let w = 1; w <= Math.max(currentWeek, lastWeek); w++) {
    let sb;
    try { sb = await Y.scoreboard(leagueKey, w); } catch { continue; }
    const teams = sb.teams;
    // Scoreboard returns teams in matchup order: pairs of consecutive entries.
    for (let i = 0; i + 1 < teams.length; i += 2) {
      const a = teams[i];
      const b = teams[i + 1];
      if (!a?.team_key || !b?.team_key) continue;
      const isPlayoffs = sb.matchups.some((m) => num(m.week) === w && num(m.is_playoffs, 0) === 1) ? 1 : 0;
      rows.push(
        { league_key: leagueKey, week: w, team_key: a.team_key, opp_team_key: b.team_key, points: num(a.team_points?.total), projected: num(a.team_projected_points?.total), is_playoffs: isPlayoffs },
        { league_key: leagueKey, week: w, team_key: b.team_key, opp_team_key: a.team_key, points: num(b.team_points?.total), projected: num(b.team_projected_points?.total), is_playoffs: isPlayoffs }
      );
    }
  }
  if (rows.length) upsertMany('matchups', Object.keys(rows[0]), rows, ['league_key', 'week', 'team_key']);
  return { rows: rows.length };
}

export async function syncTransactions(leagueKey, season) {
  const txns = await Y.transactions(leagueKey);
  const rows = [];
  for (const t of txns) {
    const ts = num(t.timestamp, 0) * 1000;
    const week = weekFromTimestamp(ts, season);
    for (const p of t.__players ?? []) {
      const td = Array.isArray(p.transaction_data)
        ? Object.assign({}, ...p.transaction_data.filter((x) => x && typeof x === 'object'))
        : (p.transaction_data ?? {});
      const movement = str(td.type);
      if (!movement) continue;
      rows.push({
        league_key: leagueKey,
        txn_id: str(t.transaction_id ?? t.transaction_key),
        type: str(t.type, 'unknown'),
        ts,
        week,
        team_key: str(td.destination_team_key ?? td.source_team_key),
        player_id: pid(p.player_id),
        movement,
        source: str(td.source_type ?? td.source_team_key),
        destination: str(td.destination_type ?? td.destination_team_key),
        faab_bid: num(t.faab_bid),
        raw: null,
      });
    }
  }
  if (rows.length) upsertMany('transactions', Object.keys(rows[0]), rows, ['league_key', 'txn_id', 'player_id', 'movement']);
  return { transactions: txns.length, rows: rows.length };
}

/** NFL weeks start on Tuesday; season week 1 begins the first Thursday in September. */
function weekFromTimestamp(ts, season) {
  if (!ts) return null;
  const seasonStart = Date.UTC(season, 8, 1);
  const weeks = Math.floor((ts - seasonStart) / (7 * 864e5)) + 1;
  return Math.max(1, Math.min(18, weeks));
}

export async function syncPlayerUniverse(leagueKey, week) {
  const players = await Y.leaguePlayers(leagueKey, { count: 300 });
  if (!players.length) return { players: 0 };
  const playerRows = dedupe(players.map(toPlayerRow), 'player_id');
  const ownershipRows = players.map((p) => ({
    league_key: leagueKey,
    player_id: pid(p.player_id),
    pct_owned: num(p.percent_owned?.value ?? p.ownership?.ownership_percentage, 0),
    pct_started: num(p.percent_started?.value, 0),
    pct_change: num(p.percent_owned?.delta, 0),
    waiver_status: str(p.ownership?.ownership_type === 'team' ? 'R' : p.ownership?.ownership_type === 'waivers' ? 'W' : 'FA', 'FA'),
  }));
  upsertMany('players', Object.keys(playerRows[0]), playerRows, ['player_id']);
  upsertMany('ownership', Object.keys(ownershipRows[0]), dedupe(ownershipRows, 'player_id'), ['league_key', 'player_id']);
  return { players: playerRows.length };
}

export async function syncDraft(leagueKey) {
  const results = await Y.draftResults(leagueKey);
  const rows = results
    .filter((d) => d.player_key)
    .map((d) => ({
      league_key: leagueKey,
      pick: num(d.pick),
      round: num(d.round),
      team_key: str(d.team_key),
      player_id: pid(String(d.player_key).split('.').pop()),
      cost: num(d.cost),
    }))
    .filter((r) => r.pick != null);
  if (rows.length) upsertMany('draft_picks', Object.keys(rows[0]), rows, ['league_key', 'pick']);
  return { picks: rows.length };
}

/**
 * Weekly stat history for every rostered player. This is what the projection
 * engine's baseline is built from, so it is worth the request budget.
 */
export async function syncHistory(leagueKey, season, throughWeek) {
  const rostered = await Y.leaguePlayers(leagueKey, { status: 'T', count: 250 });
  const keys = rostered.map((p) => p.player_key).filter(Boolean);
  if (!keys.length) return { weeks: 0, rows: 0 };

  let rows = 0;
  for (let w = 1; w < throughWeek; w++) {
    let batch;
    try { batch = await Y.playerWeekStats(leagueKey, keys, w); } catch { continue; }
    const statRows = batch.map((p) => ({
      player_id: pid(p.player_id),
      season,
      week: w,
      opponent: null,
      stats: JSON.stringify(statsFromYahoo(p)),
    })).filter((r) => r.stats !== '{}');
    if (statRows.length) {
      upsertMany('player_stats', ['player_id', 'season', 'week', 'opponent', 'stats'], statRows, ['player_id', 'season', 'week']);
      rows += statRows.length;
    }
  }
  return { weeks: throughWeek - 1, rows };
}

/** Convert a Yahoo player_stats block into our canonical raw stat line. */
function statsFromYahoo(player) {
  const stats = player.player_stats?.stats;
  if (!stats) return {};
  const list = Array.isArray(stats) ? stats : [stats];
  const out = {};
  for (const s of list) {
    const stat = s?.stat ?? s;
    const id = num(stat?.stat_id);
    const val = num(stat?.value, 0);
    if (id == null || !val) continue;
    const key = YAHOO_STAT_KEY[id] ?? `stat_${id}`;
    out[key] = val;
  }
  return out;
}
