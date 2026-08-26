/**
 * Synthetic league generator.
 *
 * Demo mode exists so that every screen and every engine in this platform can
 * be exercised before a single credential is entered, and so the test suite has
 * a realistic world to run against.
 *
 * IMPORTANT: the players generated here are FICTIONAL. Names are assembled from
 * generic name pools and the statistics are simulated. Nothing in demo mode is
 * a claim about a real athlete. Real data only ever enters the platform through
 * the Yahoo connection and the public providers in src/providers/.
 */
import { Rng } from './util/rng.mjs';
import { upsertMany, run, tx, meta } from './db/index.mjs';
import { roundRobinSchedule } from './engine/simulate.mjs';
import { DEFAULT_SCORING } from './engine/scoring.mjs';

export const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET',
  'GB', 'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE',
  'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
];

const DOME_TEAMS = new Set(['ATL', 'DAL', 'DET', 'HOU', 'IND', 'LAR', 'LV', 'MIN', 'NO', 'ARI']);

const FIRST = ['Marcus','Devin','Trey','Jalen','Kobe','Amari','Isiah','Rashad','Damon','Terrell',
  'Xavier','Cameron','Bryce','Malik','Julian','Deion','Tyrese','Elijah','Quinton','Darius',
  'Zion','Kendrick','Antoine','Roman','Cedric','Jamar','Nico','Brennan','Silas','Hollis',
  'Grant','Wesley','Dominic','Emmett','Rory','Landon','Beau','Corbin','Ronan','Griffin'];
const LAST = ['Whitfield','Barrow','Castellanos','Nakamura','Okafor','Delgado','Prescott-Hale','Vandermeer',
  'Aguilar','Boateng','Sandoval','Kaminski','Thibodeaux','Rasmussen','Ferreira','Oyelaran','Mbeki',
  'Lindqvist','Serrano','Ashworth','Bellamy','Cortland','Duquesne','Everhart','Fairbanks','Gallagher',
  'Hollowell','Ivanov','Jessup','Kilgore','Lockridge','Merriweather','Northcutt','Ormsby','Pemberton',
  'Quintero','Ravenscroft','Stockbridge','Thorne','Ulmer','Vasquez','Wilkerson','Yarborough','Zamora'];

const MANAGERS = [
  { name: 'The Analytics Dept', manager: 'Priya', archetype: 'balanced' },
  { name: 'Waiver Wire Warlord', manager: 'Deshawn', archetype: 'spender' },
  { name: 'Box Score Bandits', manager: 'Tommy', archetype: 'chaser' },
  { name: 'Set And Forget FC', manager: 'Helen', archetype: 'stander' },
  { name: 'Panic Button Pete', manager: 'Pete', archetype: 'churner' },
  { name: 'Trade Machine', manager: 'Rosa', archetype: 'dealer' },
  { name: 'Ghost Roster', manager: 'Alan', archetype: 'absentee' },
  { name: 'Zero RB Zealots', manager: 'Mina', archetype: 'balanced' },
  { name: 'Regression Coming', manager: 'Ivan', archetype: 'balanced' },
  { name: 'Sunday Scaries', manager: 'Nikki', archetype: 'chaser' },
  { name: 'Bye Week Blues', manager: 'Colton', archetype: 'stander' },
];

/** Per-position roster construction of the fictional NFL. */
const POS_PLAN = [
  { pos: 'QB', perTeam: 2, eliteRate: 0.30 },
  { pos: 'RB', perTeam: 4, eliteRate: 0.22 },
  { pos: 'WR', perTeam: 6, eliteRate: 0.20 },
  { pos: 'TE', perTeam: 3, eliteRate: 0.16 },
  { pos: 'K',  perTeam: 1, eliteRate: 0.25 },
];

/** Talent -> expected per-game fantasy points, by position. */
const TALENT_CURVE = {
  QB: (t) => 8 + 18 * t ** 1.4,
  RB: (t) => 3 + 19 * t ** 1.7,
  WR: (t) => 2.5 + 18 * t ** 1.7,
  TE: (t) => 2 + 14 * t ** 2.0,
  K:  (t) => 5 + 6 * t,
  DEF:(t) => 3 + 9 * t,
};

