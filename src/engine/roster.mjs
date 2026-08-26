/**
 * Roster slot semantics.
 *
 * Yahoo expresses lineup requirements as slot codes with multi-position
 * eligibility. Everything that reasons about "can this player start here"
 * goes through this module so FLEX, SUPERFLEX and odd commissioner setups are
 * handled in exactly one place.
 */

/** Slot code -> the set of player positions eligible to fill it. */
export const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  DST: ['DEF'],
  'W/R': ['WR', 'RB'],
  'W/T': ['WR', 'TE'],
  'R/T': ['RB', 'TE'],
  'W/R/T': ['WR', 'RB', 'TE'],
  FLEX: ['WR', 'RB', 'TE'],
  'Q/W/R/T': ['QB', 'WR', 'RB', 'TE'],
  SUPERFLEX: ['QB', 'WR', 'RB', 'TE'],
  OP: ['QB', 'WR', 'RB', 'TE'],
  BN: [],
  IR: [],
  'IR+': [],
  NA: [],
};

export const BENCH_SLOTS = new Set(['BN', 'IR', 'IR+', 'NA']);

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

export function eligiblePositions(slot) {
  return SLOT_ELIGIBILITY[slot] ?? (POSITIONS.includes(slot) ? [slot] : []);
}

export function canFill(slot, pos) {
  return eligiblePositions(slot).includes(pos);
}

export function isStartingSlot(slot) {
  return !BENCH_SLOTS.has(slot) && eligiblePositions(slot).length > 0;
}

/**
 * Expand a Yahoo roster_positions array into a flat list of individual slots.
 * [{slot:'RB',count:2}] -> ['RB','RB']
 */
export function expandSlots(rosterSlots = []) {
  const out = [];
  for (const rp of rosterSlots) {
    const slot = rp.slot ?? rp.position ?? rp;
    const count = Number(rp.count ?? rp.roster_position?.count ?? 1);
    for (let i = 0; i < count; i++) out.push(slot);
  }
  return out;
}

export const startingSlots = (rosterSlots) => expandSlots(rosterSlots).filter(isStartingSlot);

/** Human label for a slot, e.g. 'W/R/T' -> 'FLEX'. */
export function slotLabel(slot) {
  if (slot === 'W/R/T' || slot === 'W/R' || slot === 'W/T' || slot === 'R/T') return 'FLEX';
  if (slot === 'Q/W/R/T' || slot === 'OP') return 'SUPERFLEX';
  return slot;
}

/**
 * How many starters of each position the league demands, counting flex slots
 * fractionally across the positions they accept. This is the input to
 * replacement level, which is the input to every valuation in the platform.
 */
export function positionalDemand(rosterSlots, numTeams) {
  const slots = startingSlots(rosterSlots);
  const demand = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
  for (const s of slots) {
    const elig = eligiblePositions(s);
    if (!elig.length) continue;
    if (elig.length === 1) {
      demand[elig[0]] += 1;
    } else {
      // Flex demand does not split evenly in practice: it is absorbed by the
      // deepest, cheapest position pool. Weight by realistic flex usage.
      const weights = { RB: 0.45, WR: 0.45, TE: 0.08, QB: 0.02 };
      const total = elig.reduce((a, p) => a + (weights[p] ?? 0), 0) || elig.length;
      for (const p of elig) demand[p] += (weights[p] ?? 1) / total;
    }
  }
  const starters = {};
  for (const p of POSITIONS) starters[p] = demand[p] * numTeams;
  return { perTeam: demand, leagueWide: starters };
}
