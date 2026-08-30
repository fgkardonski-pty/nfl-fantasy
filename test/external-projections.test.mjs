/**
 * Projections published by an outside source.
 *
 * Two distinctions this file exists to hold. A projection is not a played game,
 * so it never reaches player_stats — written there it becomes a fact the
 * baseline believes was observed, and everything downstream inherits it. And a
 * projection is an AVERAGE, so it has to be scored as an expectation: threshold
 * bonuses weighted by the chance of clearing them, points allowed converted
 * through a distribution into this league's tiers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-extproj-'));
process.env.ORACLE_DB = path.join(tmpDir, 'test.db');
process.env.ORACLE_LOG_LEVEL = 'silent';

const { upsertMany, all, get, closeDb } = await import('../src/db/index.mjs');
const { projectPlayer } = await import('../src/engine/projections.mjs');
const LEAGUE = JSON.parse(fs.readFileSync('fantazy-fulzbol.json', 'utf8')).scoring;

test.after(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const putProjection = (playerId, week, stats) => upsertMany('external_projections',
  ['source', 'player_id', 'season', 'week', 'stats', 'fetched_at'],
  [{ source: 'sleeper', player_id: playerId, season: 2030, week, stats: JSON.stringify(stats), fetched_at: Date.now() }],
  ['source', 'player_id', 'season', 'week']);

test('a published projection is preferred over the positional archetype', () => {
  upsertMany('players', ['player_id', 'name', 'pos'], [
    { player_id: 'e1', name: 'Projected Passer', pos: 'QB' },
  ], ['player_id']);

  const ctx = { season: 2030, week: 1, scoring: LEAGUE };
  const before = projectPlayer({ player_id: 'e1', pos: 'QB', nfl_team: 'ZZZ', status: '', bye_week: null }, ctx);

  putProjection('e1', 1, { pass_cmp: 24, pass_yd: 280, pass_td: 2, pass_first_down: 13, rush_yd: 20 });
  const after = projectPlayer({ player_id: 'e1', pos: 'QB', nfl_team: 'ZZZ', status: '', bye_week: null }, ctx);

  assert.notEqual(after.mean, before.mean, 'the projection changes the answer');
  assert.ok(after.components.some((c) => String(c.note ?? '').includes('sleeper')),
    'and the projection says where the number came from');
});

test('a projected defense keeps its points-allowed value', () => {
  // The defect in its third disguise. scoreStatLine has no rate to multiply
  // def_pts_allowed by, so scoring a projected defense with it would drop the
  // entire points-allowed category — worth 16 points for a shutout in this
  // league. A projection is an average, so the tier must be integrated over a
  // distribution rather than looked up.
  upsertMany('players', ['player_id', 'name', 'pos'], [
    { player_id: 'e2', name: 'Projected Defense', pos: 'DEF' },
  ], ['player_id']);

  putProjection('e2', 1, { def_sack: 3, def_int: 1, def_tfl: 6, def_pts_allowed: 16 });
  const p = projectPlayer({ player_id: 'e2', pos: 'DEF', nfl_team: 'ZZZ', status: '', bye_week: null },
    { season: 2030, week: 1, scoring: LEAGUE });

  // Sacks, takeaways and tackles for loss alone are 6 + 2 + 6 = 14.
  assert.ok(p.mean > 14, `projected defense scored ${p.mean.toFixed(1)}, so points allowed was dropped`);
});

test('a projection for a different week is not borrowed', () => {
  upsertMany('players', ['player_id', 'name', 'pos'], [
    { player_id: 'e3', name: 'Week Three Only', pos: 'RB' },
  ], ['player_id']);
  putProjection('e3', 3, { rush_att: 20, rush_yd: 100, rush_td: 1 });

  const wk1 = projectPlayer({ player_id: 'e3', pos: 'RB', nfl_team: 'ZZZ', status: '', bye_week: null },
    { season: 2030, week: 1, scoring: LEAGUE });
  assert.ok(!wk1.components.some((c) => String(c.note ?? '').includes('sleeper')),
    'week 1 does not use a week 3 projection');
});

test('importing projections never writes to player_stats', async () => {
  // The category error this table exists to prevent: a forecast stored as a
  // result becomes a game the baseline believes was played.
  const { mapSleeperStats } = await import('../src/providers/sleeper.mjs');
  const mapped = mapSleeperStats({ rush_att: 18, rush_yd: 82, rush_td: 1 }, 'RB');
  assert.ok(Object.keys(mapped).length, 'the fixture maps to something');

  const statsBefore = all('SELECT * FROM player_stats').length;
  putProjection('e3', 5, mapped);
  assert.equal(all('SELECT * FROM player_stats').length, statsBefore,
    'no row appeared in the played-games table');
  assert.ok(get('SELECT 1 FROM external_projections WHERE player_id = ? AND week = 5', ['e3']));
});

test('two sources can disagree without overwriting each other', () => {
  upsertMany('external_projections',
    ['source', 'player_id', 'season', 'week', 'stats', 'fetched_at'],
    [{ source: 'other', player_id: 'e3', season: 2030, week: 3, stats: '{"rush_yd":40}', fetched_at: 1 }],
    ['source', 'player_id', 'season', 'week']);
  const rows = all('SELECT source FROM external_projections WHERE player_id = ? AND week = 3', ['e3']);
  assert.equal(rows.length, 2, 'source is part of the key');
});
