/**
 * Trade engine.
 *
 * Two hard truths govern fantasy trading, and this engine is built around both:
 *
 *   1. A trade only helps you if it improves your STARTING LINEUP across the
 *      remaining weeks. Winning a trade on "total value" while your lineup does
 *      not change is losing.
 *
 *   2. A trade only happens if the other manager thinks they won. So we
 *      evaluate every package TWICE — once with our valuations, once with
 *      theirs, reconstructed from their revealed preferences — and surface only
 *      the packages where both sides gain. Those are the offers that get
 *      accepted. Everything else is a rejected email.
 *
 * The search covers 1-for-1, 2-for-1, 1-for-2 and 2-for-2 packages across every
 * roster in the league, pruned aggressively so a full-league sweep stays fast.
 */
import { optimalLineup } from './optimizer.mjs';
import { clamp, round } from '../util/stats.mjs';
import { POSITIONS } from './roster.mjs';

/**
 * Rest-of-season lineup strength: the expected optimal starting total, summed
 * over the remaining weeks. This is the objective both sides are scored on.
 */
export function lineupStrength(roster, rosterSlots, weeksRemaining = 10) {
  const { lineup, total } = optimalLineup(roster, rosterSlots, (p) => p.seasonMean ?? p.mean);
  // Depth matters: injuries happen, and a roster with no bench is fragile.
  const startingIds = new Set(lineup.filter((l) => l.player).map((l) => l.player.player_id));
  const bench = roster.filter((p) => !startingIds.has(p.player_id));
  const depth = bench
    .sort((a, b) => (b.seasonMean ?? b.mean) - (a.seasonMean ?? a.mean))
    .slice(0, 6)
    .reduce((a, p, i) => a + (p.seasonMean ?? p.mean) * (0.16 * Math.exp(-i * 0.35)), 0);
  return (total + depth) * weeksRemaining;
}

/**
 * Reconstruct how a RIVAL values a player, from their revealed preferences.
 *
 * This is the whole trick. Their board is not your board:
 *   - a box-score chaser overvalues whoever just erupted,
 *   - a manager with a positional bias overpays at that position,
 *   - everyone overvalues their own players (endowment effect) and overvalues
 *     name brands relative to current role.
 */
export function rivalValuation(player, profile, { leagueBaseline = 1 } = {}) {
  let v = player.seasonMean ?? player.mean ?? 0;

  // Positional bias, from their transaction history.
  v *= 1 + clamp((profile?.bias?.[player.pos] ?? 0) * 1.8, -0.25, 0.35);

  // Recency chasing: they price the last few weeks, not the season.
  const chase = profile?.chase ?? 0.3;
  if (player.recentDelta != null) {
    v *= 1 + chase * clamp(player.recentDelta, -0.5, 0.8) * 0.7;
  }

  // Name-brand inertia: draft capital keeps commanding respect long after the
  // role is gone. ADP is the cleanest available proxy for perceived value.
  if (player.adp != null) {
    const brand = clamp((120 - player.adp) / 120, -0.3, 1);
    v *= 1 + brand * 0.12;
  }

  // Disengaged managers barely differentiate at all.
  const engagement = profile?.engagement ?? 0.7;
  if (engagement < 0.35) v = v * 0.6 + (player.adp != null ? (200 - player.adp) / 12 : v) * 0.4;

  return v * leagueBaseline;
}

/** Endowment effect: managers demand a premium to give up what they already own. */
const ENDOWMENT = 1.12;

function packageValue(players, valuator) {
  return players.reduce((a, p) => a + valuator(p), 0);
}

/** Combinations of size k from an array (k <= 2 in practice). */
function combos(arr, k) {
  if (k === 1) return arr.map((a) => [a]);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    for (let jj = i + 1; jj < arr.length; jj++) out.push([arr[i], arr[jj]]);
  }
  return out;
}

/**
 * Search for mutually beneficial trades with one rival.
 *
 * @param {Object} p
 * @param {Array}  p.myRoster       my projections
 * @param {Array}  p.theirRoster    their projections
 * @param {Object} p.theirProfile   their behavioural dossier
 * @param {Array}  p.rosterSlots
 */
