#!/usr/bin/env node
/**
 * Gridiron Oracle command line.
 *
 * Everything the war room can do is available here, because the night before a
 * draft you want a board in your terminal, not a browser tab.
 */
import process from 'node:process';
import config from '../src/config.mjs';
import { getDb, closeDb, all, get, meta } from '../src/db/index.mjs';
import * as S from '../src/service.mjs';
import { generateDemoLeague } from '../src/demo.mjs';
import { startServer } from '../src/server/index.mjs';
import { daemon } from '../src/research/daemon.mjs';
import { JOBS } from '../src/research/jobs.mjs';
import * as oauth from '../src/providers/yahoo/oauth.mjs';
import * as yahooClient from '../src/providers/yahoo/client.mjs';
import { syncLeague } from '../src/providers/yahoo/sync.mjs';
import { recommendPick, snakePicks, nextOwnPick } from '../src/engine/draft.mjs';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', grey: '\x1b[90m', white: '\x1b[97m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = new Proxy(C, { get: (t, k) => (useColor ? t[k] ?? '' : '') });

const out = (s = '') => process.stdout.write(`${s}\n`);
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const rpad = (s, n) => String(s ?? '').padStart(n);

function rule(title = '') {
  const w = Math.min(process.stdout.columns || 96, 96);
  if (!title) return out(c.grey + '─'.repeat(w) + c.reset);
  const line = `── ${title} `;
  out(c.grey + line + '─'.repeat(Math.max(0, w - line.length)) + c.reset);
}

function league(opts) {
  const l = S.getLeague(opts.league);
  if (!l) {
    out(`${c.red}No league loaded.${c.reset}`);
    out(`Run ${c.cyan}node bin/oracle.mjs demo${c.reset} to seed a demo league,`);
    out(`or ${c.cyan}node bin/oracle.mjs serve${c.reset} and connect your Yahoo account.`);
    process.exit(1);
  }
  return l;
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  async serve(opts) {
    const server = await startServer({ port: opts.port ?? config.port, host: opts.host ?? config.host });
    const url = `http://${opts.host ?? config.host}:${opts.port ?? config.port}`;
    out('');
    out(`  ${c.bold}${c.green}GRIDIRON ORACLE${c.reset} ${c.grey}· war room live${c.reset}`);
    out(`  ${c.cyan}${url}${c.reset}`);
    const l = S.getLeague();
    if (l) out(`  ${c.grey}league:${c.reset} ${l.name} ${c.grey}· week ${l.current_week} · ${l.scoringLabel}${c.reset}`);
    else out(`  ${c.yellow}no league loaded — run: node bin/oracle.mjs demo${c.reset}`);
    const y = oauth.connectionStatus();
    out(`  ${c.grey}yahoo:${c.reset} ${y.connected ? c.green + 'connected' : y.configured ? c.yellow + 'configured, not connected' : c.grey + 'not configured'}${c.reset}`);
    if (opts.research) { daemon.start(); out(`  ${c.grey}research daemon:${c.reset} ${c.green}running${c.reset}`); }
    out('');
    const shutdown = () => { daemon.stop(); server.close(); closeDb(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  },

  demo(opts) {
    const d = generateDemoLeague({
      season: Number(opts.season ?? config.season),
      currentWeek: Number(opts.week ?? 9),
      numTeams: Number(opts.teams ?? 12),
      seed: Number(opts.seed ?? config.seed),
    });
    out(`${c.green}✓${c.reset} seeded ${c.bold}${d.league.name}${c.reset}`);
    out(`  ${d.teams.length} teams · ${d.players.length} players · ${d.stats.length} stat lines · ${d.transactions.length} transactions`);
    out(`  through week ${d.league.current_week}`);
    out(`  ${c.grey}players are FICTIONAL — demo mode exists to exercise the engines, not to model real athletes${c.reset}`);
  },

  status() {
    const h = S.healthReport();
    rule('STATUS');
    out(`  league    ${h.league ? `${c.bold}${h.league.name}${c.reset} · week ${h.league.week} · ${h.league.scoring}${h.league.demo ? c.yellow + ' (demo)' + c.reset : ''}` : c.yellow + 'none' + c.reset}`);
    out(`  yahoo     ${h.yahoo.connected ? c.green + 'connected' + c.reset : h.yahoo.configured ? c.yellow + 'configured, not connected' + c.reset : c.grey + 'not configured' + c.reset}`);
    out(`  model     ${h.model}`);
    out(`  data      ${h.counts.players} players · ${h.counts.statLines} stat lines · ${h.counts.transactions} transactions · ${h.counts.games} games · ${h.counts.news} news`);
    if (h.providers.length) {
      rule('PROVIDERS');
      for (const p of h.providers) {
        out(`  ${pad(p.source, 14)} ${p.ok}/${p.n} ok  ${c.grey}last ${new Date(p.last).toISOString().slice(0, 16).replace('T', ' ')}${c.reset}`);
      }
    }
  },

  lineup(opts) {
    const l = league(opts);
    const wr = S.warRoom(l, { week: Number(opts.week ?? l.current_week), sims: Number(opts.sims ?? 20000) });
    rule(`WEEK ${wr.week} — ${wr.me.name} vs ${wr.opponent?.name ?? 'BYE'}`);
    const wp = wr.winProbability;
    const wpColor = wp > 0.6 ? c.green : wp < 0.4 ? c.red : c.yellow;
    out(`  ${c.bold}WIN PROBABILITY ${wpColor}${pct(wp)}${c.reset}   ${c.grey}${wr.sim.myMean} ± ${wr.sim.mySd} vs ${wr.sim.oppMean} ± ${wr.sim.oppSd} · ${wr.sim.sims.toLocaleString()} sims${c.reset}`);
    out(`  ${c.magenta}${wr.posture.stance.toUpperCase()}${c.reset} — ${wr.posture.advice}`);
    out('');
    out(`  ${c.grey}${pad('SLOT', 7)}${pad('PLAYER', 24)}${pad('TEAM', 9)}${rpad('PROJ', 6)}${rpad('FLOOR', 7)}${rpad('CEIL', 7)}  PROFILE${c.reset}`);
    for (const s of wr.decision.recommended.lineup) {
      const p = s.player;
      if (!p) { out(`  ${pad(s.slotLabel, 7)}${c.red}(empty)${c.reset}`); continue; }
      const opp = p.opponent ? `${p.nfl_team} ${p.isHome ? 'vs' : '@'} ${p.opponent}` : p.nfl_team;
      const flag = p.status ? c.yellow + p.status + c.reset : '';
      out(`  ${pad(s.slotLabel, 7)}${c.white}${pad(p.name, 24)}${c.reset}${pad(opp, 9)}${rpad(p.mean.toFixed(1), 6)}${c.grey}${rpad(p.floor.toFixed(1), 7)}${rpad(p.ceiling.toFixed(1), 7)}${c.reset}  ${p.profile?.label ?? ''} ${flag}`);
    }
    out('');
    out(`  ${c.cyan}${wr.decision.explanation}${c.reset}`);
    if (wr.decision.stacks.length) {
      out(`  ${c.grey}correlation: ${wr.decision.stacks.slice(0, 3).map((s) => `${s.a}~${s.b} ${s.corr > 0 ? '+' : ''}${s.corr.toFixed(2)}`).join(', ')}${c.reset}`);
    }
    rule('ALTERNATIVES');
    for (const cand of wr.decision.candidates.slice(0, 5)) {
      const mark = cand.id === wr.decision.recommended.id ? c.green + '▸' + c.reset : ' ';
      out(`  ${mark} ${rpad(pct(cand.winProb), 6)}  ${pad(cand.label, 46)} ${c.grey}μ${cand.mean.toFixed(1)} σ${cand.sd.toFixed(1)}${c.reset}`);
    }
  },

  outlook(opts) {
    const l = league(opts);
    const o = S.seasonOutlook(l, { sims: Number(opts.sims ?? config.sims.season) });
    rule(`SEASON OUTLOOK — ${l.name} (top ${l.num_playoff_teams} make the playoffs)`);
    out(`  ${c.grey}${pad('TEAM', 24)}${pad('MGR', 10)}${rpad('TITLE', 7)}${rpad('PLAYOFF', 9)}${rpad('BYE', 7)}${rpad('xWINS', 7)}${rpad('PROJ', 7)}${c.reset}`);
    for (const t of o.results) {
      const mine = t.is_mine;
      const nameCol = mine ? c.bold + c.green : c.reset;
      const team = o.teams.find((x) => x.team_key === t.team_key);
      out(`  ${nameCol}${pad(t.name, 24)}${c.reset}${c.grey}${pad(team?.manager ?? '', 10)}${c.reset}${rpad(pct(t.titleOdds), 7)}${rpad(pct(t.playoffOdds), 9)}${rpad(pct(t.byeOdds), 7)}${rpad(t.expectedWins.toFixed(1), 7)}${c.grey}${rpad(t.projMean.toFixed(0), 7)}${c.reset}`);
    }
  },

  waivers(opts) {
    const l = league(opts);
    const w = S.waiverBoard(l, { limit: Number(opts.limit ?? 12) });
    rule(`WAIVER BOARD — week ${w.week} · $${w.faabRemaining} FAAB · ${w.weeksRemaining} weeks to playoffs`);
    if (w.drop) out(`  ${c.grey}drop candidate: ${w.drop.name} (${w.drop.pos})${c.reset}\n`);
    for (const t of w.targets) {
      const lv = t.verdict.level;
      const col = lv === 'priority' ? c.green : lv === 'speculative' ? c.magenta : lv === 'add' ? c.cyan : c.grey;
      out(`  ${col}${pad(lv.toUpperCase(), 12)}${c.reset}${c.white}${pad(t.name, 22)}${c.reset}${pad(t.pos + ' ' + (t.nfl_team ?? ''), 8)} ${c.bold}$${rpad(t.bid.amount, 3)}${c.reset}  ${c.grey}+${t.marginalWeekly}/wk · title ${pct(t.titleDelta, 2)}${c.reset}`);
      out(`  ${c.grey}${' '.repeat(12)}${t.bid.rationale}${c.reset}`);
    }
    if (w.breakouts.length) {
      rule('BREAKOUT SIGNALS (role changed, market has not caught up)');
      for (const b of w.breakouts.slice(0, 6)) {
        out(`  ${pad(b.pos, 4)}${c.white}${pad(b.name, 22)}${c.reset}${c.grey}${b.signal}${c.reset}`);
      }
    }
  },

  trades(opts) {
    const l = league(opts);
    const t = S.tradeBoard(l, { limit: Number(opts.limit ?? 8) });
    rule(`TRADE BOARD — ${t.counts.winWin} win-win, ${t.counts.arbitrage} arbitrage found`);
    const show = (list, title, color) => {
      if (!list.length) return;
      out(`\n  ${color}${title}${c.reset}`);
      for (const x of list) {
        out(`  ${c.grey}→${c.reset} ${c.bold}${x.manager}${c.reset} ${c.grey}(${x.archetype?.label ?? '?'})${c.reset}`);
        out(`    send  ${c.red}${x.send.map((p) => `${p.name} ${p.pos}`).join(' + ')}${c.reset}`);
        out(`    get   ${c.green}${x.receive.map((p) => `${p.name} ${p.pos}`).join(' + ')}${c.reset}`);
        out(`    ${c.grey}you +${x.myGainPerWeek}/wk · them ${x.theirRealGain > 0 ? '+' : ''}${x.theirRealGain} · accept ${pct(x.acceptProb, 0)}${c.reset}`);
      }
    };
    show(t.winWin.slice(0, Number(opts.limit ?? 4)), 'WIN-WIN — send these first, they get accepted', c.green);
    show(t.arbitrage.slice(0, Number(opts.limit ?? 4)), 'VALUE ARBITRAGE — they overpay by their own board', c.yellow);
  },

  intel(opts) {
    const l = league(opts);
    const i = S.intel(l);
    rule('OPPONENT INTELLIGENCE');
    for (const d of i.dossiers) {
      const tag = d.is_mine ? c.green + ' (you)' + c.reset : '';
      out(`\n  ${c.bold}${d.name}${c.reset} ${c.grey}· ${d.manager}${c.reset}${tag}  ${c.magenta}${d.archetype.label}${c.reset} ${c.grey}(conf ${d.archetype.confidence})${c.reset}`);
      out(`    ${c.grey}${d.archetype.note}${c.reset}`);
      out(`    ${c.grey}record ${d.record.wins}-${d.record.losses} · $${d.faab.remaining} FAAB (burn ${d.faab.burnRatio}×) · ${d.counts.adds} adds · ${d.counts.trades} trades · last active ${d.daysSinceActive}d ago${c.reset}`);
      if (!d.is_mine && d.claims.predictions.length) {
        out(`    ${c.cyan}predicted claims${c.reset} ${c.grey}(${pct(d.claims.willAct, 0)} chance he acts)${c.reset}`);
        for (const p of d.claims.predictions.slice(0, 3)) {
          out(`      ${rpad(pct(p.probability, 0), 5)} ${pad(p.name, 22)} ${pad(p.pos, 4)} ${c.grey}~$${p.expectedBid?.amount ?? 0} — ${p.why}${c.reset}`);
        }
      }
      if (d.poach?.length) {
        out(`    ${c.yellow}buy low${c.reset}: ${d.poach.map((p) => `${p.name} (${p.pos})`).join(', ')}`);
      }
    }
    if (i.contention.length) {
      rule('CONTESTED FREE AGENTS — get there first');
      for (const x of i.contention.slice(0, 8)) {
        out(`  ${pad(x.pos, 4)}${c.white}${pad(x.name, 22)}${c.reset}${c.grey}pressure ${x.totalPressure.toFixed(2)} · ${x.rivals.slice(0, 3).map((r) => `${r.manager} ~$${r.bid ?? 0}`).join(', ')}${c.reset}`);
      }
    }
  },

  draft(opts) {
    const l = league(opts);
    const numTeams = l.num_teams;
    const slot = Number(opts.slot ?? 1);
    const rounds = Number(opts.rounds ?? 16);
    const picks = snakePicks(slot, numTeams, rounds);
    const pickNumber = Number(opts.pick ?? picks[0]);
    const next = nextOwnPick(pickNumber, slot, numTeams, rounds);

    const pool = all('SELECT * FROM players');
    const projected = S.draftValues(l, pool);
    const board = recommendPick({
      available: projected, myRoster: [], rosterSlots: l.rosterSlots, numTeams,
      pickNumber, nextPickNumber: next,
      opponents: S.getTeams(l.league_key).filter((t) => !t.is_mine).map((t) => ({ bias: {} })),
      sims: Number(opts.sims ?? 250), limit: Number(opts.limit ?? 12),
    });

    rule(`DRAFT — pick ${pickNumber} (slot ${slot} of ${numTeams}), next pick ${next}`);
    out(`  ${c.grey}${pad('#', 4)}${pad('PLAYER', 22)}${pad('POS', 6)}${rpad('PROJ', 6)}${rpad('VOR', 7)}${rpad('VONA', 7)}${rpad('SURV', 6)}${rpad('TIER', 6)}${c.reset}`);
    board.board.forEach((p, i) => {
      out(`  ${pad(i + 1, 4)}${c.white}${pad(p.name, 22)}${c.reset}${pad(`${p.pos}${p.posRank}`, 6)}${rpad(p.mean.toFixed(1), 6)}${rpad(p.vor.toFixed(1), 7)}${rpad(p.vona.toFixed(1), 7)}${c.grey}${rpad(pct(p.survivalToNextPick, 0), 6)}${rpad(p.tier, 6)}${c.reset}`);
      if (i < 3) for (const rsn of p.reasons.slice(0, 2)) out(`      ${c.grey}${rsn}${c.reset}`);
    });
    rule('POSITIONAL SCARCITY');
    for (const [pos, s] of Object.entries(board.scarcity)) {
      if (!s.total) continue;
      out(`  ${pad(pos, 6)}${rpad(s.startable, 4)} startable ${c.grey}(${s.elite} elite, best ${s.best.toFixed(1)}, replacement ${(board.replacementLevels[pos] ?? 0).toFixed(1)})${c.reset}`);
    }
  },

  async yahoo(opts, sub) {
    const action = sub ?? 'status';
    if (action === 'status') {
      const s = oauth.connectionStatus();
      rule('YAHOO');
      out(`  configured   ${s.configured ? c.green + 'yes' : c.red + 'no'}${c.reset}`);
      out(`  connected    ${s.connected ? c.green + 'yes' : c.yellow + 'no'}${c.reset}`);
      if (s.connected) {
        out(`  scope        ${s.scope}${s.canWrite ? c.green + ' (can submit moves)' + c.reset : c.grey + ' (read only)' + c.reset}`);
        out(`  expires      ${new Date(Number(s.expiresAt)).toISOString()}${s.expired ? c.yellow + ' (will refresh on next call)' + c.reset : ''}`);
      }
      out(`  redirect uri ${c.cyan}${s.redirectUri}${c.reset}`);
      if (!s.configured) {
        out('');
        out(`  ${c.grey}Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in .env.${c.reset}`);
        out(`  ${c.grey}Create an app at https://developer.yahoo.com/apps/create/ with the Fantasy Sports permission.${c.reset}`);
      } else if (!s.connected) {
        out(`\n  ${c.grey}Run${c.reset} node bin/oracle.mjs serve ${c.grey}and open${c.reset} ${c.cyan}/auth/yahoo${c.reset}`);
      }
      return;
    }
    if (action === 'leagues') {
      const leagues = await yahooClient.myLeagues();
      rule('YOUR YAHOO LEAGUES');
      for (const l of leagues) out(`  ${c.cyan}${pad(l.league_key, 20)}${c.reset}${pad(l.name, 34)}${l.num_teams} teams · week ${l.current_week}`);
      return;
    }
    if (action === 'sync') {
      const key = opts.league ?? S.activeLeagueKey();
      if (!key) { out(`${c.red}No league key. Run: oracle yahoo leagues${c.reset}`); process.exit(1); }
      out(`syncing ${key} …`);
      const report = await syncLeague(key, {
        onProgress: (p) => out(`  ${p.status === 'ok' ? c.green + '✓' : p.status === 'error' ? c.red + '✗' : c.grey + '·'}${c.reset} ${p.stage}${p.error ? c.red + ' ' + p.error + c.reset : ''}`),
      });
      out(report.ok ? `${c.green}✓ sync complete${c.reset} (${report.ms}ms)` : `${c.yellow}⚠ partial sync${c.reset} — ${report.errors.length} stage(s) failed`);
      return;
    }
    out(`${c.red}Unknown yahoo action "${action}". Try: status | leagues | sync${c.reset}`);
  },

  async research(opts, sub) {
    if (sub === 'daemon') {
      daemon.start();
      out(`${c.green}research daemon running${c.reset} — ${daemon.status().jobs.length} jobs. Ctrl-C to stop.`);
      process.on('SIGINT', () => { daemon.stop(); process.exit(0); });
      await new Promise(() => {});
      return;
    }
    const job = sub;
    if (job && !JOBS[job]) {
      out(`${c.red}Unknown job "${job}".${c.reset} Known jobs:`);
      for (const k of Object.keys(JOBS)) out(`  ${c.cyan}${k}${c.reset}`);
      process.exit(1);
    }
    rule(job ? `RESEARCH: ${job}` : 'RESEARCH: all jobs');
    const results = job ? [await JOBS[job]()] : [];
    if (!job) for (const [name, fn] of Object.entries(JOBS)) results.push(await fn());
    for (const r of results) {
      const mark = r.ok ? c.green + '✓' : c.red + '✗';
      out(`  ${mark}${c.reset} ${pad(r.job, 20)} ${c.grey}${r.ms}ms ${r.error ?? JSON.stringify(r.result ?? {})}${c.reset}`);
    }
  },

  help() {
    out(`
${c.bold}${c.green}GRIDIRON ORACLE${c.reset} ${c.grey}— a war room built to win your fantasy league${c.reset}

${c.bold}USAGE${c.reset}
  node bin/oracle.mjs <command> [options]

${c.bold}GETTING STARTED${c.reset}
  ${c.cyan}demo${c.reset}                    seed a synthetic league so every engine is usable immediately
  ${c.cyan}serve${c.reset} [--research]      start the war room web UI (default http://127.0.0.1:${config.port})
  ${c.cyan}status${c.reset}                  what is loaded, what is connected, what is stale

${c.bold}EVERY WEEK${c.reset}
  ${c.cyan}lineup${c.reset}  [--week N]      optimal lineup + win probability + the case for each start/sit
  ${c.cyan}waivers${c.reset} [--limit N]     ranked targets with recommended FAAB bids
  ${c.cyan}trades${c.reset}  [--limit N]     win-win trades and value arbitrage, with the pitch
  ${c.cyan}intel${c.reset}                   rival dossiers and predicted waiver claims
  ${c.cyan}outlook${c.reset} [--sims N]      playoff and championship odds for every team

${c.bold}DRAFT DAY${c.reset}
  ${c.cyan}draft${c.reset} --slot N [--pick N] [--rounds N]
                          live board with VOR, VONA, tiers and survival probability

${c.bold}DATA${c.reset}
  ${c.cyan}yahoo status${c.reset}            connection state and setup instructions
  ${c.cyan}yahoo leagues${c.reset}           list your Yahoo NFL leagues
  ${c.cyan}yahoo sync${c.reset} [--league K] pull a league into the local database
  ${c.cyan}research${c.reset} [job]          run research jobs once (no job = all)
  ${c.cyan}research daemon${c.reset}         run the scheduler in the foreground

${c.bold}OPTIONS${c.reset}
  --league <key>   operate on a specific league
  --week <n>       target week (defaults to the league's current week)
  --sims <n>       Monte Carlo iterations
  --port <n>       server port
  --json           machine-readable output where supported

${c.grey}Configuration lives in .env — see .env.example.${c.reset}
`);
  },
};

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else positional.push(a);
  }
  return { opts, positional };
}

async function main() {
  const [, , cmdRaw, ...rest] = process.argv;
  const cmd = cmdRaw ?? 'help';
  const { opts, positional } = parseArgs(rest);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { COMMANDS.help(); return; }
  const fn = COMMANDS[cmd];
  if (!fn) {
    out(`${c.red}Unknown command "${cmd}".${c.reset}`);
    COMMANDS.help();
    process.exit(1);
  }

  getDb();
  if (opts.json) {
    // JSON mode: run the underlying service call and print raw data.
    const l = ['lineup', 'waivers', 'trades', 'intel', 'outlook'].includes(cmd) ? league(opts) : null;
    const map = {
      lineup: () => S.warRoom(l, { week: Number(opts.week ?? l.current_week) }),
      waivers: () => S.waiverBoard(l),
      trades: () => S.tradeBoard(l),
      intel: () => S.intel(l),
      outlook: () => S.seasonOutlook(l),
      status: () => S.healthReport(),
    };
    if (map[cmd]) { out(JSON.stringify(map[cmd](), null, 2)); return; }
  }
  await fn(opts, positional[0]);
}

main()
  .then(() => { if (!['serve', 'research'].includes(process.argv[2])) closeDb(); })
  .catch((err) => {
    process.stderr.write(`${c.red}error:${c.reset} ${err.message}\n`);
    if (process.env.ORACLE_LOG_LEVEL === 'debug') process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
