/**
 * Service layer: the bridge between stored league state and the engines.
 *
 * Everything the API and the CLI need is assembled here, once, from the
 * database, so the war room, the command line, and the test suite all reason
 * about exactly the same numbers.
 */
import { all, get, j, meta, upsertMany, run } from './db/index.mjs';
import config from './config.mjs';
import { DEFAULT_SCORING, scoreStatLine, describeScoring } from './engine/scoring.mjs';
import { startingSlots, expandSlots, POSITIONS } from './engine/roster.mjs';
import { projectPlayer, MODEL_VERSION, profile as projProfile } from './engine/projections.mjs';
import { optimalLineup } from './engine/optimizer.mjs';
import { simulateMatchup, simulateSeason, teamWeekDistribution, roundRobinSchedule } from './engine/simulate.mjs';
import { optimizeForWinProbability, posture } from './engine/leverage.mjs';
import { computeVor, replacementLevels, tierize, tierSummary } from './engine/vor.mjs';
import { expectedPointsAtRank } from './engine/statline.mjs';
import { rankWaiverTargets, breakoutScan, worstDroppable } from './engine/waivers.mjs';
import { scanLeague, evaluateOffer } from './engine/trades.mjs';
import { buildProfile, buildAllProfiles, assignArchetypes, predictClaims, poachTargets, positionalNeed } from './engine/opponent.mjs';
import { rebuildTeamDefense } from './engine/matchup.mjs';
import { round, clamp, mean, shrink } from './util/stats.mjs';
import { logger } from './util/log.mjs';

const log = logger('service');

// ---------------------------------------------------------------------------
// League state
// ---------------------------------------------------------------------------

export function activeLeagueKey() {
  const explicit = meta.get('active_league');
  if (explicit) {
    const l = get('SELECT league_key FROM leagues WHERE league_key = ?', [explicit]);
    if (l) return explicit;
  }
  const first = get('SELECT league_key FROM leagues ORDER BY is_demo ASC, season DESC LIMIT 1');
  return first?.league_key ?? null;
}

export function listLeagues() {
  return all('SELECT league_key, name, season, num_teams, is_demo, current_week FROM leagues ORDER BY is_demo ASC, season DESC');
}

export function getLeague(leagueKey = activeLeagueKey()) {
  if (!leagueKey) return null;
  const l = get('SELECT * FROM leagues WHERE league_key = ?', [leagueKey]);
  if (!l) return null;
  const scoring = j(l.scoring, DEFAULT_SCORING);
  const rosterSlots = j(l.roster_slots, []);
  return {
    ...l,
    scoring,
    rosterSlots,
    slots: startingSlots(rosterSlots),
    allSlots: expandSlots(rosterSlots),
    scoringLabel: describeScoring(scoring),
    isDemo: !!l.is_demo,
  };
}

export const getTeams = (leagueKey) =>
  all('SELECT * FROM teams WHERE league_key = ? ORDER BY wins DESC, points_for DESC', [leagueKey]);

export const myTeam = (leagueKey) =>
  get('SELECT * FROM teams WHERE league_key = ? AND is_mine = 1', [leagueKey]) ??
  get('SELECT * FROM teams WHERE league_key = ? ORDER BY team_id LIMIT 1', [leagueKey]);

export function rosterOf(leagueKey, teamKey, week) {
  return all(
    `SELECT p.*, r.slot, r.is_starter
     FROM rosters r JOIN players p ON p.player_id = r.player_id
     WHERE r.league_key = ? AND r.team_key = ? AND r.week = ?`,
    [leagueKey, teamKey, week]
  );
}

