/** League-scoped, explained decisions. No fabricated title deltas or automatic moves. */
import { all, get, j, meta } from './db/index.mjs';
import * as S from './service.mjs';
import { optimalLineup } from './engine/optimizer.mjs';
import { playerCanFill, expandSlots } from './engine/roster.mjs';
import { optimizeForWinProbability } from './engine/leverage.mjs';

const brief = (p) => p ? { player_id: p.player_id, name: p.name, pos: p.pos, mean: p.mean, seasonMean: p.seasonMean } : null;

export function actionPlan(league, { now = Date.now() } = {}) {
  const key = league.league_key;
  const week = league.current_week;
  const sync = j(meta.get(`refresh:${key}`), {});
  // A league entered by hand has no live provider to refresh from, so "never
  // refreshed" is its permanent state, not a fault — and treating it as one
  // switched add/drop advice off for good. Its rosters are exactly as current as
  // the last import, which is what the page says instead.
  const manual = !league.isDemo && !key.startsWith('sleeper.l.') && !/^\d+\.l\.\d+$/.test(key);
  if (manual) sync.errors = (sync.errors ?? []).filter((e) => !/^Manually imported league/.test(e));
  const stale = !league.isDemo && !manual && (!sync.lastSuccess || now - sync.lastSuccess > 90 * 60000 || sync.errors?.length > 0);
  const me = get('SELECT * FROM teams WHERE league_key = ? AND is_mine = 1', [key]);
  const changes = all(`SELECT x.type, x.movement, x.ts, p.name player, t.name team
    FROM transactions x LEFT JOIN players p ON p.player_id=x.player_id
    LEFT JOIN teams t ON t.league_key=x.league_key AND t.team_key=x.team_key
    WHERE x.league_key=? AND x.ts>? ORDER BY x.ts DESC LIMIT 12`, [key, now - 86400000]);
  const response = {
    leagueKey: key, leagueName: league.name, week, generatedAt: now,
    freshness: { stale: !!stale, manual, enteredAt: manual ? league.synced_at ?? null : null,
      lastSuccess: sync.lastSuccess ?? null, errors: sync.errors ?? [], evidenceErrors: sync.evidenceErrors ?? [] },
    changes, acquisitions: [], lineupChanges: [], holes: [], starters: [], bench: [], blockers: [],
    waiverType: /faab/i.test(league.waiver_type ?? '') ? 'FAAB' : 'priority',
    waiverPriority: me?.waiver_priority ?? null, faabRemaining: me?.faab_remaining ?? null,
    phase: meta.get(`league_status:${key}`) ?? 'in_season',
    interpretation: 'Projected lineup gains are model estimates, not measured championship probability.',
  };
  if (!me) { response.blockers.push('Select your team for this league before using recommendations.'); return response; }
  if (stale) response.blockers.push('League rosters have not been refreshed successfully within 90 minutes. Treat cached decisions as provisional.');
  const unmapped = j(meta.get(`scoring_unmapped:${key}`), []);
  if (unmapped.length) response.blockers.push(`Scoring rules still need support: ${unmapped.join(', ')}`);
  const roster = S.rosterOf(key, me.team_key, week);
  if (!roster.length) { response.blockers.push('No roster saved. If drafting, open the Draft Room for live pick advice.'); return response; }
  const projections = S.project(league, roster, week);
  const rosterById = new Map(roster.map((p) => [p.player_id, p]));
  const games = all("SELECT * FROM games WHERE season=? AND week=? AND source='real'", [league.season, week]);
  const gameOf = (p) => games.find((g) => g.home === p.nfl_team || g.away === p.nfl_team);
  const started = (p) => Number(gameOf(p)?.kickoff ?? Infinity) <= now;
  const locked = projections.filter(started);
  const actualIds = new Set(roster.filter((p) => p.is_starter).map((p) => p.player_id));
  const fixed = [];
  const slots = [...league.slots];
  // Preserve actual slot assignment once a game starts. Unknown slot means
  // stop rather than invent a legal move around a locked player.
  for (const p of locked.filter((p) => actualIds.has(p.player_id))) {
    const slot = rosterById.get(p.player_id).slot;
    const i = slots.indexOf(slot);
    if (i < 0) { response.blockers.push('A locked starter has no exact saved slot. Refresh the provider before changing the lineup.'); return response; }
    slots.splice(i, 1); fixed.push({ slot, player: p });
  }
  const available = projections.filter((p) => !started(p));
  let best = optimalLineup(available, slots, (p) => p.mean);
  response.lineupBasis = 'Expected points in this league’s scoring';
  const opponent = S.opponentForWeek(league, me.team_key, week);
  if (!locked.length && !stale && opponent.oppKey && opponent.source !== 'estimated') {
    const theirRoster = S.rosterOf(key, opponent.oppKey, week);
    const actual = theirRoster.filter((p) => p.is_starter);
    if (actual.length === league.slots.length && !actual.some(started)) {
      const decision = optimizeForWinProbability(available, slots, S.project(league, actual, week), { sims: 12000 });
      best = { ...best, lineup: decision.recommended.lineup };
      response.lineupBasis = decision.explanation;
      response.lineupWinProbability = decision.recommended.winProb;
    }
  }
  const starters = [...fixed, ...best.lineup];
  const chosen = new Set(starters.filter((s) => s.player).map((s) => s.player.player_id));
  response.starters = starters.map((s) => ({ slot: s.slot, player: brief(s.player), locked: s.player ? started(s.player) : false,
    opponent: s.player?.opponent ?? null, isHome: s.player?.isHome ?? null, status: s.player?.status || null,
    current: s.player ? actualIds.has(s.player.player_id) : false }));
  // A slot that cannot score is a gap to fill from waivers, not a lineup move:
  // starting a kicker on bye "fills K" and still scores nothing.
  for (const s of starters) {
    if (s.player && s.player.mean > 0.05) continue;
    const reason = !s.player ? 'empty' : s.player.opponent === 'BYE' ? 'bye' : /^(O|IR|PUP|SUSP)$/.test(s.player.status ?? '') ? 'out' : 'zero';
    response.holes.push({ slot: s.slot, player: brief(s.player), reason });
  }
  const holeIds = new Set(response.holes.map((x) => x.player?.player_id).filter(Boolean));
  response.bench = projections.filter((p) => !chosen.has(p.player_id)).map(brief);
  const outs = projections.filter((p) => actualIds.has(p.player_id) && !chosen.has(p.player_id) && !started(p));
  for (const s of best.lineup.filter((s) => s.player && !actualIds.has(s.player.player_id) && !holeIds.has(s.player.player_id))) {
    const p = s.player;
    const out = outs.find((o) => playerCanFill(s.slot, o));
    if (out) outs.splice(outs.indexOf(out), 1);
    response.lineupChanges.push({ start: brief(p), sit: brief(out), slot: s.slot,
      gain: p.mean - (out?.mean ?? 0),
      why: `${p.name} projects ${p.mean.toFixed(1)} in your scoring${out ? ` versus ${out.name} at ${out.mean.toFixed(1)}` : ` and fills ${s.slot}`}. ${p.status ? `Designation ${p.status}: recheck availability before kickoff.` : 'No injury designation in the saved feed.'}`,
      deadline: gameOf(p)?.kickoff ?? null });
  }
  if (!games.length) response.blockers.push('Verified kickoff times unavailable. Check player locks on the league platform before acting.');

  const allRosters = S.getTeams(key).map((t) => S.rosterOf(key, t.team_key, week));
  const rosterCount = allRosters.filter((r) => r.length).length;
  const noSource = projections.filter((p) => !p.games && !p.components.some((c) => c.key === 'baseline' && /projection|archetype/.test(c.note ?? '')));
  const publicationTimes = new Map(all('SELECT player_id, MAX(fetched_at) at FROM external_projections WHERE season=? AND week=? GROUP BY player_id', [league.season, week]).map((r) => [r.player_id, r.at]));
  const staleForecast = (p) => publicationTimes.has(p.player_id) && now - publicationTimes.get(p.player_id) > 24 * 3600000;
  const staleForecasts = projections.some(staleForecast);
  if (staleForecasts) response.blockers.push('Some weekly forecasts are over 24 hours old. Refresh before acting.');
  if (noSource.length) response.blockers.push('Some roster players lack a projection or ranking. Do not drop players based only on fallback values.');
  // A partial import is not evidence of free agency.
  if (rosterCount !== league.num_teams || stale || unmapped.length || noSource.length || staleForecasts || sync.evidenceErrors?.length) {
    response.acquisitionNote = 'Add/drop recommendations paused until roster ownership, scoring and player evidence are trustworthy.';
    return finishPlan(response, { current: projections, fixed, slots, started, actualIds, roster });
  }
  const rosterLimit = expandSlots(league.rosterSlots).filter((s) => !['IR', 'IR+', 'NA'].includes(s)).length;
  const irIds = new Set(roster.filter((p) => ['IR', 'IR+'].includes(p.slot)).map((p) => p.player_id));
  const fa = S.project(league, S.freeAgentPool(key, week, { limit: 400 }).filter((p) => p.nfl_team && !started(p)), week)
    .filter((add) => !staleForecast(add)
      && add.mean > 0 && !(add.games === 0 && !add.components.some((c) => c.key === 'baseline' && /projection|archetype/.test(c.note ?? ''))));

  // A plan, not a menu. Each move is chosen against the roster the previous
  // moves leave behind: ranked independently, the best two "adds" were two
  // defenses fighting over one slot while the empty kicker spot went unfilled.
  let current = projections;
  const taken = new Set();
  for (let step = 0; step < 3; step++) {
    const live = current.filter((p) => !started(p));
    const lineupNow = optimalLineup(live, slots, (p) => p.mean);
    const startingNow = new Set(lineupNow.lineup.filter((s) => s.player).map((s) => s.player.player_id));
    const activeSize = current.filter((p) => !irIds.has(p.player_id)).length;
    const drops = activeSize < rosterLimit ? [null]
      : current.filter((p) => !startingNow.has(p.player_id) && !started(p) && !irIds.has(p.player_id));
    const seasonBase = optimalLineup(current, league.slots, (p) => p.seasonMean).total;
    const weeklyBase = lineupNow.total;
    let choice = null;
    for (const add of fa) {
      if (taken.has(add.player_id)) continue;
      for (const drop of drops) {
        const after = [...current.filter((p) => p.player_id !== drop?.player_id), add];
        const weeklyGain = optimalLineup(after.filter((p) => !started(p)), slots, (p) => p.mean).total - weeklyBase;
        const seasonGain = optimalLineup(after, league.slots, (p) => p.seasonMean).total - seasonBase;
        const benchGain = (add.seasonMean - (drop?.seasonMean ?? 0)) * 0.15;
        const score = weeklyGain + seasonGain + benchGain;
        // Do not trade a future starter away to chase a one-week streamer.
        // A move must improve a lineup — this week's or the season's. A bench-only
        // reshuffle (a backup QB for the only spare kicker) is churn, not advice.
        if (seasonGain < -0.5 || score < 1 || (weeklyGain < 0.5 && seasonGain < 1)) continue;
        if (!choice || score > choice.score) choice = { add: brief(add), drop: brief(drop), weeklyGain, seasonGain, score,
          addDetail: add, dropDetail: drop,
          category: weeklyGain >= 0.5 ? 'Improve this lineup' : 'Bench upgrade to review',
          why: `${weeklyGain.toFixed(1)} projected points gained in the remaining lineup; ${seasonGain.toFixed(1)} per-game change to the season starting lineup. ${drop ? `Giving up ${drop.name} costs a bench option valued at ${drop.seasonMean.toFixed(1)} per game.` : 'Uses an open roster spot.'}`,
          deadline: gameOf(add)?.kickoff ?? null };
      }
    }
    if (!choice) break;
    const { addDetail, dropDetail, ...move } = choice;
    move.step = step + 1;
    move.addPos = addDetail.pos;
    move.opponent = addDetail.opponent ?? null;
    move.isHome = addDetail.isHome ?? null;
    response.acquisitions.push(move);
    taken.add(addDetail.player_id);
    current = [...current.filter((p) => p.player_id !== dropDetail?.player_id), addDetail];
  }
  response.acquisitionNote = response.acquisitions.length
    ? 'A sequence: each move assumes the ones before it were made. Verify waiver clearance and drop eligibility on your league platform.'
    : 'Hold your roster. No supported upgrade clears the current evidence threshold.';
  return finishPlan(response, { current, fixed, slots, started, actualIds, roster, added: taken });
}

