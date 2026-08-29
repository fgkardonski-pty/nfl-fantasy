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

// ---------------------------------------------------------------------------
// Bye-week stacking
// ---------------------------------------------------------------------------

/**
 * Drafting several starters who are all off in the same week is a real cost,
 * but a narrow one — a single week, and only for the players the bench cannot
 * cover. These pin that it is priced as a tiebreaker and never as a reason to
 * pass on a clearly better player, which would be the worse mistake.
 */
test('a bye week nobody else on the roster shares costs nothing', async () => {
  const { byeCollisionPenalty } = await import('../src/engine/draft.mjs');
  const roster = [{ bye_week: 7 }, { bye_week: 9 }, { bye_week: 11 }];
  assert.equal(byeCollisionPenalty({ bye_week: 5, vor: 20 }, roster, 5), 0);
});

test('the bench absorbs the first collisions before any penalty applies', async () => {
  const { byeCollisionPenalty } = await import('../src/engine/draft.mjs');
  // Everyone has a bye somewhere; one overlap is normal roster construction.
  assert.equal(byeCollisionPenalty({ bye_week: 7, vor: 20 }, [{ bye_week: 7 }], 5), 0);
});

test('stacking past what the bench covers costs, and scales with what is lost', async () => {
  const { byeCollisionPenalty } = await import('../src/engine/draft.mjs');
  const stacked = [{ bye_week: 7 }, { bye_week: 7 }, { bye_week: 7 }];
  const elite = byeCollisionPenalty({ bye_week: 7, vor: 20 }, stacked, 5);
  const marginal = byeCollisionPenalty({ bye_week: 7, vor: 2 }, stacked, 5);
  assert.ok(elite > 0, 'a fourth starter on the same bye is a real cost');
  assert.ok(elite > marginal, 'colliding elite production costs more than colliding filler');
});

test('the penalty stays small enough to be a tiebreaker, not a veto', async () => {
  const { byeCollisionPenalty } = await import('../src/engine/draft.mjs');
  const stacked = [{ bye_week: 7 }, { bye_week: 7 }, { bye_week: 7 }, { bye_week: 7 }];
  const vor = 20;
  const penalty = byeCollisionPenalty({ bye_week: 7, vor }, stacked, 5);
  // A bye collision is one week of a fourteen-week season. If this ever grew
  // large enough to outweigh a real VOR gap, the board would start ducking
  // better players to tidy up a calendar.
  assert.ok(penalty < vor * 0.25,
    `penalty ${penalty.toFixed(2)} must stay well under the value it is weighed against`);
});

test('a player with no recorded bye week is never penalised', async () => {
  const { byeCollisionPenalty } = await import('../src/engine/draft.mjs');
  // Free agents in the rankings export carry no bye; absent data must not read
  // as "week 0" and collide with everyone else missing one.
  const roster = [{ bye_week: null }, { bye_week: null }, { bye_week: null }];
  assert.equal(byeCollisionPenalty({ bye_week: null, vor: 20 }, roster, 5), 0);
  assert.equal(byeCollisionPenalty({ bye_week: 0, vor: 20 }, roster, 5), 0);
});

// ---------------------------------------------------------------------------
// Roster fit: value this roster can actually use
// ---------------------------------------------------------------------------

/**
 * VOR measures a player against a replacement-level STARTER, which is the right
 * question only while he would start. Once his position's slots are filled he
 * is a bench player, and these pin that the score reflects it.
 *
 * The defect this guards against was live: roster need added for an empty slot
 * but nothing subtracted for a full one, so a second quarterback in a
 * one-quarterback league carried a starter's whole value and was recommended
 * first overall over a running back at a completely unfilled position.
 */
const ONE_QB = [
  { slot: 'QB', count: 1 }, { slot: 'RB', count: 2 }, { slot: 'WR', count: 2 },
  { slot: 'TE', count: 1 }, { slot: 'W/R', count: 1 }, { slot: 'BN', count: 6 },
];

