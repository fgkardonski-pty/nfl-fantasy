/**
 * Sleeper's weekly stat feed is mapped by hand from published documentation
 * rather than from an observed response, because this development environment
 * cannot reach api.sleeper.app at all. That makes the mapping the least
 * verified code in the platform and the easiest place for a silent, positional
 * scoring error — the exact failure mode that has already cost this league a
 * draft. These tests pin the parts a wrong guess would break.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { mapSleeperStats, mapSleeperUsage, SLEEPER_STAT_MAP } = await import('../src/providers/sleeper.mjs');
const { scoreStatLine } = await import('../src/engine/scoring.mjs');
const { expectedScore } = await import('../src/engine/statline.mjs');
const LEAGUE = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile('fantazy-fulzbol.json', 'utf8'))).scoring;

test('a receiver line maps onto the categories this league actually pays for', () => {
  const raw = { rec: 8, rec_yd: 112, rec_td: 1, rec_fd: 5, rec_tgt: 11, rec_40p: 1, fum_lost: 1 };
  const s = mapSleeperStats(raw, 'WR');

  assert.equal(s.rec, 8);
  assert.equal(s.rec_yd, 112);
  assert.equal(s.rec_td, 1);
  // First downs and the 40+ reception are the two rules generic rankings
  // ignore and this league pays real points for. If either failed to map they
  // would score zero and every possession receiver would be undervalued.
  assert.equal(s.rec_first_down, 5);
  assert.equal(s.rec_40, 1);
  assert.equal(s.fum_lost, 1);
  // Targets are usage, not scoring — they must not leak into the stat line.
  assert.equal(s.rec_tgt, undefined);
});

test('rec_fd and rec_td are not confused — they differ by one letter and six points', () => {
  const fd = mapSleeperStats({ rec_fd: 6 }, 'WR');
  const td = mapSleeperStats({ rec_td: 6 }, 'WR');
  assert.equal(fd.rec_first_down, 6);
  assert.equal(fd.rec_td, undefined);
  assert.equal(td.rec_td, 6);
  assert.equal(td.rec_first_down, undefined);

  assert.equal(scoreStatLine(fd, LEAGUE), 3, '6 first downs at 0.5 = 3 points');
  assert.equal(scoreStatLine(td, LEAGUE), 36, '6 touchdowns at 6 = 36 points');
});

test('two-point conversions from all three routes accumulate rather than overwrite', () => {
  // pass_2pt, rush_2pt and rec_2pt all collapse onto one canonical key. A
  // last-write-wins map would score a two-score game as one.
  const s = mapSleeperStats({ pass_2pt: 1, rush_2pt: 1, rec_2pt: 1 }, 'QB');
  assert.equal(s.two_pt, 3);
});

test('return yards go to the defence and nowhere else', () => {
  // The manager corrected this directly: RB/WR/TE score nothing for return
  // yards in this league, and only the DEF unit's return yardage pays (10
  // yards per point, plus 1 at 30 yards). Writing return yards onto a skill
  // player is harmless only while ret_yd is zero — and becomes a silent
  // inflation the moment anyone edits the scoring config.
  const wr = mapSleeperStats({ kr_yd: 40, pr_yd: 25 }, 'WR');
  assert.equal(wr.def_ret_yd, undefined);
  assert.equal(scoreStatLine(wr, LEAGUE), 0, 'a receiver scores nothing for 65 return yards here');

  const def = mapSleeperStats({ kr_yd: 40, pr_yd: 25 }, 'DEF');
  assert.equal(def.def_ret_yd, 65, 'kick and punt return yards are summed');
  // 65 yards at 0.1 = 6.5, plus the flat +1 for crossing 30 in a game.
  assert.equal(scoreStatLine(def, LEAGUE), 7.5);
});

test('a real defensive week scores its points-allowed tier, not zero', () => {
  // The bug this pins: Sleeper publishes BOTH a raw pts_allow total and a flag
  // for the exact bucket. Only the raw total was mapped, and there is no
  // def_pts_allowed rate for the scoring loop to multiply by — so a shutout
  // scored zero for points allowed instead of sixteen. It went unnoticed
  // because the raw total was present and looked like the category was covered.
  const shutout = mapSleeperStats({ pts_allow: 0, pts_allow_0: 1, sack: 3 }, 'DEF');
  assert.equal(shutout.def_pa_0, 1);
  assert.equal(shutout.def_pts_allowed, 0);
  assert.equal(scoreStatLine(shutout, LEAGUE), 16 + 6, 'shutout bonus plus three sacks');

  const blowout = mapSleeperStats({ pts_allow: 38, pts_allow_35p: 1 }, 'DEF');
  assert.equal(scoreStatLine(blowout, LEAGUE), -6);

  for (const [key, target] of [['pts_allow_1_6', 'def_pa_1_6'], ['pts_allow_7_13', 'def_pa_7_13'],
    ['pts_allow_14_20', 'def_pa_14_20'], ['pts_allow_21_27', 'def_pa_21_27'],
    ['pts_allow_28_34', 'def_pa_28_34']]) {
    assert.equal(mapSleeperStats({ [key]: 1 }, 'DEF')[target], 1, `${key} maps to ${target}`);
  }
});

test('the raw points-allowed total is not paid a second time on top of the tier', () => {
  // A real line carries both. The tier is exact and the raw total is what the
  // projection path converts through a distribution; scoring both would pay for
  // the same points allowed twice.
  const real = mapSleeperStats({ pts_allow: 10, pts_allow_7_13: 1 }, 'DEF');
  assert.equal(expectedScore(real, LEAGUE), 6, 'the exact tier wins outright');

  // With no tier flag — the archetype case — the raw average is still converted.
  const archetypeLike = { def_pts_allowed: 10 };
  assert.ok(expectedScore(archetypeLike, LEAGUE) > 0, 'a projection still prices points allowed');
});

test('a defence reads its return yards from the TEAM keys, not a player’s', () => {
  // def_kr_yd / def_pr_yd are the unit's returns; kr_yd / pr_yd are one
  // player's and simply do not appear on a DST row. Reading the player keys for
  // a defence left def_ret_yd unset on every defence in the league, so both the
  // per-yard rate and the +1 at thirty yards scored nothing.
  const d = mapSleeperStats({ def_kr_yd: 48, def_pr_yd: 17, sack: 2 }, 'DEF');
  assert.equal(d.def_ret_yd, 65);
  // 65 * 0.1 = 6.5, +1 for crossing 30, +4 for two sacks.
  assert.equal(scoreStatLine(d, LEAGUE), 11.5);

  // And a defence that only has the player-shaped keys still works, rather than
  // silently scoring nothing.
  assert.equal(mapSleeperStats({ kr_yd: 30 }, 'DEF').def_ret_yd, 30);
});

test('a special-teams fumble recovery counts as a defensive one', () => {
  const d = mapSleeperStats({ fum_rec: 1, def_st_fum_rec: 1 }, 'DEF');
  assert.equal(d.def_fum_rec, 2, 'Yahoo does not split them, so they accumulate');
  assert.equal(scoreStatLine(d, LEAGUE), 4);
});

test('a defence line carries points allowed through for tier scoring', () => {
  const s = mapSleeperStats({ sack: 4, int: 2, fum_rec: 1, tkl_loss: 7, pts_allow: 10, safe: 1 }, 'DEF');
  assert.equal(s.def_sack, 4);
  assert.equal(s.def_int, 2);
  assert.equal(s.def_fum_rec, 1);
  assert.equal(s.def_safety, 1);
  // Tackles for loss are worth a point each here and were entirely absent from
  // the valuation model until this league's scoring was audited.
  assert.equal(s.def_tfl, 7);
  // The raw total is carried for the projection path. No bucket flag was in
  // this blob, so none is set — the tier only appears when Sleeper sends it.
  assert.equal(s.def_pts_allowed, 10);
  assert.equal(s.def_pa_7_13, undefined, 'a tier is never inferred from the raw total');
});

test('zero and missing stats are dropped rather than stored as zeroes', () => {
  const s = mapSleeperStats({ rec: 0, rec_yd: 0, pass_td: 2, gp: 1 }, 'WR');
  assert.deepEqual(Object.keys(s), ['pass_td']);
});

test('mapSleeperStats survives junk without throwing', () => {
  assert.deepEqual(mapSleeperStats(null, 'WR'), {});
  assert.deepEqual(mapSleeperStats(undefined, 'WR'), {});
  assert.deepEqual(mapSleeperStats({ rec: 'not a number' }, 'WR'), {});
});

test('usage shares are computed against team totals, or left null', () => {
  const u = mapSleeperUsage({ off_snp: 45, tm_off_snp: 60, rec_tgt: 9, tm_pass_att: 36 });
  assert.equal(u.snap_pct, 0.75);
  assert.equal(u.target_share, 0.25);
  // No team denominator means no share. An approximated usage number goes
  // straight into a start/sit call, so null is the honest answer.
  assert.equal(mapSleeperUsage({ rec_tgt: 9 })?.target_share ?? null, null);
  assert.equal(mapSleeperUsage({}), null);
});

test('every mapped target is a scoring key this league recognises', () => {
  // Guards against a typo in the map producing a key nothing ever reads —
  // which would score zero forever without any error.
  const known = new Set(Object.keys(LEAGUE).filter((k) => !k.startsWith('_') && k !== 'bonuses'));
  const extra = new Set(['def_pts_allowed', 'def_yds_allowed', 'ret_yd', 'ret_td']);
  for (const target of Object.values(SLEEPER_STAT_MAP)) {
    if (target == null) continue;
    assert.ok(known.has(target) || extra.has(target), `${target} is not a scoring key in this league`);
  }
});