export function freeAgentPool(leagueKey, week, { limit = 260 } = {}) {
  return all(
    `SELECT p.*, o.pct_owned, o.pct_started, o.pct_change, o.waiver_status
     FROM players p
     LEFT JOIN ownership o ON o.player_id = p.player_id AND o.league_key = ?
     WHERE p.player_id NOT IN (
       SELECT player_id FROM rosters WHERE league_key = ? AND week = ?
     )
     ORDER BY COALESCE(o.pct_owned, 0) DESC
     LIMIT ?`,
    [leagueKey, leagueKey, week, limit]
  );
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

const projCache = new Map();
const cacheKey = (leagueKey, week, ids) => `${leagueKey}|${week}|${ids.length}|${MODEL_VERSION}`;

/**
 * Project a set of players for a week, with a season-long ("rest of season")
 * mean attached. Results are memoised per request-batch because the waiver and
 * trade engines re-project the same rosters many times.
 */
export function project(league, players, week, { persist = false } = {}) {
  const ctx = { season: league.season, week, scoring: league.scoring };
  const out = players.map((p) => {
    const pr = projectPlayer(p, ctx);
    pr.pctOwned = p.pct_owned ?? null;
    pr.pctChange = p.pct_change ?? null;
    pr.bye_week = p.bye_week;
    pr.profile = projProfile(pr);
    // Rest-of-season mean: this week's projection is matchup-specific; the
    // season number strips the matchup out and is what trades are priced on.
    pr.seasonMean = seasonMean(p, league, week);
    pr.recentDelta = recentDelta(p, league, week);
    pr.adp = adpOf(p.player_id, league.season);
    return pr;
  });
  if (persist) persistProjections(league.league_key, league.season, week, out);
  return out;
}

/** Bye-week-aware, matchup-neutral per-game expectation for the rest of the season. */
function seasonMean(player, league, week) {
  const rows = all(
    'SELECT stats FROM player_stats WHERE player_id = ? AND season = ? AND week > 0 AND week < ? ORDER BY week DESC LIMIT 8',
    [player.player_id, league.season, week]
  );
  if (!rows.length) {
    const prior = { QB: 15, RB: 9, WR: 9, TE: 6.5, K: 7.5, DEF: 6.5 }[player.pos] ?? 8;
    return prior;
  }
  const pts = rows.map((r) => scoreStatLine(j(r.stats, {}), league.scoring));
  // Weight the most recent half more heavily.
  const w = pts.map((_, i) => Math.exp(-i / 4));
  const num = pts.reduce((a, p, i) => a + p * w[i], 0);
  const den = w.reduce((a, b) => a + b, 0);
  const observed = num / den;
  const prior = { QB: 15, RB: 9, WR: 9, TE: 6.5, K: 7.5, DEF: 6.5 }[player.pos] ?? 8;
  const n = rows.length;
  const out = (n * observed + 3 * prior) / (n + 3);
  const status = (player.status || '').toUpperCase();
  if (['O', 'IR', 'PUP', 'SUSP'].includes(status)) return out * 0.25;
  return out;
}

/** Fractional change in recent output vs season baseline — drives rival valuation. */
function recentDelta(player, league, week) {
  const recent = all(
    'SELECT stats FROM player_stats WHERE player_id = ? AND season = ? AND week > 0 AND week < ? ORDER BY week DESC LIMIT 3',
    [player.player_id, league.season, week]
  ).map((r) => scoreStatLine(j(r.stats, {}), league.scoring));
  const season = all(
    'SELECT stats FROM player_stats WHERE player_id = ? AND season = ? AND week > 0 AND week < ?',
    [player.player_id, league.season, week]
  ).map((r) => scoreStatLine(j(r.stats, {}), league.scoring));
  if (!recent.length || !season.length) return 0;
  const s = mean(season);
  if (s <= 0.5) return 0;
  return clamp((mean(recent) - s) / s, -1, 2);
}

function adpOf(playerId, season) {
  const r = get('SELECT adp FROM adp WHERE player_id = ? AND season = ? ORDER BY source LIMIT 1', [playerId, season]);
  return r ? Number(r.adp) : null;
}

function persistProjections(leagueKey, season, week, projections) {
  upsertMany('projections',
    ['league_key', 'player_id', 'season', 'week', 'mean', 'sd', 'floor', 'ceiling', 'components', 'model', 'updated_at'],
    projections.map((p) => ({
      league_key: leagueKey, player_id: p.player_id, season, week,
      mean: p.mean, sd: p.sd, floor: p.floor, ceiling: p.ceiling,
      components: JSON.stringify(p.components), model: p.model, updated_at: Date.now(),
    })),
    ['league_key', 'player_id', 'season', 'week']
  );
}

/**
 * Season-long per-game value, for DRAFT and dynasty valuation.
 *
 * This is deliberately different from the weekly projection. A weekly
 * projection asks "what will he score against Denver this Sunday"; a draft
 * board asks "what is he worth over a season", which must ignore any single
 * matchup and must work before a single snap has been played.
 *
 * Three tiers of evidence, in order:
 *   1. observed production this season, recency-weighted and shrunk to the
 *      positional prior by sample size,
 *   2. ADP, when there is no production yet — the market's aggregate opinion is
 *      a far better pre-season prior than "every wide receiver is average",
 *   3. the positional prior, when we have neither.
 *
 * Using the weekly projection here is the bug that makes every pre-season draft
 * board show identical values for every player at a position.
 */
export function draftValues(league, players) {
  const season = league.season;
  const shrinkK = { QB: 3, RB: 3.5, WR: 4, TE: 4, K: 5, DEF: 5 };

  // Positional rank from ADP: sort each position's ADP-ranked players and use
  // their order within the position. This is what turns a global consensus
  // ranking into "he is the RB7", which is the input the archetype curves need.
  const posRankOf = new Map();
  const publishedRank = new Set();
  {
    // Prefer the positional rank as PUBLISHED. Deriving it by sorting ADP
    // conflates two different things: ADP is where the market takes a player,
    // and the market reaches. Kickers are the clearest case — they go dozens of
    // picks before their consensus rank, so an ADP-derived ordering would price
    // the most over-drafted kicker as though he were the best one.
    for (const r of all(
      'SELECT player_id, pos_rank FROM adp WHERE season = ? AND pos_rank IS NOT NULL',
      [season]
    )) { posRankOf.set(r.player_id, r.pos_rank); publishedRank.add(r.player_id); }

    // Anyone the publisher did not rank still needs an ordering, and ADP within
    // the position is the best available stand-in.
    const withAdp = players
      .filter((p) => !posRankOf.has(p.player_id))
      .map((p) => ({ id: p.player_id, pos: p.pos, adp: adpOf(p.player_id, season) }))
      .filter((x) => x.adp != null)
      .sort((a, b) => a.adp - b.adp);
    // Continue past the published ranks rather than restarting at 1, or an
    // unranked player would be priced as his position's best.
    const counters = {};
    for (const p of players) {
      const r = posRankOf.get(p.player_id);
      if (r != null) counters[p.pos] = Math.max(counters[p.pos] ?? 0, r);
    }
    for (const x of withAdp) {
      counters[x.pos] = (counters[x.pos] ?? 0) + 1;
      posRankOf.set(x.id, counters[x.pos]);
    }
  }

  // Replacement-ish rank per position, used only when a player has no ADP at
  // all — the market has no opinion, so assume roster-filler production rather
  // than inventing a rank.
  const UNRANKED = { QB: 30, RB: 55, WR: 80, TE: 32, K: 28, DEF: 28 };

  /**
   * Expected per-game points for a player, priced in THIS LEAGUE'S scoring.
   *
   * The previous implementation multiplied a fixed positional prior (QB 15,
   * RB 9, ...) by an ADP decay curve — which never looked at the league's
   * scoring rules at all. In a league paying per completion, per first down and
   * 6 per passing touchdown that understated quarterbacks by more than half,
   * because none of those categories exist in the generic scoring those priors
   * were calibrated against.
   */
  const adpCurve = (pos, adp, playerId) => {
    const rank = posRankOf.get(playerId)
      ?? (adp != null ? Math.max(1, Math.round(adp / 3)) : (UNRANKED[pos] ?? 60));
    return expectedPointsAtRank(pos, rank, league.scoring);
  };

  return players.map((p) => {
    // Week 0 holds a PROJECTED stat line; weeks 1+ hold observed games. The
    // distinction is load-bearing: a projection is already a full-season
    // expectation, so shrinking it toward a replacement-level prior the way a
    // one-game sample must be shrunk is simply wrong. Doing so priced a back
    // projected for 1350 yards and 11 touchdowns at 10 points a game instead of
    // roughly 24 — an error large enough to invert a draft board.
    const projRow = get(
      'SELECT stats FROM player_stats WHERE player_id = ? AND season = ? AND week = 0',
      [p.player_id, season]
    );
    const rows = all(
      'SELECT week, stats FROM player_stats WHERE player_id = ? AND season = ? AND week > 0 ORDER BY week DESC',
      [p.player_id, season]
    );
    const prior = expectedPointsAtRank(p.pos, UNRANKED[p.pos] ?? 60, league.scoring);
    const adp = adpOf(p.player_id, season);
    const projected = projRow ? scoreStatLine(j(projRow.stats, {}), league.scoring) : null;

    let value;
    let basis;
    if (rows.length) {
      const pts = rows.map((r) => scoreStatLine(j(r.stats, {}), league.scoring));
      const w = pts.map((_, i) => Math.exp(-i / 5));
      const observed = pts.reduce((a, x, i) => a + x * w[i], 0) / w.reduce((a, b) => a + b, 0);
      // A real projection is a far better prior than either ADP or a positional
      // archetype, so it takes precedence when one exists.
      const anchor = projected != null
        ? projected
        : (adp != null ? (observed + adpCurve(p.pos, adp, p.player_id)) / 2 : observed);
      // Shrink observed play toward that prior by sample size, not toward
      // replacement level.
      value = shrink(observed, anchor, rows.length, shrinkK[p.pos] ?? 4);
      basis = `${rows.length} game${rows.length === 1 ? '' : 's'}`
        + (projected != null ? ' + projection' : adp != null ? ' + ADP' : '');
    } else if (projected != null) {
      // No games played: the projection IS the season expectation. Use it as-is.
      value = projected;
      basis = 'projected stat line, priced in league scoring';
    } else if (adp != null) {
      value = adpCurve(p.pos, adp, p.player_id);
      const rank = posRankOf.get(p.player_id);
      // Say where the rank came from. A published rank and one inferred from
      // ADP deserve different amounts of trust, and the difference is visible
      // in the app rather than buried.
      basis = publishedRank.has(p.player_id)
        ? `${p.pos}${rank}, priced in league scoring (ADP ${adp.toFixed(1)})`
        : `ADP ${adp.toFixed(1)} -> ${p.pos}${rank ?? '?'} (inferred), priced in league scoring`;
    } else {
      value = expectedPointsAtRank(p.pos, UNRANKED[p.pos] ?? 60, league.scoring);
      basis = 'unranked (no ADP) — priced as roster filler in league scoring';
    }

    // Availability discounts a season-long valuation, but not to zero — an
    // injured player still has trade and stash value.
    const status = (p.status || '').toUpperCase();
    if (['O', 'IR', 'PUP', 'SUSP'].includes(status)) value *= 0.3;
    else if (status === 'D') value *= 0.75;
    else if (status === 'Q') value *= 0.94;

    return {
      player_id: p.player_id,
      name: p.name,
      pos: p.pos,
      eligible_positions: p.eligible_positions ?? null,
      nfl_team: p.nfl_team,
      bye_week: p.bye_week,
      status: p.status || '',
      adp,
      mean: Math.max(0, value),
      seasonMean: Math.max(0, value),
      sd: Math.max(0.5, value * 0.35),
      games: rows.length,
      basis,
    };
  });
}

// ---------------------------------------------------------------------------
// Matchup + season outlook
// ---------------------------------------------------------------------------

export function currentMatchup(leagueKey, teamKey, week) {
  return get(
    'SELECT * FROM matchups WHERE league_key = ? AND team_key = ? AND week = ?',
    [leagueKey, teamKey, week]
  );
}

export function scheduleFor(league) {
  const rows = all(
    'SELECT week, team_key, opp_team_key FROM matchups WHERE league_key = ? ORDER BY week',
    [league.league_key]
  );
  if (!rows.length) {
    const keys = getTeams(league.league_key).map((t) => t.team_key);
    return roundRobinSchedule(keys, (league.playoff_start_week ?? 15) - 1);
  }
  const byWeek = new Map();
  for (const r of rows) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, new Set());
    const seen = byWeek.get(r.week);
    const pairKey = [r.team_key, r.opp_team_key].sort().join('~');
    seen.add(pairKey);
  }
  return [...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([week, pairs]) => ({
    week,
    pairs: [...pairs].map((p) => p.split('~')),
  }));
}

