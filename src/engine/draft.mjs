/**
 * Draft engine.
 *
 * The draft is the single highest-leverage day of the fantasy season, and it is
 * the one place where almost everyone plays badly: they draft the highest
 * player on a list, ignoring both what the list will look like when their next
 * pick comes around and what the other eleven humans in the room are about to
 * do.
 *
 * This engine fixes both:
 *
 *   VONA (Value of Next Available) — for every position, simulate the draft
 *   forward to your next pick using an opponent model, and measure what you
 *   would realistically still be able to get. The correct pick maximises
 *   (value now) − (value still available later), NOT (value now). That is what
 *   turns "best player available" into "best pick available".
 *
 *   Opponent modelling — rivals do not draft off your board. They draft near
 *   ADP, they chase positional runs, and they have team-specific biases the
 *   platform learns from their past drafts and transactions.
 */
import { Rng } from '../util/rng.mjs';
import { computeVor, tierize, tierSummary, scarcity } from './vor.mjs';
import { positionalDemand, POSITIONS } from './roster.mjs';
import { softmax, clamp, mean, round } from '../util/stats.mjs';

/**
 * The order the OPPONENTS will draft in — not the order we would.
 *
 * This is the single most important distinction in the whole engine, and
 * getting it wrong destroys the edge it exists to find. The rivals in the room
 * do not share our valuation. They draft near public consensus, so where a
 * player has a real ADP, that ADP is what predicts when he leaves the board.
 *
 * The previous version took the BETTER of ADP and our own valuation rank. The
 * intent was sound — a player with no ADP would otherwise sit at the back of
 * the shortlist, never be taken by the model, and appear to survive every
 * simulation, collapsing VONA for his whole position. But applying it to
 * players who DO have an ADP asserts that opponents value players exactly as we
 * do, which is precisely false whenever our valuation is most useful.
 *
 * In a league whose scoring makes quarterbacks far more valuable than the
 * public consensus does, it went badly wrong. A quarterback with an ADP of 55
 * was ranked 1st, so the model had fifteen rivals fighting over him, reported
 * an 18% chance he survived twenty-five picks, and urged taking him
 * immediately. In reality nobody else in that room wants him yet — he is
 * available a full two rounds later, and the entire advantage lies in knowing
 * that and spending the early pick elsewhere.
 *
 * So: a real ADP is used as it stands. Our valuation fills in ONLY where the
 * market has no opinion at all, which is the case the fallback was written for.
 */
export function draftRanks(available) {
  // Rank by VALUE OVER REPLACEMENT where we have it, not raw projected points.
  // Raw points rank every quarterback above every running back, which would
  // fill the realistic-draft shortlist with quarterbacks and model a draft
  // room that has never existed.
  const key = (p) => (p.vor !== undefined ? p.vor : (p.mean ?? 0));
  const byValue = [...available].sort((a, b) => key(b) - key(a));
  const valueRank = new Map(byValue.map((p, i) => [p.player_id, i + 1]));
  const ranks = new Map();
  for (const p of available) {
    const adp = Number.isFinite(p.adp) ? p.adp : null;
    ranks.set(p.player_id, adp ?? valueRank.get(p.player_id) ?? 999);
  }
  return ranks;
}

/** The players an opponent would realistically consider at this point. */
export function shortlist(available, size) {
  const ranks = draftRanks(available);
  return [...available]
    .sort((a, b) => ranks.get(a.player_id) - ranks.get(b.player_id))
    .slice(0, size);
}

/**
 * Everything a run of simulations can share.
 *
 * The shortlist and its rank map depend only on the available pool, so they are
 * built once and handed to every simulation. Ranks are keyed by player_id and
 * the per-simulation pool is a fresh shallow copy, so the shared map stays
 * valid even as each simulation splices players out of its own copy.
 */
export function prepareSimulation(available, size) {
  const pool = shortlist(available, size);
  return { pool, ranks: draftRanks(pool) };
}

/**
 * Probability that a given available player is taken at a given pick by an
 * opponent, given ADP, positional run pressure, and that opponent's bias.
 */
