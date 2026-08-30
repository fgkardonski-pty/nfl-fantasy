/**
 * The projection engine.
 *
 * Design commitments:
 *  - Every projection is a DISTRIBUTION (mean, sd, floor, ceiling), never a
 *    single number. A start/sit call between a 12.0 and an 11.4 is decided by
 *    the shape of those distributions, not by the 0.6.
 *  - Every projection carries its own explanation. The `components` array lists
 *    each multiplier that moved the number and by how much, so the war room can
 *    always answer "why".
 *  - Small samples are shrunk toward positional priors. Rookies and
 *    role-changers get WIDER variance, not fabricated precision.
 *  - Nothing is invented. If a data source is missing, its multiplier is 1.0
 *    and the component says so.
 */
import { all, get, j } from '../db/index.mjs';
import { clamp, gammaCdf, gammaQuantileMS } from '../util/stats.mjs';
import { scoreStatLine } from './scoring.mjs';
import { usageProfile, opportunityScore, ewma, POSITION_PRIORS, shrinkToPrior } from './features.mjs';
import { defenseMultiplier, environmentMultiplier, weatherMultiplier, findGame, weekHasSchedule } from './matchup.mjs';
import { expectedPointsAtRank, expectedScore } from './statline.mjs';

export const MODEL_VERSION = 'oracle-proj-1.4';

/** Availability multipliers by injury designation. */
const STATUS_MULT = {
  '': 1, P: 1, Q: 0.90, D: 0.55, O: 0, IR: 0, 'IR-R': 0, PUP: 0, SUSP: 0, NA: 0, COV: 0.75,
};
/** Extra variance from an uncertain designation — a questionable player is a coin flip. */
const STATUS_VAR = {
  '': 1, P: 1, Q: 1.30, D: 1.55, O: 1, IR: 1, PUP: 1, SUSP: 1, COV: 1.4,
};

function statusFactor(status) {
  const s = (status || '').toUpperCase().trim();
  return {
    mult: STATUS_MULT[s] ?? 1,
    varMult: STATUS_VAR[s] ?? 1,
    label: s || 'healthy',
  };
}

/**
 * Recency-weighted per-game baseline in league scoring, shrunk toward the
 * positional prior by how many games we have actually observed.
 */
export function baselinePpg(playerId, pos, season, throughWeek, scoring) {
  const rows = all(
    `SELECT week, stats FROM player_stats WHERE player_id = ? AND season = ? AND week <= ? ORDER BY week ASC`,
    [playerId, season, throughWeek]
  );
  const pts = rows.map((r) => scoreStatLine(j(r.stats, {}), scoring));
  const games = pts.length;

  const priorPpg = POSITION_PRIORS[pos]?.ppg ?? 10;
  if (!games) {
    // Before a single game is played there are no stats, and a flat positional
    // prior makes every player at a position identical — every quarterback
    // 16.5, every defense 7.0. That is not a small inaccuracy: it is the whole
    // season-long side of the platform declining to distinguish Josh Allen from
    // a backup, so the war room, waivers and trades all rank teammates level
    // and the numbers still look computed.
    //
    // The draft board already solves this. Consensus rank -> positional rank ->
    // archetype stat line -> THIS league's scoring is the same chain, and it is
    // calibrated against real projections. Falling back to it costs nothing and
    // is right for the entire preseason, which is exactly when the flat prior
    // was doing the most damage.
    // An outside projection for this exact week beats any archetype: it knows
    // the player, the offense and the opponent, none of which a positional
    // curve can. Preferred whenever one has been imported.
    const ext = externalProjection(playerId, season, throughWeek + 1, scoring);
    if (ext != null) {
      return {
        ppg: ext.points, games: 0, recent: null, seasonAvg: null, external: ext.source,
        source: `${ext.source} projection for week ${throughWeek + 1}`,
      };
    }

    const rank = positionalRankOf(playerId, pos, season);
    if (rank != null) {
      return {
        ppg: expectedPointsAtRank(pos, rank, scoring),
        games: 0, recent: null, seasonAvg: null, rank,
        source: `no games played — ${pos}${rank} archetype priced on this league's scoring`,
      };
    }
    return { ppg: priorPpg, games: 0, recent: null, seasonAvg: null, source: 'positional prior (no games played, no consensus rank)' };
  }
  const recent = ewma(pts, 2.5);
  const seasonAvg = pts.reduce((a, b) => a + b, 0) / games;

  // Two-stage shrinkage: recent form toward season average (recency is real but
  // noisy), then that blend toward the positional prior by total sample size.
  const formWeight = clamp(games / (games + 2), 0, 0.75);
  const blended = formWeight * recent + (1 - formWeight) * seasonAvg;
  const ppg = shrinkToPrior(pos, blended, games);

  return {
    ppg,
    games,
    recent,
    seasonAvg,
    source: `${games} game${games === 1 ? '' : 's'}, recency-weighted then shrunk to ${pos} prior`,
  };
}

