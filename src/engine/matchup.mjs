/**
 * Matchup and game-environment adjustments.
 *
 * Two separate effects, deliberately kept separate:
 *   1. Defensive quality  — how many points this defense concedes to this
 *      position relative to league average, shrunk hard because a 4-game
 *      sample of "points allowed to WRs" is mostly schedule noise.
 *   2. Game environment   — the Vegas total and spread imply how many points
 *      this offense is expected to score and whether they will be throwing to
 *      catch up or running out the clock.
 */
import { all, get } from '../db/index.mjs';
import { clamp, shrink } from '../util/stats.mjs';

/** League-average implied team total; the neutral point for environment scaling. */
const NEUTRAL_TEAM_TOTAL = 22.5;

/**
 * Defensive adjustment multiplier for a position facing `defTeam`.
 * Shrunk toward 1.0 by sample size: with 4 games of evidence, roughly half the
 * raw signal survives.
 */
export function defenseMultiplier(defTeam, pos, season) {
  if (!defTeam) return { mult: 1, note: 'no opponent', sample: 0 };
  const row = get(
    'SELECT pts_allowed_over_avg, sample FROM team_defense WHERE nfl_team = ? AND season = ? AND pos = ?',
    [defTeam, season, pos]
  );
  if (!row || !row.sample) return { mult: 1, note: 'no defensive sample', sample: 0 };

  const base = { QB: 16.5, RB: 11, WR: 10.5, TE: 8, K: 8, DEF: 7 }[pos] ?? 10;
  const rawMult = 1 + Number(row.pts_allowed_over_avg) / base;
  // Shrink toward neutral; k = 4 games.
  const shrunk = shrink(rawMult, 1, Number(row.sample), 4);
  const mult = clamp(shrunk, 0.72, 1.32);
  const pct = Math.round((mult - 1) * 100);
  return {
    mult,
    sample: Number(row.sample),
    note: pct === 0 ? `${defTeam} neutral vs ${pos}` :
      `${defTeam} allows ${pct > 0 ? '+' : ''}${pct}% to ${pos}`,
  };
}

/** Find this player's game for the week, plus whether he is home. */
/**
 * Whether a schedule exists for this week at all.
 *
 * The difference between "this team has no game" and "no games are loaded" is
 * the difference between a bye — where zero is the right projection — and a
 * missing import, where zero is a fabrication. Nothing could tell them apart.
 */
export function weekHasSchedule(season, week) {
  return (get("SELECT COUNT(*) c FROM games WHERE season = ? AND week = ? AND source = 'real'", [season, week])?.c ?? 0) > 0;
}

export function findGame(nflTeam, season, week) {
  if (!nflTeam) return null;
  // Only a slate tagged 'real' is read. Demo fixtures use real team
  // abbreviations and plausible spreads, so an untagged or invented schedule is
  // indistinguishable from a true one — and worse than none, because a player
  // whose team is absent from it is projected at zero as though he were on bye.
  const g = get(
    `SELECT * FROM games WHERE season = ? AND week = ? AND source = 'real' AND (home = ? OR away = ?)`,
    [season, week, nflTeam, nflTeam]
  );
  if (!g) return null;
  const isHome = g.home === nflTeam;
  return {
    ...g,
    isHome,
    opponent: isHome ? g.away : g.home,
    impliedTeam: isHome ? g.implied_home : g.implied_away,
    impliedOpp: isHome ? g.implied_away : g.implied_home,
    // Positive spread = this team is the underdog by that many points.
    teamSpread: isHome ? g.spread : -g.spread,
  };
}

/**
 * Game-environment multiplier from the betting market.
 *
 * The implied team total scales offensive volume for everyone. The spread then
 * redistributes it: big underdogs throw more (good for QB/WR/TE, bad for RB
 * rushing volume), big favourites run more (the inverse). This "game script"
 * effect is one of the few genuinely predictive signals available before
 * kickoff, because it is the market's aggregated opinion, not ours.
 */
