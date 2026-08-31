#!/usr/bin/env node
/**
 * Gridiron Oracle command line.
 *
 * Everything the war room can do is available here, because the night before a
 * draft you want a board in your terminal, not a browser tab.
 */
import process from 'node:process';
import config from '../src/config.mjs';
import { getDb, closeDb, all, get, run, meta } from '../src/db/index.mjs';
import * as S from '../src/service.mjs';
import { generateDemoLeague } from '../src/demo.mjs';
import { startServer } from '../src/server/index.mjs';
import { daemon } from '../src/research/daemon.mjs';
import { JOBS, addNews } from '../src/research/jobs.mjs';
import * as oauth from '../src/providers/yahoo/oauth.mjs';
import * as yahooClient from '../src/providers/yahoo/client.mjs';
import { syncLeague } from '../src/providers/yahoo/sync.mjs';
import { recommendPick, snakePicks, nextContestedPick } from '../src/engine/draft.mjs';
import { uncoveredScoringRules } from '../src/engine/statline.mjs';
import { scoringCodeFor } from '../src/providers/fantasypros.mjs';
import { seedRealPlayers, importRankingsFromCsv, importAdpFromText, setupRealLeague, clearDemoData, demoPlayerCount, importRankingsFromFantasyPros, importProjectionsFromFantasyPros, importWeeklyFromSleeper, probeSleeperWeekly, importScheduleFromSleeper, importSleeperLeague, syncSleeperDraft } from '../src/realdata.mjs';
import * as fantasypros from '../src/providers/fantasypros.mjs';
import fs from 'node:fs';
import path from 'node:path';

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
const n1 = (x) => (x == null ? '—' : Number(x).toFixed(1));

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

  calibrate(opts) {
    const l = league(opts);
    const file = opts.file ?? 'fantazy-fulzbol.json';
    let truth;
    try {
      truth = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')).yahooWeek1;
    } catch (e) { out(`${c.red}Could not read ${file}: ${e.message}${c.reset}`); process.exit(1); }
    if (!truth) { out(`${c.red}No "yahooWeek1" block in ${file}.${c.reset}`); process.exit(1); }

    const r = S.calibrationReport(l, truth, { week: Number(opts.week ?? l.current_week) });
    rule(`CALIBRATION vs Yahoo — week ${r.week} · ${r.overall?.n ?? 0} players matched`);

    // Per position first, because this is the check an aggregate hides: two
    // large errors in opposite directions sum to nearly nothing.
    out(`  ${c.grey}${pad('POS', 6)}${rpad('N', 3)} ${rpad('BIAS', 8)}${rpad('%', 8)}${rpad('RMSE', 7)}  ${rpad('OUR SPREAD', 11)}${rpad('THEIRS', 8)}${c.reset}`);
    for (const p of r.positions) {
      const bad = Math.abs(p.biasPct ?? 0) > 12;
      const col = bad ? c.red : Math.abs(p.biasPct ?? 0) > 6 ? c.yellow : c.green;
      out(`  ${c.white}${pad(p.pos, 6)}${c.reset}${rpad(p.n, 3)} ${col}${rpad((p.bias > 0 ? '+' : '') + p.bias, 8)}${rpad((p.biasPct > 0 ? '+' : '') + p.biasPct + '%', 8)}${c.reset}${rpad(p.rmse, 7)}  ${rpad(p.spreadOurs, 11)}${rpad(p.spreadTheirs, 8)}`);
    }
    if (r.overall) {
      out(`  ${c.grey}${pad('ALL', 6)}${rpad(r.overall.n, 3)} ${rpad((r.overall.bias > 0 ? '+' : '') + r.overall.bias, 8)}${rpad('', 8)}${rpad(r.overall.rmse, 7)}${c.reset}`);
      out(`  ${c.grey}A near-zero ALL bias proves nothing on its own — two opposite errors sum to it.${c.reset}`);
    }

    const worst = r.players.slice(0, Number(opts.limit ?? 10));
    if (worst.length) {
      out(`\n  ${c.bold}Largest disagreements${c.reset}`);
      for (const p of worst) {
        const col = Math.abs(p.error) > 8 ? c.red : Math.abs(p.error) > 4 ? c.yellow : c.grey;
        out(`  ${pad(p.pos, 5)}${c.white}${pad(p.name, 22)}${c.reset}ours ${rpad(n1(p.ours), 6)}  theirs ${rpad(n1(p.theirs), 6)}  ${col}${(p.error > 0 ? '+' : '') + n1(p.error)}${c.reset}`);
      }
    }

    const cmp = r.teams.filter((t) => t.ours != null);
    if (cmp.length) {
      out(`\n  ${c.bold}Team totals (complete rosters only)${c.reset}`);
      for (const t of cmp) {
        const col = Math.abs(t.error) > 15 ? c.red : Math.abs(t.error) > 7 ? c.yellow : c.green;
        out(`  ${c.white}${pad(t.name, 24)}${c.reset}ours ${rpad(n1(t.ours), 7)}  theirs ${rpad(n1(t.theirs), 7)}  ${col}${(t.error > 0 ? '+' : '') + n1(t.error)}${c.reset}`);
      }
    }
    const skipped = r.teams.filter((t) => t.ours == null);
    if (skipped.length) {
      out(`  ${c.grey}not comparable (incomplete rosters): ${skipped.map((t) => `${t.name} ${t.have}/${t.size}`).join(', ')}${c.reset}`);
    }
    if (r.unmatched.length) {
      out(`  ${c.grey}not in the player pool (${r.unmatched.length}): ${r.unmatched.slice(0, 8).join(', ')}${r.unmatched.length > 8 ? ' …' : ''}${c.reset}`);
    }
  },

  async sleeper(opts, sub, positional = []) {
    if (sub === 'league') {
      const remembered = meta.get('sleeper_league_id');
      const id = opts.id ?? positional[1] ?? remembered;
      if (!id) {
        out(`${c.red}Usage:${c.reset} node bin/oracle.mjs sleeper league --id <league_id> [--user <username>]`);
        out(`${c.grey}The league id is in the Sleeper URL: sleeper.com/leagues/<id>/team${c.reset}`);
        process.exit(1);
      }
      if (!opts.id && remembered) out(`${c.grey}re-syncing remembered league ${remembered}${c.reset}`);
      const user = opts.user ?? meta.get('sleeper_username') ?? null;
      const r = await importSleeperLeague(String(id), { username: user });
      if (!r.ok) {
        out(`${c.red}\u2717${c.reset} ${r.note}`);
        if (r.detail) out(`  ${c.grey}${r.detail}${c.reset}`);
        return;
      }

      out(`${c.green}\u2713${c.reset} ${c.bold}${r.name}${c.reset} (${r.league_key})`);
      out(`  ${r.teams} teams · ${r.rosterSpots} roster spots · ${r.matchups} matchups · week ${r.week}`);
      if (r.undrafted) {
        out(`  ${c.yellow}This league has not drafted yet${c.reset} — every roster is empty, which is why there`);
        out(`  ${c.grey}are no roster spots or matchups. Re-run this command after the draft.${c.reset}`);
        out(`  ${c.grey}The draft board works now though: ${c.cyan}node bin/oracle.mjs draft --slot N --league ${r.league_key}${c.reset}`);
      }
      out(`  ${r.scoringRules} scoring rules read from the league settings`);
      if (r.myTeam) out(`  ${c.green}your team: ${c.bold}${r.myTeam}${c.reset}`);
      else out(`  ${c.yellow}!${c.reset} no team flagged as yours — pass ${c.cyan}--user <your sleeper username>${c.reset}`);

      // Anything unrecognised is surfaced, never dropped silently: an unmapped
      // scoring rule scores zero forever and an unmapped slot is one the
      // optimizer can never fill.
      if (r.unmappedScoring?.length) {
        out(`  ${c.yellow}scoring keys not understood (they will score ZERO):${c.reset} ${r.unmappedScoring.join(', ')}`);
        out(`  ${c.grey}Send that list back — each one is either irrelevant or a bug.${c.reset}`);
      }
      if (r.unmappedSlots?.length) {
        out(`  ${c.yellow}roster slots not understood:${c.reset} ${r.unmappedSlots.join(', ')}`);
      }
      if (r.unknownPlayers) {
        out(`  ${c.grey}${r.unknownPlayers} rostered players are not in the local pool — run ${c.cyan}real seed${c.reset}${c.grey}.${c.reset}`);
      }
      out(`\n  ${c.grey}Both leagues now live side by side. Switch with the picker in the app,${c.reset}`);
      out(`  ${c.grey}or on the command line with ${c.cyan}--league ${r.league_key}${c.reset}${c.grey}.${c.reset}`);
      return;
    }
    if (sub === 'draft') {
      const id = opts.id ?? meta.get('sleeper_league_id');
      if (!id) { out(`${c.red}No league id. Run ${c.cyan}sleeper league --id <id>${c.reset}${c.red} first.${c.reset}`); process.exit(1); }
      const r = await syncSleeperDraft(String(id), { username: opts.user ?? meta.get('sleeper_username') });
      if (!r.ok) {
        out(`${c.red}\u2717${c.reset} ${r.note}`);
        if (r.detail) out(`  ${c.grey}${r.detail}${c.reset}`);
        return;
      }

      rule(`SLEEPER DRAFT ${r.draftId} — ${r.status}`);
      out(`  format   : ${c.bold}${r.type}${c.reset}${r.isAuction ? `  ${c.yellow}(auction — pick order carries no meaning)${c.reset}` : ''}`);
      out(`  teams    : ${r.teams} · rounds ${r.rounds}${r.pickTimerSec ? ` · ${r.pickTimerSec}s per pick` : ''}`);
      out(`  your seat: ${r.mySeat != null ? `${c.green}${c.bold}${r.mySeat}${c.reset}` : `${c.yellow}unknown — pass --user <sleeper username>${c.reset}`}`);
      out(`  picks    : ${r.made} made${r.unknownPlayers ? `, ${r.unknownPlayers} not in the local pool` : ''}`);
      if (r.mine.length) out(`  yours    : ${r.mine.length}`);

      if (r.status === 'pre_draft') {
        out(`\n  ${c.grey}The draft has not started. Everything above is already known, so the${c.reset}`);
        out(`  ${c.grey}board can be opened now and will fill itself in as picks are made.${c.reset}`);
      }
      if (r.mySeat != null && !r.isAuction) {
        out(`\n  ${c.cyan}node bin/oracle.mjs draft --slot ${r.mySeat} --league sleeper.l.${id}${c.reset}`);
      }
      return;
    }
    out(`${c.red}Unknown sleeper action "${sub ?? ''}". Try: league --id <id> [--user <name>] | draft${c.reset}`);
    process.exit(1);
  },

  myteam(opts, sub) {
    const l = league(opts);
    const name = opts.team ?? sub;
    const teams = S.getTeams(l.league_key);
    if (!name) {
      rule(`TEAMS IN ${l.name}`);
      for (const t of teams) {
        out(`  ${t.is_mine ? c.green + '*' + c.reset : ' '} ${c.white}${pad(t.name, 28)}${c.reset}${c.grey}${t.manager ?? ''}${c.reset}`);
      }
      out(`\n  ${c.grey}Set yours: ${c.cyan}node bin/oracle.mjs myteam --team "<name>" --league ${l.league_key}${c.reset}`);
      return;
    }
    const match = teams.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
    if (!match) {
      out(`${c.red}No team called "${name}" in ${l.name}.${c.reset} Run ${c.cyan}myteam${c.reset} with no argument to list them.`);
      process.exit(1);
    }
    run('UPDATE teams SET is_mine = 0 WHERE league_key = ?', [l.league_key]);
    run('UPDATE teams SET is_mine = 1 WHERE league_key = ? AND team_key = ?', [l.league_key, match.team_key]);
    S.invalidateOutlook();
    out(`${c.green}\u2713${c.reset} ${c.bold}${match.name}${c.reset} is now your team in ${l.name}.`);
  },

  rules(opts) {
    const l = league(opts);
    rule(`${l.name} — RULES AS IMPORTED`);

    out(`  ${c.bold}Roster${c.reset} (${l.rosterSlots.reduce((a, s) => a + s.count, 0)} spots)`);
    out(`    ${l.rosterSlots.map((s) => `${s.slot}\u00d7${s.count}`).join('  ')}`);
    out(`    ${c.grey}starting lineup: ${l.slots.join(', ')}${c.reset}`);

    const scoring = Object.entries(l.scoring)
      .filter(([k, v]) => typeof v === 'number' && v !== 0 && !k.startsWith('_'));
    const group = (prefix, label) => {
      const rows = scoring.filter(([k]) => prefix.test(k));
      if (!rows.length) return;
      out(`\n  ${c.bold}${label}${c.reset}`);
      for (const [k, v] of rows.sort((a, b) => a[0].localeCompare(b[0]))) {
        out(`    ${pad(k, 24)}${c.cyan}${v > 0 ? '+' : ''}${v}${c.reset}`);
      }
    };
    group(/^pass_|^pick_six/, 'Passing');
    group(/^rush_/, 'Rushing');
    group(/^rec/, 'Receiving');
    group(/^(fg|pat)/, 'Kicking');
    group(/^def_pa_/, 'Defense — points allowed');
    group(/^def_ya_/, 'Defense — yards allowed');
    group(/^def_(?!pa_|ya_)/, 'Defense — other');
    group(/^(ret_|two_pt|fum_|st_)/, 'Misc');

    // Which consensus board the opponent model is reading. A format mismatch is
    // invisible without this: every name matches, every rank looks plausible,
    // and the predicted draft is another league's.
    const src = S.adpSourcesFor(l);
    out(`\n  ${c.bold}Consensus board${c.reset} (drives the opponent model, not valuation)`);
    out(`    this league is ${c.bold}${src.code}${c.reset}`);
    if (src.exact.length) {
      out(`    ${c.green}using ${src.exact.join(', ')} — published for this format${c.reset}`);
    } else if (src.fallback === 'untagged') {
      out(`    ${c.yellow}using ${src.order[0]} — format unknown, so it may be another league's board${c.reset}`);
      out(`    ${c.grey}Re-import with: ${c.cyan}real fp-csv --file <f> --scoring ${src.code} --league ${l.league_key}${c.reset}`);
    } else if (src.fallback === 'wrong-format') {
      out(`    ${c.red}only boards for OTHER formats are loaded (${src.available.join(', ')})${c.reset}`);
      out(`    ${c.grey}Scoring format changes the ORDER of a board, not just its scale.${c.reset}`);
      out(`    ${c.cyan}real fp-csv --file <f> --scoring ${src.code} --league ${l.league_key}${c.reset}`);
    } else {
      out(`    ${c.red}no consensus board loaded at all — the opponent model has nothing to run on${c.reset}`);
    }

    // The check that matters: a rule the model never feeds scores zero forever.
    const uncovered = uncoveredScoringRules(l.scoring);
    out('');
    if (uncovered.length) {
      out(`  ${c.red}${uncovered.length} rules score points but nothing in the model produces them:${c.reset}`);
      for (const u of uncovered) out(`    ${c.red}${pad(u.stat, 24)}${c.reset}${c.grey}${u.points} pts — ${u.note ?? 'no archetype supplies this'}${c.reset}`);
      out(`  ${c.grey}Each is a category valued at zero. Send this list back.${c.reset}`);
    } else {
      out(`  ${c.green}every scoring rule is fed by the model.${c.reset}`);
    }
  },

  leagues() {
    const list = S.listLeagues();
    const active = S.activeLeagueKey();
    rule(`LEAGUES — ${list.length} loaded`);
    for (const l of list) {
      const mark = l.league_key === active ? `${c.green}*${c.reset}` : ' ';
      const kind = l.is_demo ? `${c.grey}demo${c.reset}` : l.league_key.startsWith('sleeper.') ? `${c.cyan}sleeper${c.reset}` : `${c.magenta}manual${c.reset}`;
      out(`  ${mark} ${c.white}${pad(l.name, 26)}${c.reset}${pad(kind, 18)}${rpad(l.num_teams, 3)} teams  week ${l.current_week}  ${c.grey}${l.league_key}${c.reset}`);
    }
    out(`\n  ${c.grey}* = default when no --league is passed. Every command takes ${c.cyan}--league <key>${c.reset}${c.grey}.${c.reset}`);
  },

  rosters(opts) {
    const l = league(opts);
    const r = S.rosterCompleteness(l, { week: Number(opts.week ?? l.current_week) });
    rule(`ROSTER COMPLETENESS — week ${r.week} · ${r.playersHeld} of ${r.playersExpected} players held`);
    if (r.complete) { out(`  ${c.green}every team is complete.${c.reset}`); return; }

    out(`  ${c.grey}${pad('TEAM', 24)}${rpad('HAVE', 6)}  MISSING STARTING POSITIONS${c.reset}`);
    for (const t of [...r.teams].sort((a, b) => a.have - b.have)) {
      const col = t.complete ? c.green : t.have < r.rosterSize / 2 ? c.red : c.yellow;
      const mark = t.is_mine ? `${c.bold}*${c.reset}` : ' ';
      const miss = t.missingPositions.length
        ? `${c.red}${t.missingPositions.join(', ')}${c.reset}`
        : `${c.grey}bench only${c.reset}`;
      out(`  ${mark}${c.white}${pad(t.name, 23)}${c.reset}${col}${rpad(`${t.have}/${t.size}`, 6)}${c.reset}  ${miss}`);
    }
    // The point that a raw count cannot make on its own.
    const noK = r.teams.filter((t) => t.missingPositions.includes('K')).length;
    const noD = r.teams.filter((t) => t.missingPositions.includes('DEF')).length;
    if (noK || noD) {
      out(`\n  ${c.yellow}${noD} teams have no defense and ${noK} no kicker.${c.reset}`);
      out(`  ${c.grey}Those two slots are not filler in this league: a complete team observed in week 1${c.reset}`);
      out(`  ${c.grey}projected 150.18, of which its kicker and defense were 41.24 — 27%.${c.reset}`);
    }
    out(`\n  ${c.grey}Fill teams in via the "rosters" block of the league config, then re-run ${c.cyan}real league${c.reset}${c.grey}.${c.reset}`);
  },

  stream(opts) {
    const l = league(opts);
    const week = Number(opts.week ?? l.current_week);
    const r = S.streamDefenses(l, { week, limit: Number(opts.limit ?? 10) });

    rule(`DEFENSE STREAMER — week ${week}`);
    if (!r.ok) {
      out(`  ${c.yellow}no ranking produced${c.reset} (${r.reason})`);
      out(`  ${c.grey}${r.note}${c.reset}`);
      out(`\n  ${c.grey}A ranking needs this week's real slate with betting lines:${c.reset}`);
      out(`    ${c.cyan}node bin/oracle.mjs research odds${c.reset}  ${c.grey}or import a schedule with implied team totals${c.reset}`);
      return;
    }

    if (r.mine) {
      out(`  ${c.white}holding ${c.bold}${r.mine.name}${c.reset}${c.white} vs ${r.mine.opponent} — ${n1(r.mine.mean)} projected${c.reset}`);
      out(`  ${c.grey}their opponent is implied for ${r.mine.impliedOpponentTotal} points${c.reset}\n`);
    } else if (r.note) {
      out(`  ${c.yellow}${r.note}${c.reset}\n`);
    }

    out(`  ${c.grey}${pad('DEFENSE', 18)}${pad('VS', 8)}${rpad('IMP', 5)} ${rpad('PROJ', 6)} ${rpad('GAIN', 6)}  CLAIM ODDS${c.reset}`);
    for (const d of r.best) {
      const gain = d.expectedGain == null ? '  —  ' : (d.expectedGain > 0 ? '+' : '') + n1(d.expectedGain);
      const gcol = d.expectedGain == null ? c.grey : d.expectedGain > 1.5 ? c.green : d.expectedGain > 0 ? c.cyan : c.grey;
      // Claim odds, not claim risk: the manager wants to know what they can get.
      const odds = 1 - (d.claimRisk ?? 0);
      const ocol = odds > 0.8 ? c.green : odds > 0.5 ? c.yellow : c.red;
      out(`  ${c.white}${pad(d.name, 18)}${c.reset}${pad((d.home ? 'vs ' : '@ ') + d.opponent, 8)}${rpad(d.impliedOpponentTotal, 5)} ${c.bold}${rpad(n1(d.mean), 6)}${c.reset} ${gcol}${rpad(gain, 6)}${c.reset}  ${ocol}${pct(odds, 0)}${c.reset}`);
    }

    if (r.recommended) {
      const d = r.recommended;
      const why = r.mine
        ? `${n1(d.expectedGain)} points better than ${r.mine.name}`
        : `no defense is rostered, and this is the best one we can realistically claim`;
      out(`\n  ${c.green}CLAIM${c.reset} ${c.bold}${d.name}${c.reset} — ${why}; from waiver priority ${r.waiverPriority ?? '?'} this claim lands about ${pct(1 - d.claimRisk, 0)} of the time.`);
    } else if (r.mine) {
      out(`\n  ${c.grey}STAND PAT — nothing available beats ${r.mine.name} by enough to spend a claim on.${c.reset}`);
    }
    if (r.contested.length) {
      out(`  ${c.grey}likely gone before our turn: ${r.contested.map((d) => d.name).join(', ')}${c.reset}`);
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
      out(`    ${c.grey}record ${d.record.wins}-${d.record.losses} · $${d.faab.remaining} FAAB (burn ${d.faab.burnRatio}×) · ${d.counts.adds} adds · ${d.counts.trades} trades · last active ${d.daysSinceActive == null ? 'never' : d.daysSinceActive + 'd ago'}${c.reset}`);
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
    const next = nextContestedPick(pickNumber, slot, numTeams, rounds);

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

  async yahoo(opts, sub, positional = []) {
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
    if (action === 'connect') {
      const { url } = oauth.authorizeUrl({ access: opts.write ? 'write' : 'read' });
      rule('CONNECT YAHOO');
      out('  1. Open this URL in your browser and approve access:\n');
      out(`     ${c.cyan}${url}${c.reset}\n`);
      out(`  2. Yahoo sends you back to a callback URL. It may fail to load — ${c.bold}that is fine${c.reset}.`);
      out('     Copy the ENTIRE address from your browser\'s address bar.\n');
      out(`  3. Finish the connection:\n`);
      out(`     ${c.cyan}node bin/oracle.mjs yahoo code "<paste the whole URL here>"${c.reset}\n`);
      out(`  ${c.grey}The link is valid for 15 minutes.${c.reset}`);
      return;
    }
    if (action === 'code') {
      const pasted = positional?.[1] ?? opts.code;
      if (!pasted) {
        out(`${c.red}Paste the redirect URL or the code:${c.reset} node bin/oracle.mjs yahoo code "<url or code>"`);
        process.exit(1);
      }
      const { code, state, error, errorDescription } = oauth.parseCallbackInput(pasted);
      if (error) {
        out(`${c.red}Yahoo refused the authorisation.${c.reset}\n`);
        out(`  ${oauth.explainOAuthError(error, errorDescription)}`);
        process.exit(1);
      }
      if (!code) {
        out(`${c.red}No authorisation code found in that input.${c.reset}`);
        out(`${c.grey}Paste the ENTIRE address from the browser bar, including everything after the "?".${c.reset}`);
        process.exit(1);
      }
      await oauth.exchangeCode(code, state);
      out(`${c.green}✓ Yahoo connected.${c.reset}`);
      const leagues = await yahooClient.myLeagues();
      if (!leagues.length) {
        out(`${c.yellow}No NFL leagues found on this account for the current season.${c.reset}`);
        return;
      }
      rule('YOUR LEAGUES');
      for (const l of leagues) out(`  ${c.cyan}${pad(l.league_key, 20)}${c.reset}${pad(l.name, 34)}${l.num_teams} teams · week ${l.current_week}`);
      out(`\n  Next: ${c.cyan}node bin/oracle.mjs yahoo sync --league <key>${c.reset}`);
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
    if (action === 'doctor') {
      rule('YAHOO PRE-FLIGHT');
      const s2 = oauth.connectionStatus();
      const checks = [];
      const add = (label, ok, detail) => { checks.push({ label, ok, detail }); };

      add('ORACLE_SECRET set', Boolean(config.secret),
        'Tokens are encrypted at rest and refuse to be stored without it. Set ORACLE_SECRET in .env.');
      add('YAHOO_CLIENT_ID set', Boolean(config.yahoo.clientId), 'Copy it from https://developer.yahoo.com/apps/');
      add('YAHOO_CLIENT_SECRET set', Boolean(config.yahoo.clientSecret), 'Copy it from the same page.');
      add('Redirect URI is https', /^https:\/\//i.test(s2.redirectUri || ''),
        `Yahoo rejects plain http. Currently: ${s2.redirectUri}. Set YAHOO_REDIRECT_URI in .env to the `
        + 'exact https URL registered on the Yahoo app — the browser does not need to reach it, '
        + 'because the code can be pasted back with "yahoo code".');
      add('Tokens stored', s2.connected, 'Not connected yet — run: node bin/oracle.mjs yahoo connect');

      for (const ch of checks) {
        out(`  ${ch.ok ? c.green + '\u2713' : c.yellow + '\u2717'}${c.reset} ${ch.label}`);
        if (!ch.ok) out(`      ${c.grey}${ch.detail}${c.reset}`);
      }

      if (!s2.connected) {
        out(`\n  ${c.grey}Local setup is what these checks cover. They cannot tell you whether Yahoo has${c.reset}`);
        out(`  ${c.grey}approved your app for the Fantasy Sports API — only trying the connection can, and${c.reset}`);
        out(`  ${c.grey}an unapproved app fails with "invalid_scope" no matter how the rest is configured.${c.reset}`);
        return;
      }

      // Connected: prove it against the live API rather than trusting the token.
      out(`\n  ${c.grey}calling the live API…${c.reset}`);
      try {
        const leagues = await yahooClient.myLeagues();
        out(`  ${c.green}\u2713${c.reset} API call succeeded — ${leagues.length} NFL league(s) visible`);
        for (const l of leagues) out(`      ${c.cyan}${l.league_key}${c.reset}  ${l.name} · ${l.num_teams} teams`);
        out(`\n  ${c.green}Yahoo is fully working.${c.reset} Next: ${c.cyan}node bin/oracle.mjs yahoo sync --league <key>${c.reset}`);
      } catch (err) {
        out(`  ${c.red}\u2717${c.reset} the API rejected the request: ${err.message}`);
        out(`      ${c.grey}A stored token that cannot call the API usually means the approval covers a${c.reset}`);
        out(`      ${c.grey}different scope than the one requested. Try: YAHOO_SCOPE=fspt-r in .env, reconnect.${c.reset}`);
      }
      return;
    }
    out(`${c.red}Unknown yahoo action "${action}". Try: status | doctor | connect | code | leagues | sync${c.reset}`);
  },

  /**
   * News in, projection impact out.
   *
   * This is the one place the Claude API key does anything. The model is asked
   * to do the single thing it beats a regression at — read a sentence of
   * English and say whether a player's role just grew or shrank — and never to
   * project points or pick lineups. Everything it returns is stored with its
   * rationale so it can be overruled.
   */
  async news(opts, sub, positional = []) {
    const action = sub ?? 'list';

    if (action === 'add') {
      const headline = positional?.[1] ?? opts.headline;
      if (!headline) {
        out(`${c.red}Usage:${c.reset} node bin/oracle.mjs news add "<headline>" --player "<name>" [--body "..."]`);
        process.exit(1);
      }
      let playerId = null;
      if (opts.player) {
        const norm = (n) => String(n).toLowerCase().replace(/[^a-z]/g, '');
        const hits = all('SELECT player_id, name, pos, nfl_team FROM players')
          .filter((p) => norm(p.name) === norm(opts.player));
        if (!hits.length) {
          out(`${c.red}No player matches "${opts.player}".${c.reset} News needs a player to attach an impact to.`);
          process.exit(1);
        }
        if (hits.length > 1) {
          out(`${c.yellow}"${opts.player}" matches ${hits.length} players:${c.reset}`);
          for (const h of hits) out(`  ${h.player_id}  ${h.name} (${h.pos}, ${h.nfl_team ?? 'FA'})`);
          out(`${c.grey}Re-run with --player-id to pick one.${c.reset}`);
          process.exit(1);
        }
        playerId = hits[0].player_id;
        out(`${c.grey}attached to ${hits[0].name} (${hits[0].pos}, ${hits[0].nfl_team ?? 'FA'})${c.reset}`);
      } else if (opts['player-id']) {
        playerId = opts['player-id'];
      }
      const id = addNews({ playerId, headline, body: opts.body, source: opts.source ?? 'manual', url: opts.url });
      out(`${c.green}\u2713${c.reset} news added (${id})`);
      out(`${c.grey}Score it with:${c.reset} ${c.cyan}node bin/oracle.mjs research news:score${c.reset}`);
      if (!config.anthropicKey) {
        out(`${c.yellow}! ANTHROPIC_API_KEY is not set — scoring will be skipped and the impact stays neutral.${c.reset}`);
      }
      return;
    }

    if (action === 'list') {
      const rows = all(
        `SELECT n.ts, n.headline, n.impact, n.confidence, n.rationale, p.name, p.pos
           FROM news n LEFT JOIN players p ON p.player_id = n.player_id
          ORDER BY n.ts DESC LIMIT ?`, [Number(opts.limit ?? 20)]
      );
      rule('NEWS');
      if (!rows.length) {
        out(`  ${c.grey}Nothing yet. Add some:${c.reset}`);
        out(`  ${c.cyan}node bin/oracle.mjs news add "Coach says X will start" --player "Player Name"${c.reset}`);
        return;
      }
      for (const r of rows) {
        const scored = r.impact != null;
        const tone = !scored ? c.grey : r.impact > 0.05 ? c.green : r.impact < -0.05 ? c.red : c.grey;
        out(`  ${tone}${scored ? (r.impact > 0 ? '+' : '') + Number(r.impact).toFixed(2) : ' ---- '}${c.reset}`
          + `  ${pad(r.name ?? '(no player)', 22)}${r.headline.slice(0, 60)}`);
        if (r.rationale) out(`          ${c.grey}${r.rationale} (confidence ${Number(r.confidence ?? 0).toFixed(2)})${c.reset}`);
      }
      const unscored = rows.filter((r) => r.impact == null).length;
      if (unscored) out(`\n  ${c.grey}${unscored} unscored. Run:${c.reset} ${c.cyan}node bin/oracle.mjs research news:score${c.reset}`);
      return;
    }

    out(`${c.red}Unknown news action "${action}". Try: add | list${c.reset}`);
  },

  async research(opts, sub, positional = []) {
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

  async real(opts, sub) {
    if (sub === 'seed') {
      const demoCount = demoPlayerCount();
      if (demoCount && !opts.clean) {
        out(`${c.yellow}\u26a0${c.reset}  ${demoCount} fictional demo players are in the database.`);
        out(`   Mixing them with real players would rank invented names on your draft board.`);
        out(`   Re-run with ${c.cyan}--clean${c.reset} to remove the demo world first:`);
        out(`     ${c.cyan}node bin/oracle.mjs real seed --clean${c.reset}`);
        out(`   ${c.grey}(demo data is regenerable any time with: node bin/oracle.mjs demo)${c.reset}`);
        process.exit(1);
      }
      if (opts.clean) {
        const { leagues } = clearDemoData();
        out(`${c.grey}cleared ${demoCount} demo players and ${leagues} demo league(s)${c.reset}`);
      }
      out('Fetching the real NFL player index from Sleeper...');
      const { players } = await seedRealPlayers();
      out(`${c.green}\u2713${c.reset} seeded ${players} real players`);
      out(`${c.grey}Next: node bin/oracle.mjs real league --file fantazy-fulzbol.json${c.reset}`);
      return;
    }
    if (sub === 'adp') {
      const file = opts.file ?? opts._file;
      if (!file) { out(`${c.red}Usage:${c.reset} node bin/oracle.mjs real adp --file <rankings.txt>`); process.exit(1); }
      const text = fs.readFileSync(path.resolve(file), 'utf8');
      const season = Number(opts.season ?? config.season);
      const report = importAdpFromText(text, { season, source: opts.source ?? 'manual' });
      out(`${c.green}\u2713${c.reset} matched ${report.matched}/${report.total} names`);
      if (report.unmatched.length) {
        out(`\n${c.yellow}Unmatched (fix the spelling in your file, or these players are not in the DB yet):${c.reset}`);
        for (const n of report.unmatched) out(`  ${c.grey}${n}${c.reset}`);
      }
      return;
    }
    if (sub === 'check') {
      const league = S.getLeague(opts.league);
      if (!league) { out(`${c.red}No league loaded.${c.reset}`); process.exit(1); }
      rule(`SCORING COVERAGE — ${league.name}`);
      const gaps = uncoveredScoringRules(league.scoring);
      const numeric = Object.values(league.scoring).filter((x) => typeof x === 'number').length;
      out(`  ${numeric - gaps.length} of ${numeric} scoring rules are exercised by the valuation model.\n`);
      if (!gaps.length) { out(`  ${c.green}\u2713 every rule is fed by an archetype${c.reset}`); return; }
      out(`  ${c.yellow}These rules score points but NOTHING feeds them, so they are worth zero${c.reset}`);
      out(`  ${c.yellow}in every valuation this app produces:${c.reset}\n`);
      for (const g of gaps) {
        const big = Math.abs(g.points) >= 0.4;
        out(`   ${big ? c.red + '!' : c.grey + '\u00b7'}${c.reset} ${g.stat.padEnd(22)}${String(g.points).padStart(6)} pts`);
      }
      out(`\n  ${c.grey}Rare events (return touchdowns, two-point conversions) cost little in${c.reset}`);
      out(`  ${c.grey}expectation. A high per-unit rate on a COMMON stat does not — check those${c.reset}`);
      out(`  ${c.grey}against Yahoo before trusting any number this app prints.${c.reset}`);
      return;
    }
    if (sub === 'fp-csv') {
      const file = opts.file ?? opts._file;
      if (!file) {
        out(`${c.red}Usage:${c.reset} node bin/oracle.mjs real fp-csv --file <FantasyPros_..._Rankings.csv>`);
        out(`${c.grey}Download from fantasypros.com/nfl/rankings/ — the "Download CSV" button.${c.reset}`);
        process.exit(1);
      }
      const league = S.getLeague(opts.league);
      const season = Number(opts.season ?? league?.season ?? config.season);
      const text = fs.readFileSync(path.resolve(file), 'utf8');
      // The scoring format of the board being imported. Defaults to the target
      // league's own format, because a board is only usable by a league whose
      // rules it was published for — and getting this wrong is invisible: the
      // names all match, the ranks all look plausible, and the ORDER is another
      // league's.
      const fmt = String(opts.scoring ?? (league ? scoringCodeFor(league.scoring) : 'HALF')).toUpperCase();
      const report = importRankingsFromCsv(text, { season, scoring: fmt });
      out(`${c.green}\u2713${c.reset} matched ${report.matched}/${report.total} ranked players (season ${season}, ${c.bold}${fmt}${c.reset})`);
      if (!opts.scoring && league) {
        out(`${c.grey}  Format taken from ${league.name}. Pass ${c.cyan}--scoring PPR|HALF|STD${c.reset}${c.grey} to override.${c.reset}`);
      }
      if (report.byPos) {
        out(`${c.grey}  ${Object.entries(report.byPos).map(([k, v]) => `${k} ${v}`).join('  ')}${c.reset}`);
      }
      if (report.matched < 150) {
        out(`${c.yellow}! only ${report.matched} matched — a 16-team draft is 256 picks. Paste this output back.${c.reset}`);
      }
      if (report.unmatched?.length) {
        out(`${c.grey}unmatched (${report.unmatched.length}): ${report.unmatched.slice(0, 12).join(', ')}${report.unmatched.length > 12 ? ' \u2026' : ''}${c.reset}`);
      }
      out(`${c.grey}${report.attribution ?? ''}${c.reset}`);
      return;
    }
    if (sub === 'fp-probe') {
      const league = S.getLeague(opts.league);
      const season = Number(opts.season ?? league?.season ?? config.season);
      const scoring = opts.scoring ?? (league ? fantasypros.scoringCodeFor(league.scoring) : 'HALF');
      rule(`FANTASYPROS PROBE (season ${season}, ${scoring})`);
      const attempts = await fantasypros.probe({ season, scoring });
      for (const a of attempts) {
        const mark = a.playersFound ? `${c.green}\u2713${c.reset}` : `${c.red}\u2717${c.reset}`;
        const claim = a.reported != null && a.reported !== a.playersFound
          ? ` ${c.yellow}(API reports ${a.reported})${c.reset}`
          : (a.reported != null ? ` ${c.grey}(API count ${a.reported})${c.reset}` : '');
        out(`  ${mark} ${a.kind.padEnd(14)} season ${a.season} ${a.type.padEnd(13)} HTTP ${a.status} · ${a.playersFound} players${claim}`);
        for (const sp of a.sample) out(`     ${c.grey}${sp}${c.reset}`);
        if (!a.playersFound && a.body) out(`     ${c.grey}${a.body}${c.reset}`);
      }
      const ok = attempts.filter((a) => a.playersFound);
      out('');
      if (ok.length) {
        const r = ok.find((a) => a.kind === 'rankings');
        const p = ok.find((a) => a.kind === 'projections');
        out(`  ${c.green}Working:${c.reset}`);
        if (r) out(`    rankings    season ${r.season} type ${r.type} — ${c.cyan}node bin/oracle.mjs real fp --season ${r.season}${c.reset}`);
        if (p) out(`    projections season ${p.season} — ${c.cyan}node bin/oracle.mjs real fp-proj --season ${p.season}${c.reset}`);
      } else {
        out(`  ${c.yellow}Nothing returned players. Paste this output back.${c.reset}`);
      }
      return;
    }
    if (sub === 'fp-page') {
      const league = S.getLeague(opts.league);
      const season = Number(opts.season ?? league?.season ?? config.season);
      const scoring = opts.scoring ?? (league ? fantasypros.scoringCodeFor(league.scoring) : 'HALF');
      rule(`FANTASYPROS PAGING PROBE (season ${season}, ${scoring})`);
      const { reported, baseline, findings } = await fantasypros.probePaging({ season, scoring });
      out(`  baseline: ${baseline} players returned, API reports ${reported ?? '?'} available\n`);
      for (const f of findings) {
        const mark = f.effect === 'ENLARGED' || f.effect === 'MOVED'
          ? `${c.green}\u2713${c.reset}` : `${c.grey}\u00b7${c.reset}`;
        out(`  ${mark} ${f.param.padEnd(12)}=${String(f.value).padEnd(4)} HTTP ${f.status} \u00b7 ${f.players} players \u00b7 ${f.effect}`);
        for (const sp of f.sample ?? []) out(`     ${c.grey}${sp}${c.reset}`);
      }
      out('');
      const win = findings.find((f) => f.effect === 'ENLARGED' || f.effect === 'MOVED');
      const untested = findings.filter((f) => f.effect === 'no answer');
      if (win) {
        out(`  ${c.green}Found it:${c.reset} ${win.param} (${win.kind}). Paste this back and I will wire it in.`);
      } else {
        out(`  ${c.yellow}No paging parameter enlarged or moved the page.${c.reset}`);
        if (untested.length) {
          out(`  ${c.grey}${untested.length} candidate(s) got no answer at all — those were not actually tested.${c.reset}`);
        }
        out(`  ${c.grey}Use the CSV export instead, which carries the whole board:${c.reset}`);
        out(`  ${c.cyan}node bin/oracle.mjs real fp-csv --file <FantasyPros_..._Rankings.csv>${c.reset}`);
      }
      return;
    }
    if (sub === 'fp-proj') {
      const league = S.getLeague(opts.league);
      const season = Number(opts.season ?? league?.season ?? config.season);
      out(`Fetching season projections from FantasyPros (season ${season})...`);
      const report = await importProjectionsFromFantasyPros({ season });
      out(`${c.green}\u2713${c.reset} matched ${report.matched}/${report.total} projected players`);
      if (report.truncated?.length) {
        out(`${c.yellow}! the API sent fewer players than it reported for: ${report.truncated.join(', ')}${c.reset}`);
      }
      if (report.unmatched?.length) {
        out(`${c.grey}unmatched (${report.unmatched.length}): ${report.unmatched.slice(0, 10).join(', ')}${report.unmatched.length > 10 ? ' …' : ''}${c.reset}`);
      }
      out(`${c.grey}${report.attribution ?? ''}${c.reset}`);
      return;
    }
    if (sub === 'fp') {
      const league = S.getLeague(opts.league);
      const season = Number(opts.season ?? league?.season ?? config.season);
      const scoring = opts.scoring ?? (league ? fantasypros.scoringCodeFor(league.scoring) : 'HALF');
      out(`Fetching ${scoring} consensus rankings from FantasyPros (season ${season})...`);
      const report = await importRankingsFromFantasyPros({ season, scoring, type: (opts.type ?? 'DRAFT').toUpperCase() });
      out(`${c.green}\u2713${c.reset} matched ${report.matched}/${report.total} ranked players`);
      if (report.estimatedRanks) {
        out(`${c.grey}${report.estimatedRanks} of those sat below the overall consensus board and were slotted by positional extrapolation${c.reset}`);
      }
      if (report.truncated?.length) {
        out(`${c.yellow}! the API sent fewer players than it reported for: ${report.truncated.join(', ')}${c.reset}`);
      }
      if (report.matched < 150) {
        out(`${c.yellow}! only ${report.matched} players priced — a 16-team draft is 256 picks. Paste this output back before drafting.${c.reset}`);
      }
      if (report.unmatched?.length) {
        out(`${c.grey}unmatched (${report.unmatched.length}): ${report.unmatched.slice(0, 12).join(', ')}${report.unmatched.length > 12 ? ' …' : ''}${c.reset}`);
      }
      out(`${c.grey}${report.attribution ?? ''}${c.reset}`);
      return;
    }
    if (sub === 'league') {
      const file = opts.file ?? opts._file;
      if (!file) {
        out(`${c.red}Usage:${c.reset} node bin/oracle.mjs real league --file <league.json>`);
        out(`${c.grey}See real-league.example.json for the template.${c.reset}`);
        process.exit(1);
      }
      const cfg = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const r = setupRealLeague(cfg);
      out(`${c.green}\u2713${c.reset} league configured: ${c.bold}${cfg.name}${c.reset} (${r.league_key})`);
      out(`  ${r.teams} teams${cfg.divisions?.length ? ` across ${cfg.divisions.length} divisions` : ''}, ${r.matchups} real matchup${r.matchups === 1 ? '' : 's'} entered`);
      if (!r.matchups) {
        out(`  ${c.yellow}!${c.reset} no real schedule entered — every opponent shown in the app is a GUESS from a round robin.`);
        out(`    ${c.grey}Add a "schedule" block to the config as you read weeks off Yahoo.${c.reset}`);
      } else {
        const known = Object.keys(cfg.schedule ?? {}).sort((a, b) => a - b).join(', ');
        out(`  ${c.grey}real weeks: ${known}. Every other week is an estimate and is labelled as one in the app.${c.reset}`);
      }
      if (r.unknownTeams?.length) {
        out(`  ${c.red}!${c.reset} schedule names not in the team list, ignored: ${r.unknownTeams.join(', ')}`);
      }
      if (r.rosters) {
        const rr = r.rosters;
        out(`  ${c.green}\u2713${c.reset} ${c.bold}${rr.players}${c.reset} roster spots across ${rr.teams} teams`);
        if (rr.contested.length) {
          out(`  ${c.yellow}!${c.reset} claimed by more than one team, so assigned to NEITHER:`);
          for (const x of rr.contested) out(`      ${x.player} — ${x.teams.join(' and ')}`);
        }
        if (rr.unmatched.length) {
          out(`  ${c.yellow}!${c.reset} names not found in the player pool (${rr.unmatched.length}): ${rr.unmatched.slice(0, 10).join(', ')}${rr.unmatched.length > 10 ? ' …' : ''}`);
        }
        const thin = Object.entries(rr.written).filter(([, n]) => n < 6).map(([t, n]) => `${t} (${n})`);
        if (thin.length) out(`  ${c.grey}fewer than six picks recorded: ${thin.join(', ')}${c.reset}`);
      }
      return;
    }
    if (sub === 'stats' || sub === 'proj-week') {
      const kind = sub === 'stats' ? 'stats' : 'projections';
      const season = Number(opts.season ?? config.season ?? new Date().getFullYear());
      const week = Number(opts.week ?? 1);
      if (!Number.isFinite(week) || week < 1) {
        out(`${c.red}Usage:${c.reset} node bin/oracle.mjs real ${sub} --week N [--season YYYY] [--through N]`);
        process.exit(1);
      }
      const through = opts.through != null ? Number(opts.through) : week;
      let total = 0;
      for (let w = week; w <= through; w++) {
        const res = await importWeeklyFromSleeper({ season, week: w, kind });
        if (!res.ok) { out(`${c.yellow}!${c.reset} week ${w}: ${res.note}`); continue; }

        // A green tick over zero rows is a lie about the outcome. The two ways
        // to write nothing are completely different problems and must not print
        // the same line: an unplayed week is fine and expected, whereas a full
        // response that matched no local player means the id link is broken.
        if (res.provided === 0) {
          out(`${c.yellow}\u25CB${c.reset} ${kind} ${season} wk${w}: nothing to import — Sleeper has no data for this week yet.`);
          continue;
        }
        if (res.written === 0) {
          out(`${c.red}\u2717${c.reset} ${kind} ${season} wk${w}: Sleeper returned ${res.provided} players and NONE matched a local player.`);
          out(`  ${c.grey}The sleeper_id link is broken. Run ${c.cyan}real seed${c.reset}${c.grey}, then ${c.cyan}real probe-week --week ${w}${c.reset}${c.grey}.${c.reset}`);
          continue;
        }
        total += res.written;
        out(`${c.green}\u2713${c.reset} ${kind} ${season} wk${w}: ${c.bold}${res.written}${c.reset} players (${res.usage} with usage), ${res.unknownIds} ids not in our player table`);
      }
      if (total) {
        out(`${c.grey}Weekly evidence now feeds projections — the War Room should stop pricing teammates identically.${c.reset}`);
      } else {
        out(`${c.grey}Nothing was written, so projections still fall back to positional archetypes.${c.reset}`);
      }
      return;
    }
    if (sub === 'schedule') {
      const season = Number(opts.season ?? config.season ?? new Date().getFullYear());
      const r = await importScheduleFromSleeper({ season });
      if (!r.ok) { out(`${c.yellow}!${c.reset} ${r.note}`); return; }
      out(`${c.green}\u2713${c.reset} ${c.bold}${r.games}${c.reset} games across ${r.weeks} weeks for ${r.season}`);
      if (!r.withLines) {
        out(`  ${c.grey}No betting lines yet. Projections are now matchup-aware, but the defense${c.reset}`);
        out(`  ${c.grey}streamer needs implied team totals — those come from an odds feed:${c.reset}`);
        out(`    ${c.cyan}node bin/oracle.mjs research odds${c.reset}`);
      } else {
        out(`  ${c.grey}${r.withLines} games already carry betting lines.${c.reset}`);
      }
      return;
    }
    if (sub === 'probe-week') {
      const season = Number(opts.season ?? config.season ?? new Date().getFullYear());
      const week = Number(opts.week ?? 1);
      const kind = opts.kind === 'projections' ? 'projections' : 'stats';
      const r = await probeSleeperWeekly({ season, week, kind });
      if (!r.ok && r.reason === 'empty-week') {
        out(`${c.yellow}\u25CB${c.reset} ${r.note}`);
        if (r.state) {
          out(`  ${c.grey}Sleeper currently reports: season ${r.state.season}, week ${r.state.week} (${r.state.seasonType}).${c.reset}`);
        }
        // The mapping is the thing that needs verifying, and it can be verified
        // today against any season that has already been played. Waiting for
        // week 1 to kick off would mean discovering a wrong stat key on a
        // Sunday, which is the worst possible time to discover it.
        out(`\n  ${c.bold}Verify the stat mapping now, against a season that has been played:${c.reset}`);
        out(`    ${c.cyan}node bin/oracle.mjs real probe-week --season ${season - 1} --week 1${c.reset}`);
        out(`  ${c.grey}And for the upcoming week, projections exist before stats do:${c.reset}`);
        out(`    ${c.cyan}node bin/oracle.mjs real probe-week --week ${week} --kind projections${c.reset}`);
        return;
      }
      if (!r.ok) {
        out(`${c.red}\u2717${c.reset} ${r.note}`);
        out(`${c.grey}If this machine can reach api.sleeper.app in a browser, the block is this process's network, not Sleeper.${c.reset}`);
        return;
      }
      out(`${c.bold}Sleeper ${r.kind} ${r.season} week ${r.week}${c.reset}`);
      out(`  players returned : ${r.players}`);
      out(`  linked locally   : ${r.matched} of ${r.players} (we hold ${r.linked} sleeper ids)`);
      out(`  ${c.green}mapped keys${c.reset}   : ${r.mapped.map(([k, n]) => `${k}(${n})`).join(' ') || '(none)'}`);
      if (r.unmapped.length) {
        out(`  ${c.yellow}unmapped keys${c.reset} : ${r.unmapped.map(([k, n]) => `${k}(${n})`).join(' ')}`);
        out(`  ${c.grey}Unmapped keys score zero. Anything above that this league pays for is a bug — send this line back.${c.reset}`);
      } else {
        out(`  ${c.green}every returned key is accounted for.${c.reset}`);
      }
      return;
    }
    out(`${c.red}Unknown real action "${sub}". Try: seed | league --file <f> | fp-csv --file <f> | fp | fp-proj | fp-probe | fp-page | adp --file <f> | schedule | stats --week N | proj-week --week N | probe-week --week N${c.reset}`);
    process.exit(1);
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
  ${c.cyan}stream${c.reset}  [--week N]      defenses to stream, ranked by the offence they face
  ${c.cyan}rosters${c.reset}                 how much of each team's roster the database actually holds
  ${c.cyan}calibrate${c.reset}               measure this model against Yahoo's own league-scored numbers
  ${c.cyan}intel${c.reset}                   rival dossiers and predicted waiver claims
  ${c.cyan}outlook${c.reset} [--sims N]      playoff and championship odds for every team

${c.bold}DRAFT DAY${c.reset}
  ${c.cyan}draft${c.reset} --slot N [--pick N] [--rounds N]
                          live board with VOR, VONA, tiers and survival probability

${c.bold}LEAGUES${c.reset}
  ${c.cyan}leagues${c.reset}                 every league loaded, and which is the default
  ${c.cyan}rules${c.reset}                   a league's roster and scoring exactly as imported
  ${c.cyan}sleeper league${c.reset} --id <id> [--user <name>]
                          import a Sleeper league (settings, rosters, matchups);
                          re-run with no --id to re-sync the remembered league
  ${c.cyan}sleeper draft${c.reset}           read the live draft: format, your seat, every pick so far
  ${c.cyan}myteam${c.reset} [--team <name>]  show, or set, which team is yours in a league

${c.bold}DATA${c.reset}
  ${c.cyan}yahoo status${c.reset}            connection state and setup instructions
  ${c.cyan}yahoo doctor${c.reset}            check every prerequisite, then prove it against the live API
  ${c.cyan}yahoo connect${c.reset}           print the authorisation URL to open in your browser
  ${c.cyan}yahoo code${c.reset} "<url>"      finish the connection by pasting the redirect URL
  ${c.cyan}yahoo leagues${c.reset}           list your Yahoo NFL leagues
  ${c.cyan}yahoo sync${c.reset} [--league K] pull a league into the local database
  ${c.cyan}real seed${c.reset} [--clean]     seed real NFL players from Sleeper (no Yahoo needed)
  ${c.cyan}real league${c.reset} --file f.json  configure a real league from hand-entered settings
  ${c.cyan}real fp${c.reset}                 import rankings from the FantasyPros API (needs a key)
  ${c.cyan}real fp-proj${c.reset}            import projected stat lines (better than rankings)
  ${c.cyan}real check${c.reset}              which scoring rules the valuation model actually feeds
  ${c.cyan}real fp-csv --file <f>${c.reset}  import a FantasyPros rankings CSV (add --scoring PPR|HALF|STD)
  ${c.cyan}real fp-probe${c.reset}           diagnose the FantasyPros endpoint shape
  ${c.cyan}real fp-page${c.reset}            find the undocumented paging parameter
  ${c.cyan}real adp${c.reset} --file f.txt   import real draft rankings from a pasted list
  ${c.cyan}real stats${c.reset} --week N     import a played week's real stat lines from Sleeper
  ${c.cyan}real proj-week${c.reset} --week N Sleeper's projections for a week not yet played
  ${c.cyan}real probe-week${c.reset} --week N  show what Sleeper returns and which keys we map
  ${c.cyan}real schedule${c.reset}           import the NFL schedule (no odds; those come from research odds)
  ${c.cyan}research${c.reset} [job]          run research jobs once (no job = all)
  ${c.cyan}news add${c.reset} "<headline>"   record news, then score it with the Claude API
  ${c.cyan}news list${c.reset}               recent news with its scored projection impact
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

/**
 * Commands within one or two edits of what was typed.
 *
 * Deliberately strict: a suggestion that is not obviously right is worse than
 * none, because it sends someone off to try a command that will also fail.
 */
function nearestCommands(input, names, max = 3) {
  const scored = names
    .map((n) => ({ n, d: editDistance(input.toLowerCase(), n.toLowerCase()) }))
    .filter(({ n, d }) => d <= 2 || n.startsWith(input.toLowerCase()))
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, max).map((x) => x.n);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

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
    const near = nearestCommands(cmd, Object.keys(COMMANDS));
    if (near.length) out(`${c.grey}Did you mean: ${near.map((n) => c.cyan + n + c.reset).join(', ')}?${c.grey}${c.reset}`);
    // The likeliest cause of a command that reads correctly but does not
    // exist: this checkout is behind the one the instruction came from.
    out(`${c.grey}If you were told to run this, the command may be newer than your checkout:${c.reset}`);
    out(`  ${c.cyan}git pull${c.reset}`);
    out('');
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
  if (positional[1] && !opts.file) opts._file = positional[1];
  await fn(opts, positional[0], positional);
}

main()
  .then(() => { if (!['serve', 'research'].includes(process.argv[2])) closeDb(); })
  .catch((err) => {
    process.stderr.write(`${c.red}error:${c.reset} ${err.message}\n`);
    if (process.env.ORACLE_LOG_LEVEL === 'debug') process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
