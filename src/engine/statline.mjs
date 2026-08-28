/**
 * Positional archetype stat lines.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before a season starts there are no box scores, so a draft board has nothing
 * to score. The obvious shortcut is to rank players by ADP and call it a day —
 * but ADP is published for GENERIC scoring (usually half-PPR, 4-point passing
 * touchdowns, nothing for completions or first downs). Feeding it straight into
 * a draft board silently prices every player in a league that is not yours.
 *
 * That error is not cosmetic. In a league that pays 0.5 per completion, 0.5 per
 * first down and 6 per passing touchdown, an elite quarterback earns roughly
 * nineteen points a game from completions and first downs ALONE — categories
 * that do not exist in the scoring ADP was built for. Ranking off raw ADP there
 * understates quarterbacks by more than half.
 *
 * THE TRANSFORMATION
 * ------------------
 *   ADP  ->  positional rank  ->  archetype stat line  ->  YOUR scoring  ->  value
 *
 * Read as: "the market says he is the RB7; here is what an RB7 typically
 * produces; here is what that production is worth under your rules."
 *
 * HONEST LIMITS
 * -------------
 * These are POSITIONAL ARCHETYPES, not player projections. The RB7 line is what
 * a seventh-ranked back typically does, not a forecast of one specific player's
 * usage, offense, or health. That is the right altitude for converting a
 * consensus ranking into league-specific value, and it is deliberately not a
 * claim to know more about a player than the market does. Once real games are
 * played, observed production takes over and these curves fall away.
 */
import { gammaCdf } from '../util/stats.mjs';

/**
 * Per-game production anchors by positional rank.
 *
 * Values between anchors are linearly interpolated; beyond the last anchor they
 * decay toward zero, because the anchors cover the fantasy-relevant pool and
 * past it players do not merely produce less, they mostly do not play. Numbers
 * are typical NFL per-game production for a player finishing at that rank.
 */
