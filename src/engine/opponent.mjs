/**
 * Opponent modelling.
 *
 * Your league is not a contest against projections. It is a contest against
 * eleven people, and people are enormously predictable. Every one of them leaves
 * a complete behavioural record in the transaction log: what they bid, when they
 * bid it, what positions they hoard, whether they chase last week's box score,
 * whether they panic-drop after one bad game, and whether they have quietly
 * stopped paying attention in November.
 *
 * This module turns that log into a dossier per manager, and then uses the
 * dossier to answer the two questions that actually win leagues:
 *
 *   "What is this manager going to do this week?"   (so you get there first)
 *   "What will this manager accept in a trade?"     (so your offer gets taken)
 */
import { all, get, j } from '../db/index.mjs';
import { clamp, mean, round, softmax, zscores } from '../util/stats.mjs';
import { POSITIONS, startingSlots, eligiblePositions } from './roster.mjs';

const WEEK_MS = 7 * 864e5;

/**
 * Build the behavioural profile for one manager from their transaction history.
 */
export function buildProfile(leagueKey, teamKey, { season, currentWeek, now = Date.now() } = {}) {
  const team = get('SELECT * FROM teams WHERE league_key = ? AND team_key = ?', [leagueKey, teamKey]);
  if (!team) return null;

  const txns = all(
    `SELECT * FROM transactions WHERE league_key = ? AND team_key = ? ORDER BY ts ASC`,
    [leagueKey, teamKey]
  );
  const adds = txns.filter((t) => t.movement === 'add');
  const drops = txns.filter((t) => t.movement === 'drop');
  const trades = txns.filter((t) => t.type === 'trade');
  const bids = adds.map((t) => Number(t.faab_bid)).filter((b) => Number.isFinite(b) && b > 0);

  const weeksElapsed = Math.max(1, currentWeek - 1);
  const addsPerWeek = adds.length / weeksElapsed;

  // --- Aggression -----------------------------------------------------------
  // How often they touch the wire relative to a typical manager (~1 add/week).
  const aggression = clamp(addsPerWeek / 2.0, 0, 1);

  // --- FAAB behaviour -------------------------------------------------------
  const budget = Number(team.faab_remaining ?? 100);
  const spent = bids.reduce((a, b) => a + b, 0);
  const startingBudget = spent + budget;
  const spendRate = startingBudget > 0 ? spent / startingBudget : 0;
  const seasonProgress = clamp(weeksElapsed / 13, 0, 1);
  // >1 means they are burning budget faster than the calendar.
  const burnRatio = seasonProgress > 0.05 ? spendRate / seasonProgress : 1;
  const maxBid = bids.length ? Math.max(...bids) : 0;
  const avgBid = bids.length ? mean(bids) : 0;

  // --- Positional bias ------------------------------------------------------
  const posCounts = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
  let posTotal = 0;
  for (const a of adds) {
    const p = get('SELECT pos FROM players WHERE player_id = ?', [a.player_id]);
    if (!p) continue;
    if (posCounts[p.pos] === undefined) continue;
    posCounts[p.pos] += 1;
    posTotal += 1;
  }
  const bias = {};
  const leagueBaseline = { QB: 0.10, RB: 0.32, WR: 0.32, TE: 0.12, K: 0.07, DEF: 0.07 };
  for (const pos of POSITIONS) {
    const share = posTotal ? posCounts[pos] / posTotal : leagueBaseline[pos];
    bias[pos] = round(share - leagueBaseline[pos], 3);
  }

  // --- Recency chasing ------------------------------------------------------
  // Did the players they added just have a big week? A manager who only ever
  // adds last week's top performers is trivially front-runnable.
  const chase = recencyChasing(leagueKey, adds, season);

  // --- Panic dropping -------------------------------------------------------
  // Drops of players who were added less than 3 weeks earlier.
  const addTimes = new Map();
  for (const a of adds) addTimes.set(a.player_id, Number(a.ts));
  let quickDrops = 0;
  for (const d of drops) {
    const t = addTimes.get(d.player_id);
    if (t && Number(d.ts) - t < 3 * WEEK_MS) quickDrops += 1;
  }
  const panic = drops.length ? clamp(quickDrops / drops.length, 0, 1) : 0;

  // --- Engagement -----------------------------------------------------------
  const lastActivity = txns.length ? Number(txns[txns.length - 1].ts) : 0;
  const daysSinceActive = lastActivity ? (now - lastActivity) / 864e5 : 999;
  const engagement = clamp(1 - daysSinceActive / 21, 0, 1);

  // --- Trading --------------------------------------------------------------
  const tradeAppetite = clamp((trades.length / Math.max(1, weeksElapsed)) / 0.4, 0, 1);

  return {
    league_key: leagueKey,
    team_key: teamKey,
    name: team.name,
    manager: team.manager,
    is_mine: !!team.is_mine,
    record: { wins: team.wins, losses: team.losses, ties: team.ties, pf: team.points_for, pa: team.points_against },
    counts: { adds: adds.length, drops: drops.length, trades: trades.length },
    aggression: round(aggression, 3),
    faab: {
      remaining: budget,
      startingBudget,
      spent,
      spendRate: round(spendRate, 3),
      burnRatio: round(burnRatio, 2),
      maxBid,
      avgBid: round(avgBid, 1),
      bids,
    },
    bias,
    chase: round(chase, 3),
    panic: round(panic, 3),
    engagement: round(engagement, 3),
    daysSinceActive: round(daysSinceActive, 1),
    tradeAppetite: round(tradeAppetite, 3),
    // Archetype is assigned league-relative by assignArchetypes(); a single
    // profile in isolation has no baseline to be judged against.
    archetype: { ...BALANCED, confidence: 0 },
    updated_at: now,
  };
}

