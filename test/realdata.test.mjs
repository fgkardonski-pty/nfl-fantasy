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

const { parseRankingLines, importAdpFromText, setupRealLeague, importRankingsFromCsv } = await import('../src/realdata.mjs');
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

test('a projected stat line is used as a season expectation, not shrunk like one game', async () => {
  // Regression. Projections are stored at week 0; observed games at week 1+.
  // Treating a projection as a single observed game shrank it hard toward a
  // replacement-level prior, pricing a back projected for 1350 rushing yards
  // and 11 touchdowns at ~10 points a game instead of ~24 — an error easily
  // large enough to invert the top of a draft board.
  const { upsertMany, run, all } = await import('../src/db/index.mjs');
  const S = await import('../src/service.mjs');
  const { scoreStatLine } = await import('../src/engine/scoring.mjs');

  run("DELETE FROM players WHERE player_id LIKE 'proj%'");
  run('DELETE FROM player_stats WHERE season = 2032');
  run('DELETE FROM adp WHERE season = 2032');

  const cols = ['player_id', 'name', 'pos', 'nfl_team', 'bye_week', 'status', 'injury_note',
    'age', 'years_exp', 'depth_rank', 'yahoo_key', 'sleeper_id', 'headshot', 'updated_at'];
  upsertMany('players', cols, [{
    player_id: 'proj1', name: 'Projected Back', pos: 'RB', nfl_team: 'ATL', bye_week: 5,
    status: '', injury_note: null, age: 23, years_exp: 2, depth_rank: 1,
    yahoo_key: null, sleeper_id: 'proj1', headshot: null, updated_at: Date.now(),
  }], ['player_id']);

  // A strong per-game projected line.
  const statLine = {
    rush_att: 17, rush_yd: 79, rush_td: 0.65,
    rec: 3.5, rec_yd: 28, rec_td: 0.18,
    rush_first_down: 4.1, rec_first_down: 2.0,
  };
  upsertMany('player_stats', ['player_id', 'season', 'week', 'opponent', 'stats'],
    [{ player_id: 'proj1', season: 2032, week: 0, opponent: null, stats: JSON.stringify(statLine) }],
    ['player_id', 'season', 'week']);

  const { league_key } = setupRealLeague({
    name: 'Projection Check', season: 2032, numTeams: 12,
    scoring: { rush_att: 0.2, rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1, rec_td: 6,
      rush_first_down: 0.5, rec_first_down: 0.5 },
    rosterSlots: [{ slot: 'RB', count: 2 }, { slot: 'BN', count: 4 }], myTeamName: 'T',
  });
  const league = S.getLeague(league_key);
  const [valued] = S.draftValues(league, all("SELECT * FROM players WHERE player_id = 'proj1'"));

  const expected = scoreStatLine(statLine, league.scoring);
  assert.ok(expected > 20, `sanity: this line is worth ${expected.toFixed(1)} in these rules`);
  assert.ok(Math.abs(valued.mean - expected) < 0.01,
    `projection used directly (${valued.mean.toFixed(1)}), not shrunk to ${expected.toFixed(1)}`);
  assert.match(valued.basis, /projected stat line/);
});

test('week 0 projections never count as observed games played', async () => {
  const { all } = await import('../src/db/index.mjs');
  const S = await import('../src/service.mjs');
  const league = S.getLeague('real.l.2032');
  const [valued] = S.draftValues(league, all("SELECT * FROM players WHERE player_id = 'proj1'"));
  assert.equal(valued.games, 0,
    'a forecast is not a game played — counting it as one would also corrupt every variance estimate');
});

// ---------------------------------------------------------------------------
// CSV import: rank and ADP are different numbers and must stay different
// ---------------------------------------------------------------------------

/**
 * The CSV carries both a consensus rank and the market's ADP, and they
 * disagree — often sharply. Conflating them is the mistake this pins against.
 *
 * Positional rank answers "how good do the experts think he is", and drives
 * valuation through the archetype curves. ADP answers "when will he actually be
 * gone", and drives whether it is safe to wait a round. A kicker ranked 183rd
 * who goes at pick 124 is not a better kicker for being over-drafted; pricing
 * him off his ADP would say exactly that.
 */