const ANCHORS = {
  QB: [
    { rank: 1,  pass_cmp: 24.0, pass_att: 35.0, pass_yd: 280, pass_td: 2.10, pass_int: 0.50, rush_att: 5.5, rush_yd: 32, rush_td: 0.45 },
    { rank: 6,  pass_cmp: 23.0, pass_att: 34.0, pass_yd: 255, pass_td: 1.75, pass_int: 0.60, rush_att: 3.5, rush_yd: 18, rush_td: 0.25 },
    { rank: 12, pass_cmp: 21.0, pass_att: 32.5, pass_yd: 230, pass_td: 1.45, pass_int: 0.70, rush_att: 2.5, rush_yd: 11, rush_td: 0.15 },
    { rank: 20, pass_cmp: 19.5, pass_att: 31.0, pass_yd: 210, pass_td: 1.20, pass_int: 0.75, rush_att: 2.0, rush_yd:  8, rush_td: 0.10 },
    { rank: 32, pass_cmp: 17.0, pass_att: 28.0, pass_yd: 180, pass_td: 0.95, pass_int: 0.80, rush_att: 1.8, rush_yd:  6, rush_td: 0.08 },
  ],
  RB: [
    { rank: 1,  rush_att: 17.0, rush_yd: 80, rush_td: 0.60, rec: 4.0, rec_yd: 30, rec_td: 0.20 },
    { rank: 6,  rush_att: 15.5, rush_yd: 68, rush_td: 0.48, rec: 3.4, rec_yd: 25, rec_td: 0.14 },
    { rank: 12, rush_att: 13.0, rush_yd: 55, rush_td: 0.35, rec: 3.0, rec_yd: 22, rec_td: 0.10 },
    { rank: 24, rush_att: 10.0, rush_yd: 42, rush_td: 0.25, rec: 2.2, rec_yd: 16, rec_td: 0.07 },
    { rank: 36, rush_att:  7.0, rush_yd: 28, rush_td: 0.15, rec: 1.5, rec_yd: 10, rec_td: 0.04 },
    { rank: 60, rush_att:  4.0, rush_yd: 16, rush_td: 0.08, rec: 0.9, rec_yd:  6, rec_td: 0.02 },
  ],
  WR: [
    { rank: 1,  rec: 7.0, rec_yd: 95, rec_td: 0.60, rush_att: 0.3, rush_yd: 2, rush_td: 0.02 },
    { rank: 6,  rec: 6.2, rec_yd: 82, rec_td: 0.48, rush_att: 0.2, rush_yd: 1, rush_td: 0.01 },
    { rank: 12, rec: 5.5, rec_yd: 70, rec_td: 0.40, rush_att: 0.1, rush_yd: 1, rush_td: 0.01 },
    { rank: 24, rec: 4.5, rec_yd: 56, rec_td: 0.28 },
    { rank: 36, rec: 3.6, rec_yd: 44, rec_td: 0.20 },
    { rank: 60, rec: 2.5, rec_yd: 30, rec_td: 0.12 },
    { rank: 90, rec: 1.6, rec_yd: 18, rec_td: 0.06 },
  ],
  TE: [
    { rank: 1,  rec: 6.0, rec_yd: 70, rec_td: 0.50 },
    { rank: 6,  rec: 4.5, rec_yd: 50, rec_td: 0.35 },
    { rank: 12, rec: 3.5, rec_yd: 38, rec_td: 0.25 },
    { rank: 24, rec: 2.4, rec_yd: 24, rec_td: 0.15 },
    { rank: 40, rec: 1.5, rec_yd: 14, rec_td: 0.08 },
  ],
  K: [
    { rank: 1,  fg_made: 2.00, fg_0_19: 0.02, fg_20_29: 0.45, fg_30_39: 0.62, fg_40_49: 0.60, fg_50p: 0.31, pat_made: 2.60, fg_miss_0_19: 0.01 },
    { rank: 12, fg_made: 1.60, fg_0_19: 0.02, fg_20_29: 0.40, fg_30_39: 0.50, fg_40_49: 0.45, fg_50p: 0.23, pat_made: 2.20, fg_miss_0_19: 0.01 },
    { rank: 24, fg_made: 1.30, fg_0_19: 0.01, fg_20_29: 0.34, fg_30_39: 0.42, fg_40_49: 0.36, fg_50p: 0.17, pat_made: 1.90, fg_miss_0_19: 0.02 },
    { rank: 32, fg_made: 1.10, fg_0_19: 0.01, fg_20_29: 0.30, fg_30_39: 0.36, fg_40_49: 0.30, fg_50p: 0.13, pat_made: 1.70, fg_miss_0_19: 0.02 },
  ],
  DEF: [
    { rank: 1,  def_sack: 2.90, def_int: 1.00, def_fum_rec: 0.70, def_td: 0.18, def_safety: 0.05, def_block: 0.05, def_pts_allowed: 17.0, def_ret_yd: 22 },
    { rank: 6,  def_sack: 2.50, def_int: 0.85, def_fum_rec: 0.60, def_td: 0.13, def_safety: 0.04, def_block: 0.04, def_pts_allowed: 20.0, def_ret_yd: 20 },
    { rank: 12, def_sack: 2.20, def_int: 0.72, def_fum_rec: 0.52, def_td: 0.09, def_safety: 0.03, def_block: 0.03, def_pts_allowed: 22.5, def_ret_yd: 18 },
    { rank: 24, def_sack: 1.80, def_int: 0.58, def_fum_rec: 0.42, def_td: 0.06, def_safety: 0.02, def_block: 0.02, def_pts_allowed: 25.5, def_ret_yd: 16 },
    { rank: 32, def_sack: 1.50, def_int: 0.48, def_fum_rec: 0.35, def_td: 0.04, def_safety: 0.02, def_block: 0.02, def_pts_allowed: 28.0, def_ret_yd: 15 },
  ],
};

/**
 * Derived rates applied on top of the anchors.
 *
 * First downs and explosive plays are not tracked separately in the anchor
 * tables because they move almost proportionally with the volume stats they
 * come from. Deriving them keeps the anchors readable and keeps the two in
 * sync — a hand-maintained first-down column would drift out of step with the
 * completion column it depends on.
 */
const DERIVED = {
  // A completion produces a first down slightly more than half the time.
  pass_first_down: (s) => (s.pass_cmp ?? 0) * 0.55,
  // Roughly a quarter of carries move the chains.
  rush_first_down: (s) => (s.rush_att ?? 0) * 0.24,
  // Receptions convert at a bit under 60%.
  rec_first_down: (s) => (s.rec ?? 0) * 0.57,
  // Explosive plays scale with yards per attempt, not attempts alone.
  pass_cmp_40: (s) => ((s.pass_yd ?? 0) / 250) * 0.45,
  pass_td_40: (s) => (s.pass_td ?? 0) * 0.11,
  rush_40: (s) => ((s.rush_yd ?? 0) / 80) * 0.13,
  rush_td_40: (s) => (s.rush_td ?? 0) * 0.10,
  rec_40: (s) => ((s.rec_yd ?? 0) / 90) * 0.34,
  rec_td_40: (s) => (s.rec_td ?? 0) * 0.20,
  // Interceptions returned for a touchdown against the passer.
  pick_six_thrown: (s) => (s.pass_int ?? 0) * 0.09,
  // Fumbles lost track carries plus receptions.
  fum_lost: (s) => ((s.rush_att ?? 0) + (s.rec ?? 0)) * 0.006,
};

