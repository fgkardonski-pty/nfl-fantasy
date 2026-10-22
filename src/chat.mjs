/**
 * The "Ask" assistant: explains the app's own recommendations in plain words.
 *
 * It is an explainer, not a second engine. Every number it may use comes from
 * the same functions the pages render — the weekly plan, the matchup
 * simulation, the waiver board — frozen into a snapshot at the start of each
 * conversation, plus two read-only lookups for players the snapshot does not
 * cover. It is told to disagree with a recommendation when the numbers say the
 * edge is marginal, because a recommendation that cannot survive the question
 * "why?" should not survive it.
 *
 * Conversations are append-only and live on the server. The model keeps its
 * reasoning (thinking blocks) bound to the exact conversation that produced
 * it, so history is never edited or rebuilt between turns: the system prompt
 * and tools are constants, the league snapshot is the first message, and each
 * turn only appends. A server restart forgets conversations; the client then
 * starts a new one.
 */
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import config from './config.mjs';
import * as S from './service.mjs';
import { actionPlan } from './actions.mjs';
import { all, get } from './db/index.mjs';
import { normaliseName } from './providers/sleeper.mjs';
import { optimalLineup } from './engine/optimizer.mjs';
import { logger } from './util/log.mjs';

const log = logger('chat');

export const isEnabled = () => Boolean(config.anthropicKey);

let client = null;
const api = () => (client ??= new Anthropic({
  apiKey: config.anthropicKey,
  defaultHeaders: config.anthropicWorkspaceId ? { 'anthropic-workspace-id': config.anthropicWorkspaceId } : undefined,
}));

const MAX_TOOL_ROUNDS = 6;
const MAX_CONVERSATIONS = 50;
const conversations = new Map();   // id -> { leagueKey, messages, createdAt }

// Frozen for the life of the process: any change to it mid-conversation would
// invalidate the model's earlier reasoning and the prompt cache.
const SYSTEM = `You are the assistant inside Gridiron Oracle, a fantasy football app. The person you are talking to manages the team marked "mine" in the league snapshot. Your job is to explain the app's recommendations and help them decide what to do in their league platform (Yahoo or Sleeper).

How the app works, so you can explain it:
- Weekly projection ("weekProj"): a published projection for this week, priced through this league's own scoring rules. Floor and ceiling are the 10th and 90th percentiles of the simulated distribution.
- Season value ("seasonValue"): points per week over the rest of the season — recent games weighted more heavily, shrunk toward the player's preseason rank when few games have been played. A player with 1-2 games is mostly his preseason rank; one with 6 games is mostly his play.
- The plan ("plan.moves"): a sequence of add/drop moves, each chosen against the roster the previous moves leave behind. A move is only listed if it adds at least 0.5 points to this week's best lineup or at least 1 point per week to the typical season lineup. "weeklyGain" and "seasonGain" are those two numbers.
- Win probability: thousands of simulated games of the user's best lineup against the opponent's BEST possible lineup (deliberately pessimistic — managers fix lineups before kickoff). "ifOpponentKeepsLineup" is the chance if the opponent leaves the lineup they currently have set.
- Waivers: a player marked "W" in the league platform is on waivers and needs a claim, processed in waiver-priority order; "FA" means he can be added immediately.
- Season odds ("leagueStandings"): the rest of the regular season is simulated thousands of times from each team's current record plus its projected weekly score (mean and spread of its best lineup), against the real schedule where known and an estimated one otherwise. The top teams by record make the playoffs; the bracket is single elimination, re-seeded each round. Title odds = how often a team wins every playoff game. Because the playoffs ignore regular-season record, title odds track roster strength ("typicalWeek") far more than record: a strong 4-2 team can out-rank a weaker 5-1 team. The way to raise title odds is to raise the typical-week score - through trades and long-term pickups, not this week's streamers.
- Trades: trade_ideas returns packages the app found where the user's typical-week score rises, with the other team's gain and an estimated acceptance chance. Acceptance estimates are rough when the league has no transaction history.

How to answer:
- Use only numbers from the snapshot or from your tools. Never invent stats, injuries or news. If something is not in the data, say you don't have it.
- Lead with the direct answer, then the two or three numbers that drive it. Keep it short: a few sentences or a short list. Plain words — no "σ", "VOR" or model jargon.
- Be honest about margins. If a recommended move gains about a point a week or less, say it is marginal and say what it costs (for example, giving up the best bench cover at a position). It is fine to tell the user to skip a recommendation.
- When the user asks about a player not in the snapshot, use lookup_player. For "who else is available at X", use best_available. To compare against another team or explain its odds, use get_team. For "how do I improve my chances" or anything about trades, use trade_ideas.
- You can see every team in the league through leagueStandings and get_team - never say you lack another team's data without calling get_team first.
- When recommending an action, say exactly what to do in the league platform: who to add, who to drop, who to start and who to bench.`;