const CSV_HEADER =
  '"RK",TIERS,"PLAYER NAME",TEAM,"POS","BYE WEEK","UPSIDE ","BUST ","SOS SEASON","ECR VS. ADP"';

test('CSV import keeps the published positional rank separate from ADP', async () => {
  const { upsertMany, all, get } = await import('../src/db/index.mjs');
  const roster = [
    ['csv1', 'Alpha Back', 'RB'], ['csv2', 'Beta Back', 'RB'],
    ['csv3', 'Gamma Back', 'RB'], ['csv4', 'Delta Kicker', 'K'],
  ];
  upsertMany('players', ['player_id', 'name', 'pos', 'updated_at'],
    roster.map(([id, name, pos]) => ({ player_id: id, name, pos, updated_at: Date.now() })),
    ['player_id']);

  // Gamma is ranked third but goes second; the market disagrees with the
  // experts about him, which is exactly the case that must not be flattened.
  const csv = [
    CSV_HEADER,
    '"1",1,"Alpha Back",DET,"RB1","6","-","-","-","0"',
    '"2",1,"Beta Back",ATL,"RB2","11","-","-","-","+4"',
    '"3",1,"Gamma Back",IND,"RB3","13","-","-","-","-1"',
    '"183",10,"Delta Kicker",DAL,"K1","14","-","-","-","-59"',
  ].join('\n');

  const report = importRankingsFromCsv(csv, { season: 2031, source: 'test-csv' });
  assert.equal(report.matched, 4);

  const rows = all(
    'SELECT player_id, adp, ecr, pos_rank, tier FROM adp WHERE season = ? AND source = ? ORDER BY ecr',
    [2031, 'test-csv']
  );
  assert.deepEqual(rows.map((r) => r.pos_rank), [1, 2, 3, 1], 'published positional ranks');
  assert.deepEqual(rows.map((r) => r.adp), [1, 6, 2, 124], 'market ADP, reconstructed');
  assert.deepEqual(rows.map((r) => r.ecr), [1, 2, 3, 183], 'consensus rank kept as published');

  // Beta is RB2 by consensus but goes at 6, behind Gamma at 2. Both facts are
  // recorded; neither has overwritten the other.
  const beta = rows.find((r) => r.player_id === 'csv2');
  const gamma = rows.find((r) => r.player_id === 'csv3');
  assert.ok(beta.pos_rank < gamma.pos_rank, 'Beta is rated higher');
  assert.ok(beta.adp > gamma.adp, 'yet Gamma comes off the board first');

  // Bye weeks land on the player, where they are needed every week of the year.
  assert.equal(get('SELECT bye_week FROM players WHERE player_id = ?', ['csv2']).bye_week, 11);
});

test('valuation prices a player by his published rank, not by his ADP', async () => {
  const { upsertMany, run } = await import('../src/db/index.mjs');
  setupRealLeague({
    leagueKey: 'csvtest.l.1', name: 'CSV Test', season: 2032, numTeams: 12,
    scoring: { rec: 0.5, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rush_td: 6, rec_td: 6, pass_td: 4 },
    rosterSlots: [{ slot: 'QB', count: 1 }, { slot: 'RB', count: 2 }, { slot: 'WR', count: 2 }],
  });

  upsertMany('players', ['player_id', 'name', 'pos', 'updated_at'], [
    { player_id: 'vr1', name: 'Elite Back', pos: 'RB', updated_at: Date.now() },
    { player_id: 'vr2', name: 'Hyped Back', pos: 'RB', updated_at: Date.now() },
  ], ['player_id']);

  // Hyped Back has the BETTER (earlier) ADP but the WORSE published rank.
  // Deriving positional rank by sorting ADP would price him as the better back.
  const csv = [
    CSV_HEADER,
    '"1",1,"Elite Back",DET,"RB1","6","-","-","-","+30"',
    '"40",4,"Hyped Back",ATL,"RB2","11","-","-","-","-25"',
  ].join('\n');
  importRankingsFromCsv(csv, { season: 2032, source: 'fantasypros-csv' });

  const valued = S.draftValues(S.getLeague('csvtest.l.1'),
    (await import('../src/db/index.mjs')).all("SELECT * FROM players WHERE player_id LIKE 'vr%'"));
  const elite = valued.find((p) => p.player_id === 'vr1');
  const hyped = valued.find((p) => p.player_id === 'vr2');

  assert.ok(hyped.adp < elite.adp, 'the hyped back does come off the board first');
  assert.ok(elite.mean > hyped.mean,
    `the RB1 must still be worth more per game (RB1 ${elite.mean.toFixed(1)} vs RB2 ${hyped.mean.toFixed(1)})`);
  assert.match(elite.basis, /RB1/);
  run("DELETE FROM leagues WHERE league_key = 'csvtest.l.1'");
});

