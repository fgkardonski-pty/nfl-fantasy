/**
 * League-aware fantasy scoring.
 *
 * Nothing in this platform assumes "standard PPR". Yahoo hands back a scoring
 * table keyed by its own numeric stat ids; we keep raw stat lines in the
 * database and price them through the league's real table at read time. Change
 * a scoring rule in Yahoo, re-sync the settings, and every projection, every
 * ranking, and every historical week re-prices with no re-fetch of stats.
 */

/**
 * Yahoo NFL stat_id -> canonical stat key.
 * Ids Yahoo emits that are not listed here still work: unknown ids are applied
 * directly against a same-named raw stat, so a novel league rule degrades to
 * "scored if we have the stat" rather than "silently dropped".
 */
export const YAHOO_STAT_IDS = {
  1: 'games_played',
  2: 'pass_att',
  3: 'pass_cmp',
  4: 'pass_yd',
  5: 'pass_td',
  6: 'pass_int',
  7: 'sacked',
  8: 'rush_att',
  9: 'rush_yd',
  10: 'rush_td',
  11: 'rec',
  12: 'rec_yd',
  13: 'rec_td',
  14: 'ret_yd',
  15: 'ret_td',
  16: 'two_pt',
  17: 'fum',
  18: 'fum_lost',
  19: 'fg_0_19',
  20: 'fg_20_29',
  21: 'fg_30_39',
  22: 'fg_40_49',
  23: 'fg_50p',
  24: 'fg_made',
  25: 'fg_miss',
  26: 'pat_made',
  27: 'pat_miss',
  29: 'def_pts_allowed',
  31: 'def_pts_allowed',
  32: 'def_sack',
  33: 'def_int',
  34: 'def_fum_rec',
  35: 'def_td',
  36: 'def_safety',
  37: 'def_block',
  38: 'def_ret_td',
  50: 'def_pa_0',
  51: 'def_pa_1_6',
  52: 'def_pa_7_13',
  53: 'def_pa_14_20',
  54: 'def_pa_21_27',
  55: 'def_pa_28_34',
  56: 'def_pa_35p',
  57: 'targets',
  78: 'rec_first_down',
  79: 'rush_first_down',
  80: 'pass_first_down',
};

/** A sane full-PPR default so demo mode and unauthenticated use still work. */
export const DEFAULT_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, two_pt: 2,
  rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6,
  ret_td: 6, fum_lost: -2,
  fg_0_19: 3, fg_20_29: 3, fg_30_39: 3, fg_40_49: 4, fg_50p: 5,
  pat_made: 1, fg_miss: -1,
  def_sack: 1, def_int: 2, def_fum_rec: 2, def_td: 6, def_safety: 2,
  def_block: 2, def_ret_td: 6,
  def_pa_0: 10, def_pa_1_6: 7, def_pa_7_13: 4, def_pa_14_20: 1,
  def_pa_21_27: 0, def_pa_28_34: -1, def_pa_35p: -4,
};

/**
 * Convert a Yahoo settings scoring array into a canonical {statKey: points} map.
 * @param {Array<{stat_id:number|string, value:number|string}>} statModifiers
 */
export function scoringFromYahoo(statModifiers = []) {
  const out = {};
  for (const m of statModifiers) {
    const id = Number(m.stat_id ?? m.statId);
    const val = Number(m.value);
    if (!Number.isFinite(val) || val === 0) continue;
    const key = YAHOO_STAT_IDS[id] ?? `stat_${id}`;
    // Yahoo can emit the same canonical key from multiple ids (e.g. 29 and 31
    // both mean points allowed). Last non-zero wins rather than summing.
    out[key] = val;
  }
  return Object.keys(out).length ? out : { ...DEFAULT_SCORING };
}

/**
 * Score one raw stat line.
 * @param {Object} stats canonical stat key -> raw amount
 * @param {Object} scoring canonical stat key -> points per unit
 * @returns {number} fantasy points
 */
export function scoreStatLine(stats, scoring = DEFAULT_SCORING) {
  let pts = 0;
  for (const [key, per] of Object.entries(scoring)) {
    const raw = stats[key];
    if (raw == null) continue;
    pts += Number(raw) * Number(per);
  }
  return pts;
}

/** Same as scoreStatLine but returns the per-stat breakdown for explainability. */
export function scoreBreakdown(stats, scoring = DEFAULT_SCORING) {
  const parts = [];
  let total = 0;
  for (const [key, per] of Object.entries(scoring)) {
    const raw = Number(stats[key] ?? 0);
    if (!raw) continue;
    const pts = raw * Number(per);
    total += pts;
    parts.push({ stat: key, raw, per: Number(per), points: pts });
  }
  parts.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { total, parts };
}

/**
 * Is this league PPR, half, or standard? Used for replacement-level tuning and
 * for the human-readable league summary — never for the actual arithmetic.
 */
export function pprValue(scoring) {
  return Number(scoring?.rec ?? 0);
}

export function describeScoring(scoring) {
  const ppr = pprValue(scoring);
  const recLabel = ppr >= 1 ? 'Full PPR' : ppr >= 0.5 ? 'Half PPR' : ppr > 0 ? `${ppr} PPR` : 'Standard (no PPR)';
  const passTd = scoring?.pass_td ?? 4;
  const passYd = scoring?.pass_yd ?? 0.04;
  const bits = [recLabel, `${passTd}pt pass TD`, `1pt / ${Math.round(1 / (passYd || 0.04))} pass yd`];
  if (scoring?.rec_first_down) bits.push('PPFD');
  if (scoring?.rush_first_down) bits.push('rush 1D bonus');
  return bits.join(' · ');
}

/**
 * How much a single reception is worth relative to a rushing yard. This is the
 * number that decides whether pass-catching backs and slot receivers are league
 * winners or roster filler, so it feeds directly into positional valuation.
 */
export function receptionPremium(scoring) {
  const rec = Number(scoring?.rec ?? 0);
  const recYd = Number(scoring?.rec_yd ?? 0.1) || 0.1;
  return rec / recYd; // in "receiving yards equivalent"
}
