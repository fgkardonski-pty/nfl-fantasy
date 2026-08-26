/**
 * Start/sit by WIN PROBABILITY.
 *
 * The projected-points optimum is the right answer only when you are close to
 * even money. It is the wrong answer at the extremes, and those are the weeks
 * that decide seasons:
 *
 *   - As a heavy UNDERDOG your expected points are irrelevant; you need the
 *     tail. Starting the volatile boom/bust receiver over the safe 11-point
 *     back loses expected points and gains win probability, because the only
 *     paths where you win are the ones where something goes right.
 *
 *   - As a heavy FAVOURITE the tail is what beats you. Minimising variance is
 *     worth giving up points for, because you are converting the middle of the
 *     distribution — where you already win — into certainty.
 *
 * This module takes the point-optimal lineup, enumerates the realistic
 * alternatives, and re-scores every one of them by simulated win probability
 * against the actual opponent's actual lineup. The recommendation is whichever
 * maximises P(win). When that differs from the points-optimal lineup, the war
 * room says so, and by how much.
 */
import { optimalLineup, closeCalls } from './optimizer.mjs';
import { simulateMatchup } from './simulate.mjs';
import { describeStacks, lineupCorrelationLoad } from './correlation.mjs';
import { round, clamp } from '../util/stats.mjs';

/**
 * Enumerate candidate lineups worth simulating.
 * We do not brute-force every legal lineup (combinatorially wasteful and mostly
 * nonsense); we take the point-optimal lineup and every single-swap variant
 * from the closest start/sit calls, which is where the real decisions live.
 */
export function candidateLineups(roster, slots, { maxCandidates = 10, pointCostLimit = 6 } = {}) {
  const base = optimalLineup(roster, slots, (p) => p.mean);
  const candidates = [{
    id: 'optimal',
    label: 'Projection-optimal',
    lineup: base.lineup,
    swap: null,
    pointCost: 0,
  }];

  const calls = closeCalls(roster, slots, (p) => p.mean, maxCandidates * 2);
  for (const c of calls) {
    if (c.pointCost > pointCostLimit) continue;
    if (candidates.length >= maxCandidates) break;
    const forced = optimalLineup(
      roster, slots,
      (p) => (p.player_id === c.in.player_id ? p.mean + 1e6 : p.mean)
    );
    candidates.push({
      id: `swap_${c.in.player_id}`,
      label: `Start ${c.in.name} over ${c.out.name}`,
      lineup: forced.lineup,
      swap: { in: c.in, out: c.out, slot: c.slot },
      pointCost: c.pointCost,
    });
  }

  // Also offer an explicit ceiling lineup and an explicit floor lineup — the
  // two extremes a manager reaches for when the matchup is lopsided.
  const ceil = optimalLineup(roster, slots, (p) => p.ceiling ?? p.mean);
  const floor = optimalLineup(roster, slots, (p) => p.floor ?? p.mean);
  const sig = (l) => l.lineup.map((x) => x.player?.player_id ?? '-').join(',');
  const seen = new Set(candidates.map((c) => sig(c)));
  for (const [id, label, l] of [['ceiling', 'Max ceiling (chase the tail)', ceil], ['floor', 'Max floor (protect the lead)', floor]]) {
    if (seen.has(sig(l))) continue;
    seen.add(sig(l));
    candidates.push({
      id, label, lineup: l.lineup, swap: null,
      pointCost: base.total - l.lineup.reduce((a, x) => a + (x.player?.mean ?? 0), 0),
    });
  }
  return candidates;
}

/**
 * Score every candidate lineup by simulated win probability against a specific
 * opponent lineup, and return them ranked.
 */