const TOOLS = [
  {
    name: 'lookup_player',
    description: 'Look up any NFL player by name: this week\'s projection in this league\'s scoring, floor and ceiling, season value, injury status, games played, and who owns him in this league (or that he is available). Use it for any player not already in the snapshot.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Player or team-defense name, e.g. "Tre Tucker" or "Dolphins".' } },
      required: ['name'],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: 'get_team',
    description: "Get any team in this league: record, title and playoff odds, its full roster with this week's and season projections, its best lineup this week, and its typical-week strength. Use it to compare teams or explain why a team's odds are higher or lower.",
    input_schema: {
      type: 'object',
      properties: { team: { type: 'string', description: 'Team name as it appears in leagueStandings, e.g. "The Sharks".' } },
      required: ['team'],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: 'trade_ideas',
    description: "The app's trade suggestions for the user: what to send, what to get, how much each side's typical-week score changes, and an estimated chance the other manager accepts.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: 'best_available',
    description: 'List the best unrostered players in this league at one position, with how much each would add to the user\'s best lineup this week and over the season.',
    input_schema: {
      type: 'object',
      properties: { position: { type: 'string', enum: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] } },
      required: ['position'],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
];

const r1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);

function playerFacts(p) {
  const base = (p.components ?? []).find((c) => c.kind === 'base');
  return {
    name: p.name, pos: p.pos, nflTeam: p.nfl_team ?? null,
    status: p.status || null,
    game: p.opponent === 'BYE' ? 'BYE' : p.opponent ? `${p.isHome ? 'vs' : '@'} ${p.opponent}` : null,
    weekProj: r1(p.mean), floor: r1(p.floor), ceiling: r1(p.ceiling),
    seasonValue: r1(p.seasonMean), gamesPlayed: p.games ?? 0,
    projectionSource: base?.note ?? null,
  };
}

