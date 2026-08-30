/**
 * Defense streaming.
 *
 * This league pays for defenses well above the Yahoo default — two points a
 * sack, sixteen for a shutout, a point per tackle for loss — so the weekly
 * spread between the best and worst startable defense is wide, and a defense
 * costs nothing to acquire. That combination makes streaming the cheapest real
 * edge available. It is also the easiest place to produce confident nonsense,
 * because a ranking built on a synthetic schedule looks exactly like one built
 * on a real slate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { rankStreamers, expectedDefenseWeek, claimRisk } = await import('../src/engine/streaming.mjs');
const fs = await import('node:fs/promises');
const SCORING = JSON.parse(await fs.readFile('fantazy-fulzbol.json', 'utf8')).scoring;

const unit = { def_sack: 2.6, def_int: 0.8, def_fum_rec: 0.5, def_tfl: 6.0, def_4th_down_stop: 0.5 };
const defense = (nfl_team, over = {}) => ({
  player_id: `d-${nfl_team}`, name: `${nfl_team} Defense`, nfl_team, unit, ...over,
});
const game = (home, away, ih, ia, over = {}) => ({
  season: 2026, week: 1, home, away, implied_home: ih, implied_away: ia, source: 'real', ...over,
});

test('a soft matchup is worth several points more than a hard one', () => {
  const soft = expectedDefenseWeek({ impliedOpponentTotal: 15, scoring: SCORING, unit });
  const hard = expectedDefenseWeek({ impliedOpponentTotal: 29, scoring: SCORING, unit });

  assert.ok(soft.mean > hard.mean, 'facing a weaker offence is worth more');
  // The whole case for streaming rests on this gap being large enough to be
  // worth a roster move. If it collapses to noise the feature is pointless.
  assert.ok(soft.mean - hard.mean > 3,
    `matchup swing was only ${(soft.mean - hard.mean).toFixed(1)} points — too small to act on`);
  assert.ok(soft.matchupSwing > 0 && hard.matchupSwing < 0,
    'swing is measured against a neutral matchup, so it signs correctly either way');
});

test('the same defense is priced differently by opponent, and points allowed drives it', () => {
  const soft = expectedDefenseWeek({ impliedOpponentTotal: 15, scoring: SCORING, unit });
  const hard = expectedDefenseWeek({ impliedOpponentTotal: 29, scoring: SCORING, unit });
  // Unit production moves a little with the matchup but must not be the bulk
  // of the difference, or a great defense would be double-counted.
  const paGap = soft.pointsAllowedValue - hard.pointsAllowedValue;
  const unitGap = soft.unitValue - hard.unitValue;
  assert.ok(paGap > unitGap, 'points allowed, not unit production, is the streaming signal');
  assert.ok(unitGap > 0, 'unit production still tilts with the matchup, just less');

  // The tilt is capped at ±15%, so unit production can never run away with the
  // ranking however extreme the line. Asserting the cap rather than a ratio
  // keeps this test meaningful if the balance is ever retuned.
  const flat = expectedDefenseWeek({ impliedOpponentTotal: 22.5, scoring: SCORING, unit });
  assert.ok(soft.unitValue <= flat.unitValue * 1.15 + 1e-9);
  assert.ok(hard.unitValue >= flat.unitValue * 0.85 - 1e-9);
});

test('a ranking is refused rather than guessed when the schedule is synthetic', () => {
  const r = rankStreamers({
    defenses: [defense('ARI'), defense('SF')],
    games: [game('ARI', 'SF', 21, 24, { source: 'demo' })],
    scoring: SCORING,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'synthetic-schedule');
});

test('an untagged slate is refused rather than trusted', () => {
  // Rows written before source tracking existed carry no provenance. If the
  // operator ever ran the demo, those rows are invented fixtures wearing real
  // team abbreviations. Giving them the benefit of the doubt is exactly how a
  // real defense ends up ranked against a game that never existed.
  const r = rankStreamers({
    defenses: [defense('ARI'), defense('SF')],
    games: [game('ARI', 'SF', 21, 24, { source: null })],
    scoring: SCORING,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unverified-schedule');
});

test('a real slate is ranked even when demo rows sit alongside it', () => {
  const r = rankStreamers({
    defenses: [defense('ARI'), defense('SF'), defense('NYJ'), defense('BUF')],
    games: [
      game('ARI', 'SF', 27, 26),
      game('NYJ', 'BUF', 17, 14, { source: 'demo' }),   // stale, must be ignored
    ],
    scoring: SCORING,
  });
  assert.equal(r.ok, true);
  // NYJ would have ranked first on the demo row's soft matchup. It must not
  // appear at all: a leftover fixture cannot promote a defense.
  assert.deepEqual(r.best.map((x) => x.nfl_team).sort(), ['ARI', 'SF']);
});

test('a ranking is refused when the slate carries no betting lines', () => {
  const r = rankStreamers({
    defenses: [defense('ARI')],
    games: [game('ARI', 'SF', null, null)],
    scoring: SCORING,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-lines');
});

test('an empty week is refused, not returned as an empty ranking', () => {
  const r = rankStreamers({ defenses: [defense('ARI')], games: [], scoring: SCORING });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-schedule');
});

test('defenses are ranked by the offence they face, not by their own reputation', () => {
  const r = rankStreamers({
    defenses: [defense('ARI'), defense('SF'), defense('NYJ'), defense('BUF')],
    games: [
      game('ARI', 'SF', 27, 26),     // both face strong offences
      game('NYJ', 'BUF', 17, 14),    // both face weak ones
    ],
    scoring: SCORING,
  });
  assert.equal(r.ok, true);
  // BUF faces the offence implied for 17; NYJ faces the one implied for 14.
  assert.equal(r.best[0].nfl_team, 'NYJ', 'the softest matchup ranks first');
  assert.equal(r.best[0].opponent, 'BUF');
  assert.equal(r.best[0].impliedOpponentTotal, 14);
  assert.ok(r.best.at(-1).impliedOpponentTotal >= 26, 'the hardest matchup ranks last');
});

test('a defense on bye or off the slate is dropped rather than ranked at zero', () => {
  const r = rankStreamers({
    defenses: [defense('ARI'), defense('CLE')],   // CLE has no game
    games: [game('ARI', 'SF', 24, 18)],
    scoring: SCORING,
  });
  assert.equal(r.best.length, 1);
  assert.equal(r.best[0].nfl_team, 'ARI');
});

test('a rostered defense is not offered as a pickup', () => {
  const r = rankStreamers({
    defenses: [defense('NYJ', { rostered: true }), defense('BUF')],
    games: [game('NYJ', 'BUF', 17, 14)],
    scoring: SCORING,
  });
  assert.deepEqual(r.best.map((x) => x.nfl_team), ['BUF']);
});

test('our own defense is the baseline, and a pickup must beat it to be recommended', () => {
  const r = rankStreamers({
    defenses: [defense('ARI'), defense('NYJ'), defense('BUF')],
    games: [game('ARI', 'SF', 24, 13), game('NYJ', 'BUF', 15, 14)],
    scoring: SCORING,
    myDefenseTeam: 'NYJ',
    waiverPriority: 1, leagueSize: 16,
  });
  assert.equal(r.mine.nfl_team, 'NYJ');
  assert.ok(!r.best.some((x) => x.nfl_team === 'NYJ'), 'we are not offered ourselves');
  for (const c of r.best) assert.equal(typeof c.expectedGain, 'number');

  // ARI faces an offence implied for 13; NYJ (ours) faces one implied for 14.
  // That gap is under the threshold, so churning the roster is not advised.
  assert.equal(r.recommended, null, 'a marginal upgrade is not worth a waiver claim');
});

test('waiver priority decides which upgrade is realistic, not just which is best', () => {
  const defenses = [
    defense('NYJ'), defense('BUF'), defense('ARI'), defense('SF'), defense('CLE'), defense('PIT'),
  ];
  const games = [
    game('NYJ', 'BUF', 30, 12),   // BUF faces the softest offence in the slate
    game('ARI', 'SF', 28, 15),
    game('CLE', 'PIT', 26, 20),
  ];
  const first = rankStreamers({ defenses, games, scoring: SCORING, waiverPriority: 1, leagueSize: 16 });
  const last = rankStreamers({ defenses, games, scoring: SCORING, waiverPriority: 16, leagueSize: 16 });

  assert.equal(first.best[0].nfl_team, last.best[0].nfl_team, 'the ranking itself does not move');
  // What moves is what we can plausibly get. At priority 1 the top target is
  // ours for the taking; at 16, twelve managers claim before us.
  assert.ok(last.best[0].claimRisk > first.best[0].claimRisk);
  assert.equal(first.best[0].claimRisk, 0, 'first in the queue takes whoever it wants');
  assert.ok(last.contested.length > 0, 'the back of the queue is told what it will lose');
  assert.notEqual(last.recommended?.nfl_team, undefined, 'and is still given something it can actually win');
});

test('claim risk falls off as a defense sits deeper in the pile', () => {
  const pool = [{}, {}, {}, {}, {}];
  const risks = pool.map((p) => claimRisk(p, pool, 12, 16));
  for (let i = 1; i < risks.length; i++) {
    assert.ok(risks[i] < risks[i - 1], 'each slot deeper is likelier to survive to our turn');
  }
  assert.ok(risks[0] <= 0.95 && risks.at(-1) >= 0);
});
