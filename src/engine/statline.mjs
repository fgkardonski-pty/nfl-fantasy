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
  // Quarterback is the flattest position in fantasy and these anchors made it
  // the steepest. Measured against a full slate of league-scored projections,
  // the real spread from the best starting quarterback to a streamer is about
  // twelve points a game; these anchors produced twenty-two. The elite line was
  // the problem — two touchdowns a game is a career year, not a baseline — and
  // the exaggeration fed straight into draft valuation.
  QB: [
    { rank: 1,  pass_cmp: 23.5, pass_att: 34.5, pass_yd: 262, pass_td: 1.72, pass_int: 0.55, rush_att: 4.6, rush_yd: 26, rush_td: 0.34 },
    { rank: 6,  pass_cmp: 22.4, pass_att: 33.5, pass_yd: 246, pass_td: 1.56, pass_int: 0.62, rush_att: 3.2, rush_yd: 17, rush_td: 0.23 },
    { rank: 12, pass_cmp: 21.2, pass_att: 32.5, pass_yd: 231, pass_td: 1.42, pass_int: 0.70, rush_att: 2.6, rush_yd: 12, rush_td: 0.16 },
    { rank: 20, pass_cmp: 20.2, pass_att: 31.5, pass_yd: 218, pass_td: 1.30, pass_int: 0.75, rush_att: 2.2, rush_yd:  9, rush_td: 0.12 },
    { rank: 32, pass_cmp: 18.8, pass_att: 30.0, pass_yd: 200, pass_td: 1.14, pass_int: 0.80, rush_att: 1.9, rush_yd:  7, rush_td: 0.09 },
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
  // Tackles for loss and fourth-down stops are here because leagues that score
  // them at a point apiece — as this one does — get roughly seven and a half
  // points a game from categories a defense archetype without them reports as
  // zero. Omitting them priced every defense at barely a third of its worth.
  DEF: [
    { rank: 1,  def_sack: 2.90, def_int: 1.00, def_fum_rec: 0.70, def_td: 0.18, def_safety: 0.05, def_block: 0.05, def_pts_allowed: 17.0, def_ret_yd: 22, def_tfl: 7.4, def_4th_down_stop: 0.62 },
    { rank: 6,  def_sack: 2.50, def_int: 0.85, def_fum_rec: 0.60, def_td: 0.13, def_safety: 0.04, def_block: 0.04, def_pts_allowed: 20.0, def_ret_yd: 20, def_tfl: 6.8, def_4th_down_stop: 0.55 },
    { rank: 12, def_sack: 2.20, def_int: 0.72, def_fum_rec: 0.52, def_td: 0.09, def_safety: 0.03, def_block: 0.03, def_pts_allowed: 22.5, def_ret_yd: 18, def_tfl: 6.2, def_4th_down_stop: 0.48 },
    { rank: 24, def_sack: 1.80, def_int: 0.58, def_fum_rec: 0.42, def_td: 0.06, def_safety: 0.02, def_block: 0.02, def_pts_allowed: 25.5, def_ret_yd: 16, def_tfl: 5.4, def_4th_down_stop: 0.40 },
    { rank: 32, def_sack: 1.50, def_int: 0.48, def_fum_rec: 0.35, def_td: 0.04, def_safety: 0.02, def_block: 0.02, def_pts_allowed: 28.0, def_ret_yd: 15, def_tfl: 4.8, def_4th_down_stop: 0.34 },
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
 * Expected value of the points-allowed TIERS given an average points allowed.
 *
 * Leagues score points allowed in buckets — a shutout, one to six, seven to
 * thirteen — and the archetype supplies an average. Those do not meet: an
 * average of twenty scores nothing at all under a key called
 * `def_pts_allowed`, so the entire category, worth up to sixteen points, was
 * silently dropped for every defense.
 *
 * Averaging is also the wrong operation even where the key matches. A defense
 * allowing twenty a game is not a "fourteen to twenty" defense every week; it
 * pitches the occasional shutout and gets run over sometimes, and the bonus
 * schedule is steeply non-linear across exactly that range. So the value is the
 * probability-weighted sum over the buckets, taken from a gamma fitted to the
 * average, which is the same treatment the yardage thresholds already get.
 */
const PA_TIERS = [
  { key: 'def_pa_0', lo: 0, hi: 0.5 },
  { key: 'def_pa_1_6', lo: 0.5, hi: 6.5 },
  { key: 'def_pa_7_13', lo: 6.5, hi: 13.5 },
  { key: 'def_pa_14_20', lo: 13.5, hi: 20.5 },
  { key: 'def_pa_21_27', lo: 20.5, hi: 27.5 },
  { key: 'def_pa_28_34', lo: 27.5, hi: 34.5 },
  { key: 'def_pa_35p', lo: 34.5, hi: Infinity },
];

export function expectedPointsAllowedValue(meanAllowed, scoring, cv = 0.45) {
  if (!(meanAllowed > 0)) return 0;
  const sd = Math.max(1e-6, meanAllowed * cv);
  const shape = (meanAllowed / sd) ** 2;
  const scale = (sd * sd) / meanAllowed;
  let pts = 0;
  for (const t of PA_TIERS) {
    const rate = Number(scoring?.[t.key] ?? 0);
    if (!rate) continue;
    const p = (t.hi === Infinity ? 1 : gammaCdf(t.hi, shape, scale)) - gammaCdf(t.lo, shape, scale);
    pts += Math.max(0, p) * rate;
  }
  return pts;
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
  // Points allowed is carried as an average but scored in buckets, so it needs
  // converting rather than multiplying. The loop above cannot do it: there is
  // no `def_pts_allowed` rate to multiply by, which is exactly why the whole
  // category used to vanish.
  // Guarded against the tier flags: a REAL stat line carries both the raw total
  // and the exact bucket it landed in. The loop above already scored the bucket,
  // so converting the raw total as well would pay for the same points allowed
  // twice. Only convert when no bucket is present, which is the archetype case
  // this branch exists for.
  const hasTier = PA_TIERS.some((t) => statLine[t.key] != null);
  if (statLine.def_pts_allowed != null && !hasTier) {
    total += expectedPointsAllowedValue(Number(statLine.def_pts_allowed), scoring);
  }
  return total;
}

/**
 * Which of a league's scoring rules the archetypes never exercise.
 *
 * This exists because of a defect it would have caught immediately. A league
 * scoring tackles for loss at a point each, fourth-down stops at a point, and
 * points allowed in buckets had all three transcribed correctly into its
 * configuration — and the defense archetype supplied none of those keys, so the
 * scoring loop had nothing to multiply and silently produced zero. Defenses
 * were priced at a third of their worth for an entire draft.
 *
 * The rules were right and the stat lines were incomplete, which is a gap no
 * amount of re-reading the rules would reveal: it only shows when you ask
 * whether anything actually feeds them. So ask, mechanically.
 *
 * @returns {Array<{stat:string, points:number, positions:string[]}>} rules that
 *          score points but that no archetype at any relevant position supplies
 */
export function uncoveredScoringRules(scoring = {}) {
  const supplied = new Map();
  for (const pos of Object.keys(ANCHORS)) {
    for (const key of Object.keys(archetypeStatLine(pos, 1))) {
      if (!supplied.has(key)) supplied.set(key, []);
      supplied.get(key).push(pos);
    }
  }
  // Points allowed is supplied as an average and converted into its buckets, so
  // the tier keys are covered even though no stat line names them.
  const TIER_KEYS = new Set(PA_TIERS.map((t) => t.key));

  const out = [];
  for (const [stat, points] of Object.entries(scoring)) {
    if (typeof points !== 'number' || points === 0) continue;
    if (stat.startsWith('_')) continue;                 // documentation keys
    if (TIER_KEYS.has(stat) && supplied.has('def_pts_allowed')) continue;
    if (supplied.has(stat)) continue;
    out.push({ stat, points, positions: [] });
  }
  return out.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
}

/**
 * Empirical level correction, per position.
 *
 * The anchors are generic NFL production rates. Scored through a real league's
 * rules and checked against a full slate of that league's own player-level
 * projections — one hundred and ninety of them — the SHAPE came out right but
 * the LEVEL did not, consistently, by position.
 *
 * These factors close that gap. They are measurements, not preferences, and
 * they are here rather than hidden inside the anchor tables because inventing
 * stat lines to hit a number would be worse: a defense does not record four
 * sacks a game, and writing that down to make the arithmetic work would leave a
 * table that lies about football.
 *
 * Defense carries the largest correction and had the largest defect behind it:
 * two whole scoring categories were being dropped before this was measured.
 */
const CALIBRATION = { QB: 0.95, RB: 0.85, WR: 0.97, TE: 0.88, K: 0.92, DEF: 1.42 };

/**
 * How far a position's values are spread around its own middle, as a multiple
 * of what the archetype curve produces.
 *
 * Quarterback alone needed this, and the evidence for it does not depend on
 * knowing anyone's schedule. Measured against Yahoo's own league-scored week 1
 * projections, this model spread nine quarterbacks across 11.8 points while
 * Yahoo spread them across 7.58 — and Yahoo's figure is matchup-INCLUSIVE,
 * which can only add variance, so their matchup-neutral spread is tighter
 * still. A neutral curve wider than a matchup-inflated one is over-spread
 * whatever the ordering. Every one of the six quarterbacks that could be
 * compared erred in the direction that predicts: the top three too high, the
 * middle three too low.
 *
 * The correction is deliberately short of what the ratio alone would justify
 * (0.64). With eight data points, some of the gap is ordering and matchup
 * rather than slope, and those two cannot be separated until a real NFL
 * schedule with betting lines is loaded. Compressing all the way would be
 * fitting noise.
 *
 * Every other position is left alone because every other position agreed:
 * RB spread 16.0 against 16.0, TE 6.6 against 6.8, WR 14.3 against 12.7,
 * DEF 6.3 against 7.4, all with bias inside 6%.
 */
const SPREAD = { QB: 0.70 };

/** The rank each position's compression pivots around — roughly its own middle. */
const PIVOT_RANK = { QB: 8 };

/**
 * Expected per-game fantasy points for a player at `rank` within `pos`, under
 * this league's actual scoring. This is the number a pre-season draft board
 * should rank on.
 */
export function expectedPointsAtRank(pos, rank, scoring) {
  const raw = expectedScore(archetypeStatLine(pos, rank), scoring) * (CALIBRATION[pos] ?? 1);
  const k = SPREAD[pos];
  if (!k) return raw;
  // Compress toward the position's own middle, which leaves the middle of the
  // curve where the measurement says it already belongs and pulls in the tails.
  const pivot = expectedScore(archetypeStatLine(pos, PIVOT_RANK[pos] ?? 8), scoring) * (CALIBRATION[pos] ?? 1);
  return pivot + k * (raw - pivot);
}

export { ANCHORS, DERIVED };
