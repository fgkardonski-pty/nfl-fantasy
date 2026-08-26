/**
 * Waiver wire and FAAB optimisation.
 *
 * The mistake nearly everyone makes on waivers is ranking free agents by
 * projected points. Projected points are not the question. The question is:
 *
 *   "If I add this player and drop my worst rosterable player, how much does my
 *    championship probability go up — and what is that worth in dollars, given
 *    that dollars spent now are not available in week 11?"
 *
 * That is what this module computes. A 14-point-per-game receiver is worth
 * nothing to you if you already start three better ones. A 9-point flex is
 * worth a quarter of your budget if it plugs the hole that is about to cost you
 * a playoff seed.
 */
import { all, get } from '../db/index.mjs';
import { clamp, round, mean } from '../util/stats.mjs';
import { optimalLineup } from './optimizer.mjs';
import { breakoutSignal, usageProfile } from './features.mjs';
import { predictBid } from './opponent.mjs';

/**
 * Marginal lineup value of adding a player: how much the optimal starting
 * lineup improves, averaged over the remaining weeks, after accounting for the
 * player you would drop.
 */
export function marginalLineupValue(myRoster, candidate, rosterSlots, { dropCandidate = null } = {}) {
  const before = optimalLineup(myRoster, rosterSlots, (p) => p.mean);
  const withAdd = dropCandidate
    ? [...myRoster.filter((p) => p.player_id !== dropCandidate.player_id), candidate]
    : [...myRoster, candidate];
  const after = optimalLineup(withAdd, rosterSlots, (p) => p.mean);
  return {
    before: before.total,
    after: after.total,
    delta: after.total - before.total,
    startsImmediately: after.lineup.some((l) => l.player?.player_id === candidate.player_id),
  };
}

/** The player on my roster I would least mind losing. */
export function worstDroppable(myRoster, rosterSlots, { protect = new Set() } = {}) {
  const base = optimalLineup(myRoster, rosterSlots, (p) => p.mean);
  const startingIds = new Set(base.lineup.filter((l) => l.player).map((l) => l.player.player_id));
  const droppable = myRoster.filter((p) => !startingIds.has(p.player_id) && !protect.has(p.player_id));
  if (!droppable.length) return null;
  // Rank by what the roster loses without them across the season, not this week
  // alone: a bye-week starter is not droppable just because he scores 0 today.
  return droppable.sort((a, b) => (a.seasonMean ?? a.mean) - (b.seasonMean ?? b.mean))[0];
}

/**
 * Rank the entire free-agent pool by value added to MY team.
 *
 * @param {Object} p
 * @param {Array}  p.freeAgents   projections for available players
 * @param {Array}  p.myRoster     projections for my current roster
 * @param {Array}  p.rosterSlots
 * @param {Array}  p.rivalProfiles opponent dossiers, for bid competition
 */
