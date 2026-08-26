/**
 * Scoring-aware draft valuation.
 *
 * The claim under test is the one that matters on draft night: that a league's
 * scoring rules change WHICH PLAYERS ARE WORTH DRAFTING, not merely how many
 * points everyone scores. A valuation that inflates every player equally is
 * useless; the whole point is that categories like per-completion and
 * per-first-down scoring move positions relative to each other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archetypeStatLine, expectedScore, expectedPointsAtRank, expectedThresholdBonus,
} from '../src/engine/statline.mjs';
import { scoreStatLine, scoreBreakdown, scoreBonuses } from '../src/engine/scoring.mjs';

/** Generic scoring, of the kind published ADP is built for. */
const STANDARD = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1,
  rush_yd: 0.1, rush_td: 6,
  rec: 0.5, rec_yd: 0.1, rec_td: 6, fum_lost: -2,
};

/** The user's league: pays for completions, first downs, and 6pt passing TDs. */
const CUSTOM = {
  pass_cmp: 0.5, pass_yd: 0.04, pass_td: 6, pass_int: -1, pass_first_down: 0.5,
  rush_att: 0.2, rush_yd: 0.1, rush_td: 6, rush_first_down: 0.5,
  rec: 0.5, rec_yd: 0.1, rec_td: 6, rec_first_down: 0.5,
  fum_lost: -2,
  bonuses: [
    { stat: 'pass_yd', threshold: 50, points: 1 },
    { stat: 'rush_yd', threshold: 50, points: 1 },
    { stat: 'rec_yd', threshold: 50, points: 1 },
  ],
};

test('archetype stat lines decline monotonically with positional rank', () => {
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    let prev = Infinity;
    for (const rank of [1, 6, 12, 24, 36]) {
      const pts = expectedPointsAtRank(pos, rank, STANDARD);
      assert.ok(pts > 0, `${pos}${rank} produces positive value`);
      assert.ok(pts <= prev + 1e-9, `${pos}${rank} (${pts.toFixed(1)}) <= ${pos} previous rank (${prev.toFixed(1)})`);
      prev = pts;
    }
  }
});

test('archetype lines interpolate between anchors rather than snapping', () => {
  const r6 = expectedPointsAtRank('RB', 6, STANDARD);
  const r9 = expectedPointsAtRank('RB', 9, STANDARD);
  const r12 = expectedPointsAtRank('RB', 12, STANDARD);
  assert.ok(r9 < r6 && r9 > r12, 'RB9 sits strictly between its bracketing anchors');
});

test('archetype lines hold flat past the last anchor instead of going negative', () => {
  const deep = expectedPointsAtRank('WR', 500, STANDARD);
  assert.ok(deep > 0, 'a very deep rank still produces non-negative value');
  assert.equal(deep, expectedPointsAtRank('WR', 1000, STANDARD), 'held flat past the final anchor');
});

test('derived first downs scale with the volume stat they come from', () => {
  const elite = archetypeStatLine('QB', 1);
  const weak = archetypeStatLine('QB', 32);
  assert.ok(elite.pass_first_down > weak.pass_first_down);
  assert.ok(elite.pass_first_down < elite.pass_cmp, 'not every completion is a first down');
  const rb = archetypeStatLine('RB', 1);
  assert.ok(rb.rush_first_down < rb.rush_att, 'not every carry moves the chains');
});

test('per-completion and per-first-down scoring inflates quarterbacks far more than receivers', () => {
  // This is the core claim: the custom rules do NOT lift all positions equally.
  const qbLift = expectedPointsAtRank('QB', 1, CUSTOM) / expectedPointsAtRank('QB', 1, STANDARD);
  const wrLift = expectedPointsAtRank('WR', 1, CUSTOM) / expectedPointsAtRank('WR', 1, STANDARD);
  assert.ok(qbLift > 1.8, `QB value roughly doubles under these rules (got ${qbLift.toFixed(2)}x)`);
  assert.ok(wrLift < 1.4, `WR value moves far less (got ${wrLift.toFixed(2)}x)`);
  assert.ok(qbLift > wrLift * 1.5, 'the gap between positions is the point, not the absolute inflation');
});

