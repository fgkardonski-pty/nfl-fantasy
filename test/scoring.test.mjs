/** Scoring must reflect the league's real rules, verified by hand computation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoringFromYahoo, scoreStatLine, scoreBreakdown, describeScoring,
  pprValue, receptionPremium, DEFAULT_SCORING, YAHOO_STAT_IDS,
} from '../src/engine/scoring.mjs';
import { SETTINGS_RESPONSE } from './fixtures/yahoo.mjs';
import { root, extractList } from '../src/providers/yahoo/parse.mjs';

test('full PPR hand computation', () => {
  // 8 receptions + 112 receiving yards + 1 TD = 8 + 11.2 + 6 = 25.2
  assert.equal(Math.round(scoreStatLine({ rec: 8, rec_yd: 112, rec_td: 1 }, DEFAULT_SCORING) * 100) / 100, 25.2);
});

test('quarterback hand computation', () => {
  // 312 pass yards (12.48) + 3 pass TD (12) + 1 INT (-1) + 24 rush yards (2.4) = 25.88
  const pts = scoreStatLine({ pass_yd: 312, pass_td: 3, pass_int: 1, rush_yd: 24 }, DEFAULT_SCORING);
  assert.equal(Math.round(pts * 100) / 100, 25.88);
});

test('scoring is driven by the league table, not a hardcoded default', () => {
  const halfPpr = { ...DEFAULT_SCORING, rec: 0.5 };
  const sixPtPass = { ...DEFAULT_SCORING, pass_td: 6 };
  const line = { rec: 8, rec_yd: 112, rec_td: 1 };
  assert.equal(scoreStatLine(line, halfPpr), scoreStatLine(line, DEFAULT_SCORING) - 4);
  assert.equal(
    scoreStatLine({ pass_td: 3 }, sixPtPass),
    scoreStatLine({ pass_td: 3 }, DEFAULT_SCORING) + 6
  );
});

test('unknown stats are ignored rather than silently scored', () => {
  assert.equal(scoreStatLine({ some_stat_we_do_not_price: 999 }, DEFAULT_SCORING), 0);
  assert.equal(scoreStatLine({}, DEFAULT_SCORING), 0);
});

test('scoringFromYahoo maps stat ids to canonical keys', () => {
  const s = scoringFromYahoo([
    { stat_id: '4', value: '0.04' },
    { stat_id: '5', value: '6' },
    { stat_id: '11', value: '0.5' },
    { stat_id: '13', value: '6' },
    { stat_id: '18', value: '-2' },
    { stat_id: '99', value: '0' },     // zero-valued rules are dropped
  ]);
  assert.equal(s.pass_yd, 0.04);
  assert.equal(s.pass_td, 6);
  assert.equal(s.rec, 0.5);
  assert.equal(s.fum_lost, -2);
  assert.ok(!('stat_99' in s), 'a zero modifier is not a scoring rule');
});

test('an empty Yahoo scoring table falls back to a documented default', () => {
  const s = scoringFromYahoo([]);
  assert.deepEqual(s, DEFAULT_SCORING);
});

test('an unrecognised stat id is preserved rather than dropped', () => {
  const s = scoringFromYahoo([{ stat_id: '4', value: '0.04' }, { stat_id: '4242', value: '3' }]);
  assert.equal(s.stat_4242, 3, 'a novel league rule still scores if we have the stat');
  assert.equal(scoreStatLine({ stat_4242: 2 }, s), 6);
});

test('the real Yahoo settings fixture yields half PPR', () => {
  const stats = extractList(root(SETTINGS_RESPONSE), 'stat');
  const s = scoringFromYahoo(stats);
  assert.equal(s.rec, 0.5);
  assert.equal(s.pass_td, 4);
  assert.equal(s.pass_int, -1);
  assert.match(describeScoring(s), /Half PPR/);
  assert.match(describeScoring(s), /4pt pass TD/);
});

test('scoreBreakdown totals to scoreStatLine and is ordered by impact', () => {
  const line = { rec: 8, rec_yd: 112, rec_td: 1, fum_lost: 1 };
  const b = scoreBreakdown(line, DEFAULT_SCORING);
  assert.equal(Math.round(b.total * 100) / 100, Math.round(scoreStatLine(line, DEFAULT_SCORING) * 100) / 100);
  const magnitudes = b.parts.map((p) => Math.abs(p.points));
  assert.deepEqual(magnitudes, [...magnitudes].sort((a, c) => c - a), 'sorted by absolute impact');
});

test('describeScoring and reception premium', () => {
  assert.match(describeScoring(DEFAULT_SCORING), /Full PPR/);
  assert.match(describeScoring({ ...DEFAULT_SCORING, rec: 0 }), /Standard/);
  assert.equal(pprValue(DEFAULT_SCORING), 1);
  // One reception is worth ten receiving yards in full PPR.
  assert.equal(receptionPremium(DEFAULT_SCORING), 10);
  assert.equal(receptionPremium({ rec: 0.5, rec_yd: 0.1 }), 5);
});

test('every mapped stat id has a canonical name', () => {
  for (const [id, key] of Object.entries(YAHOO_STAT_IDS)) {
    assert.ok(typeof key === 'string' && key.length, `stat ${id} maps to a name`);
  }
});