/**
 * The lineup to set once every recommended move is made, and the start/sit
 * swaps that takes. Without it an add reads as complete when it is only half
 * the job: claiming a defense does nothing until it replaces the one starting.
 */
function finishPlan(response, { current, fixed, slots, started, actualIds, roster, added = new Set() }) {
  const best = optimalLineup(current.filter((p) => !started(p)), slots, (p) => p.mean);
  const lineup = [...fixed, ...best.lineup];
  const inLineup = new Set(lineup.filter((s) => s.player).map((s) => s.player.player_id));
  response.plannedLineup = lineup.map((s) => ({
    slot: s.slot, player: brief(s.player),
    opponent: s.player?.opponent ?? null, isHome: s.player?.isHome ?? null, status: s.player?.status || null,
    locked: s.player ? started(s.player) : false,
    isNew: s.player ? added.has(s.player.player_id) : false,
    alreadyStarting: s.player ? actualIds.has(s.player.player_id) : false,
  }));
  // Who comes out for each newcomer: whoever holds that slot now and is not in
  // the planned lineup anywhere else.
  const benched = roster.filter((p) => actualIds.has(p.player_id) && !inLineup.has(p.player_id));
  response.plannedSwaps = lineup.filter((s) => s.player && !actualIds.has(s.player.player_id) && !started(s.player)).map((s) => {
    // Same slot first; failing that, whoever else drops out of the lineup — the
    // optimiser reshuffles slots, so a flex start can push out a WR-slot starter.
    let outIdx = benched.findIndex((p) => p.slot === s.slot);
    if (outIdx < 0) outIdx = benched.findIndex((p) => playerCanFill(s.slot, p) || playerCanFill(p.slot, s.player));
    if (outIdx < 0 && benched.length) outIdx = 0;
    const out = outIdx >= 0 ? benched.splice(outIdx, 1)[0] : null;
    return { slot: s.slot, start: brief(s.player), sit: out ? { player_id: out.player_id, name: out.name, pos: out.pos } : null,
      isNew: added.has(s.player.player_id) };
  });
  response.remainingHoles = lineup.filter((s) => !s.player || s.player.mean <= 0.05).map((s) => s.slot);
  return response;
}