/**
 * How strongly this manager's adds correlate with the previous week's fantasy
 * output — i.e. how much they are chasing the box score rather than the role.
 */
function recencyChasing(leagueKey, adds, season) {
  if (!adds.length) return 0;
  let hits = 0;
  let n = 0;
  for (const a of adds) {
    const wk = Number(a.week);
    if (!Number.isFinite(wk) || wk < 2) continue;
    const prev = get(
      'SELECT stats FROM player_stats WHERE player_id = ? AND season = ? AND week = ?',
      [a.player_id, season, wk - 1]
    );
    if (!prev) continue;
    n += 1;
    const s = j(prev.stats, {});
    // Crude but effective proxy for "had a loud week".
    const loud = (Number(s.rec_td ?? 0) + Number(s.rush_td ?? 0) + Number(s.pass_td ?? 0)) >= 2 ||
      Number(s.rush_yd ?? 0) >= 100 || Number(s.rec_yd ?? 0) >= 100;
    if (loud) hits += 1;
  }
  return n ? hits / n : 0;
}

/**
 * Candidate archetypes, each scored against a manager's traits.
 *
 * Archetypes are assigned RELATIVE TO THE LEAGUE, not against fixed thresholds.
 * An absolute cutoff ("panic > 0.5 means churner") mislabels most of a league
 * whose managers are all fairly active, which makes the whole dossier useless —
 * a label everybody has is not intelligence. Instead we z-score each trait
 * across the league and pick the archetype whose signature this manager departs
 * from the league mean on most strongly, falling back to "balanced" when
 * nothing stands out.
 */
const ARCHETYPES = [
  {
    key: 'absentee', label: 'Absentee',
    note: 'Has not touched the roster in weeks. Free wins and cheap trade targets.',
    signature: { engagement: -2.0, aggression: -1.0 },
    hard: (t) => t.engagement < 0.3 || t.daysSinceActive > 21,
  },
  {
    key: 'spender', label: 'Budget Burner',
    note: 'Spends FAAB far faster than the calendar. Outlast, do not outbid — he will be broke when it matters.',
    signature: { burnRatio: 1.6, aggression: 0.6 },
    hard: (t) => t.burnRatio > 1.25,
  },
  {
    key: 'chaser', label: 'Box Score Chaser',
    note: "Buys last week's points rather than the role. Sell him volatile players right after a spike.",
    signature: { chase: 1.8, aggression: 0.8 },
    hard: (t) => t.chase > 0.4,
  },
  {
    key: 'churner', label: 'Panic Churner',
    note: 'Cuts talent after one bad game. Watch his drops — real value falls out of this roster.',
    signature: { panic: 1.8, aggression: 0.5 },
    hard: (t) => t.panic > 0.55,
  },
  {
    key: 'dealer', label: 'Active Dealer',
    note: 'Trades willingly. Your most likely counterparty for a consolidation deal.',
    signature: { tradeAppetite: 2.0 },
    hard: (t) => t.tradeAppetite > 0.15,
  },
  {
    key: 'stander', label: 'Set-and-Forget',
    note: 'Drafts and sits. Will not contest your waiver claims — you can bid low against him.',
    signature: { aggression: -1.6, engagement: 0.4 },
    hard: (t) => t.aggression < 0.35 && t.engagement >= 0.3,
  },
];

const BALANCED = {
  key: 'balanced', label: 'Balanced',
  note: 'No strongly exploitable tendency yet. Treat as a rational actor.',
};

const TRAIT_KEYS = ['aggression', 'burnRatio', 'chase', 'panic', 'engagement', 'tradeAppetite'];

/**
 * Assign archetypes to a whole league at once, relative to that league.
 * @param {Array} profiles output of buildProfile()
 */
