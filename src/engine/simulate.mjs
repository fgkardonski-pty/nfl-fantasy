/**
 * Monte Carlo simulation.
 *
 * Every recommendation this platform makes is denominated in one currency:
 * change in probability of winning. Points are an intermediate quantity nobody
 * gets a trophy for. To get from projections to probabilities honestly we need
 * three things, all of which are implemented here:
 *
 *   1. Correct MARGINALS  — weekly fantasy scoring is right-skewed with a floor
 *      at zero, so each player is sampled from a gamma matched to his projected
 *      mean and standard deviation, not a normal.
 *
 *   2. Correct DEPENDENCE — players are sampled through a GAUSSIAN COPULA: draw
 *      a correlated multivariate normal, push it through the normal CDF to get
 *      correlated uniforms, then invert each player's own gamma. This preserves
 *      each player's exact marginal distribution while imposing the correlation
 *      structure from correlation.mjs. Sampling correlated normals directly
 *      would silently destroy the skew.
 *
 *   3. Speed — inverting a gamma CDF per player per simulation would be far too
 *      slow, so each player's quantile function is tabulated once on a
 *      tail-dense grid and then interpolated. 20,000 simulations of a full
 *      matchup runs in tens of milliseconds.
 */
import { Rng, correlatedNormals } from '../util/rng.mjs';
import {
  cholesky, normalCdf, mean as avg, stdevPop, quantile, gammaQuantileMS, clamp, round,
} from '../util/stats.mjs';
import { buildCorrelationMatrix } from './correlation.mjs';
import { optimalLineup } from './optimizer.mjs';

/**
 * Tabulated inverse CDF for one player's gamma distribution.
 * Grid is denser in the tails, where fantasy outcomes are decided.
 */
export class QuantileTable {
  constructor(mu, sigma, n = 512) {
    this.mu = mu;
    this.zero = mu <= 1e-9 || sigma <= 1e-9;
    this.n = n;
    if (this.zero) return;
    this.us = new Float64Array(n);
    this.xs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // Beta-like spacing: concentrate knots near 0 and 1.
      const t = i / (n - 1);
      const u = clamp(0.5 * (1 - Math.cos(Math.PI * t)), 1e-4, 1 - 1e-4);
      this.us[i] = u;
      this.xs[i] = gammaQuantileMS(u, mu, sigma);
    }
  }

  /** Linear interpolation of the quantile at uniform u. */
  at(u) {
    if (this.zero) return this.mu > 0 ? this.mu : 0;
    const us = this.us;
    if (u <= us[0]) return this.xs[0];
    if (u >= us[this.n - 1]) return this.xs[this.n - 1];
    // Binary search for the bracketing knots.
    let lo = 0;
    let hi = this.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (us[mid] <= u) lo = mid; else hi = mid;
    }
    const w = (u - us[lo]) / (us[hi] - us[lo]);
    return this.xs[lo] + w * (this.xs[hi] - this.xs[lo]);
  }
}

/**
 * Draw `nSims` correlated score samples for a set of projections.
 * @returns {Float64Array[]} one array of samples per player, aligned with input
 */
export function samplePlayers(projections, nSims, rng) {
  const n = projections.length;
  const out = Array.from({ length: n }, () => new Float64Array(nSims));
  if (!n) return out;

  const tables = projections.map((p) => new QuantileTable(p.mean, p.sd));
  const R = buildCorrelationMatrix(projections);
  const L = cholesky(R);
  const z = new Float64Array(n);

  for (let s = 0; s < nSims; s++) {
    correlatedNormals(rng, L, z);
    for (let i = 0; i < n; i++) {
      const u = normalCdf(z[i]);
      out[i][s] = tables[i].at(u);
    }
  }
  return out;
}

/**
 * Simulate a head-to-head fantasy matchup.
 *
 * Both rosters are sampled jointly so that cross-roster correlation is
 * respected — if your opponent starts the quarterback throwing to your wide
 * receiver, those outcomes are linked, and pretending otherwise misprices the
 * matchup.
 *
 * @param {Array} myLineup   projections of my STARTERS
 * @param {Array} oppLineup  projections of the opponent's STARTERS
 */
