import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-actions-'));
process.env.ORACLE_DB = path.join(tmp, 'test.db');
process.env.ORACLE_LOG_LEVEL = 'silent';
const { default: config } = await import('../src/config.mjs');
config.cacheDir = path.join(tmp, 'cache');
const { all, get, run, upsertMany, meta, closeDb } = await import('../src/db/index.mjs');
const { importSleeperLeague } = await import('../src/realdata.mjs');
const { saveSleeperTransactions } = await import('../src/research/refresh.mjs');
const { actionPlan } = await import('../src/actions.mjs');
const S = await import('../src/service.mjs');
const { projectPlayer, baselinePpg } = await import('../src/engine/projections.mjs');
const { ResearchDaemon } = await import('../src/research/daemon.mjs');
const { JOBS } = await import('../src/research/jobs.mjs');

const key = 'sleeper.l.12345';
const savedFetch = globalThis.fetch;
const rosterPayload = [
  { roster_id: 1, owner_id: 'u1', players: ['1', '2'], starters: ['1'], settings: { waiver_budget_used: 37, waiver_position: 2 } },
  { roster_id: 2, owner_id: 'u2', players: ['3'], starters: ['3'], settings: {} },
];
globalThis.fetch = async (url) => {
  const u = String(url);
  let body;
  if (u.endsWith('/league/12345')) body = { league_id: '12345', name: 'Sleeper Test', season: '2035', total_rosters: 2,
    status: 'in_season', roster_positions: ['WR', 'BN'], scoring_settings: { rec: 1 },
    settings: { playoff_week_start: 3, playoff_teams: 2, waiver_budget: 100, waiver_type: 2 } };
  else if (u.endsWith('/users')) body = [{ user_id: 'u1', display_name: 'Frank' }, { user_id: 'u2', display_name: 'Rival' }];
  else if (u.endsWith('/rosters')) body = rosterPayload;
  else if (u.endsWith('/state/nfl')) body = { season: '2035', week: 1 };
  else if (u.includes('/matchups/')) body = [{ roster_id: 1, matchup_id: 1, points: 0 }, { roster_id: 2, matchup_id: 1, points: 0 }];
  else if (u.endsWith('/user/frank')) body = { user_id: 'u1', display_name: 'Frank' };
  else throw new Error(`Unexpected test URL ${u}`);
  return new Response(JSON.stringify(body), { status: 200 });
};
test.after(() => { globalThis.fetch = savedFetch; closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Sleeper reimport preserves my team and spent FAAB, with exact starter slots', async () => {
  upsertMany('players', ['player_id', 'sleeper_id', 'name', 'pos', 'nfl_team'], [
    ['p1', '1', 'Starter', 'WR', 'BUF'], ['p2', '2', 'Bench', 'WR', 'BUF'],
    ['p3', '3', 'Rival player', 'WR', 'NYJ'], ['p4', '4', 'Upgrade', 'WR', 'BUF'],
  ].map(([player_id, sleeper_id, name, pos, nfl_team]) => ({ player_id, sleeper_id, name, pos, nfl_team })), ['player_id']);
  const first = await importSleeperLeague('12345', { username: 'frank' });
  assert.equal(first.ok, true);
  const second = await importSleeperLeague('12345');
  assert.equal(second.ok, true);
  assert.equal(S.myTeam(key).name, 'Frank');
  assert.equal(S.myTeam(key).faab_remaining, 63);
  assert.equal(S.rosterOf(key, `${key}.t.1`, 1).find((p) => p.player_id === 'p1').slot, 'WR');
});

test('incomplete player universe refuses replacement rather than erasing a roster', async () => {
  run("UPDATE players SET sleeper_id=NULL WHERE player_id='p2'");
  const before = S.rosterOf(key, `${key}.t.1`, 1);
  const result = await importSleeperLeague('12345');
  assert.equal(result.ok, false);
  assert.deepEqual(S.rosterOf(key, `${key}.t.1`, 1), before);
  run("UPDATE players SET sleeper_id='2' WHERE player_id='p2'");
});