/** Coefficient of variation for game-to-game yardage, used for threshold bonuses. */
const YARD_CV = { pass_yd: 0.30, rush_yd: 0.55, rec_yd: 0.65, def_ret_yd: 0.80 };

/**
 * How fast production falls away past the deepest anchor, as a fraction of that
 * anchor's rank. The anchors cover the fantasy-relevant pool at a position;
 * beyond it sit third-string quarterbacks and practice-squad receivers who are
 * not merely worse, they largely do not play.
 */
const TAIL_DECAY = 0.35;

function interpolate(anchors, rank) {
  if (rank <= anchors[0].rank) return { ...anchors[0] };
  const last = anchors[anchors.length - 1];

  // Past the deepest anchor, DECAY rather than repeat it. Returning the last
  // anchor unchanged asserted that the 200th quarterback in the league produces
  // exactly what the 40th does — in this league's scoring, 28.8 points a game
  // for someone who will not take a snap. Every unranked player in the pool was
  // priced off that flat line, and with an empty starting slot to fill it was
  // enough to put a retired quarterback at the top of a live draft board.
  if (rank > last.rank) {
    const tau = Math.max(1, last.rank * TAIL_DECAY);
    const mult = Math.exp(-(rank - last.rank) / tau);
    const out = {};
    for (const [key, v] of Object.entries(last)) {
      if (key === 'rank') continue;
      out[key] = (v ?? 0) * mult;
    }
    return out;
  }

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (rank >= a.rank && rank <= b.rank) {
      const t = (rank - a.rank) / (b.rank - a.rank);
      const out = {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (key === 'rank') continue;
        const av = a[key] ?? 0;
        const bv = b[key] ?? 0;
        out[key] = av + (bv - av) * t;
      }
      return out;
    }
  }
  return { ...last };
}

/**
 * The expected per-game stat line for a player at `rank` within `pos`.
 * @returns {Object} canonical stat keys -> expected per-game amounts
 */
export function archetypeStatLine(pos, rank) {
  const anchors = ANCHORS[pos];
  if (!anchors) return {};
  const base = interpolate(anchors, Math.max(1, rank));
  for (const [key, fn] of Object.entries(DERIVED)) {
    const v = fn(base);
    if (v > 0) base[key] = v;
  }
  return base;
}

/**
 * Expected value of a threshold bonus given an EXPECTED per-game amount.
 *
 * A bonus that fires once a player passes fifty yards is not worth its face
 * value times the number of games — it is worth the probability of clearing
 * fifty in a given game. A back averaging eighty yards clears it most weeks; a
 * back averaging forty clears it sometimes. Modelling that as a probability
 * rather than a yes/no on the average is the difference between pricing the
 * bonus correctly and handing it to everyone equally.
 */
export function expectedThresholdBonus(mean, threshold, points, cv = 0.55) {
  if (!(mean > 0) || !(points !== 0)) return 0;
  const sd = Math.max(1e-6, mean * cv);
  const shape = (mean / sd) ** 2;
  const scale = (sd * sd) / mean;
  const pExceed = 1 - gammaCdf(threshold, shape, scale);
  return pExceed * points;
}

/**
 * Score an EXPECTED (average) stat line under a league's rules.
 *
 * Distinct from scoreStatLine(), which scores one real game where a threshold
 * either fired or did not. Here every input is an average, so threshold bonuses
 * are weighted by how often they would actually fire.
 */
export function expectedScore(statLine, scoring) {
  let total = 0;
  for (const [key, per] of Object.entries(scoring)) {
    if (key === 'bonuses') continue;
    const amount = statLine[key];
    if (amount == null || typeof per !== 'number') continue;
    total += Number(amount) * per;
  }
  for (const bonus of scoring.bonuses ?? []) {
    const mean = statLine[bonus.stat];
    if (mean == null) continue;
    total += expectedThresholdBonus(
      Number(mean), Number(bonus.threshold), Number(bonus.points),
      YARD_CV[bonus.stat] ?? 0.55
    );
  }
  return total;
}

/**
 * Expected per-game fantasy points for a player at `rank` within `pos`, under
 * this league's actual scoring. This is the number a pre-season draft board
 * should rank on.
 */
export function expectedPointsAtRank(pos, rank, scoring) {
  return expectedScore(archetypeStatLine(pos, rank), scoring);
}

export { ANCHORS, DERIVED };
