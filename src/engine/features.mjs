/**
 * Opportunity features.
 *
 * Fantasy points are noisy; opportunity is not. A running back who takes 78% of
 * the snaps and 5 red-zone carries is a good play whether or not he found the
 * end zone last Sunday. These features are what let the platform buy a breakout
 * the week *before* the box score makes it obvious and everyone else bids.
 */
import { all, j } from '../db/index.mjs';
import { mean, clamp, shrink } from '../util/stats.mjs';

/** Exponentially-weighted mean over an array ordered oldest -> newest. */
export function ewma(values, halfLife = 2.5) {
  if (!values.length) return 0;
  const lambda = Math.log(2) / halfLife;
  let num = 0;
  let den = 0;
  const n = values.length;
  for (let i = 0; i < n; i++) {
    const age = n - 1 - i;              // 0 = most recent
    const w = Math.exp(-lambda * age);
    num += w * values[i];
    den += w;
  }
  return den ? num / den : 0;
}

/** Trend slope of the last `k` observations, normalised to the series mean. */
export function trend(values, k = 4) {
  const v = values.slice(-k);
  if (v.length < 2) return 0;
  const n = v.length;
  const xs = v.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(v);
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (v[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  return my > 0 ? slope / my : 0;        // fractional change per week
}

const USAGE_COLS = ['snap_pct', 'route_pct', 'target_share', 'rush_share', 'air_yard_share', 'rz_touches', 'gl_carries'];

/**
 * Assemble the usage profile for a player: recency-weighted level, short-term
 * trend, and the sample size backing it (which drives how much we shrink).
 */
export function usageProfile(playerId, season, throughWeek) {
  const rows = all(
    `SELECT * FROM player_usage WHERE player_id = ? AND season = ? AND week <= ?
     ORDER BY week ASC`,
    [playerId, season, throughWeek]
  );
  const out = { games: rows.length };
  for (const c of USAGE_COLS) {
    const series = rows.map((r) => Number(r[c] ?? 0));
    out[c] = ewma(series, 2.5);
    out[`${c}_trend`] = trend(series, 4);
  }
  return out;
}

/**
 * Composite "opportunity score" in 0..1 — how much of his team's productive
 * volume this player commands. Weighted by what actually converts to points at
 * each position.
 */
export function opportunityScore(pos, u) {
  const snap = clamp(u.snap_pct ?? 0, 0, 1);
  const tgt = clamp(u.target_share ?? 0, 0, 1);
  const rush = clamp(u.rush_share ?? 0, 0, 1);
  const air = clamp(u.air_yard_share ?? 0, 0, 1);
  const rz = clamp((u.rz_touches ?? 0) / 6, 0, 1);
  switch (pos) {
    case 'RB': return clamp(0.45 * rush + 0.25 * snap + 0.15 * tgt + 0.15 * rz, 0, 1);
    case 'WR': return clamp(0.45 * tgt + 0.25 * air + 0.2 * snap + 0.1 * rz, 0, 1);
    case 'TE': return clamp(0.5 * tgt + 0.25 * snap + 0.15 * air + 0.1 * rz, 0, 1);
    case 'QB': return clamp(0.7 * snap + 0.3 * clamp(rush * 3, 0, 1), 0, 1);
    default: return clamp(snap, 0, 1);
  }
}

/**
 * Breakout signal: a step change in opportunity that the fantasy market has not
 * priced yet. Positive values mean the player's role has grown recently and his
 * ownership has not caught up.
 */
export function breakoutSignal({ pos, usage, pctOwned = 0, pctChange = 0 }) {
  const share = opportunityScore(pos, usage);
  const trendKey = pos === 'RB' ? 'rush_share_trend' : 'target_share_trend';
  const roleTrend = clamp(usage[trendKey] ?? 0, -1, 1);
  const snapTrend = clamp(usage.snap_pct_trend ?? 0, -1, 1);
  const rzTrend = clamp(usage.rz_touches_trend ?? 0, -1, 1);

  // Momentum in the role itself.
  const momentum = 0.5 * roleTrend + 0.3 * snapTrend + 0.2 * rzTrend;
  // How much of that role is already reflected in ownership.
  const priced = clamp(pctOwned / 100, 0, 1);
  const unpriced = 1 - priced;

  const raw = (0.55 * share + 0.45 * clamp(momentum * 2, -1, 1)) * (0.35 + 0.65 * unpriced);
  return {
    score: clamp(raw, -1, 1),
    share,
    momentum,
    unpriced,
    ownershipVelocity: pctChange,
  };
}

/**
 * Positional priors used to shrink thin samples. Values are per-game fantasy
 * points in full PPR for a league-average starter at the position, with `k`
 * expressing how many games of evidence it takes to move halfway off the prior.
 */
export const POSITION_PRIORS = {
  QB: { ppg: 16.5, k: 3.0, cv: 0.33 },
  RB: { ppg: 11.0, k: 3.5, cv: 0.52 },
  WR: { ppg: 10.5, k: 4.0, cv: 0.58 },
  TE: { ppg: 8.0,  k: 4.0, cv: 0.62 },
  K:  { ppg: 8.0,  k: 5.0, cv: 0.45 },
  DEF:{ ppg: 7.0,  k: 5.0, cv: 0.65 },
};

/** Shrink an observed per-game average toward the positional prior. */
export function shrinkToPrior(pos, observedPpg, games) {
  const prior = POSITION_PRIORS[pos] ?? POSITION_PRIORS.WR;
  return shrink(observedPpg, prior.ppg, games, prior.k);
}