function opponentPickWeights(available, pickNumber, { runPressure = {}, bias = {}, adpNoise = 9, ranks = null }) {
  const rank = ranks ?? draftRanks(available);
  return available.map((p) => {
    // Use the composite rank, not raw ADP. Opponents mostly follow consensus,
    // but they are not blind: a player whose role has changed since draft day
    // does get taken well ahead of his stale ADP, and a model that never takes
    // him reports zero opportunity cost for waiting, which is the opposite of
    // the truth.
    const adp = rank.get(p.player_id) ?? p.adp ?? 200;
    // Distance from ADP in picks; managers overwhelmingly draft near consensus.
    const z = (pickNumber - adp) / adpNoise;
    // Logistic-ish: strongly disfavoured well before ADP, near-certain well after.
    let w = Math.exp(-0.5 * Math.max(0, -z) ** 2) * (1 + 0.35 * clamp(z, 0, 3));
    w *= 1 + (runPressure[p.pos] ?? 0) * 0.6;   // positional run momentum
    w *= 1 + (bias[p.pos] ?? 0);                // this manager's tendencies
    return Math.max(1e-6, w);
  });
}

/**
 * Simulate the draft forward from `pickNumber` to `untilPick`, returning the
 * board as it would realistically look when you are back on the clock.
 */
export function simulateForward(available, pickNumber, untilPick, opponents, rng, { poolSize = 70, prepared = null } = {}) {
  // Real drafters pick from a short list, not from every rostered NFL player.
  // Sampling across the whole universe flattens the distribution so badly that
  // elite players "survive" every simulation and VONA collapses to zero.
  //
  // `prepared` lets a caller running many simulations build that shortlist once
  // and reuse it. It depends only on `available`, which does not change between
  // simulations, so recomputing it per run sorted the entire player universe
  // hundreds of times over — the single largest cost in producing a pick, and
  // pure waste. Callers that do not pass it get the same result, just slower.
  const base = prepared ?? prepareSimulation(available, Math.max(poolSize, (untilPick - pickNumber) * 3));
  const pool = base.pool.map((p) => ({ ...p }));
  const poolRanks = base.ranks;
  const runPressure = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
  const taken = [];
  for (let pick = pickNumber; pick < untilPick && pool.length; pick++) {
    const opp = opponents[(pick - 1) % Math.max(1, opponents.length)] ?? {};
    const weights = opponentPickWeights(pool, pick, { runPressure, bias: opp.bias ?? {}, ranks: poolRanks });
    // Temperature below 1 sharpens the distribution: real drafts are noisy but
    // they are not close to uniform, and a flat softmax here would make every
    // elite player appear to survive to your next pick.
    const probs = softmax(weights.map((w) => Math.log(w)), 0.55);
    const idx = rng.weightedIndex(probs);
    const [picked] = pool.splice(idx, 1);
    taken.push(picked);
    // Runs build momentum and decay.
    for (const pos of POSITIONS) runPressure[pos] *= 0.75;
    runPressure[picked.pos] = (runPressure[picked.pos] ?? 0) + 0.5;
  }
  return { remaining: pool, taken };
}

/**
 * Value of Next Available.
 *
 * For each position, the expected best available projection at that position
 * when your NEXT pick arrives. The difference between what you can take now and
 * this number is the true cost of waiting.
 */