// ---------------------------------------------------------------------------
// Full-league ingestion: divisions, stable keys, and the real-vs-guessed schedule
// ---------------------------------------------------------------------------

const LEAGUE16 = {
  leagueKey: 'test.l.div', name: 'Divided League', season: 2026, numTeams: 4,
  scoring: {}, rosterSlots: [{ slot: 'QB', count: 1 }, { slot: 'BN', count: 3 }],
  myTeamName: 'Frank the Tank',
  divisions: [
    { name: 'East', teams: ['Alpha', 'Bravo'] },
    { name: 'West', teams: ['Frank the Tank', 'Delta'] },
  ],
  teams: [
    { name: 'Alpha', waiverPriority: 1 },
    { name: 'Bravo', waiverPriority: 2 },
    { name: 'Frank the Tank', waiverPriority: 3 },
    { name: 'Delta', waiverPriority: 4 },
  ],
  schedule: { 1: [['Frank the Tank', 'Delta']] },
};

test('setupRealLeague ingests every team, its division and its waiver priority', () => {
  const { league_key } = setupRealLeague(LEAGUE16);
  const teams = S.getTeams(league_key);
  assert.equal(teams.length, 4, 'the league is its whole membership, not just us');

  const me = S.myTeam(league_key);
  assert.equal(me.name, 'Frank the Tank');
  assert.equal(teams.filter((t) => t.is_mine).length, 1, 'exactly one team is ours');

  const byName = new Map(teams.map((t) => [t.name, t]));
  assert.equal(byName.get('Alpha').division, 'East');
  assert.equal(byName.get('Frank the Tank').division, 'West');
  // Waiver priority is the constraint that decides whether a streaming plan is
  // realistic at all, so it has to survive ingestion.
  assert.equal(byName.get('Delta').waiver_priority, 4);
});

test('a real schedule week is kept as fact; the rest of the season is flagged estimated', () => {
  const league = S.getLeague('test.l.div');
  const sched = S.scheduleFor(league);

  const wk1 = sched.find((w) => w.week === 1);
  assert.ok(wk1, 'week 1 is present');
  // One pairing was entered out of the two a four-team week needs, so the week
  // is correctly reported as part-real: one known pair, the rest filled in.
  assert.equal(wk1.knownPairs, 1);
  assert.equal(wk1.pairs.length, 2, 'the week is completed so the simulation plays a full slate');
  assert.equal(wk1.estimated, true, 'a partially-entered week still contains guesses');

  const me = S.myTeam('test.l.div');
  const delta = S.getTeams('test.l.div').find((t) => t.name === 'Delta');
  const pair = wk1.pairs.find((p) => p.includes(me.team_key));
  assert.ok(pair.includes(delta.team_key), 'we play the opponent the config names, not a generated one');

  // And a week entered in full carries no guesses at all.
  setupRealLeague({ ...LEAGUE16, schedule: { 1: [['Frank the Tank', 'Delta'], ['Alpha', 'Bravo']] } });
  const full = S.scheduleFor(S.getLeague('test.l.div')).find((w) => w.week === 1);
  assert.equal(full.knownPairs, 2);
  assert.equal(full.estimated, false, 'nothing was invented for a week we entered completely');

  // The whole point of the merge: one known week must not erase the other
  // thirteen from the season simulation.
  assert.ok(sched.length > 1, 'the rest of the regular season is still scheduled');
  assert.ok(sched.filter((w) => w.week > 1).every((w) => w.estimated),
    'every week we have not entered is marked as a guess');
});

