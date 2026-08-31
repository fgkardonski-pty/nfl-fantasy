/**
 * Two leagues under one roof.
 *
 * They share exactly one thing — the player universe — which is correct: the
 * same athlete valued under two different rule sets is what the scoring layer
 * exists for. Everything else is scoped by league key, and the failure this
 * guards against is subtle rather than loud: a view rendering one league's
 * numbers under the other's name looks entirely normal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-multi-'));
process.env.ORACLE_DB = path.join(tmpDir, 'test.db');
process.env.ORACLE_LOG_LEVEL = 'silent';

const { setupRealLeague, scoringFromSleeper } = await import('../src/realdata.mjs');
const S = await import('../src/service.mjs');
const { upsertMany, all, closeDb } = await import('../src/db/index.mjs');
const { scoreStatLine } = await import('../src/engine/scoring.mjs');

test.after(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('setup: two leagues, one shared player', () => {
  upsertMany('players', ['player_id', 'name', 'pos'], [
    { player_id: 'ml1', name: 'Shared Receiver', pos: 'WR' },
    { player_id: 'ml2', name: 'Shared Passer', pos: 'QB' },
  ], ['player_id']);

  // Half PPR with a first-down bonus.
  setupRealLeague({
    leagueKey: 'test.l.alpha', name: 'Alpha', season: 2026, numTeams: 2,
    scoring: { rec: 0.5, rec_first_down: 0.5 }, myTeamName: 'Alpha Mine',
    rosterSlots: [{ slot: 'WR', count: 1 }, { slot: 'BN', count: 1 }],
    teams: [{ name: 'Alpha Mine' }, { name: 'Alpha Rival' }],
    rosters: { 'Alpha Mine': [{ name: 'Shared Receiver', pos: 'WR' }] },
  });
  // Full PPR, no first-down bonus.
  setupRealLeague({
    leagueKey: 'test.l.beta', name: 'Beta', season: 2026, numTeams: 2,
    scoring: { rec: 1, rec_first_down: 0 }, myTeamName: 'Beta Mine',
    rosterSlots: [{ slot: 'WR', count: 1 }, { slot: 'BN', count: 1 }],
    teams: [{ name: 'Beta Mine' }, { name: 'Beta Rival' }],
    rosters: { 'Beta Rival': [{ name: 'Shared Receiver', pos: 'WR' }] },
  });

  assert.equal(S.listLeagues().length >= 2, true);
});

test('each league keeps its own teams, and its own idea of which is mine', () => {
  assert.equal(S.myTeam('test.l.alpha').name, 'Alpha Mine');
  assert.equal(S.myTeam('test.l.beta').name, 'Beta Mine');

  const alpha = S.getTeams('test.l.alpha').map((t) => t.name).sort();
  const beta = S.getTeams('test.l.beta').map((t) => t.name).sort();
  assert.deepEqual(alpha, ['Alpha Mine', 'Alpha Rival']);
  assert.deepEqual(beta, ['Beta Mine', 'Beta Rival']);
  // No team leaks across.
  assert.ok(!alpha.some((n) => beta.includes(n)));
});

test('the same player sits on different teams in different leagues', () => {
  const aRoster = all("SELECT team_key FROM rosters WHERE league_key='test.l.alpha' AND player_id='ml1'");
  const bRoster = all("SELECT team_key FROM rosters WHERE league_key='test.l.beta' AND player_id='ml1'");
  assert.equal(aRoster.length, 1);
  assert.equal(bRoster.length, 1);
  assert.notEqual(aRoster[0].team_key, bRoster[0].team_key);

  // In Alpha he is ours; in Beta he belongs to a rival. Nothing about the
  // player row itself records ownership, which is what makes this work.
  assert.equal(aRoster[0].team_key, S.myTeam('test.l.alpha').team_key);
  assert.notEqual(bRoster[0].team_key, S.myTeam('test.l.beta').team_key);
});

test('the same stat line is worth different points in each league', () => {
  const line = { rec: 8, rec_first_down: 5, rec_yd: 100 };
  const a = scoreStatLine(line, S.getLeague('test.l.alpha').scoring);
  const b = scoreStatLine(line, S.getLeague('test.l.beta').scoring);
  assert.notEqual(a, b, 'half PPR with a first-down bonus is not full PPR');
});

test('roster completeness is computed per league, not globally', () => {
  const a = S.rosterCompleteness(S.getLeague('test.l.alpha'), { week: 1 });
  const b = S.rosterCompleteness(S.getLeague('test.l.beta'), { week: 1 });
  assert.equal(a.mine.have, 1, 'our Alpha team holds the shared receiver');
  assert.equal(b.mine.have, 0, 'our Beta team holds nobody');
});

test('Sleeper scoring settings map onto this platform\'s keys', () => {
  const { scoring, unmapped } = scoringFromSleeper({
    rec: 0.5, rec_yd: 0.1, rec_td: 6, pass_td: 4,
    pts_allow_0: 10, pts_allow_7_13: 4, pts_allow_35p: -4,
    sack: 1, def_st_td: 6,
    some_future_rule: 3,        // must be reported, not silently dropped
    ignored_zero: 0,
  });
  assert.equal(scoring.rec, 0.5);
  assert.equal(scoring.pass_td, 4);
  assert.equal(scoring.def_sack, 1);
  assert.equal(scoring.def_ret_td, 6);
  // Points-allowed tiers come through under their own bucket names.
  assert.equal(scoring.def_pa_0, 10);
  assert.equal(scoring.def_pa_7_13, 4);
  assert.equal(scoring.def_pa_35p, -4);
  // An unrecognised rule scores zero forever, so it has to be surfaced.
  assert.deepEqual(unmapped, ['some_future_rule']);
  assert.equal(scoring.ignored_zero, undefined, 'a zero-valued rule is not a rule');
});

test('each league reads the consensus board published for its own scoring', () => {
  // ADP drives the OPPONENT model — when a player leaves the board, what
  // survives to the next pick, what VONA is worth. Scoring format changes the
  // ORDER of a consensus board, not just its scale, so a full-PPR league
  // reading a half-PPR board predicts the wrong draft. That is the same shape
  // as the defect that already cost a draft: valuation right, market wrong.
  upsertMany('adp', ['player_id', 'season', 'source', 'adp'], [
    { player_id: 'ml1', season: 2026, source: 'fp-PPR', adp: 4 },
    { player_id: 'ml1', season: 2026, source: 'fp-HALF', adp: 19 },
    { player_id: 'ml1', season: 2026, source: 'legacy', adp: 99 },
  ], ['player_id', 'season', 'source']);

  const alpha = S.getLeague('test.l.alpha');   // rec 0.5  -> HALF
  const beta = S.getLeague('test.l.beta');     // rec 1    -> PPR

  assert.equal(S.adpSourcesFor(alpha).code, 'HALF');
  assert.equal(S.adpSourcesFor(beta).code, 'PPR');
  assert.deepEqual(S.adpSourcesFor(alpha).exact, ['fp-HALF']);
  assert.deepEqual(S.adpSourcesFor(beta).exact, ['fp-PPR']);

  // The same player, two leagues, two different market expectations.
  assert.equal(S.adpFor(alpha, 'ml1'), 19);
  assert.equal(S.adpFor(beta, 'ml1'), 4);
});

test('an untagged board is used but not mistaken for a match', () => {
  // A board whose format is unknown is better than nothing and worse than a
  // match, and the difference has to be visible — the failure is silent
  // otherwise: every name resolves and every rank looks plausible.
  upsertMany('adp', ['player_id', 'season', 'source', 'adp'],
    [{ player_id: 'ml2', season: 2026, source: 'legacy', adp: 30 }],
    ['player_id', 'season', 'source']);

  const league = { ...S.getLeague('test.l.alpha'), scoring: { rec: 0 } };  // STD
  const src = S.adpSourcesFor(league);
  assert.equal(src.code, 'STD');
  assert.deepEqual(src.exact, [], 'no board was published for this format');
  assert.equal(src.fallback, 'untagged');
  assert.ok(src.order.includes('legacy'), 'it is still used rather than leaving nothing');
  // And a tagged board for the WRONG format ranks below an untagged one,
  // because a known mismatch is worse evidence than an unknown.
  assert.ok(src.order.indexOf('legacy') < src.order.indexOf('fp-PPR'));
});