export function simulateMatchup(myLineup, oppLineup, { sims = 20000, seed = 1 } = {}) {
  const rng = new Rng(seed);
  const all = [...myLineup, ...oppLineup];
  if (!all.length) {
    return { winProb: 0.5, myMean: 0, oppMean: 0, margin: 0, sims: 0 };
  }
  const samples = samplePlayers(all, sims, rng);
  const nMine = myLineup.length;

  const mineTotals = new Float64Array(sims);
  const oppTotals = new Float64Array(sims);
  for (let i = 0; i < nMine; i++) {
    const s = samples[i];
    for (let k = 0; k < sims; k++) mineTotals[k] += s[k];
  }
  for (let i = nMine; i < all.length; i++) {
    const s = samples[i];
    for (let k = 0; k < sims; k++) oppTotals[k] += s[k];
  }

  let wins = 0;
  let ties = 0;
  const margins = new Float64Array(sims);
  for (let k = 0; k < sims; k++) {
    const d = mineTotals[k] - oppTotals[k];
    margins[k] = d;
    if (d > 1e-9) wins++;
    else if (Math.abs(d) <= 1e-9) ties++;
  }

  const mineArr = Array.from(mineTotals);
  const oppArr = Array.from(oppTotals);
  return {
    winProb: (wins + 0.5 * ties) / sims,
    sims,
    myMean: avg(mineArr),
    mySd: stdevPop(mineArr),
    myFloor: quantile(mineArr, 0.1),
    myCeiling: quantile(mineArr, 0.9),
    oppMean: avg(oppArr),
    oppSd: stdevPop(oppArr),
    oppFloor: quantile(oppArr, 0.1),
    oppCeiling: quantile(oppArr, 0.9),
    margin: avg(Array.from(margins)),
    marginP10: quantile(Array.from(margins), 0.1),
    marginP90: quantile(Array.from(margins), 0.9),
    myTotals: mineArr,
    oppTotals: oppArr,
  };
}

/**
 * Team weekly score distribution, used for season-long simulation.
 *
 * For the CURRENT week we simulate at the player level. For future weeks that
 * is neither affordable nor honest — we do not know who will be healthy, who
 * will be on a bye, or what the lines will be — so a team is summarised by a
 * mean and standard deviation derived from its roster and simulated at team
 * level. This is stated explicitly rather than dressed up as precision we do
 * not have.
 */
export function teamWeekDistribution(rosterProjections, slots) {
  const { lineup } = optimalLineup(rosterProjections, slots, (p) => p.mean);
  const starters = lineup.map((l) => l.player).filter(Boolean);
  const mean = starters.reduce((a, p) => a + p.mean, 0);
  // Variance with correlation: Var = Σσᵢ² + 2ΣΣρᵢⱼσᵢσⱼ
  let varSum = 0;
  for (const p of starters) varSum += p.sd * p.sd;
  const R = buildCorrelationMatrix(starters);
  for (let i = 0; i < starters.length; i++) {
    for (let k = i + 1; k < starters.length; k++) {
      varSum += 2 * R[i][k] * starters[i].sd * starters[k].sd;
    }
  }
  return { mean, sd: Math.sqrt(Math.max(varSum, 1e-9)), starters };
}

/**
 * Full-season Monte Carlo.
 *
 * @param {Object} params
 * @param {Array}  params.teams        [{team_key,name,wins,losses,ties,points_for,dist:{mean,sd}}]
 * @param {Array}  params.schedule     [{week, pairs:[[teamKeyA, teamKeyB], ...]}]
 * @param {number} params.playoffTeams
 * @param {number} params.playoffStartWeek
 * @param {number} params.endWeek
 */