export function rankWaiverTargets({
  freeAgents, myRoster, rosterSlots, rivalProfiles = [], leagueKey, season, week,
  faabRemaining = 100, weeksRemaining = 10, playoffOdds = 0.5, limit = 25,
}) {
  const drop = worstDroppable(myRoster, rosterSlots);
  const ranked = freeAgents.map((fa) => {
    const mv = marginalLineupValue(myRoster, fa, rosterSlots, { dropCandidate: drop });

    // Opportunity signal — the part the rest of the league has not priced yet.
    const usage = usageProfile(fa.player_id, season, week - 1);
    const bo = breakoutSignal({
      pos: fa.pos, usage, pctOwned: fa.pctOwned ?? 0, pctChange: fa.pctChange ?? 0,
    });

    // Rest-of-season value, not just this week: a player who starts for you for
    // ten weeks is worth vastly more than a one-week streamer with the same
    // weekly projection.
    const persistence = clamp(0.35 + 0.65 * bo.share, 0.35, 1);
    const rosValue = mv.delta * weeksRemaining * persistence;

    // Convert points into championship probability. A point of weekly lineup
    // improvement is worth most on the playoff bubble — but never nothing: a
    // team already locked into the playoffs still has to WIN the bracket, and a
    // dead team still improves its odds by getting better. The floor keeps a
    // 100%-playoff-odds contender from valuing every upgrade at zero.
    const bubble = 4 * playoffOdds * (1 - playoffOdds);
    const leverage = 0.45 + 0.55 * bubble;
    const titleDelta = clamp(rosValue * 0.0016 * leverage, 0, 0.35);

    // How hard will the league fight for him?
    const competition = bidCompetition(fa, rivalProfiles);

    const bid = optimalBid({
      titleDelta, faabRemaining, weeksRemaining, competition,
      startsImmediately: mv.startsImmediately,
    });

    return {
      ...fa,
      marginalWeekly: round(mv.delta, 2),
      startsImmediately: mv.startsImmediately,
      rosValue: round(rosValue, 1),
      titleDelta: round(titleDelta, 4),
      breakout: round(bo.score, 3),
      breakoutDetail: bo,
      competition,
      bid,
      dropSuggestion: drop ? { player_id: drop.player_id, name: drop.name, pos: drop.pos } : null,
      verdict: verdict({ mv, bo, bid, titleDelta }),
    };
  });

  return ranked
    .sort((a, b) => b.titleDelta - a.titleDelta || b.rosValue - a.rosValue)
    .slice(0, limit);
}

/**
 * How much competition to expect for this player, and the highest bid we should
 * expect to have to beat.
 */
export function bidCompetition(player, rivalProfiles) {
  const bids = [];
  for (const prof of rivalProfiles) {
    if (prof.is_mine) continue;
    // Rough desire proxy: positional bias plus how much the market is moving.
    const desire = clamp(
      0.35 + 2.5 * (prof.bias?.[player.pos] ?? 0) + clamp((player.pctChange ?? 0) / 25, 0, 0.5),
      0.05, 1.2
    );
    const b = predictBid(prof, player, desire / 3.2);
    if (b && b.amount > 0) bids.push({ team: prof.name, team_key: prof.team_key, amount: b.amount, archetype: prof.archetype?.label });
  }
  bids.sort((a, b) => b.amount - a.amount);
  return {
    contenders: bids.slice(0, 4),
    topRivalBid: bids.length ? bids[0].amount : 0,
    expectedRivals: bids.filter((b) => b.amount > 0).length,
  };
}

/**
 * Optimal FAAB bid.
 *
 * Budget is a depleting resource with an option value: dollars kept are dollars
 * available for the injury that has not happened yet. We therefore bid the
 * player's value to us, capped by a fraction of remaining budget that shrinks
 * with the number of weeks still to come, and shaded just past the highest bid
 * we expect a rival to make.
 */
export function optimalBid({
  titleDelta, faabRemaining, weeksRemaining, competition, startsImmediately,
}) {
  if (faabRemaining <= 0) {
    return { amount: 0, ceiling: 0, rationale: 'No FAAB remaining — this is a waiver-priority or free-agent claim only.' };
  }
  // Value-based ceiling: what fraction of the budget this player's title impact
  // justifies. A move worth +5 percentage points of title odds is worth a lot.
  const valueFraction = clamp(titleDelta / 0.08, 0, 0.75);

  // Option value of holding budget: never spend it all before the deadline.
  const horizonReserve = clamp(0.10 + 0.25 * (weeksRemaining / 14), 0.10, 0.35);
  const spendable = faabRemaining * (1 - horizonReserve);

  let amount = Math.round(spendable * valueFraction);

  // Shade past the expected top rival bid when the player is worth having.
  const rival = competition?.topRivalBid ?? 0;
  if (titleDelta > 0.004 && rival > 0) {
    const shaded = Math.round(rival * 1.15) + 1;
    if (shaded <= spendable) amount = Math.max(amount, shaded);
  }
  if (startsImmediately) amount = Math.max(amount, Math.round(faabRemaining * 0.03));
  amount = Math.round(clamp(amount, 0, faabRemaining));

  const rationale = [];
  if (valueFraction > 0.3) rationale.push(`worth ${(titleDelta * 100).toFixed(2)} pts of title odds — a genuine season-changer`);
  else if (titleDelta > 0.004) rationale.push(`moves title odds ${(titleDelta * 100).toFixed(2)} pts`);
  else rationale.push('marginal value — not worth real budget');
  if (rival > 0 && amount > rival) rationale.push(`expect a rival bid near $${rival}; $${amount} clears it`);
  else if (rival > 0 && amount > 0) rationale.push(`a rival may bid ~$${rival}; $${amount} is what he is worth to you, do not chase past it`);
  else if (rival > 0) rationale.push(`rivals may bid ~$${rival} — let them have him`);
  if (amount > 0) rationale.push(`holding $${Math.round(faabRemaining * horizonReserve)} in reserve for the next ${weeksRemaining} weeks`);

  return {
    amount,
    ceiling: Math.round(spendable),
    pctOfBudget: faabRemaining ? round(amount / faabRemaining, 3) : 0,
    rationale: rationale.join('; '),
  };
}