export function computeVona(available, { pickNumber, nextPickNumber, opponents, sims = 300, seed = 5 }) {
  const rng = new Rng(seed);
  const bestLater = Object.fromEntries(POSITIONS.map((p) => [p, []]));
  const survival = new Map(available.map((p) => [p.player_id, 0]));

  // Players outside the realistic draft shortlist are never taken by the
  // opponent model, so they survive with probability 1 and set the floor for
  // "best still available later".
  const size = Math.max(70, (nextPickNumber - pickNumber) * 3);
  const prepared = prepareSimulation(available, size);
  const shortlistIds = new Set(prepared.pool.map((p) => p.player_id));
  const floorByPos = {};
  for (const p of available) {
    if (shortlistIds.has(p.player_id)) continue;
    if (!floorByPos[p.pos] || p.mean > floorByPos[p.pos]) floorByPos[p.pos] = p.mean;
    survival.set(p.player_id, sims); // never contested
  }

  for (let s = 0; s < sims; s++) {
    const { remaining } = simulateForward(
      available, pickNumber + 1, nextPickNumber, opponents, rng, { prepared }
    );
    const byPos = {};
    for (const p of remaining) {
      if (!byPos[p.pos] || p.mean > byPos[p.pos].mean) byPos[p.pos] = p;
      if (shortlistIds.has(p.player_id)) survival.set(p.player_id, (survival.get(p.player_id) ?? 0) + 1);
    }
    for (const pos of POSITIONS) {
      bestLater[pos].push(Math.max(byPos[pos]?.mean ?? 0, floorByPos[pos] ?? 0));
    }
  }

  const vona = {};
  for (const pos of POSITIONS) {
    const nowBest = Math.max(0, ...available.filter((p) => p.pos === pos).map((p) => p.mean));
    const later = mean(bestLater[pos]);
    vona[pos] = { now: nowBest, expectedLater: later, vona: nowBest - later };
  }
  const survivalProb = new Map(
    [...survival.entries()].map(([id, c]) => [id, c / sims])
  );
  return { vona, survivalProb };
}

/**
 * The pick recommendation.
 *
 * Score = VOR (value over replacement, in this league's scoring)
 *       + VONA (what you lose by waiting at this position)
 *       + roster-need bonus (starting slots you have not filled)
 *       − risk penalty (injury designation, thin sample)
 *       + tier-cliff bonus (last player in a tier before a drop)
 */
export function recommendPick({
  available, myRoster, rosterSlots, numTeams, pickNumber, nextPickNumber,
  opponents = [], sims = 300, seed = 11, limit = 12,
}) {
  const { players: valued, levels, meta } = computeVor(available, rosterSlots, numTeams);

  // How many bench slots there are decides how many bye collisions are
  // absorbable before one actually costs a starting spot.
  const benchDepth = (Array.isArray(rosterSlots) ? rosterSlots : [])
    .filter((s) => String(s?.slot ?? s).toUpperCase() === 'BN')
    .reduce((a, s) => a + (Number(s?.count) || 1), 0) || 5;

  // Tier WITHIN each position. A global tier list bands quarterbacks against
  // kickers, which is arithmetically valid and completely useless to a drafter:
  // what you need to see is the cliff at YOUR position.
  const tierOf = new Map();
  const lastInTier = new Set();
  const tiersByPos = {};
  for (const pos of POSITIONS) {
    const posPlayers = valued.filter((p) => p.pos === pos);
    if (!posPlayers.length) continue;
    const tiered = tierize(posPlayers);
    for (const p of tiered) tierOf.set(p.player_id, p.tier);
    const summary = tierSummary(tiered);
    tiersByPos[pos] = summary;
    for (const t of summary) {
      if (t.players.length) lastInTier.add(t.players[t.players.length - 1].player_id);
    }
  }
  const tiers = tiersByPos;

  const { vona, survivalProb } = computeVona(valued, {
    pickNumber, nextPickNumber, opponents, sims, seed,
  });

  // What does my roster still need?
  const need = rosterNeed(myRoster, rosterSlots);

  const scored = valued.map((p) => {
    const v = vona[p.pos]?.vona ?? 0;
    const needBonus = (need[p.pos] ?? 0) * Math.max(2, levels[p.pos] * 0.12);
    const cliffBonus = lastInTier.has(p.player_id) ? Math.max(1, (p.mean - levels[p.pos]) * 0.08) : 0;
    const risk = riskPenalty(p);
    const byePenalty = byeCollisionPenalty(p, myRoster, benchDepth);
    const survive = survivalProb.get(p.player_id) ?? 0;
    // Production, and what waiting costs, are both worth only what this roster
    // can use. Roster NEED stays outside the discount: it is about the slot,
    // not the player, and discounting it would double-count the same fact.
    const fit = rosterFit(p.pos, myRoster, rosterSlots, numTeams);
    const score = (p.vor + v * 0.85 + cliffBonus) * fit + needBonus - risk - byePenalty;
    return {
      ...p,
      tier: tierOf.get(p.player_id) ?? 1,
      vona: v,
      needBonus,
      cliffBonus,
      risk,
      byePenalty,
      fit,
      survivalToNextPick: survive,
      score,
      reasons: buildReasons(p, { v, needBonus, cliffBonus, risk, byePenalty, fit, survive, levels, tiers: tierOf.get(p.player_id) }),
    };
  }).sort((a, b) => b.score - a.score);

  return {
    board: scored.slice(0, limit),
    all: scored,
    vona,
    need,
    tiers,
    replacementLevels: levels,
    replacementMeta: meta,
    scarcity: scarcity(available, levels),
  };
}