/** Everything the assistant may cite, built from the same calls the pages use. */
function snapshot(league) {
  const week = league.current_week;
  const me = S.myTeam(league.league_key);
  const plan = actionPlan(league);
  const roster = S.project(league, S.rosterOf(league.league_key, me.team_key, week), week);
  let matchup = null;
  try {
    const w = S.warRoom(league, { sims: 6000 });
    if (w.ready !== false) {
      matchup = {
        opponent: w.opponent?.name ?? null,
        opponentSource: w.opponentSource,
        winProbability: r1(w.sim.winProb * 100),
        myProjectedScore: r1(w.sim.myMean),
        opponentBestLineupScore: r1(w.sim.oppMean),
        ifOpponentKeepsLineup: w.ifOpponentKeepsLineup
          ? { winProbability: r1(w.ifOpponentKeepsLineup.winProb * 100), opponentScore: r1(w.ifOpponentKeepsLineup.oppMean), notStarting: w.ifOpponentKeepsLineup.benched }
          : null,
        opponentLineup: (w.oppLineup ?? []).filter((l) => l.player).map((l) => ({ slot: l.slotLabel ?? l.slot, name: l.player.name, weekProj: r1(l.player.mean) })),
      };
    }
  } catch (err) { log.warn(`matchup unavailable for chat: ${err.message}`); }

  let season = null;
  let standings = [];
  try {
    const o = S.cachedOutlook(league);
    const mine = o.results?.find((r) => r.is_mine);
    if (mine) season = { titleOdds: r1(mine.titleOdds * 100), playoffOdds: r1(mine.playoffOdds * 100), expectedWins: r1(mine.expectedWins) };
    const teamRows = new Map(S.getTeams(league.league_key).map((t) => [t.team_key, t]));
    standings = (o.results ?? []).map((r) => {
      const t = teamRows.get(r.team_key) ?? {};
      return {
        team: r.name, manager: t.manager ?? null, isMine: !!r.is_mine,
        record: `${t.wins ?? 0}-${t.losses ?? 0}${t.ties ? `-${t.ties}` : ''}`,
        titleOdds: r1(r.titleOdds * 100), playoffOdds: r1(r.playoffOdds * 100),
        expectedFinalWins: r1(r.expectedWins), typicalWeek: r1(r.projMean), weeklySpread: r1(r.projSd),
      };
    });
  } catch { /* odds are a nicety here */ }

  const schedule = [];
  for (let w = week; w < (league.playoff_start_week ?? 15); w++) {
    try {
      const { oppKey, source } = S.opponentForWeek(league, me.team_key, w);
      const opp = oppKey ? get('SELECT name FROM teams WHERE league_key = ? AND team_key = ?', [league.league_key, oppKey]) : null;
      if (opp) schedule.push({ week: w, opponent: opp.name, confirmed: source !== 'estimated' });
    } catch { /* schedule is context, not essential */ }
  }

  const board = S.waiverBoard(league, { limit: 60 });
  const topByPos = {};
  for (const t of board.targets) {
    (topByPos[t.pos] ??= []);
    if (topByPos[t.pos].length < 5) topByPos[t.pos].push({ ...playerFacts(t), addsThisWeek: r1(t.marginalWeekly), restOfSeasonValueToYou: r1(t.rosValue) });
  }

  return {
    league: {
      name: league.name, week, scoring: league.scoringLabel,
      startingSlots: league.slots, waiverType: plan.waiverType,
      myWaiverPriority: plan.waiverPriority, teams: league.num_teams,
      rostersAsOf: plan.freshness.manual ? `entered by hand ${new Date(plan.freshness.enteredAt).toISOString().slice(0, 16)}` : 'synced from the league platform',
    },
    myTeam: {
      name: me.name, record: `${me.wins}-${me.losses}${me.ties ? `-${me.ties}` : ''}`,
      roster: roster.map((p) => ({ ...playerFacts(p), rosterSlot: p.slot })),
    },
    plan: {
      moves: plan.acquisitions.map((a) => ({ step: a.step, add: a.add.name, addPos: a.addPos, drop: a.drop?.name ?? null,
        weeklyGain: r1(a.weeklyGain), seasonGain: r1(a.seasonGain), appExplanation: a.why })),
      startSitChanges: (plan.plannedSwaps ?? []).map((s) => ({ slot: s.slot, start: s.start.name, bench: s.sit?.name ?? null, isNewPickup: s.isNew })),
      gaps: plan.holes,
      lineupAfterMoves: (plan.plannedLineup ?? []).map((s) => ({ slot: s.slot, name: s.player?.name ?? null, weekProj: r1(s.player?.mean) })),
      note: plan.acquisitionNote ?? null,
      warnings: plan.blockers,
    },
    matchup,
    seasonOdds: season,
    leagueStandings: standings,
    myRemainingSchedule: schedule,
    playoffs: { teams: league.num_playoff_teams, startWeek: league.playoff_start_week, endWeek: league.end_week },
    bestAvailableByPosition: topByPos,
  };
}