/**
 * Usage multiplier: adjust the historical baseline for a role that has changed.
 * A back whose snap share went 40% -> 70% is not the player his season average
 * describes. This is where the platform gets ahead of the market.
 */
export function usageMultiplier(pos, usage, baselineGames) {
  if (!usage || !usage.games) return { mult: 1, note: 'no usage data', opportunity: null };
  const opp = opportunityScore(pos, usage);
  const trendKey = pos === 'RB' ? 'rush_share_trend' : pos === 'QB' ? 'snap_pct_trend' : 'target_share_trend';
  const roleTrend = clamp(usage[trendKey] ?? 0, -0.6, 0.6);
  const snapTrend = clamp(usage.snap_pct_trend ?? 0, -0.6, 0.6);

  // Only the *change* in role should move the projection — the level is already
  // baked into the historical points. Damped, and damped harder on thin samples.
  const raw = 0.55 * roleTrend + 0.45 * snapTrend;
  const confidence = clamp(usage.games / (usage.games + 2), 0, 0.8);
  const mult = clamp(1 + raw * 0.45 * confidence, 0.78, 1.30);
  const pct = Math.round((mult - 1) * 100);
  return {
    mult,
    opportunity: opp,
    note: pct === 0 ? 'role stable' : `role trending ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%`,
  };
}

/** Aggregate recent news impact into a single multiplier, decayed by age. */
export function newsMultiplier(playerId, now = Date.now()) {
  const rows = all(
    `SELECT ts, headline, impact, confidence, rationale FROM news
     WHERE player_id = ? AND impact IS NOT NULL AND ts > ? ORDER BY ts DESC LIMIT 12`,
    [playerId, now - 14 * 864e5]
  );
  if (!rows.length) return { mult: 1, note: null, items: [] };
  let acc = 0;
  let wsum = 0;
  for (const r of rows) {
    const ageDays = (now - Number(r.ts)) / 864e5;
    const decay = Math.exp(-ageDays / 5);              // half-life ~3.5 days
    const w = decay * clamp(Number(r.confidence ?? 0.5), 0, 1);
    acc += w * clamp(Number(r.impact), -1, 1);
    wsum += w;
  }
  if (wsum <= 0) return { mult: 1, note: null, items: rows };
  const netImpact = acc / Math.max(wsum, 1e-9) * clamp(wsum, 0, 1);
  const mult = clamp(1 + netImpact * 0.25, 0.6, 1.4);
  const pct = Math.round((mult - 1) * 100);
  return {
    mult,
    note: pct === 0 ? null : `news ${pct > 0 ? '+' : ''}${pct}%`,
    items: rows.slice(0, 4),
  };
}

/**
 * Coefficient of variation for a player's weekly distribution.
 * Volatility is not constant: it falls with usage certainty (a bell-cow back is
 * more predictable than a committee back) and rises with a thin sample or a
 * questionable tag.
 */
export function volatility(pos, { games = 0, opportunity = null, statusVar = 1 }) {
  const base = POSITION_PRIORS[pos]?.cv ?? 0.55;
  // Thin samples widen the distribution.
  const sampleInflation = 1 + 0.45 * Math.exp(-games / 3);
  // High, stable opportunity narrows it.
  const oppFactor = opportunity == null ? 1 : clamp(1.16 - 0.30 * opportunity, 0.86, 1.16);
  return clamp(base * sampleInflation * oppFactor * statusVar, 0.18, 1.6);
}