/**
 * How much of a player's value THIS roster can actually use.
 *
 * VOR answers "how much better is he than a replacement-level starter", and
 * that is the right question only while he would in fact start. Once the slots
 * his position can fill are taken, he is a bench player, and a bench player's
 * contribution is a fraction of what he would produce starting.
 *
 * Nothing expressed this before. Roster need ADDED for an empty slot but
 * nothing SUBTRACTED for a full one, so a second quarterback in a
 * one-quarterback league kept the whole of a starter's value and could
 * outrank a running back at a position still completely unfilled. That is
 * backwards: he would sit on the bench all season.
 *
 * How much a bench player is worth depends entirely on the position:
 *
 *   RB, WR   Real value. Injuries are constant and flex slots are hungry, so
 *            depth here starts games most weeks of the season.
 *   TE       Some. One starting slot, occasionally flex-eligible.
 *   QB       Little in a one-QB league. The backup plays during a bye or an
 *            injury, and a streamed free agent covers that nearly as well.
 *   K, DEF   Almost none. Both are streamed off waivers week to week; a second
 *            one is a wasted roster spot.
 *
 * Demand is taken from the league's own slots, so a superflex or two-QB league
 * raises the quarterback ceiling on its own rather than needing a special case.
 */
const BENCH_VALUE = { RB: 0.65, WR: 0.60, TE: 0.35, QB: 0.25, K: 0.10, DEF: 0.15 };

export function rosterFit(pos, myRoster, rosterSlots, numTeams) {
  const { perTeam } = positionalDemand(rosterSlots, numTeams);
  // How many of this position this roster can actually start, counting the
  // share of the flex slots that realistically goes to it.
  const startable = perTeam[pos] ?? 1;
  const have = (myRoster ?? []).filter((p) => p.pos === pos).length;

  // How far past startable this pick would put me. Fractional on purpose:
  // demand for flex-eligible positions is fractional, so the discount arrives
  // gradually as a position fills rather than snapping on at a threshold.
  const surplus = Math.max(0, (have + 1) - startable);
  if (surplus <= 0) return 1;
  return (BENCH_VALUE[pos] ?? 0.4) ** surplus;
}

/**
 * Cost of stacking another starter onto a bye week I already have covered.
 *
 * Deliberately small. Drafting two starters who bye in the same week is a real
 * cost but a narrow one: it is a single week out of the season, and only the
 * players beyond what the bench can cover actually hurt. Sized as a tiebreaker,
 * because a manager who passes on a clearly better player to dodge a bye
 * collision has made the worse decision — which is exactly the mistake an
 * over-weighted penalty would encourage.
 *
 * Scaled by the player's own VOR: colliding two elite starters costs more than
 * colliding two marginal ones, because that is whose production goes missing.
 */
const SEASON_WEEKS = 14;

export function byeCollisionPenalty(p, myRoster, benchDepth = 5) {
  const bye = Number(p.bye_week);
  if (!Number.isFinite(bye) || bye <= 0) return 0;
  const clash = myRoster.filter((r) => Number(r.bye_week) === bye).length;
  // The first player on any given bye is free — everyone has a bye somewhere,
  // and a bench of this depth absorbs the early collisions.
  const uncovered = Math.max(0, clash - Math.max(1, Math.round(benchDepth / 3)));
  if (uncovered <= 0) return 0;
  return (Math.max(0, p.vor ?? 0) / SEASON_WEEKS) * Math.min(uncovered, 3);
}

function riskPenalty(p) {
  let risk = 0;
  const s = (p.status || '').toUpperCase();
  if (s === 'Q') risk += 1.5;
  if (s === 'D') risk += 4;
  if (['O', 'IR', 'PUP', 'SUSP'].includes(s)) risk += 25;
  if ((p.games ?? 0) < 2) risk += 1.5;     // unproven role
  return risk;
}