export function simulateSeason({
  teams, schedule, playoffTeams = 6, playoffStartWeek = 15, endWeek = 17,
  sims = 5000, seed = 7, currentWeek = 1,
}) {
  const rng = new Rng(seed);
  const idx = new Map(teams.map((t, i) => [t.team_key, i]));
  const n = teams.length;

  const madePlayoffs = new Int32Array(n);
  const wonTitle = new Int32Array(n);
  const gotBye = new Int32Array(n);
  const seedCounts = Array.from({ length: n }, () => new Int32Array(n + 1));
  const winTotals = Array.from({ length: n }, () => []);
  const pfTotals = Array.from({ length: n }, () => []);

  const regularWeeks = schedule.filter((w) => w.week >= currentWeek && w.week < playoffStartWeek);
  const tables = teams.map((t) => new QuantileTable(t.dist.mean, t.dist.sd));

  for (let s = 0; s < sims; s++) {
    const wins = new Float64Array(n);
    const pf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      wins[i] = (teams[i].wins ?? 0) + 0.5 * (teams[i].ties ?? 0);
      pf[i] = teams[i].points_for ?? 0;
    }

    for (const wk of regularWeeks) {
      for (const [a, b] of wk.pairs) {
        const ia = idx.get(a);
        const ib = idx.get(b);
        if (ia === undefined || ib === undefined) continue;
        const sa = tables[ia].at(rng.uniform());
        const sb = tables[ib].at(rng.uniform());
        pf[ia] += sa;
        pf[ib] += sb;
        if (sa > sb) wins[ia] += 1;
        else if (sb > sa) wins[ib] += 1;
        else { wins[ia] += 0.5; wins[ib] += 0.5; }
      }
    }

    // Seed by wins, then points for — the near-universal tiebreaker.
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((x, y) => (wins[y] - wins[x]) || (pf[y] - pf[x]));

    for (let r = 0; r < n; r++) {
      const i = order[r];
      seedCounts[i][r + 1] += 1;
      winTotals[i].push(wins[i]);
      pfTotals[i].push(pf[i]);
    }

    const field = order.slice(0, playoffTeams);
    for (const i of field) madePlayoffs[i] += 1;

    // Bracket: byes to the top seeds when the field is not a power of two.
    const rounds = Math.ceil(Math.log2(Math.max(2, playoffTeams)));
    const bracketSize = 2 ** rounds;
    const byes = bracketSize - playoffTeams;
    for (let i = 0; i < byes; i++) gotBye[field[i]] += 1;

    // Simulate the bracket, re-seeding each round (highest seed plays lowest).
    let alive = field.slice();
    let advanced = alive.slice(0, byes);
    let playing = alive.slice(byes);
    while (advanced.length + playing.length > 1) {
      const winners = [...advanced];
      for (let i = 0; i < playing.length / 2; i++) {
        const hi = playing[i];
        const lo = playing[playing.length - 1 - i];
        const sh = tables[hi].at(rng.uniform());
        const sl = tables[lo].at(rng.uniform());
        winners.push(sh >= sl ? hi : lo);
      }
      // Re-seed by original seeding order.
      winners.sort((x, y) => field.indexOf(x) - field.indexOf(y));
      advanced = [];
      playing = winners;
      if (playing.length === 1) break;
    }
    if (playing.length === 1) wonTitle[playing[0]] += 1;
  }

  return teams.map((t, i) => ({
    team_key: t.team_key,
    name: t.name,
    is_mine: !!t.is_mine,
    projMean: round(t.dist.mean, 2),
    projSd: round(t.dist.sd, 2),
    playoffOdds: madePlayoffs[i] / sims,
    titleOdds: wonTitle[i] / sims,
    byeOdds: gotBye[i] / sims,
    expectedWins: round(avg(winTotals[i]), 2),
    winsP10: round(quantile(winTotals[i], 0.1), 1),
    winsP90: round(quantile(winTotals[i], 0.9), 1),
    expectedPf: round(avg(pfTotals[i]), 1),
    seedDist: Array.from(seedCounts[i]).slice(1).map((c) => c / sims),
  })).sort((a, b) => b.titleOdds - a.titleOdds);
}

/**
 * Round-robin schedule generator (the circle method), used for demo leagues and
 * as a fallback when a league's future matchups have not been published yet.
 */
export function roundRobinSchedule(teamKeys, weeks) {
  const keys = [...teamKeys];
  if (keys.length % 2) keys.push(null); // bye placeholder
  const n = keys.length;
  const half = n / 2;
  const rotation = keys.slice(1);
  const schedule = [];
  for (let w = 1; w <= weeks; w++) {
    const r = (w - 1) % rotation.length;
    const rotated = [...rotation.slice(r), ...rotation.slice(0, r)];
    const left = [keys[0], ...rotated.slice(0, half - 1)];
    const right = rotated.slice(half - 1).reverse();
    const pairs = [];
    for (let i = 0; i < half; i++) {
      if (left[i] && right[i]) pairs.push([left[i], right[i]]);
    }
    schedule.push({ week: w, pairs });
  }
  return schedule;
}
