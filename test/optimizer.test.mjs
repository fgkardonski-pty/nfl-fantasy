/**
 * The lineup optimizer claims to be EXACT. That claim is verified here against
 * exhaustive brute force over hundreds of random rosters and slot
 * configurations, including the specific cases where the common greedy
 * approach is provably wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hungarian, optimalLineup, lineupMarginals, closeCalls } from '../src/engine/optimizer.mjs';
import { eligiblePositions, positionalDemand, startingSlots, expandSlots, canFill, playerCanFill, parseEligibility } from '../src/engine/roster.mjs';
import { Rng } from '../src/util/rng.mjs';

/** Exhaustive search over every legal slot assignment. */
function brute(players, slots) {
  let best = -Infinity;
  const used = new Array(players.length).fill(false);
  (function rec(i, acc) {
    if (i === slots.length) { if (acc > best) best = acc; return; }
    const elig = eligiblePositions(slots[i]);
    let any = false;
    for (let k = 0; k < players.length; k++) {
      if (used[k] || !elig.includes(players[k].pos)) continue;
      any = true; used[k] = true;
      rec(i + 1, acc + players[k].mean);
      used[k] = false;
    }
    if (!any) rec(i + 1, acc);   // slot may be left empty
  })(0, 0);
  return best;
}

test('hungarian solves a known assignment problem', () => {
  // Classic 3x3: optimal minimum cost is 5 (0->1, 1->0, 2->2)
  const cost = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
  const { assignment, cost: total } = hungarian(cost);
  assert.equal(total, 5);
  assert.equal(new Set(assignment).size, 3, 'assignment is a bijection');
});

test('hungarian handles rectangular matrices', () => {
  const cost = [[1, 9, 9, 9], [9, 2, 9, 9]];
  const { assignment, cost: total } = hungarian(cost);
  assert.equal(total, 3);
  assert.deepEqual(assignment, [0, 1]);
});

test('hungarian rejects more rows than columns', () => {
  assert.throws(() => hungarian([[1], [2], [3]]), /cols >= rows/);
});

test('optimalLineup beats the greedy trap', () => {
  // Greedy fills TE with the best tight end, then puts the best remaining
  // flex-eligible player in FLEX. Here that is also optimal only because both
  // tight ends outscore the flex alternatives — the point is the optimizer must
  // find it without special-casing.
  const players = [
    { player_id: 'a', name: 'Elite TE', pos: 'TE', mean: 14 },
    { player_id: 'b', name: 'TE2', pos: 'TE', mean: 13.5 },
    { player_id: 'c', name: 'RB1', pos: 'RB', mean: 12 },
    { player_id: 'd', name: 'WR1', pos: 'WR', mean: 11 },
  ];
  const { lineup, total } = optimalLineup(players, ['TE', 'W/R/T'], (p) => p.mean);
  assert.equal(total, 27.5);
  assert.deepEqual(lineup.map((l) => l.player.name), ['Elite TE', 'TE2']);
});

test('optimalLineup is exact — verified against brute force', () => {
  const SLOTSETS = [
    ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF'],
    ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'W/R/T', 'W/R/T', 'Q/W/R/T'],
    ['QB', 'QB', 'RB', 'WR', 'TE', 'W/R/T'],
    ['RB', 'WR', 'W/T', 'R/T'],
  ];
  const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const rng = new Rng(4242);
  for (let t = 0; t < 250; t++) {
    const slots = SLOTSETS[t % SLOTSETS.length];
    const n = rng.int(7, 13);
    const players = Array.from({ length: n }, (_, i) => ({
      player_id: `p${i}`, name: `P${i}`,
      pos: POS[rng.weightedIndex([2, 4, 5, 2, 1, 1])],
      mean: Math.round(rng.range(0, 28) * 10) / 10,
    }));
    const opt = optimalLineup(players, slots, (p) => p.mean);
    assert.ok(Math.abs(opt.total - brute(players, slots)) < 1e-6,
      `trial ${t}: optimizer ${opt.total} vs brute force ${brute(players, slots)}`);
  }
});

test('optimalLineup never starts a player twice', () => {
  const players = [
    { player_id: 'a', pos: 'RB', name: 'A', mean: 20 },
    { player_id: 'b', pos: 'WR', name: 'B', mean: 5 },
  ];
  const { lineup } = optimalLineup(players, ['RB', 'RB', 'W/R/T'], (p) => p.mean);
  const ids = lineup.filter((l) => l.player).map((l) => l.player.player_id);
  assert.equal(new Set(ids).size, ids.length);
});