export function generateDemoLeague({
  season = 2026, currentWeek = 9, numTeams = 12, seed = 20260826, dbWrite = true,
} = {}) {
  const rng = new Rng(seed);
  const leagueKey = `demo.l.${season}`;

  // ---- NFL schedule and bye weeks -----------------------------------------
  // Byes are assigned by taking whole PAIRINGS out of a week. Assigning byes to
  // individual teams would silently delete the opponent's game as well, leaving
  // players with no scheduled game and a zero projection for no visible reason.
  const nflSchedule = roundRobinSchedule(NFL_TEAMS, 18);
  const byes = {};
  const byeWeeks = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const onBye = new Set(); // "week|home|away" pairings removed from the schedule
  {
    let assigned = 0;
    let w = 0;
    while (assigned < NFL_TEAMS.length && w < byeWeeks.length * 4) {
      const week = byeWeeks[w % byeWeeks.length];
      const pairs = nflSchedule[week - 1].pairs.filter(
        ([a, b]) => byes[a] === undefined && byes[b] === undefined
      );
      if (pairs.length) {
        const [a, b] = pairs[rng.int(0, pairs.length - 1)];
        byes[a] = week;
        byes[b] = week;
        onBye.add(`${week}|${a}|${b}`);
        assigned += 2;
      }
      w++;
    }
    // Anything left over (odd rotations) gets a bye in the least-loaded week.
    for (const t of NFL_TEAMS) if (byes[t] === undefined) byes[t] = byeWeeks[rng.int(0, byeWeeks.length - 1)];
  }

  // ---- Player universe -----------------------------------------------------
  const players = [];
  const usedNames = new Set();
  const nameFor = () => {
    for (let i = 0; i < 200; i++) {
      const n = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    return `${rng.pick(FIRST)} ${rng.pick(LAST)} ${usedNames.size}`;
  };

  let pid = 0;
  for (const team of NFL_TEAMS) {
    for (const plan of POS_PLAN) {
      for (let d = 0; d < plan.perTeam; d++) {
        // Depth rank drives talent: starters are better than backups, with
        // enough overlap that backups occasionally break out.
        const depthPenalty = d / plan.perTeam;
        const base = rng.range(0, 1) ** 1.25;
        let talent = Math.max(0.01, base * (1 - depthPenalty * 0.75) + (d === 0 ? 0.22 : 0));
        if (d === 0 && rng.bool(plan.eliteRate)) talent = Math.min(1, talent + rng.range(0.15, 0.35));
        players.push({
          player_id: `dp${++pid}`,
          name: nameFor(),
          pos: plan.pos,
          nfl_team: team,
          bye_week: byes[team],
          status: '',
          age: Math.round(rng.range(21, 33) * 10) / 10,
          years_exp: rng.int(0, 11),
          depth_rank: d + 1,
          talent,
          __ppg: TALENT_CURVE[plan.pos](talent),
        });
      }
    }
    // Team defense as a fantasy asset.
    const dTalent = rng.range(0.05, 1);
    players.push({
      player_id: `dp${++pid}`,
      name: `${team} Defense`,
      pos: 'DEF',
      nfl_team: team,
      bye_week: byes[team],
      status: '',
      age: null, years_exp: null, depth_rank: 1,
      talent: dTalent,
      __ppg: TALENT_CURVE.DEF(dTalent),
    });
  }

  // Injuries: a realistic slice of the league is dinged up at any moment.
  for (const p of players) {
    const r = rng.uniform();
    if (r < 0.035) p.status = 'O';
    else if (r < 0.055) p.status = 'IR';
    else if (r < 0.115) p.status = 'Q';
    else if (r < 0.135) p.status = 'D';
  }

  // ---- Weekly history ------------------------------------------------------
  const stats = [];
  const usage = [];
  const gamesRows = [];
  const teamStrength = {};
  for (const t of NFL_TEAMS) teamStrength[t] = rng.range(0.35, 0.75);

  // Per-team unit share so target/carry shares within a team sum sensibly.
  const teamShares = {};
  for (const t of NFL_TEAMS) {
    const wrs = players.filter((p) => p.nfl_team === t && p.pos === 'WR').sort((a, b) => b.talent - a.talent);
    const rbs = players.filter((p) => p.nfl_team === t && p.pos === 'RB').sort((a, b) => b.talent - a.talent);
    const tes = players.filter((p) => p.nfl_team === t && p.pos === 'TE').sort((a, b) => b.talent - a.talent);
    const share = {};
    const alloc = (arr, budget, decay) => {
      let rem = budget;
      arr.forEach((p, i) => {
        const s = i === arr.length - 1 ? rem : rem * decay;
        share[p.player_id] = Math.max(0, s);
        rem -= s;
      });
    };
    alloc(wrs, 0.58, 0.45);
    alloc(tes, 0.19, 0.62);
    alloc(rbs, 0.23, 0.55);
    const rushShare = {};
    alloc(rbs, 0.78, 0.55);
    rbs.forEach((p) => { rushShare[p.player_id] = share[p.player_id]; });
    teamShares[t] = { target: share, rush: rushShare };
  }

  for (let week = 1; week <= 18; week++) {
    const wk = nflSchedule[week - 1];
    for (const [home, away] of wk.pairs) {
      if (onBye.has(`${week}|${home}|${away}`)) continue;
      const hs = teamStrength[home];
      const as = teamStrength[away];
      const total = Math.round((41 + (hs + as - 1) * 16 + rng.normal(0, 3)) * 2) / 2;
      const spread = Math.round(((as - hs) * 24 - 1.8 + rng.normal(0, 2)) * 2) / 2;
      const impliedHome = Math.round((total / 2 - spread / 2) * 10) / 10;
      const impliedAway = Math.round((total / 2 + spread / 2) * 10) / 10;
      const dome = DOME_TEAMS.has(home);
      gamesRows.push({
        season, week, home, away,
        kickoff: Date.UTC(season, 8, 7 + (week - 1) * 7, 17, 0, 0),
        total, spread,
        implied_home: impliedHome,
        implied_away: impliedAway,
        roof: dome ? 'dome' : 'outdoor',
        weather: JSON.stringify(dome ? { indoor: true } : {
          wind_mph: Math.round(Math.max(0, rng.gammaMS(8, 6))),
          temp_f: Math.round(rng.range(28, 82)),
          precip_mm: rng.bool(0.22) ? Math.round(rng.gammaMS(3, 3) * 10) / 10 : 0,
        }),
      });
    }

    if (week >= currentWeek) continue; // future weeks have lines but no results

    for (const p of players) {
      if (p.bye_week === week) continue;
      const game = gamesRows.find((g) => g.season === season && g.week === week && (g.home === p.nfl_team || g.away === p.nfl_team));
      if (!game) continue;
      const isHome = game.home === p.nfl_team;
      const opp = isHome ? game.away : game.home;
      const implied = isHome ? game.implied_home : game.implied_away;

      // Role can drift over the season — this is what creates breakouts for the
      // opportunity engine to find.
      const drift = 1 + 0.055 * (week - 1) * (p.__driftDir ?? (p.__driftDir = rng.bool(0.18) ? 1 : rng.bool(0.15) ? -1 : 0));
      const roleMult = Math.max(0.2, Math.min(2.2, drift));

      const ppg = p.__ppg * roleMult * (implied / 22.5) ** 0.7;
      const cv = { QB: 0.32, RB: 0.5, WR: 0.56, TE: 0.6, K: 0.42, DEF: 0.6 }[p.pos] ?? 0.5;
      const pts = Math.max(0, rng.gammaMS(Math.max(0.5, ppg), Math.max(0.4, ppg * cv)));

      stats.push({
        player_id: p.player_id, season, week, opponent: opp,
        stats: JSON.stringify(synthesiseStatLine(p.pos, pts, rng)),
      });

      const tShare = (teamShares[p.nfl_team].target[p.player_id] ?? 0) * roleMult;
      const rShare = (teamShares[p.nfl_team].rush[p.player_id] ?? 0) * roleMult;
      const snapBase = { QB: 0.98, RB: 0.42, WR: 0.62, TE: 0.58, K: 1, DEF: 1 }[p.pos] ?? 0.5;
      usage.push({
        player_id: p.player_id, season, week,
        snap_pct: Math.min(1, Math.max(0, snapBase * (0.6 + p.talent) * roleMult * rng.range(0.88, 1.12))),
        route_pct: p.pos === 'WR' || p.pos === 'TE' ? Math.min(1, (0.55 + p.talent * 0.4) * roleMult) : null,
        target_share: Math.min(0.5, Math.max(0, tShare * rng.range(0.75, 1.3))),
        rush_share: Math.min(0.9, Math.max(0, rShare * rng.range(0.75, 1.3))),
        air_yard_share: p.pos === 'WR' ? Math.min(0.6, Math.max(0, tShare * rng.range(0.8, 1.5))) : null,
        rz_touches: Math.max(0, rng.poisson((tShare + rShare) * 6)),
        gl_carries: p.pos === 'RB' ? Math.max(0, rng.poisson(rShare * 2.2)) : 0,
      });
    }
  }

  // ---- Fantasy league ------------------------------------------------------
  const teams = [];
  teams.push({
    league_key: leagueKey, team_key: `${leagueKey}.t.1`, team_id: 1,
    name: 'Gridiron Oracle', manager: 'You', is_mine: 1,
    archetype: 'balanced',
  });
  MANAGERS.slice(0, numTeams - 1).forEach((m, i) => {
    teams.push({
      league_key: leagueKey, team_key: `${leagueKey}.t.${i + 2}`, team_id: i + 2,
      name: m.name, manager: m.manager, is_mine: 0, archetype: m.archetype,
    });
  });

  // Snake draft the fictional universe onto the fantasy rosters.
  const draftPool = [...players]
    .map((p) => ({ ...p, __draftVal: p.__ppg * rng.range(0.85, 1.15) }))
    .sort((a, b) => b.__draftVal - a.__draftVal);
  const rosterSize = 16;
  const rosters = new Map(teams.map((t) => [t.team_key, []]));
  const draftPicks = [];
  let pick = 0;
  for (let round = 1; round <= rosterSize; round++) {
    const order = round % 2 === 1 ? teams : [...teams].reverse();
    for (const t of order) {
      const roster = rosters.get(t.team_key);
      const counts = {};
      for (const r of roster) counts[r.pos] = (counts[r.pos] ?? 0) + 1;
      const caps = { QB: 2, RB: 6, WR: 7, TE: 2, K: 1, DEF: 1 };
      // Managers reach a little; nobody drafts perfectly off a board.
      const window = draftPool.filter((p) => (counts[p.pos] ?? 0) < caps[p.pos]).slice(0, 8);
      if (!window.length) continue;
      const chosen = window[rng.weightedIndex(window.map((_, i) => Math.exp(-i * 0.55)))];
      draftPool.splice(draftPool.indexOf(chosen), 1);
      roster.push(chosen);
      pick++;
      draftPicks.push({ league_key: leagueKey, pick, round, team_key: t.team_key, player_id: chosen.player_id, cost: null });
    }
  }

  // ADP from the draft that just happened, with noise.
  const adpRows = draftPicks.map((d) => ({
    player_id: d.player_id, season, source: 'demo',
    adp: Math.max(1, d.pick + rng.normal(0, 6)),
    adp_sd: rng.range(4, 14),
  }));

  // ---- Fantasy schedule, results, standings --------------------------------
  const teamKeys = teams.map((t) => t.team_key);
  const fantasySchedule = roundRobinSchedule(teamKeys, 14);
  const matchupRows = [];
  const record = Object.fromEntries(teamKeys.map((k) => [k, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));

  const teamWeekScore = (teamKey, week) => {
    const roster = rosters.get(teamKey);
    const starters = pickStarters(roster, week);
    let total = 0;
    for (const p of starters) {
      const s = stats.find((x) => x.player_id === p.player_id && x.week === week);
      if (!s) continue;
      total += scoreFromLine(JSON.parse(s.stats));
    }
    return total;
  };

  for (const wk of fantasySchedule) {
    if (wk.week >= currentWeek) {
      for (const [a, b] of wk.pairs) {
        matchupRows.push({ league_key: leagueKey, week: wk.week, team_key: a, opp_team_key: b, points: null, projected: null, is_playoffs: wk.week >= 15 ? 1 : 0 });
        matchupRows.push({ league_key: leagueKey, week: wk.week, team_key: b, opp_team_key: a, points: null, projected: null, is_playoffs: wk.week >= 15 ? 1 : 0 });
      }
      continue;
    }
    for (const [a, b] of wk.pairs) {
      const sa = teamWeekScore(a, wk.week);
      const sb = teamWeekScore(b, wk.week);
      record[a].pf += sa; record[a].pa += sb;
      record[b].pf += sb; record[b].pa += sa;
      if (sa > sb) { record[a].w++; record[b].l++; }
      else if (sb > sa) { record[b].w++; record[a].l++; }
      else { record[a].t++; record[b].t++; }
      matchupRows.push({ league_key: leagueKey, week: wk.week, team_key: a, opp_team_key: b, points: sa, projected: null, is_playoffs: 0 });
      matchupRows.push({ league_key: leagueKey, week: wk.week, team_key: b, opp_team_key: a, points: sb, projected: null, is_playoffs: 0 });
    }
  }

  // ---- Transactions, driven by each manager's archetype --------------------
  const transactions = [];
  const faab = Object.fromEntries(teamKeys.map((k) => [k, 100]));
  const ARCH = {
    balanced: { rate: 1.0, bidMult: 1.0, chase: 0.35, panic: 0.2 },
    spender:  { rate: 1.7, bidMult: 2.6, chase: 0.45, panic: 0.3 },
    chaser:   { rate: 1.6, bidMult: 1.2, chase: 0.85, panic: 0.4 },
    stander:  { rate: 0.25, bidMult: 0.6, chase: 0.3, panic: 0.1 },
    churner:  { rate: 1.4, bidMult: 0.9, chase: 0.5, panic: 0.8 },
    dealer:   { rate: 0.9, bidMult: 1.0, chase: 0.3, panic: 0.2 },
    absentee: { rate: 0.06, bidMult: 0.4, chase: 0.3, panic: 0.1 },
  };
  let txnId = 0;
  const freePool = draftPool.slice(0, 200);
  for (let week = 2; week < currentWeek; week++) {
    for (const t of teams) {
      const a = ARCH[t.archetype] ?? ARCH.balanced;
      const nMoves = rng.poisson(a.rate);
      for (let m = 0; m < nMoves; m++) {
        if (!freePool.length) break;
        // Only add at positions the roster can actually carry. Without this the
        // highest-scoring position (QB) monopolises every waiver claim and every
        // roster ends up structurally illegal.
        const rosterNow = rosters.get(t.team_key);
        const held = {};
        for (const r of rosterNow) held[r.pos] = (held[r.pos] ?? 0) + 1;
        const CAPS = { QB: 2, RB: 6, WR: 7, TE: 2, K: 1, DEF: 2 };
        const eligible = freePool.filter((p) => (held[p.pos] ?? 0) < CAPS[p.pos]);
        if (!eligible.length) continue;

        // Chasers pick whoever exploded last week; others pick by role.
        let target;
        if (rng.bool(a.chase)) {
          const scored = eligible.map((p) => {
            const s = stats.find((x) => x.player_id === p.player_id && x.week === week - 1);
            return { p, pts: s ? scoreFromLine(JSON.parse(s.stats)) : 0 };
          }).sort((x, y) => y.pts - x.pts);
          target = scored[rng.int(0, Math.min(4, scored.length - 1))]?.p;
        } else {
          target = eligible[rng.int(0, Math.min(14, eligible.length - 1))];
        }
        if (!target) continue;
        const bid = Math.max(0, Math.round(rng.gammaMS(6 * a.bidMult, 6 * a.bidMult)));
        const spend = Math.min(bid, faab[t.team_key]);
        faab[t.team_key] -= spend;
        const ts = Date.UTC(season, 8, 7 + (week - 1) * 7, 12, 0, 0) + rng.int(0, 72) * 36e5;
        transactions.push({
          league_key: leagueKey, txn_id: `tx${++txnId}`, type: 'add/drop', ts, week,
          team_key: t.team_key, player_id: target.player_id, movement: 'add',
          source: 'waivers', destination: t.team_key, faab_bid: spend, raw: null,
        });
        freePool.splice(freePool.indexOf(target), 1);
        rosters.get(t.team_key).push(target);

        // The drop: panicky managers cut recent underperformers, others cut the worst.
        const roster = rosters.get(t.team_key);
        let dropIdx;
        if (rng.bool(a.panic)) {
          const recent = roster.map((p, i) => {
            const s = stats.find((x) => x.player_id === p.player_id && x.week === week - 1);
            return { i, pts: s ? scoreFromLine(JSON.parse(s.stats)) : 0, ppg: p.__ppg };
          }).filter((x) => x.ppg > 4).sort((x, y) => x.pts - y.pts);
          dropIdx = recent[0]?.i;
        }
        if (dropIdx == null) {
          const cnt = {};
          for (const r of roster) cnt[r.pos] = (cnt[r.pos] ?? 0) + 1;
          const MIN = { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1 };
          let worst = -1;
          let worstScore = Infinity;
          roster.forEach((p, i) => {
            if ((cnt[p.pos] ?? 0) <= (MIN[p.pos] ?? 1)) return; // never drop below legal minimum
            const surplus = (cnt[p.pos] ?? 0) - (MIN[p.pos] ?? 1);
            const sc = p.__ppg / (1 + surplus * 0.5); // surplus positions get dropped first
            if (sc < worstScore) { worstScore = sc; worst = i; }
          });
          dropIdx = worst >= 0 ? worst : roster.reduce((w, p, i) => (p.__ppg < roster[w].__ppg ? i : w), 0);
        }
        const dropped = roster[dropIdx];
        if (dropped && roster.length > rosterSize) {
          roster.splice(dropIdx, 1);
          freePool.push(dropped);
          transactions.push({
            league_key: leagueKey, txn_id: `tx${txnId}`, type: 'add/drop', ts: ts + 1000, week,
            team_key: t.team_key, player_id: dropped.player_id, movement: 'drop',
            source: t.team_key, destination: 'waivers', faab_bid: null, raw: null,
          });
        }
      }
      // Dealers make trades.
      if (t.archetype === 'dealer' && rng.bool(0.35)) {
        const other = rng.pick(teams.filter((x) => x.team_key !== t.team_key));
        const mine = rng.pick(rosters.get(t.team_key));
        const theirs = rng.pick(rosters.get(other.team_key));
        if (mine && theirs) {
          const ts = Date.UTC(season, 8, 7 + (week - 1) * 7, 20, 0, 0);
          transactions.push({ league_key: leagueKey, txn_id: `tx${++txnId}`, type: 'trade', ts, week, team_key: t.team_key, player_id: theirs.player_id, movement: 'add', source: other.team_key, destination: t.team_key, faab_bid: null, raw: null });
          transactions.push({ league_key: leagueKey, txn_id: `tx${txnId}`, type: 'trade', ts, week, team_key: other.team_key, player_id: mine.player_id, movement: 'add', source: t.team_key, destination: other.team_key, faab_bid: null, raw: null });
        }
      }
    }
  }

  // ---- Ownership -----------------------------------------------------------
  const rosteredIds = new Set();
  for (const [, r] of rosters) for (const p of r) rosteredIds.add(p.player_id);
  const ownershipRows = players.map((p) => {
    const owned = rosteredIds.has(p.player_id);
    const base = owned ? rng.range(72, 100) : Math.min(60, Math.max(0, p.__ppg * 3.4 + rng.normal(0, 8)));
    return {
      league_key: leagueKey, player_id: p.player_id,
      pct_owned: Math.round(Math.min(100, Math.max(0, base)) * 10) / 10,
      pct_started: Math.round(Math.min(100, Math.max(0, base * rng.range(0.5, 0.95))) * 10) / 10,
      pct_change: Math.round(rng.normal(0, 4) * 10) / 10,
      waiver_status: owned ? 'R' : rng.bool(0.2) ? 'W' : 'FA',
    };
  });

  const rosterRows = [];
  for (const [teamKey, roster] of rosters) {
    const starters = new Set(pickStarters(roster, currentWeek).map((p) => p.player_id));
    for (const p of roster) {
      rosterRows.push({
        league_key: leagueKey, team_key: teamKey, player_id: p.player_id,
        week: currentWeek, slot: starters.has(p.player_id) ? p.pos : 'BN',
        is_starter: starters.has(p.player_id) ? 1 : 0, acquired: null,
      });
    }
  }

  const league = {
    league_key: leagueKey,
    league_id: String(season),
    name: `The Championship Belt (Demo ${season})`,
    season,
    num_teams: numTeams,
    scoring_type: 'head',
    scoring: JSON.stringify(DEFAULT_SCORING),
    roster_slots: JSON.stringify([
      { slot: 'QB', count: 1 }, { slot: 'RB', count: 2 }, { slot: 'WR', count: 3 },
      { slot: 'TE', count: 1 }, { slot: 'W/R/T', count: 1 }, { slot: 'K', count: 1 },
      { slot: 'DEF', count: 1 }, { slot: 'BN', count: 6 },
    ]),
    waiver_type: 'FAAB',
    faab_budget: 100,
    trade_deadline: `${season}-11-20`,
    playoff_start_week: 15,
    end_week: 17,
    num_playoff_teams: 6,
    current_week: currentWeek,
    is_demo: 1,
    synced_at: Date.now(),
  };

  const teamRows = teams.map((t) => ({
    league_key: leagueKey, team_key: t.team_key, team_id: t.team_id,
    name: t.name, manager: t.manager, is_mine: t.is_mine,
    faab_remaining: faab[t.team_key],
    waiver_priority: null,
    wins: record[t.team_key].w, losses: record[t.team_key].l, ties: record[t.team_key].t,
    points_for: Math.round(record[t.team_key].pf * 100) / 100,
    points_against: Math.round(record[t.team_key].pa * 100) / 100,
    moves: transactions.filter((x) => x.team_key === t.team_key && x.movement === 'add').length,
    trade_count: transactions.filter((x) => x.team_key === t.team_key && x.type === 'trade').length,
    logo: null,
  }));

  const playerRows = players.map((p) => ({
    player_id: p.player_id, name: p.name, pos: p.pos, nfl_team: p.nfl_team,
    bye_week: p.bye_week, status: p.status, injury_note: null, age: p.age,
    years_exp: p.years_exp, depth_rank: p.depth_rank, yahoo_key: null,
    sleeper_id: null, headshot: null, updated_at: Date.now(),
  }));

  const payload = {
    league, teams: teamRows, players: playerRows, stats, usage,
    games: gamesRows, rosters: rosterRows, ownership: ownershipRows,
    transactions, matchups: matchupRows, draftPicks, adp: adpRows,
  };

  if (dbWrite) writeDemo(payload);
  return payload;
}

/** Very rough full-PPR scoring used only inside the generator. */
function scoreFromLine(s) {
  return (s.pass_yd ?? 0) * 0.04 + (s.pass_td ?? 0) * 4 - (s.pass_int ?? 0)
    + (s.rush_yd ?? 0) * 0.1 + (s.rush_td ?? 0) * 6
    + (s.rec ?? 0) + (s.rec_yd ?? 0) * 0.1 + (s.rec_td ?? 0) * 6
    - (s.fum_lost ?? 0) * 2
    + (s.fg_made ?? 0) * 3 + (s.pat_made ?? 0)
    + (s.def_sack ?? 0) + (s.def_int ?? 0) * 2 + (s.def_fum_rec ?? 0) * 2 + (s.def_td ?? 0) * 6;
}

/**
 * Decompose a fantasy point total back into a plausible raw stat line, so the
 * scoring engine has real stats to price rather than a pre-computed number.
 */
function synthesiseStatLine(pos, pts, rng) {
  const jitter = (x, f = 0.2) => Math.max(0, x * (1 + rng.normal(0, f)));
  switch (pos) {
    case 'QB': {
      const td = Math.min(6, Math.max(0, Math.round((pts - 8) / 6)));
      const yd = Math.round(jitter(Math.max(0, (pts - td * 4) / 0.04), 0.15));
      return { pass_yd: yd, pass_td: td, pass_int: rng.poisson(0.7), pass_att: Math.round(yd / 7.3), pass_cmp: Math.round(yd / 11), rush_yd: Math.round(jitter(12, 0.9)), rush_att: rng.poisson(3) };
    }
    case 'RB': {
      const td = pts > 14 ? rng.poisson(0.9) : rng.poisson(0.3);
      const rec = rng.poisson(2.6);
      const recYd = Math.round(rec * rng.range(5, 11));
      const rushYd = Math.round(Math.max(0, (pts - td * 6 - rec - recYd * 0.1) / 0.1));
      return { rush_yd: rushYd, rush_td: td, rush_att: Math.max(1, Math.round(rushYd / 4.3)), rec, rec_yd: recYd, rec_td: 0, fum_lost: rng.bool(0.04) ? 1 : 0 };
    }
    case 'WR':
    case 'TE': {
      const td = pts > 15 ? rng.poisson(0.8) : rng.poisson(0.25);
      const rec = Math.max(0, Math.round((pts - td * 6) / rng.range(2.0, 3.2)));
      const recYd = Math.round(Math.max(0, (pts - td * 6 - rec) / 0.1));
      return { rec, rec_yd: recYd, rec_td: td, targets: rec + rng.poisson(2.4) };
    }
    case 'K': {
      const fg = Math.max(0, Math.round((pts - 2) / 3.4));
      return { fg_made: fg, fg_0_19: 0, fg_20_29: rng.bool(0.3) ? 1 : 0, fg_30_39: Math.max(0, fg - 1), fg_40_49: rng.bool(0.4) ? 1 : 0, fg_50p: rng.bool(0.15) ? 1 : 0, pat_made: Math.max(0, Math.round(pts - fg * 3)) };
    }
    default: {
      const sacks = rng.poisson(2.2);
      const ints = rng.poisson(0.8);
      return { def_sack: sacks, def_int: ints, def_fum_rec: rng.poisson(0.6), def_td: rng.bool(0.12) ? 1 : 0, def_pts_allowed: Math.max(0, Math.round(rng.normal(21, 8))) };
    }
  }
}

/** Naive starter selection used only to generate demo history. */
function pickStarters(roster, week) {
  const need = { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1 };
  const flexPositions = ['RB', 'WR', 'TE'];
  const active = roster.filter((p) => p.bye_week !== week && !['O', 'IR', 'PUP', 'SUSP'].includes(p.status));
  const byPos = {};
  for (const p of active) (byPos[p.pos] ??= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.__ppg - a.__ppg);
  const starters = [];
  for (const [pos, n] of Object.entries(need)) starters.push(...(byPos[pos] ?? []).slice(0, n));
  const used = new Set(starters.map((p) => p.player_id));
  const flexPool = active.filter((p) => flexPositions.includes(p.pos) && !used.has(p.player_id))
    .sort((a, b) => b.__ppg - a.__ppg);
  if (flexPool[0]) starters.push(flexPool[0]);
  return starters;
}

/** Persist a generated league. */
export function writeDemo(d) {
  tx(() => {
    run('DELETE FROM leagues WHERE league_key = ?', [d.league.league_key]);
    run('DELETE FROM transactions WHERE league_key = ?', [d.league.league_key]);
    run('DELETE FROM rosters WHERE league_key = ?', [d.league.league_key]);
    run('DELETE FROM matchups WHERE league_key = ?', [d.league.league_key]);
    run('DELETE FROM ownership WHERE league_key = ?', [d.league.league_key]);
    run('DELETE FROM draft_picks WHERE league_key = ?', [d.league.league_key]);
  });

  upsertMany('leagues', Object.keys(d.league), [d.league], ['league_key']);
  upsertMany('teams', Object.keys(d.teams[0]), d.teams, ['league_key', 'team_key']);
  upsertMany('players', Object.keys(d.players[0]), d.players, ['player_id']);
  upsertMany('player_stats', ['player_id', 'season', 'week', 'opponent', 'stats'], d.stats, ['player_id', 'season', 'week']);
  upsertMany('player_usage', Object.keys(d.usage[0]), d.usage, ['player_id', 'season', 'week']);
  upsertMany('games', Object.keys(d.games[0]), d.games, ['season', 'week', 'home', 'away']);
  upsertMany('rosters', Object.keys(d.rosters[0]), d.rosters, ['league_key', 'team_key', 'player_id', 'week']);
  upsertMany('ownership', Object.keys(d.ownership[0]), d.ownership, ['league_key', 'player_id']);
  upsertMany('transactions', Object.keys(d.transactions[0]), d.transactions, ['league_key', 'txn_id', 'player_id', 'movement']);
  upsertMany('matchups', Object.keys(d.matchups[0]), d.matchups, ['league_key', 'week', 'team_key']);
  upsertMany('draft_picks', Object.keys(d.draftPicks[0]), d.draftPicks, ['league_key', 'pick']);
  upsertMany('adp', Object.keys(d.adp[0]), d.adp, ['player_id', 'season', 'source']);

  meta.set('active_league', d.league.league_key);
  meta.set('demo_seeded_at', String(Date.now()));
  return d.league.league_key;
}
