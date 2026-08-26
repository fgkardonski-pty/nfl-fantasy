/**
 * End-to-end tests against a freshly generated demo league in a throwaway
 * database. These exercise the real code path the war room uses: database ->
 * projections -> simulation -> recommendations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-test-'));
process.env.ORACLE_DB = path.join(tmpDir, 'test.db');
process.env.ORACLE_LOG_LEVEL = 'silent';

const { generateDemoLeague } = await import('../src/demo.mjs');
const S = await import('../src/service.mjs');
const { closeDb, all, get } = await import('../src/db/index.mjs');
const { eligiblePositions } = await import('../src/engine/roster.mjs');
const { computeVor } = await import('../src/engine/vor.mjs');

const SEED = 4242;
generateDemoLeague({ season: 2026, currentWeek: 9, numTeams: 12, seed: SEED });
const league = S.getLeague();

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the demo league seeds a coherent world', () => {
  assert.ok(league, 'a league exists');
  assert.equal(league.num_teams, 12);
  assert.equal(league.current_week, 9);
  assert.ok(league.isDemo);
  assert.equal(S.getTeams(league.league_key).length, 12);
  assert.ok(all('SELECT 1 FROM players').length > 400);
  assert.ok(all('SELECT 1 FROM player_stats').length > 2000);
  assert.ok(all('SELECT 1 FROM transactions').length > 50);
});

test('every non-bye player has a scheduled game', () => {
  // A bug in bye assignment previously deleted the OPPONENT's game too, giving
  // healthy players a zero projection for no visible reason.
  const orphans = get(
    `SELECT COUNT(*) c FROM players p
     WHERE p.bye_week != ?
       AND NOT EXISTS (SELECT 1 FROM games g WHERE g.season = ? AND g.week = ?
                       AND (g.home = p.nfl_team OR g.away = p.nfl_team))`,
    [league.current_week, league.season, league.current_week]
  ).c;
  assert.equal(orphans, 0);
});

test('every roster is legally constructible', () => {
  for (const t of S.getTeams(league.league_key)) {
    const roster = S.rosterOf(league.league_key, t.team_key, league.current_week);
    assert.ok(roster.length >= 14, `${t.name} has a full roster`);
    const counts = {};
    for (const p of roster) counts[p.pos] = (counts[p.pos] ?? 0) + 1;
    assert.ok(counts.QB >= 1, `${t.name} has a quarterback`);
    assert.ok((counts.RB ?? 0) >= 2, `${t.name} has enough backs`);
    assert.ok((counts.WR ?? 0) >= 3, `${t.name} has enough receivers`);
    assert.ok(counts.K >= 1 && counts.DEF >= 1, `${t.name} has a kicker and a defense`);
  }
});

test('projections are distributions with sane, ordered bounds', () => {
  const me = S.myTeam(league.league_key);
  const proj = S.project(league, S.rosterOf(league.league_key, me.team_key, league.current_week), league.current_week);
  assert.ok(proj.length > 10);
  for (const p of proj) {
    assert.ok(p.mean >= 0, `${p.name} mean is non-negative`);
    assert.ok(p.floor >= 0, `${p.name} floor is non-negative`);
    assert.ok(p.floor <= p.mean + 1e-9, `${p.name} floor <= mean`);
    assert.ok(p.mean <= p.ceiling + 1e-9, `${p.name} mean <= ceiling`);
    assert.ok(Array.isArray(p.components) && p.components.length >= 5, `${p.name} carries its explanation`);
    assert.ok(p.components.some((c) => c.kind === 'base'), 'a baseline component is present');
  }
  const onBye = proj.find((p) => p.opponent === 'BYE');
  if (onBye) assert.equal(onBye.mean, 0, 'a player on bye projects zero');
});

test('projections are deterministic for a fixed model and inputs', () => {
  const me = S.myTeam(league.league_key);
  const roster = S.rosterOf(league.league_key, me.team_key, league.current_week);
  const a = S.project(league, roster, league.current_week).map((p) => p.mean);
  const b = S.project(league, roster, league.current_week).map((p) => p.mean);
  assert.deepEqual(a, b);
});

test('the war room produces a legal, complete lineup and a win probability', () => {
  const wr = S.warRoom(league, { sims: 4000 });
  assert.ok(wr.winProbability > 0 && wr.winProbability < 1);
  assert.equal(wr.decision.recommended.lineup.length, league.slots.length);

  const ids = wr.decision.recommended.lineup.filter((l) => l.player).map((l) => l.player.player_id);
  assert.equal(new Set(ids).size, ids.length, 'no player starts twice');

  for (const s of wr.decision.recommended.lineup) {
    if (!s.player) continue;
    assert.ok(eligiblePositions(s.slot).includes(s.player.pos),
      `${s.player.name} (${s.player.pos}) is eligible for ${s.slot}`);
  }
  assert.ok(wr.decision.explanation.length > 20, 'the decision is explained in prose');
  assert.ok(['favourite', 'underdog', 'coin-flip'].includes(wr.posture.stance));
  assert.ok(wr.sim.myFloor <= wr.sim.myMean && wr.sim.myMean <= wr.sim.myCeiling);
});

test('the recommended lineup is never worse in win probability than the alternatives', () => {
  const wr = S.warRoom(league, { sims: 4000 });
  const best = wr.decision.candidates[0];
  for (const c of wr.decision.candidates) {
    assert.ok(best.winProb >= c.winProb - 1e-9, 'candidates are ranked by win probability');
  }
  assert.equal(wr.decision.recommended.id, best.id);
});

test('season outlook probabilities are coherent', () => {
  const { results } = S.seasonOutlook(league, { sims: 800 });
  assert.equal(results.length, 12);
  const totalTitle = results.reduce((a, r) => a + r.titleOdds, 0);
  const totalPlayoff = results.reduce((a, r) => a + r.playoffOdds, 0);
  assert.ok(Math.abs(totalTitle - 1) < 0.03, `championship odds sum to ~1 (got ${totalTitle})`);
  assert.ok(Math.abs(totalPlayoff - league.num_playoff_teams) < 0.1,
    `playoff odds sum to the number of spots (got ${totalPlayoff})`);
  for (const r of results) assert.ok(r.titleOdds <= r.playoffOdds + 1e-9);
});

test('the waiver board prices every target and never recommends overspending', () => {
  const w = S.waiverBoard(league, { limit: 15 });
  assert.ok(w.targets.length > 0);
  for (const t of w.targets) {
    assert.ok(t.bid.amount >= 0, `${t.name} bid is non-negative`);
    assert.ok(t.bid.amount <= w.faabRemaining, `${t.name} bid never exceeds the remaining budget`);
    assert.ok(t.titleDelta >= 0);
    assert.ok(t.verdict.text.length > 10, 'every target carries a verdict in prose');
    assert.ok(t.bid.rationale.length > 10, 'every bid is justified');
  }
  // Ranked by title impact, descending.
  const deltas = w.targets.map((t) => t.titleDelta);
  assert.deepEqual(deltas, [...deltas].sort((a, b) => b - a));
});

test('waiver targets are genuinely available, never already rostered', () => {
  const w = S.waiverBoard(league, { limit: 20 });
  const rostered = new Set(
    all('SELECT player_id FROM rosters WHERE league_key = ? AND week = ?',
      [league.league_key, league.current_week]).map((r) => r.player_id)
  );
  for (const t of w.targets) {
    assert.ok(!rostered.has(t.player_id), `${t.name} is not on anyone's roster`);
  }
});

test('the trade board only proposes players the two sides actually own', () => {
  const tb = S.tradeBoard(league, { limit: 10 });
  const me = S.myTeam(league.league_key);
  const mine = new Set(S.rosterOf(league.league_key, me.team_key, league.current_week).map((p) => p.player_id));

  for (const t of tb.trades) {
    const theirs = new Set(S.rosterOf(league.league_key, t.team_key, league.current_week).map((p) => p.player_id));
    for (const p of t.send) assert.ok(mine.has(p.player_id), `${p.name} is on my roster`);
    for (const p of t.receive) assert.ok(theirs.has(p.player_id), `${p.name} is on ${t.teamName}'s roster`);
    assert.ok(t.myGain > 0, 'every proposed trade improves my lineup');
    assert.ok(t.acceptProb >= 0 && t.acceptProb <= 1);
    assert.ok(t.pitch.length > 20, 'every trade comes with a pitch');
  }
});

test('win-win trades genuinely help both sides', () => {
  const tb = S.tradeBoard(league, { limit: 12 });
  for (const t of tb.winWin) {
    assert.ok(t.winWin === true);
    assert.ok(t.theirRealGain > 0, `${t.teamName} actually gains from a win-win trade`);
    assert.ok(t.myGain > 0);
  }
  for (const t of tb.arbitrage) {
    assert.ok(t.theirRealGain <= 0, 'arbitrage trades are labelled honestly');
  }
});

test('opponent dossiers cover every team with bounded traits', () => {
  const i = S.intel(league);
  assert.equal(i.dossiers.length, 12);
  for (const d of i.dossiers) {
    for (const k of ['aggression', 'chase', 'panic', 'engagement', 'tradeAppetite']) {
      assert.ok(d[k] >= 0 && d[k] <= 1, `${d.name}.${k} = ${d[k]} is in [0,1]`);
    }
    assert.ok(d.archetype.label, 'an archetype is assigned');
    assert.ok(d.archetype.note.length > 10, 'the archetype comes with an actionable note');
    assert.ok(d.daysSinceActive === null || d.daysSinceActive >= 0,
      'activity age is never negative');
    if (!d.is_mine) {
      assert.ok(d.claims.willAct >= 0 && d.claims.willAct <= 1);
      for (const p of d.claims.predictions) {
        assert.ok(p.probability >= 0 && p.probability <= 1);
        assert.ok(p.expectedBid == null || p.expectedBid.amount >= 0);
      }
    }
  }
});

test('predicted claims target free agents, not rostered players', () => {
  const i = S.intel(league);
  const rostered = new Set(
    all('SELECT player_id FROM rosters WHERE league_key = ? AND week = ?',
      [league.league_key, league.current_week]).map((r) => r.player_id)
  );
  for (const d of i.dossiers) {
    for (const p of d.claims?.predictions ?? []) {
      assert.ok(!rostered.has(p.player_id), `${p.name} is a free agent`);
    }
  }
});

test('the draft board ranks by value over replacement, not raw points', () => {
  const pool = all('SELECT * FROM players');
  const values = S.draftValues(league, pool);
  assert.equal(values.length, pool.length);
  for (const v of values) {
    assert.ok(v.mean >= 0);
    assert.ok(v.basis, 'every valuation states what it was derived from');
  }
  // Quarterbacks outscore backs in raw points but must not sweep the board.
  const { players } = computeVor(values, league.rosterSlots, league.num_teams);
  const top20 = players.slice(0, 20);
  const qbShare = top20.filter((p) => p.pos === 'QB').length / 20;
  assert.ok(qbShare < 0.5, `quarterbacks are ${Math.round(qbShare * 100)}% of the top 20, not a majority`);
});

test('the player board explains and values the whole universe', () => {
  const b = S.playerBoard(league, { limit: 40 });
  assert.ok(b.players.length > 0);
  for (const p of b.players) {
    assert.ok(p.tier >= 1);
    assert.ok(Number.isFinite(p.vor));
    assert.ok(p.components?.length);
  }
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    assert.ok(b.replacementLevels[pos] > 0, `${pos} has a replacement level`);
  }
});

test('player detail joins history, usage and ownership', () => {
  const someone = get('SELECT player_id FROM players WHERE pos = ? LIMIT 1', ['RB']);
  const d = S.playerDetail(league, someone.player_id);
  assert.ok(d.player);
  assert.ok(d.projection);
  assert.ok(Array.isArray(d.history));
  assert.ok(Array.isArray(d.usage));
});

test('health reporting works without a Yahoo connection', () => {
  const h = S.healthReport();
  assert.ok(h.league);
  assert.equal(h.yahoo.connected, false);
  assert.ok(h.counts.players > 0);
  assert.ok(h.model);
});