export function assignArchetypes(profiles) {
  if (!profiles.length) return profiles;

  const traits = profiles.map((p) => ({
    aggression: p.aggression,
    burnRatio: p.faab?.burnRatio ?? 1,
    chase: p.chase,
    panic: p.panic,
    engagement: p.engagement,
    tradeAppetite: p.tradeAppetite,
    daysSinceActive: p.daysSinceActive,
  }));

  const stats = {};
  for (const k of TRAIT_KEYS) {
    const vals = traits.map((t) => t[k] ?? 0);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, vals.length - 1));
    stats[k] = { mean: m, sd: sd || 1e-9 };
  }
  const z = (t, k) => (stats[k].sd < 1e-6 ? 0 : ((t[k] ?? 0) - stats[k].mean) / stats[k].sd);

  profiles.forEach((p, i) => {
    const t = traits[i];
    let best = null;
    let bestScore = 0;
    for (const a of ARCHETYPES) {
      if (a.hard && !a.hard(t)) continue;
      // Dot product of the manager's z-scores with the archetype signature,
      // normalised so archetypes with more terms are not automatically favoured.
      let score = 0;
      let norm = 0;
      for (const [k, w] of Object.entries(a.signature)) {
        score += z(t, k) * w;
        norm += Math.abs(w);
      }
      score /= norm || 1;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    // Require a real departure from the league norm before applying a label.
    p.archetype = bestScore >= 0.55 && best
      ? { key: best.key, label: best.label, note: best.note, confidence: round(Math.min(1, bestScore / 2), 2) }
      : { ...BALANCED, confidence: round(Math.max(0, 1 - bestScore), 2) };
    p.traitZ = Object.fromEntries(TRAIT_KEYS.map((k) => [k, round(z(t, k), 2)]));
  });
  return profiles;
}

/** Rebuild profiles for every team in a league, with league-relative archetypes. */
export function buildAllProfiles(leagueKey, opts) {
  const teams = all('SELECT team_key FROM teams WHERE league_key = ?', [leagueKey]);
  const profiles = teams.map((t) => buildProfile(leagueKey, t.team_key, opts)).filter(Boolean);
  return assignArchetypes(profiles);
}

/**
 * Positional need for a rival, from their actual roster against their actual
 * starting requirements, including bye-week and injury holes for a given week.
 */
export function positionalNeed(leagueKey, teamKey, rosterSlots, week) {
  const roster = all(
    `SELECT p.* FROM rosters r JOIN players p ON p.player_id = r.player_id
     WHERE r.league_key = ? AND r.team_key = ? AND r.week = ?`,
    [leagueKey, teamKey, week]
  );
  const slots = startingSlots(rosterSlots);
  const required = {};
  for (const s of slots) {
    for (const pos of eligiblePositions(s)) {
      required[pos] = (required[pos] ?? 0) + 1 / eligiblePositions(s).length;
    }
  }
  const available = {};
  const holes = [];
  for (const p of roster) {
    const out = ['O', 'IR', 'PUP', 'SUSP', 'D'].includes((p.status || '').toUpperCase());
    const bye = Number(p.bye_week) === Number(week);
    if (out || bye) { holes.push({ ...p, reason: bye ? 'bye' : `injury (${p.status})` }); continue; }
    available[p.pos] = (available[p.pos] ?? 0) + 1;
  }
  const need = {};
  for (const pos of POSITIONS) {
    need[pos] = round(Math.max(0, (required[pos] ?? 0) - (available[pos] ?? 0)), 2);
  }
  return { need, holes, roster };
}

/**
 * PREDICT: who does this manager claim this week, and for how much?
 *
 * Combines their revealed positional bias, their current holes, their FAAB
 * behaviour, and the free-agent pool ranked by the platform's own valuation.
 */
export function predictClaims(leagueKey, teamKey, {
  profile, freeAgents, rosterSlots, week, limit = 5,
}) {
  const { need, holes } = positionalNeed(leagueKey, teamKey, rosterSlots, week);

  const scored = freeAgents.map((fa) => {
    const posNeed = need[fa.pos] ?? 0;
    const biasPull = profile?.bias?.[fa.pos] ?? 0;
    // A box-score chaser weights last week's output; everyone else weights role.
    const chaseWeight = profile?.chase ?? 0.3;
    const loudness = clamp((fa.lastWeekPoints ?? 0) / 20, 0, 1.5);
    const roleValue = clamp((fa.vor ?? fa.mean ?? 0) / 8, -1, 2);

    const appeal =
      1.4 * posNeed +
      2.0 * biasPull +
      2.2 * (chaseWeight * loudness + (1 - chaseWeight) * roleValue) +
      1.1 * clamp((fa.pctChange ?? 0) / 10, 0, 1) +          // trending in the market
      0.8 * clamp((fa.breakout ?? 0), -1, 1);

    return { ...fa, appeal, posNeed, biasPull, loudness, roleValue };
  }).sort((a, b) => b.appeal - a.appeal);

  const top = scored.slice(0, Math.max(limit * 3, 12));
  const probs = softmax(top.map((t) => t.appeal), 0.85);
  // Overall probability this manager claims ANYONE this week.
  const actProb = clamp(0.18 + 0.72 * (profile?.aggression ?? 0.3) * (profile?.engagement ?? 0.5) * 1.4, 0.02, 0.97);

  return {
    team_key: teamKey,
    willAct: actProb,
    holes,
    need,
    predictions: top.slice(0, limit).map((t, i) => ({
      player_id: t.player_id,
      name: t.name,
      pos: t.pos,
      nfl_team: t.nfl_team,
      probability: round(probs[i] * actProb, 4),
      expectedBid: predictBid(profile, t, probs[i]),
      why: claimReason(t, profile),
    })),
  };
}