export function optimizeForWinProbability(roster, slots, oppLineup, {
  sims = 12000, seed = 31, maxCandidates = 10,
} = {}) {
  const candidates = candidateLineups(roster, slots, { maxCandidates });
  const scored = candidates.map((c, i) => {
    const starters = c.lineup.map((l) => l.player).filter(Boolean);
    const sim = simulateMatchup(starters, oppLineup, { sims, seed: seed + i });
    return {
      ...c,
      winProb: sim.winProb,
      mean: sim.myMean,
      sd: sim.mySd,
      floor: sim.myFloor,
      ceiling: sim.myCeiling,
      correlationLoad: lineupCorrelationLoad(starters),
      starters,
    };
  });

  scored.sort((a, b) => b.winProb - a.winProb);
  const best = scored[0];
  const pointOptimal = scored.find((c) => c.id === 'optimal') ?? best;

  const disagreement = best.id !== 'optimal';
  const winProbGain = best.winProb - pointOptimal.winProb;
  const pointsGiven = pointOptimal.mean - best.mean;

  return {
    recommended: best,
    pointOptimal,
    candidates: scored,
    disagreement,
    winProbGain,
    pointsGiven,
    posture: posture(pointOptimal.winProb),
    explanation: explain({ disagreement, best, pointOptimal, winProbGain, pointsGiven }),
    stacks: describeStacks(best.starters),
  };
}

/** Strategic posture implied by the matchup's baseline win probability. */
export function posture(winProb) {
  if (winProb >= 0.72) {
    return {
      stance: 'favourite',
      advice: 'Protect the lead. Prefer floor over ceiling; you lose this matchup only to variance.',
      variancePreference: -1,
    };
  }
  if (winProb <= 0.32) {
    return {
      stance: 'underdog',
      advice: 'Chase the tail. Expected points do not matter — only the outcomes where you win do. Start the volatile player.',
      variancePreference: +1,
    };
  }
  return {
    stance: 'coin-flip',
    advice: 'Play it straight. Maximise expected points; neither tail is worth paying for.',
    variancePreference: 0,
  };
}

function explain({ disagreement, best, pointOptimal, winProbGain, pointsGiven }) {
  const p = posture(pointOptimal.winProb);
  if (!disagreement) {
    return `The projection-optimal lineup is also the win-probability-optimal lineup at ${(best.winProb * 100).toFixed(1)}%. ${p.advice}`;
  }
  const article = /^[aeiou]/i.test(p.stance) ? 'an' : 'a';
  // Below ~0.3 points the difference is inside Monte Carlo noise; claiming a
  // precise points-given figure there would be false precision.
  const cost = Math.abs(pointsGiven) < 0.3
    ? 'at no meaningful cost in projected points'
    : pointsGiven > 0
      ? `while giving up ${pointsGiven.toFixed(1)} projected points`
      : `and gains ${Math.abs(pointsGiven).toFixed(1)} projected points doing it`;
  return (
    `You are ${article} ${p.stance} at ${(pointOptimal.winProb * 100).toFixed(1)}%. ` +
    `${best.label} raises win probability to ${(best.winProb * 100).toFixed(1)}% ` +
    `(+${(winProbGain * 100).toFixed(1)} pts of win probability) ${cost}. ${p.advice}`
  );
}

/**
 * Value of a roster move measured the only way that matters: the change in
 * championship probability. This is the universal currency the waiver, trade
 * and draft engines all price in.
 *
 * @param {Function} seasonSimFn  () => titleOdds for the current roster state
 */
export function championshipDelta(before, after) {
  return {
    before,
    after,
    delta: after - before,
    deltaPct: before > 0 ? (after - before) / before : (after > 0 ? Infinity : 0),
  };
}

/**
 * Translate a win-probability delta for a single week into an approximate
 * season-long championship-probability delta. A week's win probability moves
 * seed position, which moves playoff odds, which moves title odds; the
 * multiplier is small and we do not pretend otherwise.
 */
export function weeklyToSeasonImpact(winProbDelta, { weeksRemaining = 10, playoffOdds = 0.5 } = {}) {
  // A single week's win probability matters most when the team is on the
  // playoff bubble and least when its fate is already decided. 4p(1-p) peaks at
  // 1.0 for a 50% team and falls to ~0 for a lock or a dead team.
  const bubble = 4 * playoffOdds * (1 - playoffOdds);
  // One week is one of the remaining weeks; its influence dilutes with horizon.
  const share = 1 / Math.max(1, weeksRemaining);
  // Playoff probability converts to title probability at roughly the rate at
  // which a playoff team wins the bracket.
  const titleConversion = 0.35;
  return clamp(winProbDelta * bubble * share * (1 + titleConversion), -1, 1);
}