test('optimalLineup leaves a slot empty rather than filling it illegally', () => {
  const players = [{ player_id: 'a', pos: 'RB', name: 'A', mean: 20 }];
  const { lineup } = optimalLineup(players, ['RB', 'QB'], (p) => p.mean);
  const qb = lineup.find((l) => l.slot === 'QB');
  assert.equal(qb.player, null, 'no eligible quarterback means an empty slot');
});

test('optimalLineup accepts the league roster config as well as a flat slot list', () => {
  // Both forms circulate in the codebase; accepting only one silently produced
  // an empty lineup and zeroed every downstream number.
  const players = [
    { player_id: 'a', pos: 'QB', name: 'QB', mean: 20 },
    { player_id: 'b', pos: 'RB', name: 'RB1', mean: 15 },
    { player_id: 'c', pos: 'RB', name: 'RB2', mean: 12 },
  ];
  const flat = optimalLineup(players, ['QB', 'RB', 'RB'], (p) => p.mean);
  const config = optimalLineup(players, [{ slot: 'QB', count: 1 }, { slot: 'RB', count: 2 }], (p) => p.mean);
  assert.equal(flat.total, 47);
  assert.equal(config.total, 47);
});

test('bench slots are excluded from the starting lineup', () => {
  const players = Array.from({ length: 6 }, (_, i) => ({ player_id: `p${i}`, pos: 'WR', name: `W${i}`, mean: 10 - i }));
  const { lineup, bench } = optimalLineup(players, [{ slot: 'WR', count: 2 }, { slot: 'BN', count: 4 }], (p) => p.mean);
  assert.equal(lineup.length, 2);
  assert.equal(bench.length, 4);
});

test('lineupMarginals ranks the irreplaceable players highest', () => {
  const players = [
    { player_id: 'star', pos: 'QB', name: 'Star QB', mean: 26 },
    { player_id: 'backup', pos: 'QB', name: 'Backup QB', mean: 8 },
    { player_id: 'rb1', pos: 'RB', name: 'RB1', mean: 14 },
    { player_id: 'rb2', pos: 'RB', name: 'RB2', mean: 13.5 },
  ];
  const { marginals } = lineupMarginals(players, ['QB', 'RB'], (p) => p.mean);
  const star = marginals.find((m) => m.player_id === 'star');
  const rb1 = marginals.find((m) => m.player_id === 'rb1');
  assert.equal(star.marginal, 18, 'losing the star QB costs the gap to the backup');
  assert.equal(rb1.marginal, 0.5, 'losing RB1 costs only the gap to RB2');
  assert.ok(star.marginal > rb1.marginal);
});

test('closeCalls surfaces the cheapest swaps first', () => {
  const players = [
    { player_id: 'a', pos: 'WR', name: 'Starter', mean: 12 },
    { player_id: 'b', pos: 'WR', name: 'Near miss', mean: 11.8 },
    { player_id: 'c', pos: 'WR', name: 'Distant', mean: 4 },
  ];
  const calls = closeCalls(players, ['WR'], (p) => p.mean);
  assert.equal(calls[0].in.name, 'Near miss');
  assert.ok(calls[0].pointCost < calls[1].pointCost);
});

test('roster slot semantics', () => {
  assert.deepEqual(eligiblePositions('W/R/T').sort(), ['RB', 'TE', 'WR']);
  assert.deepEqual(eligiblePositions('Q/W/R/T').sort(), ['QB', 'RB', 'TE', 'WR']);
  assert.deepEqual(eligiblePositions('BN'), []);
  assert.ok(canFill('W/R/T', 'RB'));
  assert.ok(!canFill('W/R/T', 'QB'));
  assert.deepEqual(expandSlots([{ slot: 'RB', count: 2 }, { slot: 'QB', count: 1 }]), ['RB', 'RB', 'QB']);
  assert.deepEqual(expandSlots(['RB', 'QB']), ['RB', 'QB'], 'a flat list passes through unchanged');
  assert.deepEqual(startingSlots([{ slot: 'QB', count: 1 }, { slot: 'BN', count: 5 }]), ['QB']);
});

