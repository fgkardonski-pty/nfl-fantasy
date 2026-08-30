/**
 * Importing rosters transcribed from screenshots.
 *
 * This is the one ingestion path whose SOURCE is known to be lossy. The league's
 * rosters were read off draft-board images, not pulled from an API: a name can
 * be misread, a row can be cut off mid-screen, and the same player can be
 * transcribed onto two different teams. Every one of those has to surface,
 * because a roster is the input to every projection the platform makes and a
 * wrong player is indistinguishable from a right one once it is stored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-rosters-'));
process.env.ORACLE_DB = path.join(tmpDir, 'test.db');
process.env.ORACLE_LOG_LEVEL = 'silent';

const { setupRealLeague, importRostersByName } = await import('../src/realdata.mjs');
const { upsertMany, all, closeDb } = await import('../src/db/index.mjs');

test.after(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const LEAGUE = {
  leagueKey: 'test.l.ros', name: 'Roster League', season: 2026, numTeams: 3,
  scoring: {}, rosterSlots: [{ slot: 'QB', count: 1 }, { slot: 'RB', count: 1 }, { slot: 'BN', count: 4 }],
  myTeamName: 'Mine',
  teams: [{ name: 'Mine' }, { name: 'Rival' }, { name: 'Other' }],
};

test('setup', () => {
  setupRealLeague(LEAGUE);
  upsertMany('players', ['player_id', 'name', 'pos', 'nfl_team'], [
    { player_id: 'r1', name: "Ja'Marr Chase", pos: 'WR', nfl_team: 'CIN' },
    { player_id: 'r2', name: 'Josh Allen', pos: 'QB', nfl_team: 'BUF' },
    { player_id: 'r3', name: 'Brock Purdy', pos: 'QB', nfl_team: 'SF' },
    { player_id: 'r4', name: 'Bijan Robinson', pos: 'RB', nfl_team: 'ATL' },
    // A genuine duplicate name in the pool — two real players, one string.
    { player_id: 'r5', name: 'Michael Carter', pos: 'RB', nfl_team: 'ARI' },
    { player_id: 'r6', name: 'Michael Carter', pos: 'WR', nfl_team: 'NYJ' },
  ], ['player_id']);
});

test('rosters are written per team, matched by name', () => {
  const r = importRostersByName('test.l.ros', {
    Mine: ["Ja'Marr Chase", 'Josh Allen'],
    Rival: ['Bijan Robinson'],
  });
  assert.equal(r.players, 3);
  assert.equal(r.teams, 2);
  assert.deepEqual(r.written, { Mine: 2, Rival: 1 });

  const mine = all("SELECT player_id FROM rosters WHERE league_key='test.l.ros' AND team_key LIKE '%.t.1'");
  assert.deepEqual(mine.map((x) => x.player_id).sort(), ['r1', 'r2']);
});

test('a player claimed by two teams is assigned to NEITHER', () => {
  // A draft cannot produce this, so it is proof of a transcription error.
  // Picking a side would put a real player on a team that never had him, and
  // the resulting projection would look exactly as sound as a correct one.
  const r = importRostersByName('test.l.ros', {
    Mine: ["Ja'Marr Chase", 'Brock Purdy'],
    Rival: ['Brock Purdy', 'Bijan Robinson'],
  });
  assert.deepEqual(r.contested, [{ player: 'Brock Purdy', teams: ['Mine', 'Rival'] }]);

  const purdy = all("SELECT * FROM rosters WHERE league_key='test.l.ros' AND player_id='r3'");
  assert.equal(purdy.length, 0, 'he is on no roster at all');
  // The rest of both rosters still lands — one bad row does not void the import.
  assert.equal(r.players, 2);
});

test('an ambiguous name is refused rather than resolved by guessing', () => {
  const r = importRostersByName('test.l.ros', { Mine: ['Michael Carter'] });
  assert.equal(r.players, 0);
  assert.ok(r.unmatched.some((u) => u.includes('Michael Carter') && u.includes('ambiguous')));
});

test('a name that is simply absent is reported, not silently dropped', () => {
  const r = importRostersByName('test.l.ros', { Mine: ['Nobody At All', 'Josh Allen'] });
  assert.equal(r.players, 1);
  assert.deepEqual(r.unmatched, ['Nobody At All']);
});

test('a team name not in the league is reported', () => {
  const r = importRostersByName('test.l.ros', { 'Ghost Team': ['Josh Allen'] });
  assert.deepEqual(r.unknownTeams, ['Ghost Team']);
  assert.equal(r.players, 0);
});

test('re-importing replaces a team roster rather than stacking onto it', () => {
  importRostersByName('test.l.ros', { Mine: ["Ja'Marr Chase", 'Josh Allen'] });
  importRostersByName('test.l.ros', { Mine: ['Bijan Robinson'] });
  const mine = all("SELECT player_id FROM rosters WHERE league_key='test.l.ros' AND team_key LIKE '%.t.1'");
  assert.deepEqual(mine.map((x) => x.player_id), ['r4']);
});

test('the league config carries rosters that name real teams and no duplicates', async () => {
  // Guards the transcription itself, not the code: the shipped config is the
  // record of what was read off the screenshots, and both faults it is known to
  // have had — a player on two teams, a name for a team that does not exist —
  // are exactly what this import refuses to store.
  const cfg = JSON.parse(await fs.promises.readFile('fantazy-fulzbol.json', 'utf8'));
  const teamNames = new Set(cfg.teams.map((t) => t.name));

  const seen = new Map();
  for (const [team, players] of Object.entries(cfg.rosters)) {
    assert.ok(teamNames.has(team), `${team} is a real team in this league`);
    for (const p of players) {
      assert.ok(!seen.has(p), `${p} is claimed by both ${seen.get(p)} and ${team}`);
      seen.set(p, team);
    }
  }
  assert.equal(Object.keys(cfg.rosters).length, cfg.numTeams, 'every team has a roster');
});