test('the first player at an empty position is worth all of his value', async () => {
  const { rosterFit } = await import('../src/engine/draft.mjs');
  assert.equal(rosterFit('QB', [], ONE_QB, 12), 1);
  assert.equal(rosterFit('RB', [], ONE_QB, 12), 1);
});

test('a second QB in a one-QB league is worth a fraction of a starter', async () => {
  const { rosterFit } = await import('../src/engine/draft.mjs');
  const fit = rosterFit('QB', [{ pos: 'QB' }], ONE_QB, 12);
  assert.ok(fit < 0.4, `a backup QB who will not play cannot keep most of his value (got ${fit})`);
  assert.ok(fit > 0, 'but he is not worthless — byes, injuries and trade value are real');
});

test('running back depth keeps far more value than a backup kicker', async () => {
  const { rosterFit } = await import('../src/engine/draft.mjs');
  // Backs get hurt and flex slots are hungry, so RB depth starts games. A
  // second kicker never plays a down, because kickers are streamed.
  const rb = rosterFit('RB', [{ pos: 'RB' }, { pos: 'RB' }], ONE_QB, 12);
  const k = rosterFit('K', [{ pos: 'K' }], ONE_QB, 12);
  assert.ok(rb > 0.4, `RB depth is genuinely useful (got ${rb})`);
  assert.ok(k < 0.15, `a second kicker is a wasted roster spot (got ${k})`);
  assert.ok(rb > k * 3);
});

test('a superflex league does not discount the second quarterback', async () => {
  const { rosterFit } = await import('../src/engine/draft.mjs');
  // Demand comes from the league's own slots, so this needs no special case —
  // but it only works if a QB-eligible flex is understood to be a QB slot in
  // practice, which is the whole premise of superflex.
  const SUPERFLEX = [
    { slot: 'QB', count: 1 }, { slot: 'Q/W/R/T', count: 1 }, { slot: 'RB', count: 2 },
    { slot: 'WR', count: 2 }, { slot: 'TE', count: 1 }, { slot: 'BN', count: 6 },
  ];
  const second = rosterFit('QB', [{ pos: 'QB' }], SUPERFLEX, 12);
  assert.ok(second > 0.7, `the second QB starts every week in superflex (got ${second})`);
  assert.ok(second > rosterFit('QB', [{ pos: 'QB' }], ONE_QB, 12) * 2);
  // The third is a genuine backup again.
  assert.ok(rosterFit('QB', [{ pos: 'QB' }, { pos: 'QB' }], SUPERFLEX, 12) < 0.4);
});

test('a filled position cannot outrank an empty one on equal value', async () => {
  const { recommendPick } = await import('../src/engine/draft.mjs');
  const mk = (id, pos, mean) => ({ player_id: id, name: id, pos, mean, sd: mean * 0.35, adp: 20, games: 5, status: '' });
  // A deep field at each position so replacement level is meaningful.
  const available = [];
  for (let i = 0; i < 40; i++) {
    available.push(mk(`qb${i}`, 'QB', 30 - i * 0.4));
    available.push(mk(`rb${i}`, 'RB', 30 - i * 0.4));
    available.push(mk(`wr${i}`, 'WR', 20 - i * 0.3));
    available.push(mk(`te${i}`, 'TE', 14 - i * 0.3));
  }
  const rec = recommendPick({
    available,
    myRoster: [mk('mine', 'QB', 30)],   // my QB slot is already filled
    rosterSlots: ONE_QB, numTeams: 12,
    pickNumber: 20, nextPickNumber: 29, opponents: [], sims: 40, limit: 5,
  });
  assert.notEqual(rec.board[0].pos, 'QB',
    `with the QB slot filled and RBs of equal value on the board, the top pick must not be a QB (got ${rec.board[0].name})`);
});

// ---------------------------------------------------------------------------
// The opponent model must predict OPPONENTS, not us
// ---------------------------------------------------------------------------

