/**
 * The simulator's two claims are that it preserves each player's marginal
 * distribution AND imposes the intended correlation structure. Both are
 * verified here, along with the win-probability properties that follow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QuantileTable, samplePlayers, simulateMatchup, teamWeekDistribution,
  simulateSeason, roundRobinSchedule,
} from '../src/engine/simulate.mjs';
import { pairCorrelation, buildCorrelationMatrix, describeStacks, lineupCorrelationLoad } from '../src/engine/correlation.mjs';
import { Rng } from '../src/util/rng.mjs';
import { mean, stdevPop, pearson, gammaQuantileMS, quantile } from '../src/util/stats.mjs';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, msg ?? `${a} ≈ ${b} ±${eps}`);
const P = (id, pos, team, opp, mu, sd) =>
  ({ player_id: id, name: id, pos, nfl_team: team, opponent: opp, mean: mu, sd });

test('QuantileTable interpolates the exact gamma inverse closely', () => {
  const qt = new QuantileTable(14, 7);
  for (const u of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    const exact = gammaQuantileMS(u, 14, 7);
    close(qt.at(u), exact, exact * 0.005, `u=${u}`);
  }
});

test('QuantileTable handles degenerate inputs', () => {
  assert.equal(new QuantileTable(0, 5).at(0.5), 0);
  assert.equal(new QuantileTable(10, 0).at(0.9), 10);
});

test('the copula preserves each player\'s marginal distribution', () => {
  const projs = [
    P('qb', 'QB', 'KC', 'BUF', 21, 7),
    P('wr', 'WR', 'KC', 'BUF', 14, 8),
    P('rb', 'RB', 'KC', 'BUF', 12, 6),
    P('def', 'DEF', 'BUF', 'KC', 7, 4.5),
  ];
  const samples = samplePlayers(projs, 60000, new Rng(2024));
  projs.forEach((p, i) => {
    const xs = Array.from(samples[i]);
    close(mean(xs), p.mean, p.mean * 0.02, `${p.name} mean`);
    close(stdevPop(xs), p.sd, p.sd * 0.04, `${p.name} sd`);
    assert.ok(xs.every((x) => x >= 0), `${p.name} never scores negative`);
  });
});

test('the copula imposes the intended correlations', () => {
  const projs = [
    P('qb', 'QB', 'KC', 'BUF', 21, 7),
    P('wr', 'WR', 'KC', 'BUF', 14, 8),
    P('rb', 'RB', 'KC', 'BUF', 12, 6),
    P('def', 'DEF', 'BUF', 'KC', 7, 4.5),
  ];
  const s = samplePlayers(projs, 60000, new Rng(77));
  const corr = (i, k) => pearson(Array.from(s[i]), Array.from(s[k]));
  // The rank transform through a skewed marginal attenuates Pearson slightly,
  // so we assert direction and approximate magnitude rather than equality.
  assert.ok(corr(0, 1) > 0.25, 'quarterback and his own receiver move together');
  assert.ok(corr(0, 3) < -0.3, 'quarterback and the defense he faces move oppositely');
  assert.ok(Math.abs(corr(0, 2)) < 0.2, 'quarterback and his own back are near-independent');
});

test('correlation lookup is symmetric regardless of key order', () => {
  const qb = P('qb', 'QB', 'KC', 'BUF', 20, 6);
  const def = P('def', 'DEF', 'BUF', 'KC', 7, 4);
  // This was a real bug: the hand-written table used 'QB|DEF' while lookups
  // canonicalise to 'DEF|QB', silently returning 0.
  assert.equal(pairCorrelation(qb, def), pairCorrelation(def, qb));
  assert.ok(pairCorrelation(qb, def) < -0.3, 'a defense opposes the quarterback it faces');
});

test('same-team and cross-game correlations behave sensibly', () => {
  const kcQb = P('a', 'QB', 'KC', 'BUF', 20, 6);
  const kcWr = P('b', 'WR', 'KC', 'BUF', 14, 7);
  const kcRb = P('c', 'RB', 'KC', 'BUF', 12, 5);
  const kcRb2 = P('d', 'RB', 'KC', 'BUF', 6, 4);
  const farWr = P('e', 'WR', 'SEA', 'SF', 12, 6);
  assert.ok(pairCorrelation(kcQb, kcWr) > 0.3);
  assert.ok(pairCorrelation(kcRb, kcRb2) < -0.2, 'backs in the same backfield compete for carries');
  assert.ok(Math.abs(pairCorrelation(kcQb, farWr)) < 0.05, 'different games are near-independent');
  assert.equal(pairCorrelation(kcQb, kcQb), 1);
});

test('the correlation matrix is symmetric with a unit diagonal', () => {
  const projs = [P('a', 'QB', 'KC', 'BUF', 20, 6), P('b', 'WR', 'KC', 'BUF', 14, 7), P('c', 'DEF', 'BUF', 'KC', 7, 4)];
  const R = buildCorrelationMatrix(projs);
  for (let i = 0; i < 3; i++) {
    assert.equal(R[i][i], 1);
    for (let k = 0; k < 3; k++) assert.equal(R[i][k], R[k][i]);
  }
});

test('describeStacks and lineupCorrelationLoad identify exposure', () => {
  const lineup = [P('a', 'QB', 'KC', 'BUF', 20, 6), P('b', 'WR', 'KC', 'BUF', 14, 7), P('c', 'TE', 'KC', 'BUF', 9, 5)];
  const stacks = describeStacks(lineup);
  assert.ok(stacks.length >= 2);
  assert.equal(stacks[0].kind, 'stack');
  assert.ok(lineupCorrelationLoad(lineup) > 0, 'a stacked lineup carries positive correlation load');
});

test('two identical teams are a coin flip', () => {
  const mk = (p) => [P(`${p}1`, 'WR', `X${p}`, `Y${p}`, 15, 7), P(`${p}2`, 'RB', `Z${p}`, `W${p}`, 12, 6)];
  const r = simulateMatchup(mk('a'), mk('b'), { sims: 40000, seed: 11 });
  close(r.winProb, 0.5, 0.02);
  close(r.margin, 0, 1.0);
});

test('a stronger team wins more often, and win probability is monotone in strength', () => {
  const weak = [P('b1', 'WR', 'XB', 'YB', 15, 7), P('b2', 'RB', 'ZB', 'WB', 12, 6)];
  let last = 0;
  for (const boost of [0, 3, 6, 12, 20]) {
    const strong = [P('a1', 'WR', 'XA', 'YA', 15 + boost, 7), P('a2', 'RB', 'ZA', 'WA', 12, 6)];
    const r = simulateMatchup(strong, weak, { sims: 20000, seed: 5 });
    assert.ok(r.winProb >= last - 0.01, `win probability rises with strength (boost ${boost})`);
    last = r.winProb;
  }
  assert.ok(last > 0.85, 'a large edge produces a large favourite');
});

test('matchup output is internally consistent', () => {
  const a = [P('a1', 'WR', 'XA', 'YA', 18, 8), P('a2', 'RB', 'ZA', 'WA', 12, 5)];
  const b = [P('b1', 'WR', 'XB', 'YB', 14, 7)];
  const r = simulateMatchup(a, b, { sims: 20000, seed: 3 });
  close(r.myMean, 30, 0.6);
  assert.ok(r.myFloor < r.myMean && r.myMean < r.myCeiling);
  close(r.margin, r.myMean - r.oppMean, 0.5);
  assert.ok(r.marginP10 < r.marginP90);
});

test('an empty matchup does not throw', () => {
  const r = simulateMatchup([], [], { sims: 100, seed: 1 });
  assert.equal(r.winProb, 0.5);
});

test('teamWeekDistribution accounts for correlation in the variance', () => {
  const slots = ['QB', 'WR', 'WR'];
  const stacked = [P('q', 'QB', 'KC', 'BUF', 20, 8), P('w1', 'WR', 'KC', 'BUF', 14, 8), P('w2', 'WR', 'KC', 'BUF', 12, 7)];
  const spread = [P('q', 'QB', 'KC', 'BUF', 20, 8), P('w1', 'WR', 'SEA', 'SF', 14, 8), P('w2', 'WR', 'NYJ', 'MIA', 12, 7)];
  const a = teamWeekDistribution(stacked, slots);
  const b = teamWeekDistribution(spread, slots);
  close(a.mean, b.mean, 1e-9, 'means are identical');
  assert.ok(a.sd > b.sd, 'the stacked lineup has strictly more variance');
});

test('roundRobinSchedule gives every team one game per week', () => {
  for (const n of [4, 6, 10, 12]) {
    const keys = Array.from({ length: n }, (_, i) => `t${i}`);
    const sch = roundRobinSchedule(keys, 5);
    for (const wk of sch) {
      assert.equal(wk.pairs.length, n / 2, `${n} teams give ${n / 2} pairings`);
      const seen = new Set(wk.pairs.flat());
      assert.equal(seen.size, n, 'every team appears exactly once');
    }
  }
});

test('season simulation produces coherent probabilities', () => {
  const teams = Array.from({ length: 8 }, (_, i) => ({
    team_key: `t${i}`, name: `Team ${i}`, wins: 0, losses: 0, ties: 0, points_for: 0,
    is_mine: i === 0,
    dist: { mean: 120 + i * 4, sd: 25 },   // team 7 is strongest
  }));
  const schedule = roundRobinSchedule(teams.map((t) => t.team_key), 7);
  const res = simulateSeason({
    teams, schedule, playoffTeams: 4, playoffStartWeek: 8, endWeek: 10,
    sims: 1500, seed: 9, currentWeek: 1,
  });

  assert.equal(res.length, 8);
  for (const r of res) {
    assert.ok(r.playoffOdds >= 0 && r.playoffOdds <= 1);
    assert.ok(r.titleOdds >= 0 && r.titleOdds <= 1);
    assert.ok(r.titleOdds <= r.playoffOdds + 1e-9, 'you cannot win the title without making the playoffs');
    close(r.seedDist.reduce((a, b) => a + b, 0), 1, 1e-9, 'seed distribution sums to one');
  }
  const totalPlayoff = res.reduce((a, r) => a + r.playoffOdds, 0);
  close(totalPlayoff, 4, 0.05, 'exactly four playoff spots are allocated each simulation');
  close(res.reduce((a, r) => a + r.titleOdds, 0), 1, 0.02, 'exactly one champion per simulation');

  const strongest = res.find((r) => r.name === 'Team 7');
  const weakest = res.find((r) => r.name === 'Team 0');
  assert.ok(strongest.titleOdds > weakest.titleOdds, 'the strongest team is most likely to win');
});

test('season simulation respects an existing record', () => {
  const base = (wins) => Array.from({ length: 4 }, (_, i) => ({
    team_key: `t${i}`, name: `T${i}`, wins: i === 0 ? wins : 0, losses: 0, ties: 0,
    points_for: 0, is_mine: false, dist: { mean: 120, sd: 20 },
  }));
  const sch = roundRobinSchedule(['t0', 't1', 't2', 't3'], 3);
  const opts = { schedule: sch, playoffTeams: 2, playoffStartWeek: 4, endWeek: 5, sims: 1200, seed: 2, currentWeek: 1 };
  const behind = simulateSeason({ teams: base(0), ...opts }).find((r) => r.team_key === 't0');
  const ahead = simulateSeason({ teams: base(5), ...opts }).find((r) => r.team_key === 't0');
  assert.ok(ahead.playoffOdds > behind.playoffOdds + 0.2, 'a five-win head start matters');
});
