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

/**
 * Parse a player's eligibility into a set of position codes.
 * Accepts a JSON string, an array, or Yahoo's comma-delimited display_position
 * ("WR,RB"), because all three forms reach us from different code paths.
 */
export function parseEligibility(value) {
  if (!value) return [];
  let list = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try { list = JSON.parse(trimmed); } catch { list = []; }
    } else {
      list = trimmed.split(',');
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (typeof x === 'string' ? x : x?.position))
    .filter(Boolean)
    .map((x) => String(x).trim().toUpperCase())
    .map((x) => (x === 'DST' || x === 'D/ST' ? 'DEF' : x))
    // Only real position and slot codes survive. Malformed input must not
    // become a phantom eligibility entry — it would never match a slot, but it
    // would sit in the data looking like a fact.
    .filter((x) => KNOWN_CODES.has(x));
}

/** Every code that can legitimately appear in an eligibility list. */
const KNOWN_CODES = new Set([...POSITIONS, ...Object.keys(SLOT_ELIGIBILITY)]);

/**
 * Can THIS player fill THIS slot?
 *
 * Yahoo publishes a per-player eligibility list that is authoritative and that
 * a player's primary position does not always imply — a receiver who also has
 * running back eligibility can legally fill an RB slot. Where that list is
 * present we honour it; where it is absent (demo data, other providers) we fall
 * back to position-based rules.
 */
export function playerCanFill(slot, player) {
  const slotPositions = eligiblePositions(slot);
  if (!slotPositions.length) return false;

  const declared = parseEligibility(player?.eligible_positions);
  if (declared.length) {
    // Yahoo lists both real positions ("RB") and slot codes ("W/R/T"), so a
    // direct slot match counts, as does any overlap with what the slot accepts.
    if (declared.includes(slot)) return true;
    if (declared.some((pos) => slotPositions.includes(pos))) return true;
    return false;
  }
  return slotPositions.includes(player?.pos);
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
      //
      // A slot that admits quarterbacks is a different animal. Quarterbacks
      // outscore every other position by enough that essentially every manager
      // starts one there, which is the entire premise of a superflex league —
      // so that slot is a quarterback slot in all but name. Splitting it evenly
      // would report a superflex league as needing barely more than one
      // quarterback per team, and value the second one as a bench player.
      const weights = elig.includes('QB')
        ? { QB: 0.9, RB: 0.04, WR: 0.04, TE: 0.02 }
        : { RB: 0.45, WR: 0.45, TE: 0.08, QB: 0.02 };
      const total = elig.reduce((a, p) => a + (weights[p] ?? 0), 0) || elig.length;
      for (const p of elig) demand[p] += (weights[p] ?? 1) / total;
    }
  }
  const starters = {};
  for (const p of POSITIONS) starters[p] = demand[p] * numTeams;
  return { perTeam: demand, leagueWide: starters };
}
