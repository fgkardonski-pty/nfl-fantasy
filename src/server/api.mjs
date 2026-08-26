/**
 * The API surface.
 *
 * Every endpoint returns fully-computed, explained answers rather than raw
 * rows: the client is a rendering layer, not a second copy of the model. That
 * keeps one source of truth for every number and means the CLI, the war room,
 * and the test suite cannot disagree.
 */
import { Router, httpError, redirect, html } from './router.mjs';
import config from '../config.mjs';
import { all, get, run, meta, j } from '../db/index.mjs';
import * as S from '../service.mjs';
import { generateDemoLeague } from '../demo.mjs';
import * as oauth from '../providers/yahoo/oauth.mjs';
import * as yahoo from '../providers/yahoo/client.mjs';
import * as sync from '../providers/yahoo/sync.mjs';
import { JOBS, addNews } from '../research/jobs.mjs';
import { daemon } from '../research/daemon.mjs';
import { recommendPick, snakePicks, nextOwnPick } from '../engine/draft.mjs';
import { computeVor, tierize, tierSummary } from '../engine/vor.mjs';
import { evaluateOffer } from '../engine/trades.mjs';
import { optimalLineup, lineupMarginals } from '../engine/optimizer.mjs';
import { positionalNeed } from '../engine/opponent.mjs';
import { logger } from '../util/log.mjs';

const log = logger('api');

/** Resolve the active league or fail with an actionable message. */
function requireLeague(query = {}) {
  const key = query.league ?? S.activeLeagueKey();
  const league = key ? S.getLeague(key) : null;
  if (!league) {
    throw httpError(404, 'No league loaded.', 'Run "node bin/oracle.mjs demo" to seed a demo league, or connect your Yahoo account.');
  }
  return league;
}

const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