test('opponentForWeek distinguishes a real opponent from an invented one', () => {
  const league = S.getLeague('test.l.div');
  const me = S.myTeam('test.l.div');

  const wk1 = S.opponentForWeek(league, me.team_key, 1);
  assert.equal(wk1.source, 'config', 'week 1 came off the league settings');
  assert.ok(wk1.oppKey);

  // Week 2 was never entered. Returning an opponent is fine — the season
  // simulation needs one — but presenting it as fact is the bug this replaced:
  // the app previously showed a team name with no indication it was a guess.
  const wk2 = S.opponentForWeek(league, me.team_key, 2);
  assert.equal(wk2.source, 'estimated');
});

test('re-running the config after renaming our team keeps the same team key', () => {
  const before = S.myTeam('test.l.div');

  setupRealLeague({
    ...LEAGUE16,
    myTeamName: 'Frank the Tank II',
    teams: LEAGUE16.teams.map((t) => (t.name === 'Frank the Tank' ? { ...t, name: 'Frank the Tank II' } : t)),
    divisions: [
      { name: 'East', teams: ['Alpha', 'Bravo'] },
      { name: 'West', teams: ['Frank the Tank II', 'Delta'] },
    ],
    schedule: { 1: [['Frank the Tank II', 'Delta']] },
  });

  const after = S.myTeam('test.l.div');
  assert.equal(after.name, 'Frank the Tank II');
  // The key is what rosters, draft picks and matchups reference. If a rename
  // minted a new key our drafted roster would be stranded on a team we no
  // longer own — silently, with the app still looking correct.
  assert.equal(after.team_key, before.team_key, 'a rename updates in place');
  assert.equal(S.getTeams('test.l.div').filter((t) => t.is_mine).length, 1);
});

test('an existing team keeping its name is never re-pointed by a config edit', () => {
  // The failure this guards: keys assigned by array index, so adding or
  // reordering a team in the config hands every roster to the wrong manager.
  const keysBefore = new Map(S.getTeams('test.l.div').map((t) => [t.name, t.team_key]));

  setupRealLeague({
    ...LEAGUE16,
    myTeamName: 'Frank the Tank II',
    teams: [
      { name: 'Echo', waiverPriority: 5 },          // a new team, inserted first
      { name: 'Delta', waiverPriority: 4 },
      { name: 'Bravo', waiverPriority: 2 },
      { name: 'Alpha', waiverPriority: 1 },
      { name: 'Frank the Tank II', waiverPriority: 3 },
    ],
    divisions: LEAGUE16.divisions,
    schedule: {},
  });

  const keysAfter = new Map(S.getTeams('test.l.div').map((t) => [t.name, t.team_key]));
  for (const [name, key] of keysBefore) {
    if (name === 'Frank the Tank') continue;
    assert.equal(keysAfter.get(name), key, `${name} kept its key despite the reorder`);
  }
  assert.ok(keysAfter.get('Echo'), 'the genuinely new team got a key of its own');
  assert.notEqual(keysAfter.get('Echo'), keysBefore.get('Alpha'));
});

test('a schedule naming a team that does not exist is reported, not silently dropped', () => {
  const r = setupRealLeague({
    ...LEAGUE16,
    leagueKey: 'test.l.badsched',
    schedule: { 1: [['Frank the Tank', 'A Team That Never Existed']] },
  });
  assert.deepEqual(r.unknownTeams, ['A Team That Never Existed']);
  assert.equal(r.matchups, 0, 'the bad pairing is not written as if it were real');
});
