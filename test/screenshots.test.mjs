/**
 * Screenshot updates: what was read becomes the right proposed changes, and
 * applying them edits the league file correctly. No model call — the tests
 * start from already-extracted data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-shots-'));
process.env.ORACLE_DB = path.join(tmp, 'test.db');
process.env.ORACLE_LOG_LEVEL = 'silent';
const { upsertMany, meta, closeDb } = await import('../src/db/index.mjs');
const { setupRealLeague } = await import('../src/realdata.mjs');
const shots = await import('../src/screenshots.mjs');
const S = await import('../src/service.mjs');

const KEY = 'test.l.1';
const P = (id, name, pos, nfl) => ({ player_id: id, name, pos, nfl_team: nfl, status: '' });
upsertMany('players', ['player_id', 'name', 'pos', 'nfl_team', 'status'], [
  P('p1', 'Tyler Allgeier', 'RB', 'ARI'), P('p2', 'Zonovan Knight', 'RB', 'ARI'),
  P('p3', 'AJ Barner', 'TE', 'SEA'), P('p4', 'J.J. McCarthy', 'QB', 'NYG'),
  P('p5', 'Sam Darnold', 'QB', 'SEA'), P('p6', 'Kenyon Sadiq', 'TE', 'NYJ'),
  P('d1', 'New York Jets', 'DEF', 'NYJ'), P('d2', 'Tennessee Titans', 'DEF', 'TEN'),
  P('p7', 'Tyreek Hill', 'WR', null), P('p8', 'Samaje Perine', 'RB', 'CIN'),
], ['player_id']);

const file = path.join(tmp, 'league.json');
const cfg = {
  leagueKey: KEY, name: 'Test', season: 2026, numTeams: 3, myTeamName: 'Mine', currentWeek: 7,
  rosterSlots: [{ slot: 'QB', count: 1 }, { slot: 'RB', count: 1 }, { slot: 'TE', count: 1 }, { slot: 'DEF', count: 1 }, { slot: 'BN', count: 2 }],
  teams: [{ name: 'Mine', wins: 5, losses: 1 }, { name: 'Team Bravo', wins: 2, losses: 4 }, { name: "Charlie's", wins: 3, losses: 3 }],
  rosters: {
    Mine: [{ name: 'Tyler Allgeier', pos: 'RB', slot: 'RB', nfl: 'ARI' }],
    'Team Bravo': [{ name: 'Sam Darnold', pos: 'QB', slot: 'QB', nfl: 'SEA' }, { name: 'Tyreek Hill', pos: 'WR', slot: 'BN', nfl: 'MIA' }],
    "Charlie's": [{ name: 'Kenyon Sadiq', pos: 'TE', slot: 'TE', nfl: 'NYJ' }],
  },
  scoringComplete: false,
};
fs.writeFileSync(file, JSON.stringify(cfg));
setupRealLeague(cfg);
meta.set(`league_config:${KEY}`, file);

test.after(() => { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

// As read off two out-of-order screenshots: page order is NOT time order, and
// one waiver run shares a timestamp.
const extracted = {
  screenshots: [], notes: [], rosters: [],
  transactions: [
    // Screenshot 1 (top = newest on that page)
    { team: 'Team Bravo', add: { name: 'AJ Barner', pos: 'TE', nfl: 'Sea' }, drop: { name: 'Sam Darnold', pos: 'QB', nfl: 'Sea' }, fromTeam: '', when: 'Oct 21, 4:43 am' },
    { team: 'Mine', add: { name: 'Bam Knight', pos: 'RB', nfl: 'Ari' }, drop: { name: 'Tyler Allgeier', pos: 'RB', nfl: 'Ari' }, fromTeam: '', when: 'Oct 20, 1:00 pm' },
    // Screenshot 2: same waiver run, team names hidden by a popup
    { team: '', add: { name: 'J.J. McCarthy', pos: 'QB', nfl: 'NYG' }, drop: { name: 'AJ Barner', pos: 'TE', nfl: 'Sea' }, fromTeam: '', when: 'Oct 21, 4:43 am' },
    { team: '', add: { name: 'Titans', pos: 'DEF', nfl: 'Ten' }, drop: { name: 'Kenyon Sadiq', pos: 'TE', nfl: 'NYJ' }, fromTeam: '', when: '' },
    { team: 'Team Bravo', add: { name: 'Samaje Perine', pos: 'RB', nfl: 'Cin' }, drop: { name: 'Tyreek Hill', pos: 'WR', nfl: 'Mia' }, fromTeam: '', when: 'Oct 21, 4:43 am' },
  ],
};

test('proposals respect time order, nicknames, hidden teams and released players', () => {
  const p = shots.propose(KEY, extracted);
  const by = (pred) => p.changes.find(pred);
  // Barner was added and then dropped in the same run: his add must not survive.
  const barnerAdd = by((c) => c.readAs.add === 'AJ Barner');
  assert.equal(barnerAdd.add, null);
  const mcCarthy = by((c) => c.add?.name === 'J.J. McCarthy');
  assert.equal(mcCarthy.team, 'Team Bravo');             // inferred from who held Barner after the earlier move
  assert.equal(mcCarthy.status, 'ready');
  assert.equal(by((c) => c.add?.name === 'Zonovan Knight').status, 'ready');   // "Bam" Knight
  const titans = by((c) => c.add?.name === 'Tennessee Titans');
  assert.equal(titans.team, "Charlie's");                 // held the dropped Sadiq
  assert.equal(by((c) => c.add?.name === 'Samaje Perine').drop?.name, 'Tyreek Hill');   // no NFL team, still found
});

test('applying writes the end state to the league file and the database', () => {
  const p = shots.propose(KEY, extracted);
  const r = shots.apply(KEY, { changes: p.changes.filter((c) => c.status === 'ready'), currentWeek: 8 });
  assert.ok(r.applied.length >= 4);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = (t) => after.rosters[t].map((e) => e.name).sort();
  assert.deepEqual(names('Mine'), ['Zonovan Knight']);
  assert.deepEqual(names('Team Bravo'), ['J.J. McCarthy', 'Samaje Perine']);
  assert.deepEqual(names("Charlie's"), ['Tennessee Titans']);
  assert.equal(after.rosters.Mine[0].slot, 'RB');          // inherits the dropped starter's slot
  assert.equal(after.currentWeek, 8);
  const league = S.getLeague(KEY);
  assert.equal(league.current_week, 8);
  const mine = S.myTeam(KEY);
  assert.deepEqual(S.rosterOf(KEY, mine.team_key, 8).map((x) => x.name), ['Zonovan Knight']);
  // Re-reading the same screenshots now changes nothing.
  assert.ok(shots.propose(KEY, extracted).changes.every((c) => c.status !== 'ready'));
});