/**
 * The rivals in the room do not share our valuation. Where a player has a real
 * ADP, that ADP predicts when he leaves the board — and the whole edge of a
 * scoring-aware valuation is knowing that the market has NOT priced a player
 * the way this league's rules do.
 *
 * The defect: the composite rank took the better of ADP and our own valuation,
 * so a quarterback our model loved was assumed to be loved by everyone. In a
 * QB-premium league that meant a QB with an ADP of 55 was modelled as the first
 * pick of the draft, reported as unlikely to survive, and urgently recommended
 * — when in truth he was available two rounds later and the early pick should
 * have gone elsewhere. The engine destroyed the exact advantage it exists to
 * find.
 */
test('a real ADP is used as-is, not overridden by our own valuation', async () => {
  const { draftRanks } = await import('../src/engine/draft.mjs');
  const ranks = draftRanks([
    // We rate him best in the pool; the market has him going in round four.
    { player_id: 'undervalued', pos: 'QB', vor: 99, adp: 55 },
    { player_id: 'consensus', pos: 'RB', vor: 10, adp: 1 },
  ]);
  assert.equal(ranks.get('undervalued'), 55,
    'opponents draft him at his ADP, however much we like him');
  assert.equal(ranks.get('consensus'), 1);
});

test('our valuation still fills in for players the market has no opinion on', async () => {
  const { draftRanks } = await import('../src/engine/draft.mjs');
  // Without this, a player with no ADP sits at the back of every shortlist, is
  // never taken by the model, survives every simulation, and collapses VONA for
  // his whole position.
  const ranks = draftRanks([
    { player_id: 'known', pos: 'RB', vor: 5, adp: 30 },
    { player_id: 'breakout', pos: 'RB', vor: 40, adp: null },
    { player_id: 'filler', pos: 'WR', vor: 1, adp: null },
  ]);
  assert.equal(ranks.get('known'), 30);
  assert.equal(ranks.get('breakout'), 1, 'top of our board stands in for a missing ADP');
  assert.ok(ranks.get('filler') > ranks.get('breakout'));
});

test('a player the market undervalues is reported as likely to survive', async () => {
  const { computeVona } = await import('../src/engine/draft.mjs');
  const pool = [];
  // A field of consensus players who will go early...
  for (let i = 0; i < 60; i++) {
    pool.push({ player_id: `c${i}`, name: `C${i}`, pos: i % 2 ? 'RB' : 'WR', mean: 20 - i * 0.2, vor: 15 - i * 0.2, adp: i + 1 });
  }
  // ...and one our scoring loves who the market takes in round five.
  pool.push({ player_id: 'sleeper', name: 'Sleeper QB', pos: 'QB', mean: 50, vor: 18, adp: 70 });

  const { survivalProb } = computeVona(pool, {
    pickNumber: 5, nextPickNumber: 30, opponents: [{ bias: {} }], sims: 200, seed: 4,
  });
  const survives = survivalProb.get('sleeper');
  assert.ok(survives > 0.8,
    `an ADP-70 player should almost certainly last to pick 30 (got ${(survives * 100).toFixed(0)}%)`);
  // The consensus RB1 should not.
  assert.ok(survivalProb.get('c1') < 0.5);
});

test('waiting is preferred when the value will still be there', async () => {
  const { recommendPick } = await import('../src/engine/draft.mjs');
  const available = [];
  for (let i = 0; i < 50; i++) {
    available.push({ player_id: `rb${i}`, name: `RB${i}`, pos: 'RB', mean: 26 - i * 0.55, sd: 6, adp: i + 1, games: 5, status: '' });
    available.push({ player_id: `wr${i}`, name: `WR${i}`, pos: 'WR', mean: 21 - i * 0.3, sd: 5, adp: i + 1, games: 5, status: '' });
    // Quarterbacks the market ignores until much later.
    available.push({ player_id: `qb${i}`, name: `QB${i}`, pos: 'QB', mean: 50 - i * 0.6, sd: 9, adp: 55 + i, games: 5, status: '' });
  }
  const rec = recommendPick({
    available, myRoster: [],
    rosterSlots: [{ slot: 'QB', count: 1 }, { slot: 'RB', count: 2 }, { slot: 'WR', count: 2 }, { slot: 'BN', count: 6 }],
    numTeams: 16, pickNumber: 5, nextPickNumber: 30, opponents: [], sims: 120, limit: 5,
  });
  // The scarce asset is the one that will be gone. Taking the QB here spends an
  // early pick on a player still available two rounds later.
  assert.notEqual(rec.board[0].pos, 'QB',
    `should take the player who will be gone, not the one who will not (got ${rec.board[0].name})`);
  assert.ok(rec.vona.QB.vona < rec.vona.RB.vona,
    'waiting must cost less at the position the market has not bid up');
});