export function buildApi() {
  const r = new Router();

  // ---- Health & config ----------------------------------------------------

  r.get('/api/health', () => ({
    ok: true,
    version: '1.0.0',
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    ...S.healthReport(),
    daemon: daemon.status().running,
  }));

  r.get('/api/leagues', () => ({
    active: S.activeLeagueKey(),
    leagues: S.listLeagues(),
  }));

  r.post('/api/leagues/active', ({ body }) => {
    const key = body?.league_key;
    if (!key) throw httpError(400, 'league_key is required');
    if (!get('SELECT league_key FROM leagues WHERE league_key = ?', [key])) {
      throw httpError(404, `Unknown league ${key}`);
    }
    meta.set('active_league', key);
    S.invalidateOutlook();
    return { active: key };
  });

  r.get('/api/league', ({ query }) => {
    const league = requireLeague(query);
    return {
      ...league,
      teams: S.getTeams(league.league_key),
      myTeam: S.myTeam(league.league_key),
    };
  });

  /** Let the operator correct which team is theirs when Yahoo's flag is absent. */
  r.post('/api/league/my-team', ({ body, query }) => {
    const league = requireLeague(query);
    const key = body?.team_key;
    if (!key) throw httpError(400, 'team_key is required');
    run('UPDATE teams SET is_mine = 0 WHERE league_key = ?', [league.league_key]);
    run('UPDATE teams SET is_mine = 1 WHERE league_key = ? AND team_key = ?', [league.league_key, key]);
    S.invalidateOutlook();
    return { myTeam: S.myTeam(league.league_key) };
  });

  // ---- The war room -------------------------------------------------------

  r.get('/api/warroom', ({ query }) => {
    const league = requireLeague(query);
    const week = int(query.week, league.current_week);
    const sims = Math.min(int(query.sims, config.sims.week), 60000);
    return S.warRoom(league, { week, sims });
  });

  r.get('/api/outlook', ({ query }) => {
    const league = requireLeague(query);
    const fresh = query.fresh === '1';
    const outlook = fresh ? S.seasonOutlook(league) : S.cachedOutlook(league);
    return {
      week: league.current_week,
      playoffTeams: league.num_playoff_teams,
      playoffStartWeek: league.playoff_start_week,
      standings: outlook.results,
    };
  });

  // ---- Waivers ------------------------------------------------------------

  r.get('/api/waivers', ({ query }) => {
    const league = requireLeague(query);
    return S.waiverBoard(league, {
      week: int(query.week, league.current_week),
      limit: Math.min(int(query.limit, 25), 100),
    });
  });

  // ---- Trades -------------------------------------------------------------

  r.get('/api/trades', ({ query }) => {
    const league = requireLeague(query);
    return S.tradeBoard(league, {
      week: int(query.week, league.current_week),
      limit: Math.min(int(query.limit, 12), 40),
    });
  });

  /** Evaluate an offer that landed in your inbox. */
  r.post('/api/trades/evaluate', ({ body, query }) => {
    const league = requireLeague(query);
    const week = int(body?.week, league.current_week);
    const me = S.myTeam(league.league_key);
    const myRoster = S.project(league, S.rosterOf(league.league_key, me.team_key, week), week);
    const sendIds = new Set(body?.send ?? []);
    const receiveIds = body?.receive ?? [];
    if (!sendIds.size && !receiveIds.length) throw httpError(400, 'Provide send[] and receive[] player ids');

    const send = myRoster.filter((p) => sendIds.has(p.player_id));
    const receivePlayers = receiveIds
      .map((id) => get('SELECT * FROM players WHERE player_id = ?', [id]))
      .filter(Boolean);
    const receive = S.project(league, receivePlayers, week);

    return {
      ...evaluateOffer({
        myRoster, send, receive,
        rosterSlots: league.rosterSlots,
        weeksRemaining: Math.max(1, league.playoff_start_week - week),
      }),
      send: send.map((p) => ({ player_id: p.player_id, name: p.name, pos: p.pos, seasonMean: p.seasonMean })),
      receive: receive.map((p) => ({ player_id: p.player_id, name: p.name, pos: p.pos, seasonMean: p.seasonMean })),
    };
  });

  // ---- Opponent intelligence ---------------------------------------------

  r.get('/api/intel', ({ query }) => {
    const league = requireLeague(query);
    return S.intel(league, { week: int(query.week, league.current_week) });
  });

  r.get('/api/intel/:teamKey', ({ params, query }) => {
    const league = requireLeague(query);
    const week = int(query.week, league.current_week);
    const full = S.intel(league, { week });
    const dossier = full.dossiers.find((d) => d.team_key === params.teamKey);
    if (!dossier) throw httpError(404, `No dossier for team ${params.teamKey}`);
    const roster = S.project(league, S.rosterOf(league.league_key, params.teamKey, week), week);
    const { lineup } = optimalLineup(roster, league.slots, (p) => p.mean);
    return {
      ...dossier,
      ...positionalNeed(league.league_key, params.teamKey, league.rosterSlots, week),
      lineup,
      roster: roster.sort((a, b) => b.mean - a.mean),
      transactions: all(
        `SELECT t.*, p.name, p.pos FROM transactions t LEFT JOIN players p ON p.player_id = t.player_id
         WHERE t.league_key = ? AND t.team_key = ? ORDER BY t.ts DESC LIMIT 40`,
        [league.league_key, params.teamKey]
      ),
    };
  });

  // ---- Players ------------------------------------------------------------

  r.get('/api/players', ({ query }) => {
    const league = requireLeague(query);
    return S.playerBoard(league, {
      week: int(query.week, league.current_week),
      pos: query.pos || null,
      q: query.q || null,
      limit: Math.min(int(query.limit, 100), 400),
      availableOnly: query.available === '1',
    });
  });

  r.get('/api/player/:id', ({ params, query }) => {
    const league = requireLeague(query);
    const detail = S.playerDetail(league, params.id, { week: int(query.week, league.current_week) });
    if (!detail) throw httpError(404, `No player ${params.id}`);
    return detail;
  });

  // ---- Draft --------------------------------------------------------------

  r.get('/api/draft/board', ({ query }) => {
    const league = requireLeague(query);
    const week = 1;
    const numTeams = league.num_teams;
    const slot = Math.max(1, Math.min(numTeams, int(query.slot, 1)));
    const rounds = int(query.rounds, league.allSlots.length || 16);
    const pickNumber = int(query.pick, snakePicks(slot, numTeams, rounds)[0]);
    const nextPick = nextOwnPick(pickNumber, slot, numTeams, rounds);

    // Everyone already drafted in this league's stored draft is off the board;
    // in a live draft the client posts the picks as they happen via `drafted`
    // (anyone taken) and `mine` (which of those went to MY roster). Without
    // `mine`, roster-need scoring silently has nothing to work with — every
    // live draft run through the UI would score every pick as if my roster
    // were still empty, which understates how much a position is already
    // covered as the draft goes on.
    const drafted = new Set(
      (query.drafted ? String(query.drafted).split(',') : [])
        .concat(all('SELECT player_id FROM draft_picks WHERE league_key = ? AND pick < ?', [league.league_key, pickNumber]).map((d) => d.player_id))
        .filter(Boolean)
    );
    const myKeys = new Set(
      (query.mine ? String(query.mine).split(',') : [])
        .concat(all('SELECT player_id FROM draft_picks WHERE league_key = ? AND team_key = ? AND pick < ?',
          [league.league_key, query.team_key ?? '', pickNumber]).map((d) => d.player_id))
        .filter(Boolean)
    );

    const pool = all('SELECT * FROM players').filter((p) => !drafted.has(p.player_id));
    const projected = S.draftValues(league, pool);
    const myRoster = S.draftValues(league, all('SELECT * FROM players').filter((p) => myKeys.has(p.player_id)));

    const opponents = S.getTeams(league.league_key)
      .filter((t) => !t.is_mine)
      .map((t) => ({ team_key: t.team_key, bias: {} }));

    const result = recommendPick({
      available: projected,
      myRoster,
      rosterSlots: league.rosterSlots,
      numTeams,
      pickNumber,
      nextPickNumber: nextPick,
      opponents,
      sims: Math.min(int(query.sims, config.sims.draft), 1500),
      limit: Math.min(int(query.limit, 15), 60),
    });

    // `all` is the entire scored player universe and `tiers` carries a full
    // copy of every player inside every tier — together roughly half a megabyte
    // the client never reads. Send the board and a tier SUMMARY instead.
    const { all: _all, tiers, ...rest } = result;
    return {
      ...rest,
      pickNumber,
      nextPickNumber: nextPick,
      // Trimmed, not the full projection object — the client only renders name/pos.
      myRoster: myRoster.map((p) => ({ player_id: p.player_id, name: p.name, pos: p.pos })),
      tierSummary: Object.fromEntries(
        Object.entries(tiers ?? {}).map(([pos, list]) => [
          pos,
          list.slice(0, 8).map((t) => ({ tier: t.tier, size: t.size, high: t.high, low: t.low, cliff: t.cliff })),
        ])
      ),
    };
  });

  r.get('/api/draft/tiers', ({ query }) => {
    const league = requireLeague(query);
    const pos = query.pos || null;
    const pool = pos ? all('SELECT * FROM players WHERE pos = ?', [pos]) : all('SELECT * FROM players');
    const projected = S.draftValues(league, pool);
    const { players, levels, meta: m } = computeVor(projected, league.rosterSlots, league.num_teams);
    // Tier summaries carry their members, but only the fields a board needs.
    const tiers = tierSummary(tierize(players)).slice(0, 14).map((t) => ({
      tier: t.tier, size: t.size, high: t.high, low: t.low, cliff: t.cliff,
      players: t.players.map((p) => ({
        player_id: p.player_id, name: p.name, pos: p.pos, nfl_team: p.nfl_team,
        mean: Math.round(p.mean * 10) / 10, vor: Math.round(p.vor * 10) / 10,
        posRank: p.posRank, adp: p.adp,
      })),
    }));
    return { replacementLevels: levels, replacementMeta: m, tiers };
  });

  // ---- Yahoo --------------------------------------------------------------

  r.get('/api/yahoo/status', () => oauth.connectionStatus());

  // Browser-facing: a person clicking "Connect Yahoo" must never be shown raw
  // JSON. Every failure on this route renders a page that says what to do.
  r.get('/auth/yahoo', ({ res, query }) => {
    if (!config.secret) {
      html(res, 400, page('Set ORACLE_SECRET first', `
        <p>Yahoo refresh tokens are long-lived credentials to your real account, so this
        platform encrypts them at rest and refuses to store them without a key.</p>
        <p>Generate one and put it in your <code>.env</code> as <code>ORACLE_SECRET</code>:</p>
        <pre><code>node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"</code></pre>
        <p>Then restart the server and <a href="/auth/yahoo">try again</a>.</p>`));
      return;
    }
    if (!config.yahoo.configured) {
      html(res, 400, page('Yahoo is not configured', `
        <p>Create an app at
        <a href="https://developer.yahoo.com/apps/create/" target="_blank" rel="noopener">developer.yahoo.com</a>
        with the <strong>Fantasy Sports</strong> permission, then set
        <code>YAHOO_CLIENT_ID</code> and <code>YAHOO_CLIENT_SECRET</code> in your
        <code>.env</code>.</p>
        <p>The app's redirect URI must be exactly:</p>
        <pre><code>${escapeHtml(config.yahoo.redirectUri)}</code></pre>
        <p>Then restart the server and <a href="/auth/yahoo">try again</a>.</p>`));
      return;
    }
    try {
      const { url } = oauth.authorizeUrl({ access: query.write === '1' ? 'write' : 'read' });
      redirect(res, url);
    } catch (err) {
      html(res, 400, page('Could not start the Yahoo connection', `<code>${escapeHtml(err.message)}</code>`));
    }
  });

  r.get('/auth/yahoo/callback', async ({ res, query }) => {
    if (query.error) { html(res, 400, page('Yahoo declined', `Yahoo returned: <code>${escapeHtml(query.error_description ?? query.error)}</code>`)); return; }
    if (!query.code) { html(res, 400, page('Missing code', 'Yahoo did not return an authorisation code.')); return; }
    try {
      await oauth.exchangeCode(query.code, query.state);
      const leagues = await yahoo.myLeagues().catch(() => []);
      const list = leagues.length
        ? `<ul>${leagues.map((l) => `<li><strong>${escapeHtml(l.name)}</strong> — ${l.num_teams} teams, week ${l.current_week} <code>${escapeHtml(l.league_key)}</code></li>`).join('')}</ul>`
        : '<p>No NFL leagues found on this account for the current season.</p>';
      html(res, 200, page('Yahoo connected', `<p>Your Yahoo account is connected and the credentials are encrypted at rest.</p>${list}<p><a href="/">Return to the war room</a> and run a sync.</p>`));
    } catch (err) {
      html(res, 400, page('Connection failed', `<code>${escapeHtml(err.message)}</code>`));
    }
  });

  /**
   * Manual connection, for when Yahoo will not redirect to a plain-HTTP
   * localhost callback. Returns the authorisation URL; the operator approves in
   * the browser and pastes back whatever the address bar ends up showing.
   */
  r.post('/api/yahoo/manual/start', ({ body }) => {
    if (!config.secret) {
      throw httpError(400, 'ORACLE_SECRET is not set.',
        'Credentials are encrypted at rest and refuse to be stored without a key.');
    }
    const { url, state } = oauth.authorizeUrl({ access: body?.write ? 'write' : 'read' });
    return { url, state, expiresInMinutes: 15 };
  });

  r.post('/api/yahoo/manual/finish', async ({ body }) => {
    const pasted = body?.pasted ?? body?.code;
    if (!pasted) throw httpError(400, 'Paste the redirect URL, or just the code.');
    const { code, state } = oauth.parseCallbackInput(pasted);
    if (!code) {
      throw httpError(400, 'No authorisation code found in that input.',
        'Paste the whole address bar contents from after you approved access — it contains "code=".');
    }
    await oauth.exchangeCode(code, state);
    const leagues = await yahoo.myLeagues().catch(() => []);
    return { connected: true, leagues };
  });

  r.post('/api/yahoo/disconnect', () => oauth.disconnect());

  r.get('/api/yahoo/leagues', async () => ({ leagues: await yahoo.myLeagues() }));

  r.post('/api/yahoo/sync', async ({ body }) => {
    const key = body?.league_key ?? S.activeLeagueKey();
    if (!key) throw httpError(400, 'league_key is required');
    const report = await sync.syncLeague(key, {
      includePlayers: body?.includePlayers !== false,
      includeHistory: body?.includeHistory !== false,
    });
    S.invalidateOutlook();
    return report;
  });

  // ---- Research -----------------------------------------------------------

  r.get('/api/research/status', () => ({
    ...daemon.status(),
    llm: Boolean(config.anthropicKey),
    odds: Boolean(config.oddsApiKey),
    provenance: all('SELECT source, endpoint, status, ok, ms, fetched_at FROM provenance ORDER BY fetched_at DESC LIMIT 30'),
    jobs: all('SELECT job, started_at, ended_at, ok, detail FROM job_runs ORDER BY started_at DESC LIMIT 25'),
  }));

  r.post('/api/research/run', async ({ body }) => {
    const job = body?.job;
    if (job && !JOBS[job]) throw httpError(400, `Unknown job ${job}. Known: ${Object.keys(JOBS).join(', ')}`);
    const results = job ? [await JOBS[job]()] : await Promise.all(Object.values(JOBS).map((f) => f()));
    S.invalidateOutlook();
    return { results };
  });

  r.post('/api/research/daemon', ({ body }) => {
    if (body?.action === 'start') daemon.start();
    else if (body?.action === 'stop') daemon.stop();
    else throw httpError(400, 'action must be "start" or "stop"');
    return daemon.status();
  });

  r.post('/api/news', ({ body }) => {
    if (!body?.headline) throw httpError(400, 'headline is required');
    return { id: addNews(body) };
  });

  // ---- Demo ---------------------------------------------------------------

  r.post('/api/demo/seed', ({ body }) => {
    const d = generateDemoLeague({
      season: int(body?.season, config.season),
      currentWeek: int(body?.week, 9),
      numTeams: int(body?.numTeams, 12),
      seed: int(body?.seed, config.seed),
    });
    S.invalidateOutlook();
    return { league_key: d.league.league_key, players: d.players.length, week: d.league.current_week };
  });

  return r;
}

function page(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} · Gridiron Oracle</title>
<style>body{background:#0a0e14;color:#d6deeb;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:46rem;margin:8vh auto;padding:0 1.5rem}
h1{font-size:1.4rem;color:#7ee787}code{background:#141b26;padding:.15em .4em;border-radius:4px;color:#79c0ff;font-size:.9em}
a{color:#79c0ff}li{margin:.35em 0}
pre{background:#141b26;padding:.9rem 1rem;border-radius:6px;overflow-x:auto;border:1px solid #1e2938}
pre code{background:none;padding:0;color:#7ee787}p{margin:.9em 0}</style></head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