/** Season simulation across every team in the league. */
export function seasonOutlook(league, { sims = config.sims.season, seed = config.seed } = {}) {
  const week = league.current_week;
  const teams = getTeams(league.league_key);
  const enriched = teams.map((t) => {
    const roster = rosterOf(league.league_key, t.team_key, week);
    const projections = project(league, roster, week);
    // Use matchup-neutral season means so future weeks are not distorted by
    // this week's specific opponent.
    const neutral = projections.map((p) => ({ ...p, mean: p.seasonMean, sd: Math.max(1, p.seasonMean * (p.cv || 0.5)) }));
    const dist = teamWeekDistribution(neutral, league.slots);
    return { ...t, dist, is_mine: !!t.is_mine };
  });
  const results = simulateSeason({
    teams: enriched,
    schedule: scheduleFor(league),
    playoffTeams: league.num_playoff_teams,
    playoffStartWeek: league.playoff_start_week,
    endWeek: league.end_week,
    sims,
    seed,
    currentWeek: week,
  });
  return { results, teams: enriched };
}

let outlookCache = { key: null, value: null, at: 0 };
export function cachedOutlook(league, ttlMs = 120000) {
  const key = `${league.league_key}|${league.current_week}`;
  if (outlookCache.key === key && Date.now() - outlookCache.at < ttlMs) return outlookCache.value;
  const v = seasonOutlook(league);
  outlookCache = { key, value: v, at: Date.now() };
  return v;
}
export const invalidateOutlook = () => { outlookCache = { key: null, value: null, at: 0 }; };