// ---------------------------------------------------------------------------
// The turn: back-to-back picks are one decision
// ---------------------------------------------------------------------------

/**
 * At the turn of a snake the first and last seats pick twice in a row. Seat 16
 * of 16 holds picks 16 and 17 with nobody in between, and that repeats every
 * round — 48/49, 80/81, and so on.
 *
 * Measuring the horizon as "my next pick" spans a single pick during which no
 * opponent chooses, so nothing can be taken, every player survives with
 * certainty, and every VONA is zero. The board loses its entire notion of
 * scarcity — and for a turn seat that is HALF the draft advised blind, which is
 * exactly the seat where reading the run of picks matters most.
 */
test('consecutive own picks are treated as one decision', async () => {
  const { nextContestedPick, snakePicks } = await import('../src/engine/draft.mjs');
  assert.deepEqual(snakePicks(16, 16, 4), [16, 17, 48, 49]);

  // Picks 16 and 17 are back to back; the next time opponents choose before me
  // is pick 48.
  assert.equal(nextContestedPick(16, 16, 16, 16), 48, 'from the first of the pair');
  assert.equal(nextContestedPick(17, 16, 16, 16), 48, 'and from the second');
});

test('a mid-board seat is unaffected, since its picks are never adjacent', async () => {
  const { nextContestedPick } = await import('../src/engine/draft.mjs');
  // Seat 3 holds 3, 30, 35 — always with opponents in between.
  assert.equal(nextContestedPick(3, 3, 16, 16), 30);
  assert.equal(nextContestedPick(30, 3, 16, 16), 35);
});

test('seat 1 turns from the second round onward', async () => {
  const { nextContestedPick } = await import('../src/engine/draft.mjs');
  // 1, then 32 and 33 back to back, then 64 and 65.
  assert.equal(nextContestedPick(1, 1, 16, 16), 32, 'the opening pick has a full round ahead of it');
  assert.equal(nextContestedPick(32, 1, 16, 16), 64, 'but 32 and 33 are one decision');
  assert.equal(nextContestedPick(33, 1, 16, 16), 64);
});

test('at the turn, scarcity is measured rather than collapsing to zero', async () => {
  const { recommendPick, nextContestedPick } = await import('../src/engine/draft.mjs');
  const available = [];
  for (let i = 0; i < 60; i++) {
    available.push({ player_id: `rb${i}`, name: `RB${i}`, pos: 'RB', mean: 26 - i * 0.5, sd: 6, adp: i + 1, games: 5, status: '' });
    available.push({ player_id: `wr${i}`, name: `WR${i}`, pos: 'WR', mean: 21 - i * 0.28, sd: 5, adp: i + 1, games: 5, status: '' });
  }
  const slots = [{ slot: 'QB', count: 1 }, { slot: 'RB', count: 2 }, { slot: 'WR', count: 2 }, { slot: 'BN', count: 6 }];
  const common = {
    available, myRoster: [], rosterSlots: slots, numTeams: 16,
    pickNumber: 16, opponents: [{ bias: {} }], sims: 120, limit: 3,
  };

  const naive = recommendPick({ ...common, nextPickNumber: 17 });
  const real = recommendPick({ ...common, nextPickNumber: nextContestedPick(16, 16, 16, 16) });

  assert.equal(naive.vona.RB.vona, 0, 'with no opponent picks in between, nothing can be lost');
  assert.ok(real.vona.RB.vona > 0.5,
    `over a real horizon the position does fall off (got ${real.vona.RB.vona.toFixed(2)})`);
  assert.ok(real.board[0].survivalToNextPick < 0.9,
    'and the best player is no longer certain to last');
});

