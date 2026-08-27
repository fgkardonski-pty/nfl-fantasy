/**
 * The real-data bootstrap exists so a draft-night workflow does not depend on
 * Yahoo API approval. Its riskiest piece is the rankings-list parser — it runs
 * against whatever a person pastes from a public rankings page, and a
 * truncated or mismatched name on draft night is a real cost, not a cosmetic
 * bug. Tested here against the actual formats real ranking sites produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-realdata-'));
process.env.ORACLE_DB = path.join(tmpDir, 'test.db');
process.env.ORACLE_LOG_LEVEL = 'silent';

const { parseRankingLines, importAdpFromText, setupRealLeague } = await import('../src/realdata.mjs');
const S = await import('../src/service.mjs');
const { closeDb, upsertMany } = await import('../src/db/index.mjs');

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('parseRankingLines keeps names with an internal hyphen intact', () => {
  // The original implementation cut at the first bare hyphen, which truncated
  // "Amon-Ra St. Brown" to "Amon" — a real defect caught by this exact case.
  const text = [
    "6. Amon-Ra St. Brown, WR - DET",
    "7. JuJu Smith-Schuster (WR, KC)",
    "8. Kenneth Walker III - RB - SEA",
  ].join('\n');
  assert.deepEqual(parseRankingLines(text), [
    'Amon-Ra St. Brown', 'JuJu Smith-Schuster', 'Kenneth Walker III',
  ]);
});

test('parseRankingLines handles every common rankings format', () => {
  const text = [
    "1. Ja'Marr Chase, WR - CIN",
    "2) Bijan Robinson (RB, ATL)",
    "3 - Justin Jefferson\tWR\tMIN",
    "",
    "4. CeeDee Lamb - WR - DAL",
    "Christian McCaffrey (RB, SF)",
    "Ja'Marr Chase – WR – CIN",
  ].join('\n');
  assert.deepEqual(parseRankingLines(text), [
    "Ja'Marr Chase", 'Bijan Robinson', 'Justin Jefferson', 'CeeDee Lamb',
    'Christian McCaffrey', "Ja'Marr Chase",
  ]);
});

test('parseRankingLines ignores blank lines and whitespace-only input', () => {
  assert.deepEqual(parseRankingLines('\n\n   \n\n'), []);
  assert.deepEqual(parseRankingLines(''), []);
  assert.deepEqual(parseRankingLines(null), []);
});

test('importAdpFromText matches by normalised name and preserves rank order', async () => {
  upsertMany('players',
    ['player_id', 'name', 'pos', 'nfl_team', 'bye_week', 'status', 'injury_note', 'age', 'years_exp', 'depth_rank', 'yahoo_key', 'sleeper_id', 'headshot', 'updated_at'],
    [
      { player_id: 'p1', name: "Ja'Marr Chase", pos: 'WR', nfl_team: 'CIN', bye_week: 10, status: '', injury_note: null, age: 25, years_exp: 4, depth_rank: 1, yahoo_key: null, sleeper_id: '1', headshot: null, updated_at: Date.now() },
      { player_id: 'p2', name: 'Amon-Ra St. Brown', pos: 'WR', nfl_team: 'DET', bye_week: 8, status: '', injury_note: null, age: 25, years_exp: 4, depth_rank: 1, yahoo_key: null, sleeper_id: '2', headshot: null, updated_at: Date.now() },
    ],
    ['player_id']
  );

  const report = importAdpFromText(
    "1. Ja'Marr Chase, WR - CIN\n2. Amon-Ra St. Brown, WR - DET\n3. Some Undrafted Rookie",
    { season: 2026 }
  );
  assert.equal(report.matched, 2);
  assert.equal(report.total, 3);
  assert.deepEqual(report.unmatched, ['Some Undrafted Rookie']);

  const rows = (await import('../src/db/index.mjs')).all(
    'SELECT player_id, adp FROM adp WHERE season = 2026 ORDER BY adp'
  );
  assert.deepEqual(rows, [{ player_id: 'p1', adp: 1 }, { player_id: 'p2', adp: 2 }]);
});

test('importAdpFromText reports zero matches without throwing on an empty list', () => {
  const report = importAdpFromText('', { season: 2026 });
  assert.equal(report.matched, 0);
  assert.equal(report.total, 0);
});

test('setupRealLeague produces a league the service layer can load', () => {
  const cfg = {
    name: 'Test Real League',
    season: 2026,
    numTeams: 10,
    scoring: { rec: 0.5, pass_td: 6 },
    rosterSlots: [
      { slot: 'QB', count: 1 }, { slot: 'RB', count: 2 }, { slot: 'WR', count: 2 },
      { slot: 'TE', count: 1 }, { slot: 'BN', count: 6 },
    ],
    myTeamName: 'My Real Team',
  };
  const { league_key } = setupRealLeague(cfg);
  const league = S.getLeague(league_key);

  assert.equal(league.name, 'Test Real League');
  assert.equal(league.num_teams, 10);
  assert.equal(league.isDemo, false, 'a real league must never show the demo banner');
  assert.equal(league.scoring.rec, 0.5, 'the hand-entered scoring rule is honoured');
  assert.equal(league.scoring.pass_td, 6);
  // Rules the config did not override still fall back to sane defaults, so an
  // incomplete config does not silently zero out unmentioned stat categories.
  assert.ok(league.scoring.rush_td > 0, 'unspecified rules fall back to defaults, not zero');

  const me = S.myTeam(league_key);
  assert.equal(me.name, 'My Real Team');
  assert.equal(me.is_mine, 1);
});

test('setupRealLeague is idempotent — re-running with the same league updates rather than duplicates', () => {
  const cfg = {
    name: 'Reconfigured League', season: 2026, numTeams: 8,
    scoring: {}, rosterSlots: [{ slot: 'QB', count: 1 }, { slot: 'BN', count: 3 }],
    myTeamName: 'V1',
  };
  const first = setupRealLeague(cfg);
  const second = setupRealLeague({ ...cfg, myTeamName: 'V2', leagueKey: first.league_key });
  assert.equal(first.league_key, second.league_key, 're-running with an explicit leagueKey updates the same row');

  const me = S.myTeam(second.league_key);
  assert.equal(me.name, 'V2', 'the second call\'s values win, not duplicated alongside the first');
});

test('without ADP every player at a position collapses to one value', async () => {
  // This is the invariant that justifies the draft board's "no rankings
  // loaded" warning. With no ADP there is no positional rank to key the
  // archetype curves off, so the board becomes an authoritative-looking list
  // in arbitrary order — a silent failure worse than an empty board, because
  // nothing about it signals that it is meaningless.
  const { upsertMany, run, all } = await import('../src/db/index.mjs');
  const S = await import('../src/service.mjs');

  run('DELETE FROM adp');
  run("DELETE FROM players WHERE player_id LIKE 'cov%'");
  const cols = ['player_id', 'name', 'pos', 'nfl_team', 'bye_week', 'status', 'injury_note',
    'age', 'years_exp', 'depth_rank', 'yahoo_key', 'sleeper_id', 'headshot', 'updated_at'];
  upsertMany('players', cols, Array.from({ length: 12 }, (_, i) => ({
    player_id: `cov${i}`, name: `Cov Back ${i}`, pos: 'RB', nfl_team: 'KC', bye_week: 10,
    status: '', injury_note: null, age: 25, years_exp: 3, depth_rank: 1,
    yahoo_key: null, sleeper_id: `cov${i}`, headshot: null, updated_at: Date.now(),
  })), ['player_id']);

  const { league_key } = setupRealLeague({
    name: 'Coverage Check', season: 2031, numTeams: 12, scoring: { rec: 0.5 },
    rosterSlots: [{ slot: 'RB', count: 2 }, { slot: 'BN', count: 4 }], myTeamName: 'T',
  });
  const league = S.getLeague(league_key);
  const pool = all("SELECT * FROM players WHERE player_id LIKE 'cov%'");
  const values = S.draftValues(league, pool);

  const distinct = new Set(values.map((v) => v.mean.toFixed(6)));
  assert.equal(distinct.size, 1,
    'with no rankings every back is priced identically — the board cannot order them');
  assert.match(values[0].basis, /no ADP/, 'and the valuation says so rather than implying precision');
});