test('scoring rules shift the positional VALUE GAP, which is what drives draft order', () => {
  // Value over replacement is what a draft board ranks on, and replacement
  // level is POSITION-SPECIFIC: a one-quarterback league replaces around QB24,
  // while a league starting a back plus a flex replaces far deeper. Comparing
  // both positions at the same rank would understate running backs badly.
  const REPLACEMENT = { QB: 24, RB: 36, WR: 48 };
  const gap = (pos, scoring) =>
    expectedPointsAtRank(pos, 1, scoring) - expectedPointsAtRank(pos, REPLACEMENT[pos], scoring);

  const stdQb = gap('QB', STANDARD);
  const stdRb = gap('RB', STANDARD);
  const cusQb = gap('QB', CUSTOM);
  const cusRb = gap('RB', CUSTOM);
  const cusWr = gap('WR', CUSTOM);

  // Under generic scoring an elite quarterback and an elite back are worth
  // about the same over replacement — which is why generic rankings treat them
  // interchangeably at the top of a draft.
  assert.ok(Math.abs(stdQb - stdRb) < 2,
    `standard scoring values elite QB (${stdQb.toFixed(1)}) and elite RB (${stdRb.toFixed(1)}) similarly`);

  // Paying per completion and per first down breaks that tie decisively: the
  // quarterback gap grows far more than the back's, and the receiver's barely
  // moves. That reordering is the entire reason draft values must be computed
  // in the league's own scoring rather than read off published rankings.
  const qbGrowth = cusQb / stdQb;
  const rbGrowth = cusRb / stdRb;
  assert.ok(qbGrowth > rbGrowth,
    `QB gap grows faster (${qbGrowth.toFixed(2)}x) than RB gap (${rbGrowth.toFixed(2)}x)`);
  assert.ok(cusQb > cusRb && cusRb > cusWr,
    `custom scoring orders the elite tiers QB (${cusQb.toFixed(1)}) > RB (${cusRb.toFixed(1)}) > WR (${cusWr.toFixed(1)})`);
});

test('threshold bonuses are weighted by how often they would actually fire', () => {
  // A back averaging 80 yards clears fifty most weeks; one averaging 15 almost
  // never does. Awarding both the same bonus would be the bug.
  const high = expectedThresholdBonus(80, 50, 1, 0.55);
  const mid = expectedThresholdBonus(50, 50, 1, 0.55);
  const low = expectedThresholdBonus(15, 50, 1, 0.55);
  assert.ok(high > 0.6, `80-yard average clears 50 most weeks (got ${high.toFixed(2)})`);
  assert.ok(mid > 0.3 && mid < 0.7, `50-yard average is near a coin flip (got ${mid.toFixed(2)})`);
  assert.ok(low < 0.15, `15-yard average rarely clears 50 (got ${low.toFixed(2)})`);
  assert.ok(high > mid && mid > low, 'strictly ordered by expected volume');
});

test('threshold bonus handles degenerate inputs without producing value from nothing', () => {
  assert.equal(expectedThresholdBonus(0, 50, 1), 0, 'no production, no bonus');
  assert.equal(expectedThresholdBonus(-5, 50, 1), 0);
  assert.equal(expectedThresholdBonus(80, 50, 0), 0, 'a zero-point bonus is worth zero');
});

test('scoreStatLine fires a threshold bonus once, not per unit over the line', () => {
  const scoring = { rush_yd: 0.1, bonuses: [{ stat: 'rush_yd', threshold: 50, points: 1 }] };
  assert.equal(scoreStatLine({ rush_yd: 49 }, scoring), 4.9, 'below the line, no bonus');
  assert.equal(scoreStatLine({ rush_yd: 50 }, scoring), 6, 'at the line, bonus fires');
  assert.equal(scoreStatLine({ rush_yd: 200 }, scoring), 21, 'far past the line, bonus still fires exactly once');
});

test('a missing bonuses array is not an error', () => {
  assert.equal(scoreBonuses({ rush_yd: 100 }, { rush_yd: 0.1 }), 0);
  assert.equal(scoreBonuses({ rush_yd: 100 }, {}), 0);
  assert.equal(scoreStatLine({ rush_yd: 100 }, { rush_yd: 0.1 }), 10);
});

test('scoreBreakdown always reconciles with scoreStatLine, bonuses included', () => {
  const line = { rush_yd: 80, rush_td: 1, rec: 4, rec_yd: 55, pass_cmp: 0 };
  const scoring = {
    rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1,
    bonuses: [
      { stat: 'rush_yd', threshold: 50, points: 1 },
      { stat: 'rec_yd', threshold: 50, points: 1 },
      { stat: 'pass_yd', threshold: 50, points: 1 },
    ],
  };
  const bd = scoreBreakdown(line, scoring);
  assert.ok(Math.abs(bd.total - scoreStatLine(line, scoring)) < 1e-9,
    'an explanation that does not sum to the total is worse than none');
  assert.equal(bd.parts.filter((p) => p.bonus).length, 2, 'both cleared bonuses are itemised');
});

test('expectedScore ignores non-numeric scoring entries rather than coercing them', () => {
  // Configs carry `_comment` keys and a `bonuses` array; neither is a rate.
  const scoring = { rec: 0.5, _comment: 'a note', bonuses: [] };
  assert.equal(expectedScore({ rec: 10 }, scoring), 5);
});

test('kickers and defenses are priced from their own categories', () => {
  const kScoring = { fg_30_39: 3, fg_40_49: 4, fg_50p: 6, pat_made: 1 };
  assert.ok(expectedPointsAtRank('K', 1, kScoring) > expectedPointsAtRank('K', 24, kScoring));
  const dScoring = { def_sack: 2, def_int: 2, def_td: 6, def_pa_0: 16 };
  assert.ok(expectedPointsAtRank('DEF', 1, dScoring) > expectedPointsAtRank('DEF', 24, dScoring));
});

test('an unknown position yields zero rather than throwing', () => {
  assert.deepEqual(archetypeStatLine('PUNTER', 1), {});
  assert.equal(expectedPointsAtRank('PUNTER', 1, STANDARD), 0);
});