// ---------------------------------------------------------------------------
// Roster need must respect what each flex slot can actually take
// ---------------------------------------------------------------------------

/**
 * Flex demand was spread evenly over RB, WR and TE with a flat constant. That
 * is right only for a W/R/T flex. Given a W/T and a W/R — a back cannot fill
 * the first, a tight end cannot fill the second, and a receiver fills either —
 * it overstated tight ends by half and understated receivers by a quarter.
 *
 * Replacement levels already read eligibility correctly, so the engine was
 * disagreeing with itself about the same league while roster need drove what
 * got drafted.
 */
const TWO_DISTINCT_FLEX = [
  { slot: 'QB', count: 1 }, { slot: 'WR', count: 1 }, { slot: 'RB', count: 1 },
  { slot: 'TE', count: 1 }, { slot: 'W/T', count: 1 }, { slot: 'W/R', count: 1 },
  { slot: 'K', count: 1 }, { slot: 'DEF', count: 1 }, { slot: 'BN', count: 5 },
];

test('need matches the demand replacement levels are computed from', async () => {
  const { rosterNeed } = await import('../src/engine/draft.mjs');
  const { positionalDemand } = await import('../src/engine/roster.mjs');
  const need = rosterNeed([], TWO_DISTINCT_FLEX);
  const { perTeam } = positionalDemand(TWO_DISTINCT_FLEX, 1);
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    assert.ok(Math.abs(need[pos] - perTeam[pos]) < 1e-9,
      `${pos}: need ${need[pos]} must equal demand ${perTeam[pos]} — one engine, one answer`);
  }
});

test('a receiver eligible for both flexes is needed more than a tight end', async () => {
  const { rosterNeed } = await import('../src/engine/draft.mjs');
  const need = rosterNeed([], TWO_DISTINCT_FLEX);
  assert.ok(need.WR > need.RB, 'WR fills both flex slots, RB only one');
  assert.ok(need.RB > need.TE, 'and RB is favoured over TE in the W/R it shares');
  assert.ok(need.WR > 2, `WR demand exceeds its one dedicated slot (got ${need.WR.toFixed(2)})`);
  assert.ok(need.TE < 1.5, `TE demand barely exceeds its one slot (got ${need.TE.toFixed(2)})`);
});

test('a combined W/R/T flex still splits between the three that can fill it', async () => {
  const { rosterNeed } = await import('../src/engine/draft.mjs');
  const combined = [
    { slot: 'QB', count: 1 }, { slot: 'WR', count: 1 }, { slot: 'RB', count: 1 },
    { slot: 'TE', count: 1 }, { slot: 'W/R/T', count: 2 }, { slot: 'BN', count: 5 },
  ];
  const need = rosterNeed([], combined);
  assert.ok(need.RB > 1 && need.WR > 1 && need.TE > 1, 'all three carry flex demand here');
  assert.equal(need.QB, 1, 'a position with no flex eligibility is untouched');
});

test('filling a slot reduces need for that position only', async () => {
  const { rosterNeed } = await import('../src/engine/draft.mjs');
  const empty = rosterNeed([], TWO_DISTINCT_FLEX);
  const withRb = rosterNeed([{ pos: 'RB' }], TWO_DISTINCT_FLEX);
  assert.ok(withRb.RB < empty.RB);
  assert.equal(withRb.WR, empty.WR, 'taking a back does not reduce the need for receivers');
  assert.ok(withRb.RB >= 0, 'need never goes negative');
  // Over-filling a position bottoms out rather than going negative.
  const many = rosterNeed([{ pos: 'TE' }, { pos: 'TE' }, { pos: 'TE' }], TWO_DISTINCT_FLEX);
  assert.equal(many.TE, 0);
});
