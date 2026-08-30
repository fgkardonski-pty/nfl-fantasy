/**
 * Defense streaming.
 *
 * This league pays for defenses far more than a standard one does — two points
 * a sack against Yahoo's one, sixteen for a shutout against ten, plus a point
 * per tackle for loss and per fourth-down stop that most leagues do not score
 * at all. The gap between the best and worst startable defense in a given week
 * is larger here than the gap between most starting running backs, and unlike a
 * running back a defense costs nothing to acquire.
 *
 * The engine is deliberately simple, because the signal is: a defense's weekly
 * score is dominated by how many points its opponent scores, and the betting
 * market's implied team total is the best public estimate of that. Everything
 * else — sacks, takeaways, tackles for loss — is a slower-moving unit-quality
 * term that the archetype already supplies.
 *
 * What this file will NOT do is rank defenses off a schedule it cannot verify.
 * A confident ordering built on synthetic games is worse than no ordering,
 * because it looks identical to a real one.
 */
import { expectedPointsAllowedValue, expectedThresholdBonus } from './statline.mjs';
import { clamp } from '../util/stats.mjs';

/** League-average implied team total, used to centre the unit-quality term. */
const LEAGUE_AVG_TOTAL = 22.5;

/**
 * Expected fantasy points for one defense in one week.
 *
 * @param {Object} opts
 * @param {number} opts.impliedOpponentTotal  Vegas implied points for the offense faced.
 * @param {Object} opts.scoring               league scoring rules
 * @param {Object} [opts.unit]                the defense's own per-game production
 * @returns {{mean:number, pointsAllowedValue:number, unitValue:number, matchupSwing:number}}
 */
export function expectedDefenseWeek({ impliedOpponentTotal, scoring, unit = null }) {
  const pa = expectedPointsAllowedValue(impliedOpponentTotal, scoring);

  // Unit production — sacks, takeaways, tackles for loss — tilts with the
  // matchup, but only slightly. A defense facing a bad offence gets a few more
  // sacks; it does not get half again as many. The first cut scaled by
  // sqrt(avg/total), which moved unit production across a 1.55x range and made
  // it swing harder than points allowed — double-counting the matchup and
  // burying the signal this whole feature exists to surface. A gentle linear
  // tilt, clamped, keeps the ordering driven by points allowed where it belongs.
  const MATCHUP_TILT = 0.25;
  const scale = impliedOpponentTotal > 0
    ? clamp(1 + MATCHUP_TILT * (LEAGUE_AVG_TOTAL - impliedOpponentTotal) / LEAGUE_AVG_TOTAL, 0.85, 1.15)
    : 1;

  let unitValue = 0;
  if (unit) {
    for (const [key, per] of Object.entries(scoring ?? {})) {
      if (typeof per !== 'number') continue;
      if (key.startsWith('def_pa_')) continue;      // already in `pa`
      const raw = unit[key];
      if (raw == null) continue;
      unitValue += Number(raw) * scale * per;
    }
    for (const b of scoring?.bonuses ?? []) {
      const mean = unit[b.stat];
      if (mean == null) continue;
      unitValue += expectedThresholdBonus(Number(mean) * scale, b.threshold, b.points);
    }
  }

  // How much of the total is the matchup rather than the unit. A defense whose
  // value is nearly all matchup is a stream; one whose value is nearly all unit
  // is a hold.
  const neutral = expectedPointsAllowedValue(LEAGUE_AVG_TOTAL, scoring);
  return {
    mean: pa + unitValue,
    pointsAllowedValue: pa,
    unitValue,
    matchupSwing: pa - neutral,
  };
}

/**
 * Rank streaming candidates for a week.
 *
 * Returns `{ ok: false, reason }` rather than a list whenever the inputs cannot
 * support a ranking. The four ways that happens — no schedule, a synthetic
 * schedule, a schedule of unknown provenance, or one with no betting lines —
 * all produce output that looks exactly as authoritative as the real thing, so
 * each is refused explicitly.
 *
 * @param {Object} opts
 * @param {Array}  opts.defenses   [{player_id, name, nfl_team, unit?, rostered?, pctOwned?}]
 * @param {Array}  opts.games      rows from the games table for this week
 * @param {Object} opts.scoring
 * @param {string} [opts.myDefenseTeam]  the NFL team of the defense we already roster
 * @param {number} [opts.waiverPriority] our position in the rolling waiver order
 * @param {number} [opts.leagueSize]
 */