export function environmentMultiplier(game, pos) {
  if (!game || game.impliedTeam == null) {
    return { mult: 1, script: 0, note: 'no market data', total: null };
  }
  const implied = Number(game.impliedTeam);
  const volume = clamp(implied / NEUTRAL_TEAM_TOTAL, 0.72, 1.32);

  // teamSpread > 0 => underdog. Normalise to roughly [-1, 1] over ±10 points.
  const script = clamp(Number(game.teamSpread ?? 0) / 10, -1.2, 1.2);
  const scriptSensitivity = {
    QB: 0.07,    // trailing QBs throw more
    WR: 0.06,
    TE: 0.04,
    RB: -0.09,   // trailing RBs lose carries; leading RBs gain them
    K: -0.02,
    DEF: -0.18,  // favoured defenses face backups and get sack/turnover chances
  }[pos] ?? 0;

  const scriptMult = clamp(1 + script * scriptSensitivity, 0.8, 1.2);
  const mult = clamp(volume * scriptMult, 0.7, 1.35);

  const dogFav = game.teamSpread > 0 ? `${game.teamSpread.toFixed(1)}-pt dog` :
    game.teamSpread < 0 ? `${Math.abs(game.teamSpread).toFixed(1)}-pt favourite` : 'pick-em';
  return {
    mult,
    script,
    total: game.total,
    implied,
    note: `${implied.toFixed(1)} implied team total, ${dogFav}`,
  };
}

/**
 * Weather multiplier. Wind is the one weather variable with a large, repeatable
 * effect on passing and kicking; temperature and light rain barely move the
 * needle and we refuse to pretend otherwise.
 */
export function weatherMultiplier(game, pos) {
  if (!game || !game.weather) return { mult: 1, note: null };
  let w;
  try { w = typeof game.weather === 'string' ? JSON.parse(game.weather) : game.weather; }
  catch { return { mult: 1, note: null }; }
  if (game.roof && /dome|closed|indoor/i.test(game.roof)) {
    return { mult: 1, note: 'indoors' };
  }
  const wind = Number(w.wind_mph ?? 0);
  const precip = Number(w.precip_mm ?? 0);

  let mult = 1;
  const notes = [];
  if (wind >= 15) {
    const severity = clamp((wind - 15) / 15, 0, 1);
    const sens = { QB: 0.12, WR: 0.10, TE: 0.06, K: 0.18, RB: -0.04, DEF: 0.04 }[pos] ?? 0;
    mult *= 1 - severity * sens;
    notes.push(`${Math.round(wind)} mph wind`);
  }
  if (precip >= 2) {
    const sens = { QB: 0.05, WR: 0.05, TE: 0.03, K: 0.05, RB: -0.03, DEF: 0.03 }[pos] ?? 0;
    mult *= 1 - clamp(precip / 12, 0, 1) * sens;
    notes.push('precipitation');
  }
  return { mult: clamp(mult, 0.75, 1.08), note: notes.join(', ') || null };
}

/**
 * Rebuild the positional defensive table from observed weekly scoring.
 * Called after any stats sync. Uses the league's own scoring so a high-TD
 * league's defensive adjustments are expressed in that league's points.
 */
export function rebuildTeamDefense(season, scoreFn) {
  const rows = all(
    `SELECT ps.player_id, ps.season, ps.week, ps.opponent, ps.stats, p.pos
     FROM player_stats ps JOIN players p ON p.player_id = ps.player_id
     WHERE ps.season = ? AND ps.opponent IS NOT NULL`,
    [season]
  );
  // pos -> array of points (league baseline), and (defTeam,pos) -> array
  const byPos = new Map();
  const byDefPos = new Map();
  for (const r of rows) {
    if (!['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(r.pos)) continue;
    let stats;
    try { stats = JSON.parse(r.stats); } catch { continue; }
    const pts = scoreFn(stats);
    if (!Number.isFinite(pts)) continue;
    if (!byPos.has(r.pos)) byPos.set(r.pos, []);
    byPos.get(r.pos).push(pts);
    const k = `${r.opponent}|${r.pos}`;
    if (!byDefPos.has(k)) byDefPos.set(k, []);
    byDefPos.get(k).push(pts);
  }
  const posAvg = new Map();
  for (const [pos, arr] of byPos) posAvg.set(pos, arr.reduce((a, b) => a + b, 0) / arr.length);

  const out = [];
  for (const [k, arr] of byDefPos) {
    const [team, pos] = k.split('|');
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    // Weeks of evidence, not player-games: 3 WRs per game inflates the count.
    const perGame = { QB: 1, RB: 2.5, WR: 4, TE: 1.5, K: 1, DEF: 1 }[pos] ?? 2;
    out.push({
      nfl_team: team,
      season,
      pos,
      pts_allowed_over_avg: avg - (posAvg.get(pos) ?? avg),
      sample: Math.round(arr.length / perGame),
    });
  }
  return out;
}