// ---------------------------------------------------------------------------
// The weekly war room: lineup + win probability
// ---------------------------------------------------------------------------

export function warRoom(league, { week = league.current_week, sims = config.sims.week } = {}) {
  const me = myTeam(league.league_key);
  const myRoster = rosterOf(league.league_key, me.team_key, week);
  const myProj = project(league, myRoster, week, { persist: true });

  const m = currentMatchup(league.league_key, me.team_key, week);
  const oppKey = m?.opp_team_key;
  const opp = oppKey ? get('SELECT * FROM teams WHERE league_key = ? AND team_key = ?', [league.league_key, oppKey]) : null;
  const oppRoster = oppKey ? rosterOf(league.league_key, oppKey, week) : [];
  const oppProj = project(league, oppRoster, week);
  const oppBest = optimalLineup(oppProj, league.slots, (p) => p.mean);
  const oppStarters = oppBest.lineup.map((l) => l.player).filter(Boolean);

  const decision = optimizeForWinProbability(myProj, league.slots, oppStarters, {
    sims: Math.min(sims, 15000), seed: config.seed,
  });

  const sim = simulateMatchup(decision.recommended.starters, oppStarters, { sims, seed: config.seed + 1 });

  // Trim the response before it crosses the wire. Every candidate lineup
  // carries a full copy of its starters' projections, including the component
  // breakdowns — six candidates is a quarter of a megabyte of duplicated
  // objects that the client never reads.
  const slimCandidates = decision.candidates.map((cand) => ({
    id: cand.id,
    label: cand.label,
    swap: cand.swap ? { in: brief(cand.swap.in), out: brief(cand.swap.out), slot: cand.swap.slot } : null,
    pointCost: round(cand.pointCost ?? 0, 2),
    winProb: cand.winProb,
    mean: round(cand.mean, 1),
    sd: round(cand.sd, 1),
    floor: round(cand.floor, 1),
    ceiling: round(cand.ceiling, 1),
    correlationLoad: round(cand.correlationLoad ?? 0, 3),
  }));

  return {
    week,
    me: { ...me, projection: round(decision.recommended.mean, 1) },
    opponent: opp ? { ...opp, projection: round(sim.oppMean, 1) } : null,
    winProbability: sim.winProb,
    posture: posture(decision.pointOptimal.winProb),
    decision: {
      recommended: {
        id: decision.recommended.id,
        label: decision.recommended.label,
        lineup: decision.recommended.lineup,
        winProb: decision.recommended.winProb,
        mean: round(decision.recommended.mean, 1),
      },
      pointOptimalId: decision.pointOptimal.id,
      candidates: slimCandidates,
      disagreement: decision.disagreement,
      winProbGain: decision.winProbGain,
      pointsGiven: decision.pointsGiven,
      explanation: decision.explanation,
      stacks: decision.stacks,
    },
    sim: {
      winProb: sim.winProb,
      myMean: round(sim.myMean, 1), mySd: round(sim.mySd, 1),
      myFloor: round(sim.myFloor, 1), myCeiling: round(sim.myCeiling, 1),
      oppMean: round(sim.oppMean, 1), oppSd: round(sim.oppSd, 1),
      oppFloor: round(sim.oppFloor, 1), oppCeiling: round(sim.oppCeiling, 1),
      margin: round(sim.margin, 1),
      marginP10: round(sim.marginP10, 1), marginP90: round(sim.marginP90, 1),
      histogram: histogram(sim.myTotals, sim.oppTotals),
      sims: sim.sims,
    },
    roster: myProj.sort((a, b) => b.mean - a.mean),
    oppRoster: oppProj.sort((a, b) => b.mean - a.mean),
    oppLineup: oppBest.lineup,
  };
}