test('activity is idempotent and attributed to the right manager', () => {
  const t = { status: 'complete', transaction_id: 'tx1', type: 'waiver', leg: 1,
    status_updated: Date.now(), adds: { '4': 2 }, drops: { '3': 2 }, settings: { waiver_bid: 5 } };
  saveSleeperTransactions(key, [t], 1);
  saveSleeperTransactions(key, [t], 1);
  assert.equal(all('SELECT * FROM transactions WHERE league_key=?', [key]).length, 2);
  assert.equal(get("SELECT team_key FROM transactions WHERE movement='add'").team_key, `${key}.t.2`);
});

test('stale ownership blocks add/drop; fresh evidence produces explained alternatives', () => {
  const league = S.getLeague(key);
  const now = Date.now();
  for (const [id, rec] of [['p1', 5], ['p2', 2], ['p3', 7], ['p4', 10]]) {
    upsertMany('external_projections', ['source', 'player_id', 'season', 'week', 'stats', 'fetched_at'],
      [{ source: 'test', player_id: id, season: 2035, week: 1, stats: JSON.stringify({ rec }), fetched_at: now }], ['source', 'player_id', 'season', 'week']);
  }
  const stale = actionPlan(league, { now });
  assert.equal(stale.acquisitions.length, 0);
  assert.equal(stale.freshness.stale, true);
  meta.set(`refresh:${key}`, { lastSuccess: now, errors: [], evidenceErrors: [] });
  const fresh = actionPlan(league, { now });
  assert.equal(fresh.freshness.stale, false);
  assert.equal(fresh.acquisitions[0].add.player_id, 'p4');
  assert.equal(fresh.acquisitions[0].drop.player_id, 'p2');
  assert.ok(fresh.acquisitions[0].why.length > 20);
  assert.equal(fresh.waiverType, 'FAAB');
  assert.ok(fresh.acquisitions.every((a) => !['p1', 'p2', 'p3'].includes(a.add.player_id)));
});

test('a locked starter stays in its slot, even when a bench player projects higher', () => {
  upsertMany('games', ['season', 'week', 'home', 'away', 'kickoff', 'source'],
    [{ season: 2035, week: 1, home: 'BUF', away: 'NYJ', kickoff: Date.now() - 60000, source: 'real' }], ['season', 'week', 'home', 'away']);
  const d = actionPlan(S.getLeague(key));
  assert.equal(d.starters[0].player.player_id, 'p1');
  assert.equal(d.starters[0].locked, true);
  assert.equal(d.lineupChanges.length, 0);
});

test('published weekly forecast stays authoritative after games, and week zero is not a game', () => {
  upsertMany('player_stats', ['player_id', 'season', 'week', 'stats'], [
    { player_id: 'p4', season: 2035, week: 0, stats: '{"rec":100}' },
    { player_id: 'p4', season: 2035, week: 1, stats: '{"rec":1}' },
  ], ['player_id', 'season', 'week']);
  upsertMany('external_projections', ['source', 'player_id', 'season', 'week', 'stats', 'fetched_at'],
    [{ source: 'test', player_id: 'p4', season: 2035, week: 2, stats: '{"rec":12}', fetched_at: Date.now() }], ['source', 'player_id', 'season', 'week']);
  const base = baselinePpg('p4', 'WR', 2035, 1, { rec: 1 });
  assert.equal(base.games, 1);
  assert.equal(base.ppg, 12);
  const p = projectPlayer({ player_id: 'p4', pos: 'WR', nfl_team: 'BUF', status: '' }, { season: 2035, week: 2, scoring: { rec: 1 } });
  assert.equal(p.mean, 12);
});

test('overlapping refresh triggers share one in-flight job', async () => {
  const daemon = new ResearchDaemon({ schedule: [], runOnStart: false });
  let calls = 0;
  let done;
  JOBS['test:slow'] = () => { calls++; return new Promise((r) => { done = r; }); };
  const a = daemon.runOne('test:slow');
  const b = daemon.runOne('test:slow');
  await Promise.resolve();
  assert.equal(calls, 1);
  done({ ok: true });
  assert.deepEqual(await a, await b);
  delete JOBS['test:slow'];
});