/**
 * Project one player for one week.
 *
 * @returns {{mean:number, sd:number, floor:number, ceiling:number, components:Array, ...}}
 */
export function projectPlayer(player, ctx) {
  const { season, week, scoring, now = Date.now() } = ctx;
  const pos = player.pos;

  const base = baselinePpg(player.player_id, pos, season, week - 1, scoring);
  const usage = usageProfile(player.player_id, season, week - 1);
  const um = usageMultiplier(pos, usage, base.games);
  const game = findGame(player.nfl_team, season, week);
  const dm = defenseMultiplier(game?.opponent, pos, season);
  const em = environmentMultiplier(game, pos);
  const wm = weatherMultiplier(game, pos);
  const nm = newsMultiplier(player.player_id, now);
  const st = statusFactor(player.status);

  const onBye = player.bye_week != null && Number(player.bye_week) === Number(week);
  // "No game found" means one of two completely different things. If the week's
  // schedule is loaded and this team is not in it, the player genuinely does not
  // play and zero is right. If NO games are loaded at all, zero is a
  // fabrication — it silently zeroes every player in the league and reports a
  // war room full of 0.0 projections that look like a computed answer.
  const scheduleLoaded = weekHasSchedule(season, week);
  const noGame = !game && !onBye && scheduleLoaded;
  const scheduleMissing = !game && !onBye && !scheduleLoaded;

  const components = [
    { key: 'baseline', label: 'Baseline (recency-weighted)', value: base.ppg, kind: 'base', note: base.source },
    { key: 'usage', label: 'Role / opportunity', mult: um.mult, note: um.note },
    { key: 'defense', label: 'Opponent defense', mult: dm.mult, note: dm.note },
    { key: 'environment', label: 'Game environment (Vegas)', mult: em.mult, note: em.note },
    { key: 'weather', label: 'Weather', mult: wm.mult, note: wm.note ?? 'no weather effect' },
    { key: 'news', label: 'News & injury reports', mult: nm.mult, note: nm.note ?? 'nothing material' },
    { key: 'status', label: 'Availability', mult: st.mult, note: st.label === 'healthy' ? 'active' : `designated ${st.label}` },
  ];

  let mean = base.ppg * um.mult * dm.mult * em.mult * wm.mult * nm.mult * st.mult;

  if (onBye) {
    mean = 0;
    components.push({ key: 'bye', label: 'Bye week', mult: 0, note: `${player.nfl_team} on bye in week ${week}` });
  } else if (noGame) {
    mean = 0;
    components.push({ key: 'nogame', label: 'No scheduled game', mult: 0, note: 'no game found on the schedule for this week' });
  } else if (scheduleMissing) {
    // Matchup-neutral: the baseline stands, with none of the opponent, venue or
    // weather adjustments applied, because there is no game to read them from.
    components.push({
      key: 'noschedule', label: 'No schedule loaded', mult: 1,
      note: 'no games are loaded for this week — projection is matchup-neutral',
    });
  }

  mean = Math.max(0, mean);

  const cv = volatility(pos, {
    games: base.games,
    opportunity: um.opportunity,
    statusVar: st.varMult,
  });
  const sd = mean > 0 ? mean * cv : 0;

  const floor = mean > 0 ? gammaQuantileMS(0.10, mean, sd) : 0;
  const ceiling = mean > 0 ? gammaQuantileMS(0.90, mean, sd) : 0;

  return {
    player_id: player.player_id,
    name: player.name,
    pos,
    // Carried through so the optimizer sees the same eligibility the league does.
    eligible_positions: player.eligible_positions ?? null,
    nfl_team: player.nfl_team,
    opponent: game?.opponent ?? (onBye ? 'BYE' : null),
    isHome: game?.isHome ?? null,
    status: player.status || '',
    season,
    week,
    mean,
    sd,
    floor,
    ceiling,
    cv,
    games: base.games,
    opportunity: um.opportunity,
    components,
    model: MODEL_VERSION,
  };
}