/**
 * Expected FAAB bid from this manager for this player.
 * Anchored on their own historical bid distribution, scaled by how much they
 * want this specific player and how much budget they have left to spend.
 */
export function predictBid(profile, player, appealShare) {
  if (!profile) return null;
  const remaining = Number(profile.faab?.remaining ?? 0);
  if (remaining <= 0) return { amount: 0, pctOfRemaining: 0, note: 'out of FAAB' };
  const avg = profile.faab?.avgBid || Math.max(2, remaining * 0.06);
  const max = profile.faab?.maxBid || Math.max(avg * 2, remaining * 0.2);

  // Scale their typical bid by desire and by how aggressively they spend.
  const desire = clamp(appealShare * 3.2, 0.15, 1.6);
  const burn = clamp(profile.faab?.burnRatio ?? 1, 0.4, 2.2);
  const raw = avg * desire * (0.7 + 0.3 * burn);
  const amount = Math.round(clamp(raw, 0, Math.min(remaining, max * 1.5)));
  return {
    amount,
    pctOfRemaining: remaining ? round(amount / remaining, 3) : 0,
    note: `their avg bid $${avg.toFixed(0)}, max $${max}, $${remaining} left`,
  };
}

function claimReason(t, profile) {
  const bits = [];
  if (t.posNeed > 0.5) bits.push(`needs ${t.pos} (${t.posNeed.toFixed(1)} slots short)`);
  if (t.biasPull > 0.06) bits.push(`over-indexes on ${t.pos}`);
  if ((profile?.chase ?? 0) > 0.5 && t.loudness > 0.6) bits.push('chases big box scores; this player just had one');
  if ((t.pctChange ?? 0) > 5) bits.push('rising fast in ownership league-wide');
  if (t.roleValue > 0.8) bits.push('genuine role change, the market will catch up');
  return bits.length ? bits.join('; ') : 'best available at a position of need';
}

/**
 * Which of a rival's players are realistically buyable, and what it costs.
 * A panic churner sells slumping talent cheap; a box-score chaser overpays for
 * a player coming off a spike, so sell into that.
 */
export function poachTargets(leagueKey, teamKey, profile, rosterProjections, { limit = 5 } = {}) {
  const out = [];
  for (const p of rosterProjections) {
    let discount = 0;
    const reasons = [];
    if ((profile?.panic ?? 0) > 0.4 && (p.recentDelta ?? 0) < -0.15) {
      discount += 0.22; reasons.push('owner panics on slumps and this player is slumping');
    }
    if ((profile?.engagement ?? 1) < 0.3) {
      discount += 0.15; reasons.push('owner is disengaged and undervalues the whole roster');
    }
    if ((profile?.chase ?? 0) > 0.55 && (p.recentDelta ?? 0) < 0) {
      discount += 0.12; reasons.push('owner values recent points, and recent points are down');
    }
    const surplus = countSurplus(rosterProjections, p.pos);
    if (surplus > 1.5) { discount += 0.10; reasons.push(`owner is deep at ${p.pos} and can afford to sell`); }
    if (discount <= 0) continue;
    out.push({
      player_id: p.player_id, name: p.name, pos: p.pos, mean: p.mean,
      discount: round(discount, 3),
      estimatedCost: round(p.vor != null ? p.vor * (1 - discount) : p.mean * (1 - discount), 2),
      reasons,
    });
  }
  return out.sort((a, b) => b.discount - a.discount).slice(0, limit);
}

function countSurplus(roster, pos) {
  const atPos = roster.filter((r) => r.pos === pos).sort((a, b) => b.mean - a.mean);
  const startable = { QB: 1, RB: 2.5, WR: 3, TE: 1, K: 1, DEF: 1 }[pos] ?? 2;
  return Math.max(0, atPos.length - startable);
}