function lookupPlayer(league, name) {
  const want = normaliseName(String(name ?? ''));
  if (!want) return { error: 'No name given.' };
  const rows = all("SELECT * FROM players WHERE pos IN ('QB','RB','WR','TE','K','DEF') AND nfl_team IS NOT NULL");
  let hits = rows.filter((p) => normaliseName(p.name) === want);
  if (!hits.length) hits = rows.filter((p) => normaliseName(p.name).includes(want) || (p.pos === 'DEF' && want.includes(normaliseName(p.name).split(' ').pop())));
  if (!hits.length) return { error: `No active player matches "${name}".` };
  const week = league.current_week;
  return S.project(league, hits.slice(0, 3), week).map((p) => {
    const owner = get(`SELECT t.name, t.is_mine FROM rosters r JOIN teams t ON t.team_key = r.team_key AND t.league_key = r.league_key
                       WHERE r.league_key = ? AND r.week = ? AND r.player_id = ?`, [league.league_key, week, p.player_id]);
    return { ...playerFacts(p), byeWeek: p.bye_week ?? null, ownedBy: owner ? (owner.is_mine ? 'you' : owner.name) : 'available (not on any roster in this league)' };
  });
}

function bestAvailable(league, position) {
  const board = S.waiverBoard(league, { limit: 120 });
  const list = board.targets.filter((t) => t.pos === position).slice(0, 8)
    .map((t) => ({ ...playerFacts(t), addsThisWeek: r1(t.marginalWeekly), restOfSeasonValueToYou: r1(t.rosValue) }));
  return list.length ? list : { note: `No ${position} available improves your roster.` };
}

function getTeam(league, name) {
  const want = normaliseName(String(name ?? ''));
  const teams = S.getTeams(league.league_key);
  const t = teams.find((x) => normaliseName(x.name) === want)
    ?? teams.find((x) => normaliseName(x.name).includes(want) || want.includes(normaliseName(x.name)));
  if (!t) return { error: `No team called "${name}". Teams: ${teams.map((x) => x.name).join(', ')}` };
  const week = league.current_week;
  const roster = S.project(league, S.rosterOf(league.league_key, t.team_key, week), week);
  const best = optimalLineup(roster, league.slots, (p) => p.mean);
  const typical = optimalLineup(roster, league.slots, (p) => p.seasonMean ?? p.mean);
  const odds = S.cachedOutlook(league).results?.find((r) => r.team_key === t.team_key);
  return {
    team: t.name, manager: t.manager, isMine: !!t.is_mine,
    record: `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}`,
    titleOdds: odds ? r1(odds.titleOdds * 100) : null, playoffOdds: odds ? r1(odds.playoffOdds * 100) : null,
    bestLineupThisWeek: r1(best.total), typicalWeek: r1(typical.total),
    typicalLineup: typical.lineup.filter((x) => x.player).map((x) => ({ slot: x.slotLabel ?? x.slot, name: x.player.name, seasonValue: r1(x.player.seasonMean) })),
    roster: roster.map((p) => ({ ...playerFacts(p), rosterSlot: p.slot })),
  };
}

function tradeIdeas(league) {
  const t = S.tradeBoard(league, { limit: 8 });
  const deal = (d) => ({
    with: d.teamName, send: d.send.map((p) => p.name), receive: d.receive.map((p) => p.name),
    myTypicalWeekGain: r1(d.myGainPerWeek), theirTypicalWeekGain: r1(d.theirRealGain),
    acceptChance: r1(d.acceptProb * 100),
  });
  return { fairTrades: t.winWin.slice(0, 6).map(deal), lopsidedTrades: t.arbitrage.slice(0, 4).map(deal), weeksBeforePlayoffs: t.weeksRemaining };
}

