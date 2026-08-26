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
import { positionalDemand, startingSlots, POSITIONS } from './roster.mjs';
import { softmax, clamp, mean, round } from '../util/stats.mjs';

/**
 * A single ordering for "who is realistically on the board".
 *
 * ADP is the best available signal for what opponents will do, but real ADP
 * data is sparse — it covers only players who were actually drafted, so a
 * mid-season free agent or an undrafted breakout has none. Sorting by ADP alone
 * pushes every such player to the back of the shortlist, where the opponent
 * model never touches them, so they "survive" every simulation and VONA
 * collapses to zero for their whole position.
 *
 * The composite rank takes the better of a player's ADP and his rank by our own
 * valuation, so a genuinely valuable player is always in contention regardless
 * of whether ADP knows about him.
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
    const vr = valueRank.get(p.player_id) ?? 999;
    const adp = Number.isFinite(p.adp) ? p.adp : Infinity;
    ranks.set(p.player_id, Math.min(adp, vr));
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
export function simulateForward(available, pickNumber, untilPick, opponents, rng, { poolSize = 70 } = {}) {
  // Real drafters pick from a short list, not from every rostered NFL player.
  // Sampling across the whole universe flattens the distribution so badly that
  // elite players "survive" every simulation and VONA collapses to zero.
  const pool = shortlist(available, Math.max(poolSize, (untilPick - pickNumber) * 3))
    .map((p) => ({ ...p }));
  const poolRanks = draftRanks(pool);
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
  const shortlistIds = new Set(
    shortlist(available, Math.max(70, (nextPickNumber - pickNumber) * 3)).map((p) => p.player_id)
  );
  const floorByPos = {};
  for (const p of available) {
    if (shortlistIds.has(p.player_id)) continue;
    if (!floorByPos[p.pos] || p.mean > floorByPos[p.pos]) floorByPos[p.pos] = p.mean;
    survival.set(p.player_id, sims); // never contested
  }

  for (let s = 0; s < sims; s++) {
    const { remaining } = simulateForward(available, pickNumber + 1, nextPickNumber, opponents, rng);
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
    const survive = survivalProb.get(p.player_id) ?? 0;
    const score = p.vor + v * 0.85 + needBonus + cliffBonus - risk;
    return {
      ...p,
      tier: tierOf.get(p.player_id) ?? 1,
      vona: v,
      needBonus,
      cliffBonus,
      risk,
      survivalToNextPick: survive,
      score,
      reasons: buildReasons(p, { v, needBonus, cliffBonus, risk, survive, levels, tiers: tierOf.get(p.player_id) }),
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

function riskPenalty(p) {
  let risk = 0;
  const s = (p.status || '').toUpperCase();
  if (s === 'Q') risk += 1.5;
  if (s === 'D') risk += 4;
  if (['O', 'IR', 'PUP', 'SUSP'].includes(s)) risk += 25;
  if ((p.games ?? 0) < 2) risk += 1.5;     // unproven role
  return risk;
}

function buildReasons(p, { v, needBonus, cliffBonus, risk, survive, levels, tiers }) {
  const out = [];
  out.push(`${p.pos}${p.posRank} · ${p.mean.toFixed(1)} proj vs ${(levels[p.pos] ?? 0).toFixed(1)} replacement = ${p.vor >= 0 ? '+' : ''}${p.vor.toFixed(1)} VOR`);
  if (v > 1.5) out.push(`Position falls off: only ${v.toFixed(1)} pts of ${p.pos} value survives to your next pick`);
  else if (v < 0.5) out.push(`${p.pos} is deep — you can wait, similar value will be there`);
  if (survive < 0.2) out.push(`Only ${(survive * 100).toFixed(0)}% chance he lasts to your next pick`);
  else if (survive > 0.6) out.push(`${(survive * 100).toFixed(0)}% likely to still be here next round — consider waiting`);
  if (needBonus > 0.5) out.push('Fills an unfilled starting slot');
  if (cliffBonus > 0) out.push(`Last player in tier ${tiers} — a cliff follows`);
  if (risk > 3) out.push(`Injury risk: designated ${p.status}`);
  return out;
}

/** Which starting slots remain unfilled on my roster, weighted by scarcity. */
export function rosterNeed(myRoster, rosterSlots) {
  const slots = startingSlots(rosterSlots);
  const counts = {};
  for (const p of myRoster) counts[p.pos] = (counts[p.pos] ?? 0) + 1;
  const required = {};
  for (const s of slots) {
    if (POSITIONS.includes(s)) required[s] = (required[s] ?? 0) + 1;
  }
  const need = {};
  for (const pos of POSITIONS) {
    need[pos] = Math.max(0, (required[pos] ?? 0) - (counts[pos] ?? 0));
  }
  // Flex slots create latent need across the flex-eligible positions.
  const flexCount = slots.filter((s) => !POSITIONS.includes(s)).length;
  const filled = Object.entries(counts).reduce((a, [pos, c]) => a + Math.max(0, c - (required[pos] ?? 0)), 0);
  const flexNeed = Math.max(0, flexCount - filled);
  for (const pos of ['RB', 'WR', 'TE']) need[pos] += flexNeed * 0.35;
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

/** The next pick after `current` belonging to the same slot. */
export function nextOwnPick(currentPick, slot, numTeams, rounds) {
  const picks = snakePicks(slot, numTeams, rounds);
  return picks.find((p) => p > currentPick) ?? currentPick + numTeams;
}