function buildReasons(p, { v, needBonus, cliffBonus, risk, byePenalty, fit, survive, levels, tiers }) {
  const out = [];
  out.push(`${p.pos}${p.posRank} · ${p.mean.toFixed(1)} proj vs ${(levels[p.pos] ?? 0).toFixed(1)} replacement = ${p.vor >= 0 ? '+' : ''}${p.vor.toFixed(1)} VOR`);
  if (fit < 0.95) {
    out.push(
      `Your ${p.pos} slots are filled — he would be a bench player, so only `
      + `${Math.round(fit * 100)}% of that value is usable (${(p.vor * fit).toFixed(1)})`
    );
  }
  if (v > 1.5) out.push(`Position falls off: only ${v.toFixed(1)} pts of ${p.pos} value survives to your next pick`);
  else if (v < 0.5) out.push(`${p.pos} is deep — you can wait, similar value will be there`);
  if (survive < 0.2) out.push(`Only ${(survive * 100).toFixed(0)}% chance he lasts to your next pick`);
  else if (survive > 0.6) out.push(`${(survive * 100).toFixed(0)}% likely to still be here next round — consider waiting`);
  if (needBonus > 0.5) out.push('Fills an unfilled starting slot');
  if (cliffBonus > 0) out.push(`Last player in tier ${tiers} — a cliff follows`);
  if (risk > 3) out.push(`Injury risk: designated ${p.status}`);
  if (byePenalty > 0) out.push(`Bye-week stack: more starters already off in week ${p.bye_week} than the bench covers`);
  return out;
}

/** Which starting slots remain unfilled on my roster, weighted by scarcity. */
export function rosterNeed(myRoster, rosterSlots) {
  // Demand comes from positionalDemand, which reads each flex slot's actual
  // eligibility. The previous version spread flex demand evenly over RB, WR and
  // TE with a flat constant, which is only right for a league whose flex is
  // W/R/T. Given a W/T and a W/R — where a back cannot fill the first, a tight
  // end cannot fill the second, and a receiver fills either — it overstated
  // tight ends by half and understated receivers by a quarter. Replacement
  // levels already used the correct figures, so the engine was disagreeing with
  // itself about the same league, and roster need drives what gets drafted.
  const { perTeam } = positionalDemand(rosterSlots, 1);
  const counts = {};
  for (const p of myRoster ?? []) counts[p.pos] = (counts[p.pos] ?? 0) + 1;
  const need = {};
  for (const pos of POSITIONS) {
    need[pos] = Math.max(0, (perTeam[pos] ?? 0) - (counts[pos] ?? 0));
  }
  return need;
}

/**
 * Snake-draft pick numbers for a given slot.
 * @returns {number[]} overall pick numbers belonging to `slot` (1-indexed)
 */
export function snakePicks(slot, numTeams, rounds) {
  const picks = [];
  for (let r = 1; r <= rounds; r++) {
    const inRound = r % 2 === 1 ? slot : numTeams - slot + 1;
    picks.push((r - 1) * numTeams + inRound);
  }
  return picks;
}

/**
 * The next pick that OPPONENTS get to choose before.
 *
 * At the turn of a snake — the first and last seats — two picks are
 * consecutive: seat sixteen of sixteen picks at 16 and 17 with nobody in
 * between. Measuring the horizon as "my next pick" then spans a single pick
 * during which nothing can be taken from me, so every player survives, every
 * VONA is zero, and the board loses its entire notion of scarcity. For a turn
 * seat that happens at EVERY round, so half the draft is advised blind.
 *
 * Back-to-back picks are one decision, not two. The horizon that matters is the
 * next pick I hold after opponents have actually had a say, so a run of
 * consecutive own picks is walked past first.
 */
export function nextContestedPick(currentPick, slot, numTeams, rounds) {
  const picks = snakePicks(slot, numTeams, rounds);
  const mine = new Set(picks);
  let end = currentPick;
  while (mine.has(end + 1)) end++;
  return picks.find((p) => p > end) ?? end + numTeams;
}