function runTool(league, block) {
  const input = block.input ?? {};
  // Inputs stream unvalidated (eager input streaming), so check them here.
  if (block.name === 'lookup_player') {
    if (typeof input.name !== 'string' || !input.name.trim()) return { error: 'lookup_player needs a "name" string.' };
    return lookupPlayer(league, input.name);
  }
  if (block.name === 'get_team') {
    if (typeof input.team !== 'string' || !input.team.trim()) return { error: 'get_team needs a "team" string.' };
    return getTeam(league, input.team);
  }
  if (block.name === 'trade_ideas') return tradeIdeas(league);
  if (block.name === 'best_available') {
    if (!['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(input.position)) return { error: 'position must be one of QB, RB, WR, TE, K, DEF.' };
    return bestAvailable(league, input.position);
  }
  return { error: `Unknown tool ${block.name}` };
}

function newConversation(league) {
  if (conversations.size >= MAX_CONVERSATIONS) {
    const oldest = [...conversations.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    conversations.delete(oldest[0]);
  }
  const id = crypto.randomUUID();
  const convo = { leagueKey: league.league_key, messages: [], createdAt: Date.now(), snapshot: snapshot(league) };
  conversations.set(id, convo);
  return { id, convo };
}

/**
 * Answer one question, streaming newline-delimited JSON events to `emit`:
 * {type:"start", conversationId} · {type:"text", delta} · {type:"tool", name} ·
 * {type:"done"} · {type:"error", message}.
 */
export async function ask(league, { conversationId, message }, emit) {
  let id = conversationId;
  let convo = id ? conversations.get(id) : null;
  if (!convo || convo.leagueKey !== league.league_key) ({ id, convo } = newConversation(league));
  emit({ type: 'start', conversationId: id, fresh: convo.messages.length === 0 });

  const question = String(message ?? '').trim().slice(0, 4000);
  // The snapshot travels in the first user turn only, so it is part of the
  // fixed prefix every later turn appends to.
  convo.messages.push(convo.messages.length === 0
    ? { role: 'user', content: [
        { type: 'text', text: `<league_snapshot>\n${JSON.stringify(convo.snapshot)}\n</league_snapshot>` },
        { type: 'text', text: question },
      ] }
    : { role: 'user', content: question });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = api().beta.messages.stream({
      model: config.chatModel,
      max_tokens: 64000,
      system: SYSTEM,
      tools: TOOLS,
      messages: convo.messages,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      // If a safety classifier declines, the API re-runs the turn on a
      // fallback model inside the same call instead of returning nothing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    stream.on('text', (delta) => emit({ type: 'text', delta }));
    const reply = await stream.finalMessage();
    // Appended verbatim — thinking blocks included — so the next request's
    // prefix is byte-identical to this one's.
    convo.messages.push({ role: 'assistant', content: reply.content });

    if (reply.stop_reason === 'refusal') {
      emit({ type: 'text', delta: '\n\nI can’t help with that one. Try asking about a specific player or recommendation.' });
      break;
    }
    if (reply.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of reply.content.filter((b) => b.type === 'tool_use')) {
      emit({ type: 'tool', name: block.name });
      let out;
      try { out = runTool(league, block); } catch (err) { out = { error: err.message }; }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out), is_error: Boolean(out?.error) });
    }
    convo.messages.push({ role: 'user', content: results });
  }
  emit({ type: 'done' });
}

/** Map SDK errors to something the chat panel can say. */
export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key in .env was rejected. Check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.RateLimitError) return 'The assistant is rate-limited right now. Wait a minute and ask again.';
  if (err instanceof Anthropic.BadRequestError && /workspace/i.test(err.message)) {
    return 'Your Anthropic API key is not tied to a workspace. Add ANTHROPIC_WORKSPACE_ID=wrkspc_... to .env (Anthropic Console → Settings → Workspaces), or use a key created inside a workspace.';
  }
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `The assistant service returned an error (${err.status}). Try again.`;
  return err.message ?? String(err);
}
