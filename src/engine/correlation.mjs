/**
 * Correlation structure between player outcomes.
 *
 * This is the single most-skipped step in amateur fantasy tooling and the one
 * that most changes the answer. If you simulate players independently you will
 * systematically UNDERSTATE the variance of a stacked lineup and OVERSTATE your
 * win probability as an underdog — the exact two errors that lose leagues.
 *
 * Real structure we encode:
 *   - A quarterback and his own pass catchers rise and fall together.
 *   - A team's running back is mildly NEGATIVELY correlated with his own
 *     passing game: there is one ball.
 *   - Opposing offenses are positively correlated through game script — a
 *     shootout lifts everyone on the field.
 *   - A defense is strongly negatively correlated with the offense it faces.
 *   - A kicker follows his own offense into scoring range but is capped by it
 *     converting touchdowns instead of field goals.
 */

/** Same-team position-pair correlations. */
const SAME_TEAM = {
  'QB|WR': 0.34, 'QB|TE': 0.26, 'QB|RB': 0.06, 'QB|K': 0.22, 'QB|DEF': 0.06,
  'WR|WR': 0.02, 'WR|TE': 0.00, 'WR|RB': -0.05, 'WR|K': 0.08, 'WR|DEF': 0.04,
  'TE|TE': 0.00, 'TE|RB': -0.04, 'TE|K': 0.08, 'TE|DEF': 0.04,
  'RB|RB': -0.28, 'RB|K': 0.12, 'RB|DEF': 0.06,
  'K|K': 0.00, 'K|DEF': 0.10,
  'DEF|DEF': 0.00,
};

/** Opposing-team position-pair correlations (same NFL game, opposite sidelines). */
const OPPOSING = {
  'QB|QB': 0.12, 'QB|WR': 0.09, 'QB|TE': 0.07, 'QB|RB': -0.04, 'QB|K': 0.06, 'QB|DEF': -0.48,
  'WR|WR': 0.08, 'WR|TE': 0.06, 'WR|RB': -0.04, 'WR|K': 0.05, 'WR|DEF': -0.34,
  'TE|TE': 0.05, 'TE|RB': -0.03, 'TE|K': 0.04, 'TE|DEF': -0.24,
  'RB|RB': -0.10, 'RB|K': 0.03, 'RB|DEF': -0.26,
  'K|K': 0.05, 'K|DEF': -0.20,
  'DEF|DEF': -0.14,
};

const key = (a, b) => (a <= b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Normalise a hand-written table to canonically-ordered keys.
 * The tables above are written in the order that reads naturally to a human
 * ('QB|DEF'); lookups are canonical ('DEF|QB'). Normalising once at load keeps
 * both readable and correct — writing them by hand in sorted order is how you
 * end up with a silently-zero correlation between a quarterback and the defense
 * he is playing against.
 */
function canonicalise(table) {
  const out = {};
  for (const [k, v] of Object.entries(table)) {
    const [a, b] = k.split('|');
    out[key(a, b)] = v;
  }
  return out;
}

const SAME_TEAM_C = canonicalise(SAME_TEAM);
const OPPOSING_C = canonicalise(OPPOSING);

/**
 * Pairwise correlation between two projected players.
 * @param {{pos:string,nfl_team:string,opponent:string}} a
 * @param {{pos:string,nfl_team:string,opponent:string}} b
 */
export function pairCorrelation(a, b) {
  if (a.player_id === b.player_id) return 1;
  if (!a.nfl_team || !b.nfl_team) return 0;

  // A fantasy DEF is really "the defense of nfl_team", so it opposes the
  // offense of its own opponent.
  if (a.nfl_team === b.nfl_team) return SAME_TEAM_C[key(a.pos, b.pos)] ?? 0;

  const sameGame =
    (a.opponent && a.opponent === b.nfl_team) || (b.opponent && b.opponent === a.nfl_team);
  if (sameGame) return OPPOSING_C[key(a.pos, b.pos)] ?? 0;

  // Different games: essentially independent. A whisper of common NFL-wide
  // scoring environment keeps the matrix from being pathologically sparse.
  return 0.01;
}

/**
 * Build the full correlation matrix for a set of projections.
 * Returns a symmetric matrix with unit diagonal.
 */
export function buildCorrelationMatrix(projections) {
  const n = projections.length;
  const R = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    R[i][i] = 1;
    for (let k = i + 1; k < n; k++) {
      const c = pairCorrelation(projections[i], projections[k]);
      R[i][k] = c;
      R[k][i] = c;
    }
  }
  return R.map((row) => Array.from(row));
}

/**
 * Human-readable description of the strongest correlations in a lineup — this
 * is what tells a manager "you are stacked, your ceiling and your floor are
 * both further away than the projections suggest".
 */
export function describeStacks(projections, threshold = 0.2) {
  const out = [];
  for (let i = 0; i < projections.length; i++) {
    for (let k = i + 1; k < projections.length; k++) {
      const c = pairCorrelation(projections[i], projections[k]);
      if (Math.abs(c) < threshold) continue;
      out.push({
        a: projections[i].name,
        b: projections[k].name,
        corr: c,
        kind: c > 0 ? (projections[i].nfl_team === projections[k].nfl_team ? 'stack' : 'game stack') : 'conflict',
      });
    }
  }
  out.sort((x, y) => Math.abs(y.corr) - Math.abs(x.corr));
  return out;
}

/** Net correlation exposure of a lineup: >0 means variance is amplified. */
export function lineupCorrelationLoad(projections) {
  let load = 0;
  let pairs = 0;
  for (let i = 0; i < projections.length; i++) {
    for (let k = i + 1; k < projections.length; k++) {
      load += pairCorrelation(projections[i], projections[k]);
      pairs++;
    }
  }
  return pairs ? load / pairs : 0;
}