export function findTradesWith({
  myRoster, theirRoster, theirProfile, rosterSlots, weeksRemaining = 10,
  maxSend = 2, maxRecv = 2, candidateDepth = 9, limit = 8, keepBoth = true,
}) {
  // Prune BOTH sides to what each can actually afford to move.
  //
  // Taking the best player off a rival's roster regardless of their depth
  // produces offers that look great for us and are catastrophic for them —
  // strip a team's only tight end and their starting lineup has a hole every
  // week. Those offers never get accepted. Applying the same surplus logic to
  // their roster that we apply to our own is what surfaces the trades that are
  // genuinely good for both sides.
  const mySorted = [...myRoster].sort((a, b) => (b.seasonMean ?? b.mean) - (a.seasonMean ?? a.mean));
  const theirSorted = [...theirRoster].sort((a, b) => (b.seasonMean ?? b.mean) - (a.seasonMean ?? a.mean));
  const myCandidates = pruneCandidates(mySorted, rosterSlots, candidateDepth);
  const theirCandidates = pruneCandidates(theirSorted, rosterSlots, candidateDepth);

  const myBase = lineupStrength(myRoster, rosterSlots, weeksRemaining);
  const theirBase = lineupStrength(theirRoster, rosterSlots, weeksRemaining);

  const myValuator = (p) => p.seasonMean ?? p.mean ?? 0;
  const theirValuator = (p) => rivalValuation(p, theirProfile);

  const results = [];
  const sendSets = [];
  for (let k = 1; k <= maxSend; k++) sendSets.push(...combos(myCandidates, k));
  const recvSets = [];
  for (let k = 1; k <= maxRecv; k++) recvSets.push(...combos(theirCandidates, k));

  for (const send of sendSets) {
    const sendIds = new Set(send.map((p) => p.player_id));
    for (const recv of recvSets) {
      // Roster-size sanity: do not propose trades that leave either side short.
      if (Math.abs(send.length - recv.length) > 1) continue;

      const recvIds = new Set(recv.map((p) => p.player_id));
      // Roster limits are real. In an uneven trade the side receiving more
      // players must cut someone to stay legal, and the side receiving fewer
      // picks a free agent up. Ignoring that makes every 2-for-1 look like a
      // free win for the consolidating team and hides the actual cost.
      const myAfterRoster = trimToSize(
        [...myRoster.filter((p) => !sendIds.has(p.player_id)), ...recv], myRoster.length
      );
      const theirAfterRoster = trimToSize(
        [...theirRoster.filter((p) => !recvIds.has(p.player_id)), ...send], theirRoster.length
      );

      const myAfter = lineupStrength(myAfterRoster, rosterSlots, weeksRemaining);
      const myGain = myAfter - myBase;
      if (myGain <= 0.5) continue;   // must actually help me

      const theirAfter = lineupStrength(theirAfterRoster, rosterSlots, weeksRemaining);
      const theirRealGain = theirAfter - theirBase;

      // How THEY see it: their perceived value in vs their perceived value out,
      // with the endowment premium on what they are giving up.
      const theirValueOut = packageValue(recv, theirValuator) * ENDOWMENT;
      const theirValueIn = packageValue(send, theirValuator);
      const theirPerceivedGain = theirValueIn - theirValueOut;

      const acceptProb = acceptanceProbability({
        theirPerceivedGain, theirValueOut, profile: theirProfile,
        sizeMismatch: Math.abs(send.length - recv.length),
      });
      if (acceptProb < 0.06) continue;

      const winWin = theirRealGain > 0;
      results.push({
        send: send.map(brief),
        receive: recv.map(brief),
        myGain: round(myGain, 1),
        myGainPerWeek: round(myGain / weeksRemaining, 2),
        theirRealGain: round(theirRealGain, 1),
        theirPerceivedGain: round(theirPerceivedGain, 2),
        acceptProb: round(acceptProb, 3),
        expectedValue: round(myGain * acceptProb, 2),
        winWin,
        category: winWin ? 'win-win' : 'value-arbitrage',
        // A trade that genuinely helps both sides is worth more than its raw
        // expected value: it gets accepted, it does not need to be re-offered,
        // and it does not spend your credibility in the league. A trade that
        // only works because the counterparty misvalues a player is real edge,
        // but it is fragile — so it is ranked below, not hidden.
        rankScore: round(myGain * acceptProb * (winWin ? 1.4 : 0.75), 2),
        pitch: pitch({ send, recv, theirProfile, theirPerceivedGain, theirRealGain }),
      });
    }
  }

  // Do not return five variations of the same idea: keep the best offer for
  // each distinct package of players received.
  // Dedupe within each category separately so a flood of arbitrage offers can
  // never crowd out the win-win trades, which are the ones worth sending.
  const pick = (list) => {
    const seen = new Set();
    const out = [];
    for (const r of list.sort((a, b) => b.rankScore - a.rankScore)) {
      const k = r.receive.map((p) => p.player_id).sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  };
  const ww = pick(results.filter((r) => r.winWin));
  const arb = pick(results.filter((r) => !r.winWin));
  return keepBoth ? [...ww, ...arb] : [...ww, ...arb].slice(0, limit);
}

/**
 * Which players on a roster are realistically movable.
 *
 * Bench players always are. A starter is movable only when there is genuine
 * depth behind him at his position — trading a starter you cannot replace is
 * not a trade, it is a donation, and the same is true for the manager on the
 * other side of the table.
 */
function pruneCandidates(sortedRoster, rosterSlots, depth) {
  const { lineup } = optimalLineup(sortedRoster, rosterSlots, (p) => p.seasonMean ?? p.mean);
  const startingIds = new Set(lineup.filter((l) => l.player).map((l) => l.player.player_id));
  const posCount = {};
  for (const p of sortedRoster) posCount[p.pos] = (posCount[p.pos] ?? 0) + 1;
  // Minimum bodies a roster needs at each position to still field a lineup.
  const MIN_DEPTH = { QB: 2, RB: 4, WR: 5, TE: 2, K: 2, DEF: 2 };
  return sortedRoster
    .filter((p) => {
      const have = posCount[p.pos] ?? 0;
      if (!startingIds.has(p.player_id)) return true;              // bench: always movable
      return have >= (MIN_DEPTH[p.pos] ?? 3);                       // starter: only with depth
    })
    .slice(0, depth);
}

/**
 * Cut a roster back to its legal size by dropping the least valuable players,
 * or note the open slots when it is under-full. A roster below its limit is
 * left as-is: the empty spot is a waiver claim, and valuing it at zero is the
 * conservative assumption.
 */
function trimToSize(roster, size) {
  if (roster.length <= size) return roster;
  return [...roster]
    .sort((a, b) => (b.seasonMean ?? b.mean ?? 0) - (a.seasonMean ?? a.mean ?? 0))
    .slice(0, size);
}

const brief = (p) => ({
  player_id: p.player_id, name: p.name, pos: p.pos, nfl_team: p.nfl_team,
  mean: round(p.mean ?? 0, 1), seasonMean: round(p.seasonMean ?? p.mean ?? 0, 1),
});

/**
 * Probability a rival accepts, as a logistic function of their PERCEIVED gain
 * scaled by the size of what they are giving up, modulated by how engaged and
 * how trade-happy they are.
 */
export function acceptanceProbability({ theirPerceivedGain, theirValueOut, profile, sizeMismatch = 0 }) {
  const scale = Math.max(2, theirValueOut * 0.28);
  const x = theirPerceivedGain / scale;
  let p = 1 / (1 + Math.exp(-x * 1.6 + 0.9));   // needs a clear perceived win

  p *= 0.45 + 0.55 * clamp(profile?.tradeAppetite ?? 0.3, 0, 1) * 1.6;
  p *= 0.35 + 0.65 * clamp(profile?.engagement ?? 0.6, 0, 1);
  if (sizeMismatch > 0) p *= 0.82;              // consolidation is a harder sell
  return clamp(p, 0, 0.95);
}

function pitch({ send, recv, theirProfile, theirPerceivedGain, theirRealGain }) {
  const names = (a) => a.map((p) => p.name).join(' + ');
  const lines = [];
  lines.push(`Offer ${names(send)} for ${names(recv)}.`);
  if (theirPerceivedGain > 0) {
    lines.push(`They should read this as a win: on their own revealed valuations they come out ${theirPerceivedGain.toFixed(1)} ahead.`);
  }
  const arch = theirProfile?.archetype;
  if (arch?.key === 'chaser') lines.push('This manager buys recent production — lead the pitch with your player\'s last two box scores.');
  if (arch?.key === 'absentee') lines.push('This manager is disengaged; keep the offer simple and send a short message, or it will expire unread.');
  if (arch?.key === 'dealer') lines.push('This manager trades often and will counter — leave yourself room by opening slightly light.');
  if (arch?.key === 'spender') lines.push('This manager has spent their FAAB; they can only improve through trades, which is leverage for you.');
  if (theirRealGain > 0) lines.push('It genuinely helps them too, which is why it will get accepted.');
  else lines.push('It does not actually help them, but it fits how they value players — expect a counter.');
  return lines.join(' ');
}

/**
 * Sweep every rival roster in the league.
 *
 * Results come back in two clearly separated lists, because they are two
 * different kinds of move and conflating them is how you end up spamming your
 * league with offers nobody accepts:
 *
 *   winWin     — both sides genuinely improve. These get accepted, they cost
 *                you no credibility, and they are the ones to send first.
 *   arbitrage  — you gain and they do not, but their own revealed valuations
 *                say they will take it anyway. Real edge, lower hit rate, and
 *                you should know which kind you are sending.
 */
export function scanLeague({
  myRoster, rivals, rosterSlots, weeksRemaining = 10, limitPerRival = 4, limit = 15,
}) {
  const all = [];
  for (const rival of rivals) {
    if (rival.is_mine) continue;
    const found = findTradesWith({
      myRoster,
      theirRoster: rival.roster,
      theirProfile: rival.profile,
      rosterSlots,
      weeksRemaining,
      limit: limitPerRival,
    });
    for (const t of found) {
      all.push({
        ...t,
        team_key: rival.team_key,
        teamName: rival.name,
        manager: rival.manager,
        archetype: rival.profile?.archetype,
      });
    }
  }

  // Diversify across rivals: four variations of the same deal with one manager
  // is one idea, not four. Cap each rival's share of each board.
  const diversify = (list, perRival = 2) => {
    const seen = new Map();
    const out = [];
    for (const t of list.sort((a, b) => b.rankScore - a.rankScore)) {
      const n = seen.get(t.team_key) ?? 0;
      if (n >= perRival) continue;
      seen.set(t.team_key, n + 1);
      out.push(t);
    }
    return out;
  };
  const winWin = diversify(all.filter((t) => t.winWin));
  const arbitrage = diversify(all.filter((t) => !t.winWin));

  return {
    winWin: winWin.slice(0, limit),
    arbitrage: arbitrage.slice(0, limit),
    // Combined view, win-wins first, for callers that just want a single list.
    all: [...winWin, ...arbitrage].slice(0, limit),
    counts: { total: all.length, winWin: winWin.length, arbitrage: arbitrage.length },
  };
}

/**
 * Evaluate a specific proposed trade (e.g. one that landed in your inbox).
 * Answers the only question that matters: does accepting raise my rest-of-season
 * lineup strength, and by how much?
 */
export function evaluateOffer({ myRoster, send, receive, rosterSlots, weeksRemaining = 10 }) {
  const sendIds = new Set(send.map((p) => p.player_id));
  const before = lineupStrength(myRoster, rosterSlots, weeksRemaining);
  const after = lineupStrength(
    [...myRoster.filter((p) => !sendIds.has(p.player_id)), ...receive],
    rosterSlots, weeksRemaining
  );
  const delta = after - before;
  const perWeek = delta / weeksRemaining;
  let recommendation;
  if (perWeek > 1.5) recommendation = 'ACCEPT — a clear upgrade to your starting lineup.';
  else if (perWeek > 0.3) recommendation = 'LEAN ACCEPT — a modest but real improvement.';
  else if (perWeek > -0.3) recommendation = 'NEUTRAL — this is a lateral move; accept only if you prefer the roster shape.';
  else if (perWeek > -1.5) recommendation = 'LEAN REJECT — you lose lineup strength.';
  else recommendation = 'REJECT — this materially weakens your starting lineup.';
  return {
    before: round(before, 1),
    after: round(after, 1),
    delta: round(delta, 1),
    perWeek: round(perWeek, 2),
    recommendation,
  };
}