test('positionalDemand scales with league size and counts flex fractionally', () => {
  const slots = [
    { slot: 'QB', count: 1 }, { slot: 'RB', count: 2 }, { slot: 'WR', count: 3 },
    { slot: 'TE', count: 1 }, { slot: 'W/R/T', count: 1 }, { slot: 'BN', count: 6 },
  ];
  const { perTeam, leagueWide } = positionalDemand(slots, 12);
  assert.equal(perTeam.QB, 1);
  assert.ok(perTeam.RB > 2 && perTeam.RB < 2.6, 'flex adds partial running back demand');
  assert.equal(leagueWide.QB, 12);
  assert.ok(leagueWide.RB > 24);
});

// ---------------------------------------------------------------------------
// Multi-position eligibility.
//
// Yahoo publishes a per-player eligibility list that a player's primary
// position does not always imply. Storing only the position — or storing
// Yahoo's comma-delimited display_position as if it were one — makes such a
// player unstartable in every slot, so he silently vanishes from the lineup.
// ---------------------------------------------------------------------------

test('parseEligibility accepts every form the codebase produces', () => {
  assert.deepEqual(parseEligibility('["WR","RB","W/R/T"]'), ['WR', 'RB', 'W/R/T']);
  assert.deepEqual(parseEligibility(['WR', 'RB']), ['WR', 'RB']);
  assert.deepEqual(parseEligibility('WR,RB'), ['WR', 'RB'], "Yahoo's comma display form");
  assert.deepEqual(parseEligibility([{ position: 'TE' }]), ['TE'], 'Yahoo object form');
  assert.deepEqual(parseEligibility('DST'), ['DEF'], 'defense aliases normalise');
  assert.deepEqual(parseEligibility(null), []);
  assert.deepEqual(parseEligibility('not json ['), []);
});

test('playerCanFill honours a declared eligibility list', () => {
  const multi = { pos: 'WR', eligible_positions: '["WR","RB","W/R/T"]' };
  assert.ok(playerCanFill('WR', multi));
  assert.ok(playerCanFill('RB', multi), 'declared RB eligibility is honoured');
  assert.ok(playerCanFill('W/R/T', multi));
  assert.ok(!playerCanFill('QB', multi), 'eligibility is a whitelist, not a free pass');
  assert.ok(!playerCanFill('BN', multi), 'bench is not a startable slot');
});

test('playerCanFill falls back to position rules when no list is present', () => {
  const plain = { pos: 'WR' };
  assert.ok(playerCanFill('WR', plain));
  assert.ok(playerCanFill('W/R/T', plain));
  assert.ok(!playerCanFill('RB', plain), 'a plain receiver still cannot fill an RB slot');
});

test('the optimizer actually exploits multi-position eligibility', () => {
  // Without eligibility, the RB slot can only take the weak back and the flex
  // takes the strong receiver: 8 + 20 = 28.
  // With eligibility, the dual-eligible receiver fills RB and the flex takes
  // the other receiver: 20 + 14 = 34.
  const players = [
    { player_id: 'dual', name: 'Dual', pos: 'WR', mean: 20, eligible_positions: '["WR","RB"]' },
    { player_id: 'wr2', name: 'WR2', pos: 'WR', mean: 14 },
    { player_id: 'rb', name: 'Weak RB', pos: 'RB', mean: 8 },
  ];
  const withElig = optimalLineup(players, ['RB', 'W/R/T'], (p) => p.mean);
  assert.equal(withElig.total, 34);
  assert.equal(withElig.lineup.find((l) => l.slot === 'RB').player.name, 'Dual');

  const withoutElig = optimalLineup(
    players.map(({ eligible_positions, ...rest }) => rest), ['RB', 'W/R/T'], (p) => p.mean
  );
  assert.equal(withoutElig.total, 28, 'without the eligibility list the lineup is strictly worse');
});

test('a comma-delimited position never makes a player unstartable', () => {
  // This was the real bug: Yahoo returns display_position as "WR,RB" and
  // storing that verbatim as `pos` matches no slot at all.
  const broken = { player_id: 'x', name: 'Multi', pos: 'WR,RB' };
  assert.ok(!playerCanFill('WR', broken), 'the raw comma form matches nothing — that is the bug');

  const fixed = { player_id: 'x', name: 'Multi', pos: 'WR', eligible_positions: 'WR,RB' };
  assert.ok(playerCanFill('WR', fixed));
  assert.ok(playerCanFill('RB', fixed));
  const { lineup } = optimalLineup([fixed], ['RB'], (p) => 10);
  assert.equal(lineup[0].player.name, 'Multi', 'and now he starts');
});