/** Minimal player reference for wire payloads. */
const brief = (p) => (p ? { player_id: p.player_id, name: p.name, pos: p.pos } : null);

function histogram(mine, opp, bins = 28) {
  const allv = [...mine, ...opp];
  const lo = Math.min(...allv);
  const hi = Math.max(...allv);
  const w = (hi - lo) / bins || 1;
  const mk = (arr) => {
    const h = new Array(bins).fill(0);
    for (const v of arr) h[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)))] += 1;
    return h.map((c) => c / arr.length);
  };
  return { lo: round(lo, 1), hi: round(hi, 1), width: round(w, 2), mine: mk(mine), opp: mk(opp) };
}

// ---------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------

export function waiverBoard(league, { week = league.current_week, limit = 25 } = {}) {
  const me = myTeam(league.league_key);
  const myRoster = project(league, rosterOf(league.league_key, me.team_key, week), week);
  const fa = freeAgentPool(league.league_key, week);
  const faProj = project(league, fa, week);

  const profiles = buildAllProfiles(league.league_key, {
    season: league.season, currentWeek: week, scoring: league.scoring,
  });
  const outlook = cachedOutlook(league);
  const mine = outlook.results.find((r) => r.team_key === me.team_key);
  const weeksRemaining = Math.max(1, (league.playoff_start_week ?? 15) - week);

  const targets = rankWaiverTargets({
    freeAgents: faProj,
    myRoster,
    rosterSlots: league.rosterSlots,
    rivalProfiles: profiles,
    leagueKey: league.league_key,
    season: league.season,
    week,
    faabRemaining: me.faab_remaining ?? 100,
    weeksRemaining,
    playoffOdds: mine?.playoffOdds ?? 0.5,
    limit,
  });

  const breakouts = breakoutScan({
    players: fa,
    season: league.season,
    week,
    ownership: new Map(fa.map((f) => [f.player_id, { pct_owned: f.pct_owned, pct_change: f.pct_change }])),
    limit: 15,
  });

  return {
    week,
    faabRemaining: me.faab_remaining ?? 100,
    weeksRemaining,
    playoffOdds: mine?.playoffOdds ?? null,
    drop: worstDroppable(myRoster, league.rosterSlots),
    targets,
    breakouts,
  };
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export function tradeBoard(league, { week = league.current_week, limit = 15 } = {}) {
  const me = myTeam(league.league_key);
  const myRoster = project(league, rosterOf(league.league_key, me.team_key, week), week);
  const teams = getTeams(league.league_key).filter((t) => t.team_key !== me.team_key);
  const weeksRemaining = Math.max(1, (league.playoff_start_week ?? 15) - week);

  const profiles = buildAllProfiles(league.league_key, { season: league.season, currentWeek: week, scoring: league.scoring });
  const profileByTeam = new Map(profiles.map((p) => [p.team_key, p]));

  const rivals = teams.map((t) => ({
    team_key: t.team_key,
    name: t.name,
    manager: t.manager,
    is_mine: false,
    profile: profileByTeam.get(t.team_key),
    roster: project(league, rosterOf(league.league_key, t.team_key, week), week),
  }));

  const scan = scanLeague({
    myRoster, rivals, rosterSlots: league.rosterSlots, weeksRemaining, limit,
  });

  return {
    week,
    weeksRemaining,
    winWin: scan.winWin,
    arbitrage: scan.arbitrage,
    trades: scan.all,
    counts: scan.counts,
    rivals: rivals.map((r) => ({ team_key: r.team_key, name: r.name, manager: r.manager, archetype: r.profile?.archetype })),
  };
}

// ---------------------------------------------------------------------------
// Opponent intelligence
// ---------------------------------------------------------------------------

export function intel(league, { week = league.current_week } = {}) {
  const teams = getTeams(league.league_key);
  const fa = freeAgentPool(league.league_key, week, { limit: 150 });
  const faProj = project(league, fa, week);
  const { players: valued } = computeVor(faProj, league.rosterSlots, league.num_teams);
  const valueMap = new Map(valued.map((v) => [v.player_id, v]));

  const enrichedFa = faProj.map((f) => {
    const lastWeek = get(
      'SELECT stats FROM player_stats WHERE player_id = ? AND season = ? AND week = ?',
      [f.player_id, league.season, week - 1]
    );
    return {
      ...f,
      vor: valueMap.get(f.player_id)?.vor ?? 0,
      lastWeekPoints: lastWeek ? scoreStatLine(j(lastWeek.stats, {}), league.scoring) : 0,
      pctChange: f.pctChange ?? 0,
    };
  });

  // Archetypes are league-relative, so every profile must be built before any
  // of them can be labelled.
  const profiles = buildAllProfiles(league.league_key, { season: league.season, currentWeek: week, scoring: league.scoring });
  const profileByTeam = new Map(profiles.map((p) => [p.team_key, p]));

  const dossiers = teams.map((t) => {
    const prof = profileByTeam.get(t.team_key);
    if (!prof) return null;
    const claims = predictClaims(league.league_key, t.team_key, {
      profile: prof,
      freeAgents: enrichedFa,
      rosterSlots: league.rosterSlots,
      week,
      limit: 4,
    });
    const rosterProj = project(league, rosterOf(league.league_key, t.team_key, week), week);
    return {
      ...prof,
      claims,
      poach: t.is_mine ? [] : poachTargets(league.league_key, t.team_key, prof, rosterProj, { limit: 4 }),
      rosterSize: rosterProj.length,
      strength: round(rosterProj.reduce((a, p) => a + (p.seasonMean ?? 0), 0), 1),
    };
  }).filter(Boolean);

  // Persist for the research daemon and for historical comparison.
  upsertMany('opponent_profiles',
    ['league_key', 'team_key', 'profile', 'updated_at'],
    dossiers.map((d) => ({ league_key: league.league_key, team_key: d.team_key, profile: JSON.stringify(d), updated_at: Date.now() })),
    ['league_key', 'team_key']
  );

  // League-wide competition map: who is chasing the same free agents as me.
  const contention = new Map();
  for (const d of dossiers) {
    if (d.is_mine) continue;
    for (const c of d.claims.predictions) {
      if (!contention.has(c.player_id)) contention.set(c.player_id, { player_id: c.player_id, name: c.name, pos: c.pos, rivals: [] });
      contention.get(c.player_id).rivals.push({ team: d.name, manager: d.manager, probability: c.probability, bid: c.expectedBid?.amount ?? null });
    }
  }

  return {
    week,
    dossiers: dossiers.sort((a, b) => (b.is_mine ? 1 : 0) - (a.is_mine ? 1 : 0) || b.strength - a.strength),
    contention: [...contention.values()]
      .map((c) => ({ ...c, totalPressure: c.rivals.reduce((a, r) => a + r.probability, 0) }))
      .sort((a, b) => b.totalPressure - a.totalPressure)
      .slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// Player universe / research
// ---------------------------------------------------------------------------

export function playerBoard(league, { week = league.current_week, pos = null, q = null, limit = 120, availableOnly = false } = {}) {
  // Replacement level is a property of the LEAGUE, not of whatever slice of
  // players the user happens to be looking at. Computing it from a filtered
  // subset would mean that switching the position filter silently changed every
  // player's value over replacement — so the baseline is always derived from
  // the full player universe, and only the display is filtered.
  const universe = all('SELECT * FROM players');
  const universeProj = project(league, universe, week);
  const { levels, meta: levelMeta } = replacementLevels(universeProj, league.rosterSlots, league.num_teams);

  let sql = `SELECT p.*, o.pct_owned, o.pct_started, o.pct_change,
                    r.team_key AS owner_key, t.name AS owner_name
             FROM players p
             LEFT JOIN ownership o ON o.player_id = p.player_id AND o.league_key = ?
             LEFT JOIN rosters r ON r.player_id = p.player_id AND r.league_key = ? AND r.week = ?
             LEFT JOIN teams t ON t.team_key = r.team_key AND t.league_key = ?
             WHERE 1=1`;
  const params = [league.league_key, league.league_key, week, league.league_key];
  if (pos) { sql += ' AND p.pos = ?'; params.push(pos); }
  if (q) { sql += ' AND p.name LIKE ?'; params.push(`%${q}%`); }
  if (availableOnly) sql += ' AND r.team_key IS NULL';
  sql += ' ORDER BY COALESCE(o.pct_owned,0) DESC LIMIT ?';
  params.push(limit);

  const rows = all(sql, params);
  const byId = new Map(universeProj.map((p) => [p.player_id, p]));

  // Positional ranks come from the whole universe too, so "WR12" means the
  // twelfth-best receiver in the league, not the twelfth on this page.
  const posRanks = new Map();
  const counters = {};
  for (const p of [...universeProj].sort((a, b) => b.mean - a.mean)) {
    counters[p.pos] = (counters[p.pos] ?? 0) + 1;
    posRanks.set(p.player_id, counters[p.pos]);
  }

  // Tiers, likewise, are computed per position across the full universe.
  const tierOf = new Map();
  for (const position of POSITIONS) {
    const pool = universeProj.filter((p) => p.pos === position);
    if (!pool.length) continue;
    for (const t of tierize(pool)) tierOf.set(t.player_id, t.tier);
  }

  const players = rows.map((row) => {
    const proj = byId.get(row.player_id) ?? project(league, [row], week)[0];
    return {
      ...proj,
      vor: proj.mean - (levels[proj.pos] ?? 0),
      replacement: levels[proj.pos] ?? 0,
      posRank: posRanks.get(row.player_id) ?? null,
      tier: tierOf.get(row.player_id) ?? 1,
      owner: row.owner_name ?? null,
      ownerKey: row.owner_key ?? null,
      pctOwned: row.pct_owned ?? null,
      pctChange: row.pct_change ?? null,
    };
  }).sort((a, b) => b.vor - a.vor);

  return { week, replacementLevels: levels, replacementMeta: levelMeta, players };
}

export function playerDetail(league, playerId, { week = league.current_week } = {}) {
  const p = get('SELECT * FROM players WHERE player_id = ?', [playerId]);
  if (!p) return null;
  const [proj] = project(league, [p], week);
  const history = all(
    'SELECT week, opponent, stats FROM player_stats WHERE player_id = ? AND season = ? ORDER BY week',
    [playerId, league.season]
  ).map((r) => ({
    week: r.week,
    opponent: r.opponent,
    points: round(scoreStatLine(j(r.stats, {}), league.scoring), 1),
    stats: j(r.stats, {}),
  }));
  const usage = all(
    'SELECT * FROM player_usage WHERE player_id = ? AND season = ? ORDER BY week',
    [playerId, league.season]
  );
  const news = all('SELECT * FROM news WHERE player_id = ? ORDER BY ts DESC LIMIT 10', [playerId]);
  const owner = get(
    `SELECT t.name, t.team_key, t.manager FROM rosters r JOIN teams t ON t.team_key = r.team_key AND t.league_key = r.league_key
     WHERE r.league_key = ? AND r.player_id = ? AND r.week = ?`,
    [league.league_key, playerId, week]
  );
  return { player: p, projection: proj, history, usage, news, owner };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export function refreshDefensiveRatings(league) {
  const rows = rebuildTeamDefense(league.season, (stats) => scoreStatLine(stats, league.scoring));
  if (rows.length) {
    upsertMany('team_defense', ['nfl_team', 'season', 'pos', 'pts_allowed_over_avg', 'sample'], rows, ['nfl_team', 'season', 'pos']);
  }
  invalidateOutlook();
  return rows.length;
}

export function healthReport() {
  const leagueKey = activeLeagueKey();
  const league = leagueKey ? getLeague(leagueKey) : null;
  return {
    league: league ? { key: league.league_key, name: league.name, season: league.season, week: league.current_week, demo: league.isDemo, scoring: league.scoringLabel } : null,
    counts: {
      players: get('SELECT COUNT(*) c FROM players')?.c ?? 0,
      statLines: get('SELECT COUNT(*) c FROM player_stats')?.c ?? 0,
      transactions: get('SELECT COUNT(*) c FROM transactions')?.c ?? 0,
      games: get('SELECT COUNT(*) c FROM games')?.c ?? 0,
      news: get('SELECT COUNT(*) c FROM news')?.c ?? 0,
    },
    yahoo: {
      configured: config.yahoo.configured,
      connected: !!get("SELECT provider FROM oauth_tokens WHERE provider = 'yahoo'"),
    },
    providers: all('SELECT source, MAX(fetched_at) last, SUM(ok) ok, COUNT(*) n FROM provenance GROUP BY source'),
    jobs: all('SELECT job, MAX(started_at) last, ok FROM job_runs GROUP BY job ORDER BY last DESC LIMIT 10'),
    model: MODEL_VERSION,
  };
}