export function rankStreamers({
  defenses = [], games = [], scoring = {},
  myDefenseTeam = null, waiverPriority = null, leagueSize = 12, limit = 10,
} = {}) {
  if (!games.length) {
    return { ok: false, reason: 'no-schedule', note: 'No games are loaded for this week, so there is no matchup to rank on.' };
  }
  // Only a slate explicitly tagged 'real' may be ranked on. An untagged row is
  // NOT given the benefit of the doubt: rows written before source tracking
  // existed are untagged, and if the operator ever ran the demo they are
  // invented fixtures built from real team abbreviations — ARI at WAS with a
  // plausible spread — which the permissive reading would have ranked real
  // defenses against without a word. Re-importing odds is a cheap fix; a
  // confidently wrong Sunday lineup is not.
  const usable = games.filter((g) => g.source === 'real');
  if (!usable.length) {
    const allDemo = games.every((g) => g.source === 'demo');
    return {
      ok: false,
      reason: allDemo ? 'synthetic-schedule' : 'unverified-schedule',
      note: allDemo
        ? 'The only games loaded for this week are demo fixtures. Ranking real defenses against invented opponents would look exactly like a real recommendation.'
        : 'This week’s games carry no provenance — they predate source tracking, so they may be demo fixtures. Demo fixtures use real team abbreviations and plausible spreads, so they cannot be told apart by eye.',
    };
  }
  const priced = usable.filter((g) => g.implied_home != null && g.implied_away != null);
  if (!priced.length) {
    return {
      ok: false, reason: 'no-lines',
      note: 'The schedule is loaded but carries no betting lines. Implied opponent total is the whole signal here; without it this ranking would be a list of defenses in arbitrary order.',
    };
  }

  // NFL team -> the implied total of the offense it faces this week.
  const facing = new Map();
  for (const g of priced) {
    facing.set(g.home, { opponent: g.away, impliedOpponentTotal: g.implied_away, home: true });
    facing.set(g.away, { opponent: g.home, impliedOpponentTotal: g.implied_home, home: false });
  }

  const rows = [];
  for (const d of defenses) {
    const m = facing.get(d.nfl_team);
    if (!m) continue;                    // on bye, or not in the priced slate
    const ev = expectedDefenseWeek({ impliedOpponentTotal: m.impliedOpponentTotal, scoring, unit: d.unit });
    rows.push({
      player_id: d.player_id,
      name: d.name,
      nfl_team: d.nfl_team,
      opponent: m.opponent,
      home: m.home,
      impliedOpponentTotal: m.impliedOpponentTotal,
      ...ev,
      rostered: !!d.rostered,
      pctOwned: d.pctOwned ?? null,
      isMine: myDefenseTeam != null && d.nfl_team === myDefenseTeam,
    });
  }
  rows.sort((a, b) => b.mean - a.mean);

  const mine = rows.find((r) => r.isMine) ?? null;
  const available = rows.filter((r) => !r.rostered && !r.isMine);

  // Waiver realism. A rolling-priority league claims in standings order, so a
  // manager near the back of the queue loses every contested claim. Ranking a
  // defense we will not win is not advice, it is a tease — so each candidate
  // carries how likely it is to survive to our turn, and the headline pick is
  // the best one we can plausibly get rather than the best one that exists.
  const ahead = waiverPriority != null ? Math.max(0, waiverPriority - 1) : 0;
  for (const r of available) {
    r.claimRisk = claimRisk(r, available, ahead, leagueSize);
    r.expectedGain = mine ? r.mean - mine.mean : null;
    r.worthClaiming = mine ? r.mean - mine.mean > 1.5 : true;
  }

  // One threshold, so nothing falls between "realistic" and "contested". At 0.4
  // a recommendation still lands three times in five; anything worse is a name
  // to watch lose, not advice.
  const CONTESTED_AT = 0.4;
  const realistic = available.filter((r) => r.claimRisk < CONTESTED_AT);
  return {
    ok: true,
    week: games[0]?.week ?? null,
    mine,
    best: available.slice(0, limit),
    recommended: realistic.find((r) => r.worthClaiming) ?? null,
    contested: available.filter((r) => r.claimRisk >= CONTESTED_AT).slice(0, 5),
    waiverPriority,
    note: mine
      ? null
      : 'No defense on our roster was matched to this week’s slate — the comparison below is against nothing.',
  };
}

/**
 * Rough probability that a defense is claimed before our turn comes round.
 *
 * Managers chase the same visible signal we do — an obviously soft matchup — so
 * the risk is a function of how near the top of the free-agent pile a defense
 * sits, not of its absolute quality. Deliberately crude: it is a tiebreaker
 * between candidates, and pretending to more precision than that would be
 * inventing a number.
 */
export function claimRisk(row, pool, managersAhead, leagueSize) {
  if (!managersAhead) return 0;
  const rank = pool.indexOf(row);
  if (rank < 0) return 0;
  // Roughly one manager in four streams a defense in a given week.
  const streamersAhead = managersAhead * 0.25;
  // Each of them takes from the top of the pile; being one slot deeper roughly
  // halves the chance of being taken.
  const p = streamersAhead / Math.max(1, leagueSize) * Math.pow(0.55, rank);
  return Math.min(0.95, Math.max(0, p * 4));
}