/** Project an array of players for a week. */
export function projectAll(players, ctx) {
  return players.map((p) => projectPlayer(p, ctx));
}

/**
 * Boom/bust profile relative to a positional starter baseline. Turns the raw
 * distribution into the language managers actually think in.
 */
export function profile(proj) {
  const startable = { QB: 18, RB: 12, WR: 12, TE: 9, K: 8, DEF: 7 }[proj.pos] ?? 11;
  const boom = { QB: 26, RB: 20, WR: 20, TE: 16, K: 13, DEF: 14 }[proj.pos] ?? 18;
  if (proj.mean <= 0 || proj.sd <= 0) {
    return { pStartable: 0, pBoom: 0, pBust: 1, label: proj.opponent === 'BYE' ? 'BYE' : 'OUT' };
  }
  const shape = (proj.mean / proj.sd) ** 2;
  const scale = (proj.sd * proj.sd) / proj.mean;
  const cdf = (x) => gammaCdf(x, shape, scale);
  const pStartable = 1 - cdf(startable);
  const pBoom = 1 - cdf(boom);
  const pBust = cdf(startable * 0.5);
  let label = 'steady';
  if (pBoom > 0.22 && pBust > 0.30) label = 'boom/bust';
  else if (pBoom > 0.22) label = 'high ceiling';
  else if (pBust < 0.18) label = 'safe floor';
  else if (pBust > 0.40) label = 'volatile';
  return { pStartable, pBoom, pBust, label };
}


// ---------------------------------------------------------------------------
// Positional rank from consensus ADP
// ---------------------------------------------------------------------------

/**
 * A player's rank WITHIN his position, by consensus draft position.
 *
 * Memoised per season because the no-stats path runs for every player on every
 * roster on every projection call, and deriving the ordering fresh each time
 * would re-sort the whole player pool hundreds of times per request.
 *
 * Prefers a published pos_rank when the source supplies one; otherwise the rank
 * is derived by ordering that position's players on ADP, which is the same
 * thing the draft board does.
 */
const rankCache = new Map();

export function invalidateRankCache() { rankCache.clear(); }

function positionalRankOf(playerId, pos, season) {
  const key = `${season}|${pos}`;
  let map = rankCache.get(key);
  if (!map) {
    const rows = all(
      `SELECT a.player_id, MIN(a.adp) AS adp, MAX(a.pos_rank) AS pos_rank
         FROM adp a JOIN players p ON p.player_id = a.player_id
        WHERE a.season = ? AND p.pos = ?
        GROUP BY a.player_id
        ORDER BY adp ASC`,
      [season, pos]
    );
    map = new Map();
    rows.forEach((r, i) => map.set(r.player_id, r.pos_rank ?? i + 1));
    rankCache.set(key, map);
  }
  return map.get(playerId) ?? null;
}


/**
 * A projection published by an outside source for one player in one week.
 *
 * Scored through THIS league's rules rather than taken as a points total,
 * because a provider's own number is computed under its own scoring — which is
 * exactly the mistake this whole archetype layer exists to avoid. What is
 * borrowed is the stat line; the valuation stays ours.
 *
 * Scored with expectedScore, not scoreStatLine: a projected line is an AVERAGE,
 * so a threshold bonus is worth the probability of clearing it rather than all
 * or nothing, and a projected points-allowed figure has to be converted through
 * a distribution into this league's tiers. scoreStatLine has no rate to
 * multiply def_pts_allowed by, so using it here would silently drop the whole
 * points-allowed category from every projected defense — the same defect,
 * in its third disguise.
 */
function externalProjection(playerId, season, week, scoring) {
  const row = get(
    'SELECT source, stats FROM external_projections WHERE player_id = ? AND season = ? AND week = ? ORDER BY fetched_at DESC LIMIT 1',
    [playerId, season, week]
  );
  if (!row) return null;
  const stats = j(row.stats, {});
  if (!Object.keys(stats).length) return null;
  return { source: row.source, points: expectedScore(stats, scoring), stats };
}
