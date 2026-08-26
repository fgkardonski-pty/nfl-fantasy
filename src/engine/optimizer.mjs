/**
 * Exact lineup optimization.
 *
 * Setting a lineup is an assignment problem: slots on one side, players on the
 * other, edges only where the player is eligible for the slot. Greedy
 * "best player at each position, then best leftover in FLEX" is the standard
 * approach and it is *wrong* — it loses points whenever a multi-eligible player
 * is more valuable in a slot the greedy pass already filled.
 *
 * We solve it exactly with the Hungarian algorithm (O(n³), and n is at most a
 * couple dozen, so it is instant), which guarantees the true optimum under any
 * slot configuration including SUPERFLEX and custom commissioner setups.
 */
import { eligiblePositions, playerCanFill, startingSlots, slotLabel } from './roster.mjs';

const BIG = 1e9;

/**
 * Hungarian algorithm (Kuhn–Munkres, JV shortest-augmenting-path form).
 * Minimises total cost over a rectangular matrix with rows <= cols.
 * @param {number[][]} cost  cost[row][col]
 * @returns {{assignment:number[], cost:number}} assignment[row] = col or -1
 */
export function hungarian(cost) {
  const n = cost.length;
  if (n === 0) return { assignment: [], cost: 0 };
  const m = cost[0].length;
  if (m < n) throw new Error('hungarian: requires cols >= rows');

  const INF = Infinity;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1).fill(0);   // p[col] = row matched to col (1-based)
  const way = new Int32Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(INF);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      if (!Number.isFinite(delta)) break; // no augmenting path: leave row unassigned
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // Walk the augmenting path back, flipping matches.
    while (j0) {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    }
  }

  const assignment = new Array(n).fill(-1);
  let total = 0;
  for (let j = 1; j <= m; j++) {
    if (p[j] > 0 && p[j] <= n) {
      assignment[p[j] - 1] = j - 1;
      total += cost[p[j] - 1][j - 1];
    }
  }
  return { assignment, cost: total };
}

/**
 * Optimal starting lineup.
 *
 * @param {Array<{player_id:string,pos:string,name?:string}>} players roster
 * @param {string[]} slots flat list of starting slot codes
 * @param {(p:any)=>number} value objective per player (points, win-prob equity…)
 * @returns {{lineup:Array, bench:Array, total:number}}
 */
export function optimalLineup(players, slots, value = (p) => p.mean ?? 0) {
  // Accept either a flat slot list (['QB','RB','RB']) or the league's raw
  // roster config ([{slot:'RB',count:2}]). Callers legitimately hold both forms,
  // and silently returning an empty lineup for the wrong one is a bug that hides
  // for a long time because every downstream number just becomes zero.
  const starting = startingSlots(slots);
  if (!starting.length || !players.length) {
    return { lineup: [], bench: [...players], total: 0 };
  }

  // Rows = slots, cols = players. Pad columns so cols >= rows.
  const rows = starting.length;
  const pool = [...players];
  while (pool.length < rows) pool.push({ player_id: `__empty_${pool.length}`, pos: '__', name: '(empty)', __phantom: true });

  const cost = starting.map((slot) => pool.map((pl) => {
    if (pl.__phantom) return BIG / 2;              // fillable, but worth nothing
    if (!playerCanFill(slot, pl)) return BIG;      // ineligible for this slot
    return -value(pl);                             // maximise value => minimise -value
  }));

  const { assignment } = hungarian(cost);

  const lineup = [];
  const used = new Set();
  assignment.forEach((col, row) => {
    if (col < 0) return;
    const pl = pool[col];
    if (!pl || pl.__phantom) {
      lineup.push({ slot: starting[row], slotLabel: slotLabel(starting[row]), player: null, value: 0 });
      return;
    }
    if (cost[row][col] >= BIG) return; // ineligible fallback, treat as empty
    used.add(pl.player_id);
    lineup.push({
      slot: starting[row],
      slotLabel: slotLabel(starting[row]),
      player: pl,
      value: value(pl),
    });
  });

  // Present in a stable, human-readable slot order.
  const order = ['QB', 'RB', 'WR', 'TE', 'W/R/T', 'W/R', 'W/T', 'R/T', 'FLEX', 'Q/W/R/T', 'SUPERFLEX', 'OP', 'K', 'DEF', 'DST'];
  lineup.sort((a, b) => {
    const ia = order.indexOf(a.slot); const ib = order.indexOf(b.slot);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const bench = players.filter((p) => !used.has(p.player_id));
  const total = lineup.reduce((a, l) => a + (l.value || 0), 0);
  return { lineup, bench, total };
}

/**
 * Marginal value of each bench player: how much the optimal lineup total would
 * improve if this player were forced into the lineup, or drop if the currently
 * starting player were removed. This is the number that answers "how close was
 * this call?" — a 0.2-point start/sit is noise, a 4-point one is not.
 */
export function lineupMarginals(players, slots, value) {
  const base = optimalLineup(players, slots, value);
  const baseIds = new Set(base.lineup.filter((l) => l.player).map((l) => l.player.player_id));
  const out = [];
  for (const p of players) {
    const without = players.filter((q) => q.player_id !== p.player_id);
    const alt = optimalLineup(without, slots, value);
    const delta = base.total - alt.total;
    out.push({
      player_id: p.player_id,
      name: p.name,
      pos: p.pos,
      starting: baseIds.has(p.player_id),
      marginal: delta,          // points the lineup loses without this player
    });
  }
  out.sort((a, b) => b.marginal - a.marginal);
  return { base, marginals: out };
}

/**
 * The closest start/sit decisions: pairs where swapping a starter for a bench
 * player costs the least. These are the calls worth simulating for win
 * probability rather than settling on projected points.
 */
export function closeCalls(players, slots, value, limit = 6) {
  const base = optimalLineup(players, slots, value);
  const startingIds = new Set(base.lineup.filter((l) => l.player).map((l) => l.player.player_id));
  const bench = players.filter((p) => !startingIds.has(p.player_id));
  const calls = [];
  for (const b of bench) {
    // Force b into the lineup by giving it a large bonus, then measure the cost.
    const forced = optimalLineup(players, slots, (p) => (p.player_id === b.player_id ? value(p) + 1e6 : value(p)));
    const forcedTotal = forced.lineup.reduce(
      (a, l) => a + (l.player ? value(l.player) : 0), 0
    );
    const benched = base.lineup
      .filter((l) => l.player)
      .find((l) => !forced.lineup.some((f) => f.player && f.player.player_id === l.player.player_id));
    if (!benched) continue;
    calls.push({
      in: b,
      out: benched.player,
      slot: benched.slot,
      pointCost: base.total - forcedTotal,
    });
  }
  calls.sort((a, b) => a.pointCost - b.pointCost);
  return calls.slice(0, limit);
}