function verdict({ mv, bo, bid, titleDelta }) {
  if (mv.startsImmediately && titleDelta > 0.01) {
    return { level: 'priority', text: 'PRIORITY CLAIM — starts for you immediately and materially moves your title odds.' };
  }
  if (bo.score > 0.35 && (bo.unpriced ?? 0) > 0.5) {
    return { level: 'speculative', text: 'BUY THE ROLE — the usage has changed and the league has not noticed yet. This is the window.' };
  }
  if (titleDelta > 0.004) return { level: 'add', text: 'Worth adding: a real upgrade over your worst bench spot.' };
  if (mv.delta > 0) return { level: 'stream', text: 'Streaming option only — useful this week, not worth budget.' };
  return { level: 'pass', text: 'Pass. Does not improve your lineup.' };
}

/**
 * Standalone breakout scanner across the whole player universe — the players
 * whose ROLE changed, regardless of whether they are on your radar.
 */
export function breakoutScan({ players, season, week, ownership = new Map(), limit = 20 }) {
  const out = [];
  for (const p of players) {
    // Kickers and defenses have no meaningful "opportunity share" — their snap
    // share is 100% by definition, which would otherwise make them permanently
    // top the breakout board and drown out the players this scan exists to find.
    if (p.pos === 'K' || p.pos === 'DEF') continue;
    const usage = usageProfile(p.player_id, season, week - 1);
    if (!usage.games) continue;
    const own = ownership.get(p.player_id) ?? { pct_owned: 0, pct_change: 0 };
    const bo = breakoutSignal({
      pos: p.pos, usage, pctOwned: own.pct_owned ?? 0, pctChange: own.pct_change ?? 0,
    });
    if (bo.score <= 0.12) continue;
    out.push({
      player_id: p.player_id, name: p.name, pos: p.pos, nfl_team: p.nfl_team,
      score: round(bo.score, 3),
      share: round(bo.share, 3),
      momentum: round(bo.momentum, 3),
      pctOwned: own.pct_owned ?? 0,
      signal: describeBreakout(p, usage, bo),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function describeBreakout(p, usage, bo) {
  const bits = [];
  const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
  if ((usage.snap_pct_trend ?? 0) > 0.08) bits.push(`snap share climbing (now ${pct(usage.snap_pct)})`);
  if (p.pos !== 'RB' && (usage.target_share_trend ?? 0) > 0.08) bits.push(`target share climbing (now ${pct(usage.target_share)})`);
  if (p.pos === 'RB' && (usage.rush_share_trend ?? 0) > 0.08) bits.push(`carry share climbing (now ${pct(usage.rush_share)})`);
  if ((usage.rz_touches ?? 0) > 2) bits.push(`${usage.rz_touches.toFixed(1)} red-zone touches per game`);
  if (bo.unpriced > 0.7) bits.push(`still only ${Math.round((1 - bo.unpriced) * 100)}% rostered`);
  return bits.length ? bits.join(', ') : `opportunity score ${pct(bo.share)}`;
}
