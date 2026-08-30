/**
 * Rebuilding rosters from the pick order.
 *
 * The whole platform was reporting zeroes because only one team's roster was
 * ever saved: no opponent to simulate against, no league to price a trade in,
 * no field to compute playoff odds over. A snake draft's seat is fully
 * determined by pick number and league size, so the ordered pick log the live
 * board already keeps is enough to rebuild all sixteen.
 *
 * The risk it carries is an offset. One pick nobody marked shifts every later
 * pick by one seat, producing a full set of rosters that are wrong in a way
 * nothing downstream can detect — so the reconstruction is checked against the
 * picks the manager claimed as their own before any of it is trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { seatForPick, rostersFromPickOrder, snakePicks } = await import('../src/engine/draft.mjs');

test('seatForPick snakes, and agrees with snakePicks in both directions', () => {
  assert.equal(seatForPick(1, 16), 1);
  assert.equal(seatForPick(16, 16), 16);
  // The turn: seat 16 picks 16 and 17 back to back.
  assert.equal(seatForPick(17, 16), 16);
  assert.equal(seatForPick(32, 16), 1);
  assert.equal(seatForPick(33, 16), 1);

  // Every seat's picks, derived forwards, must match the list derived backwards.
  for (let slot = 1; slot <= 16; slot++) {
    const expected = snakePicks(slot, 16, 16);
    const actual = [];
    for (let pick = 1; pick <= 16 * 16; pick++) if (seatForPick(pick, 16) === slot) actual.push(pick);
    assert.deepEqual(actual, expected, `seat ${slot}`);
  }
});

test('a complete pick log splits into one roster per seat', () => {
  const drafted = Array.from({ length: 16 * 3 }, (_, i) => `p${i + 1}`);
  const r = rostersFromPickOrder(drafted, 16, { mySeat: 4, mine: ['p4', 'p29', 'p36'] });

  assert.equal(r.seats.size, 16);
  assert.equal(r.rounds, 3);
  for (const ids of r.seats.values()) assert.equal(ids.length, 3, 'three rounds, three picks each');

  // Seat 4 picks 4th, then 29th (round 2 reverses: 16..1 → seat 4 is 13th of
  // that round, pick 29), then 36th.
  assert.deepEqual(r.seats.get(4), ['p4', 'p29', 'p36']);
  assert.equal(r.verified, true);
});

test('a pick log missing an entry is rejected, not silently misattributed', () => {
  // 48 picks were made; one was never marked. Every pick after the gap now
  // belongs to the seat before it, and seat 4's roster quietly becomes someone
  // else's players.
  const full = Array.from({ length: 48 }, (_, i) => `p${i + 1}`);
  const withGap = full.filter((id) => id !== 'p20');

  const r = rostersFromPickOrder(withGap, 16, { mySeat: 4, mine: ['p4', 'p29', 'p36'] });
  assert.equal(r.verified, false, 'the inconsistency is detected');
  assert.ok(r.mismatch.derivedNotMarked.length || r.mismatch.markedNotDerived.length,
    'and it says which picks disagree');
});

test('verification is skipped rather than guessed when we cannot check it', () => {
  const drafted = ['a', 'b', 'c', 'd'];
  assert.equal(rostersFromPickOrder(drafted, 4).verified, null, 'no seat and no claims means no verdict');
  assert.equal(rostersFromPickOrder(drafted, 4, { mySeat: 2 }).verified, null);
});

test('a partial final round leaves the later seats one pick short, not misaligned', () => {
  // Drafts get abandoned mid-round. The seats that did pick must still be right.
  const drafted = Array.from({ length: 20 }, (_, i) => `p${i + 1}`);
  const r = rostersFromPickOrder(drafted, 16, { mySeat: 4, mine: ['p4'] });

  assert.deepEqual(r.seats.get(16), ['p16', 'p17'], 'the turn seat has both of its picks');
  assert.deepEqual(r.seats.get(4), ['p4'], 'a seat yet to pick again has just the one');
  assert.equal(r.seats.has(1), true);
  assert.equal(r.verified, true);
});
