/**
 * Value Over Replacement, computed from THIS league's actual rules.
 *
 * Raw projected points are useless for comparing across positions — a
 * quarterback outscores a running back every week and is still worth less,
 * because the quarterback you would have had instead also outscores that
 * running back. What matters is the gap to the player you could have had for
 * free at the same position: replacement level.
 *
 * Replacement level is not a constant. It is determined by how many starters
 * the league demands at each position, which depends on team count, roster
 * slots, and how flex slots actually get used. All of that comes from the real
 * league settings, never from an assumed 12-team standard setup.
 */
import { positionalDemand, POSITIONS } from './roster.mjs';
import { round, clamp, mean } from '../util/stats.mjs';

/**
 * Replacement-level points per position: the projected output of the last
 * player at that position who would realistically be starting league-wide.
 *
 * @param {Array} projections players with {pos, mean} — season-long or per-game
 * @param {Array} rosterSlots league roster configuration
 * @param {number} numTeams
 * @param {number} benchCushion how far past the last starter to set replacement
 */
export function replacementLevels(projections, rosterSlots, numTeams, benchCushion = 0.5) {
  const { leagueWide } = positionalDemand(rosterSlots, numTeams);
  const levels = {};
  const meta = {};
  for (const pos of POSITIONS) {
    const pool = projections
      .filter((p) => p.pos === pos)
      .sort((a, b) => b.mean - a.mean);
    if (!pool.length) { levels[pos] = 0; meta[pos] = { rank: 0, pool: 0 }; continue; }
    // The replacement player sits just past the last startable one, cushioned
    // by the fraction of a round managers spend on backups at that position.
    const startersNeeded = leagueWide[pos] ?? 0;
    const rank = Math.min(pool.length - 1, Math.max(0, Math.round(startersNeeded * (1 + benchCushion)) - 1));
    // Average a small window around that rank so a single outlier does not set
    // the baseline for the whole position.
    const lo = Math.max(0, rank - 2);
    const hi = Math.min(pool.length - 1, rank + 2);
    const window = pool.slice(lo, hi + 1).map((p) => p.mean);
    levels[pos] = mean(window);
    meta[pos] = {
      rank: rank + 1,
      pool: pool.length,
      startersNeeded: round(startersNeeded, 1),
      replacementPlayer: pool[rank]?.name ?? null,
    };
  }
  return { levels, meta };
}

/**
 * Attach VOR to every projection.
 * @returns projections sorted by VOR descending, each with .vor and .posRank
 */
export function computeVor(projections, rosterSlots, numTeams) {
  const { levels, meta } = replacementLevels(projections, rosterSlots, numTeams);
  const posCounters = {};
  const out = projections
    .map((p) => ({ ...p, vor: p.mean - (levels[p.pos] ?? 0), replacement: levels[p.pos] ?? 0 }))
    .sort((a, b) => b.vor - a.vor);
  // Positional ranks by projected output (not by VOR — managers think in
  // "he's the RB7", and that is what tier displays need).
  const byPos = [...out].sort((a, b) => b.mean - a.mean);
  for (const p of byPos) {
    posCounters[p.pos] = (posCounters[p.pos] ?? 0) + 1;
    p.posRank = posCounters[p.pos];
  }
  out.forEach((p, i) => { p.overallRank = i + 1; });
  return { players: out, levels, meta };
}

/**
 * Gap-based tiering.
 *
 * A ranked list is a lie of precision: the difference between the 4th and 5th
 * running back is usually noise, and the difference between the 8th and 9th is
 * sometimes a cliff. Tiers make the cliffs visible, which is what actually
 * drives draft decisions — you reach before a cliff, you wait after one.
 *
 * We cut a new tier where the drop between consecutive players exceeds a
 * multiple of the typical drop within the position.
 */
export function tierize(players, { sensitivity = 1.6, maxTiers = 12 } = {}) {
  if (players.length < 3) return players.map((p) => ({ ...p, tier: 1 }));
  const sorted = [...players].sort((a, b) => b.mean - a.mean);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i - 1].mean - sorted[i].mean);
  const positive = gaps.filter((g) => g > 0).sort((a, b) => a - b);
  const medianGap = positive.length ? positive[Math.floor(positive.length / 2)] : 0;
  const threshold = medianGap * sensitivity;

  let tier = 1;
  const out = [sorted[0]].map((p) => ({ ...p, tier }));
  for (let i = 1; i < sorted.length; i++) {
    if (gaps[i - 1] > threshold && tier < maxTiers) tier++;
    out.push({ ...sorted[i], tier });
  }
  return out;
}

/** Tier summary for display: size, range, and the cliff below it. */
export function tierSummary(tieredPlayers) {
  const map = new Map();
  for (const p of tieredPlayers) {
    if (!map.has(p.tier)) map.set(p.tier, []);
    map.get(p.tier).push(p);
  }
  const tiers = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([tier, members]) => ({
    tier,
    size: members.length,
    high: round(Math.max(...members.map((m) => m.mean)), 1),
    low: round(Math.min(...members.map((m) => m.mean)), 1),
    players: members,
  }));
  for (let i = 0; i < tiers.length - 1; i++) tiers[i].cliff = round(tiers[i].low - tiers[i + 1].high, 1);
  return tiers;
}

/**
 * Positional scarcity clock: how many players remain above replacement at each
 * position. When this number approaches zero at a position, the run is coming.
 */
export function scarcity(availablePlayers, levels) {
  const out = {};
  for (const pos of POSITIONS) {
    const pool = availablePlayers.filter((p) => p.pos === pos);
    const aboveReplacement = pool.filter((p) => p.mean > (levels[pos] ?? 0));
    const elite = pool.filter((p) => p.mean > (levels[pos] ?? 0) * 1.35);
    out[pos] = {
      total: pool.length,
      startable: aboveReplacement.length,
      elite: elite.length,
      best: pool.length ? Math.max(...pool.map((p) => p.mean)) : 0,
    };
  }
  return out;
}
