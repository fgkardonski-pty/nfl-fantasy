/**
 * FantasyPros response handling.
 *
 * This client was written without live access to the API, so the parsing is
 * deliberately shape-tolerant and these tests pin that tolerance. The failure
 * mode being guarded against is a rankings import that silently returns nothing
 * and leaves the draft board priced as if every player were identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlayers, scoringCodeFor, ATTRIBUTION } from '../src/providers/fantasypros.mjs';

test('parses a FantasyPros-style envelope with its own field names', () => {
  const out = extractPlayers({
    players: [
      { player_name: "Ja'Marr Chase", player_position_id: 'WR', player_team_id: 'CIN', rank_ecr: 1, tier: 1 },
      { player_name: 'Bijan Robinson', player_position_id: 'RB', player_team_id: 'ATL', rank_ecr: 2, tier: 1 },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Ja'Marr Chase");
  assert.equal(out[0].pos, 'WR');
  assert.equal(out[0].rank, 1);
});

test('finds the player array however deeply it is wrapped', () => {
  const out = extractPlayers({
    status: 'ok',
    data: { rankings: [
      { name: 'Justin Jefferson', position: 'WR', team: 'MIN', rank: 1 },
      { name: 'Saquon Barkley', position: 'RB', team: 'PHI', rank: 2 },
    ] },
  });
  assert.equal(out.length, 2);
  assert.equal(out[1].name, 'Saquon Barkley');
});

test('accepts a bare array and carries ADP through when present', () => {
  const out = extractPlayers([
    { full_name: 'CeeDee Lamb', pos: 'WR', team: 'DAL', adp: 3.4 },
    { full_name: 'Jahmyr Gibbs', pos: 'RB', team: 'DET', adp: 4.1 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].adp, 3.4);
});

test('team defenses normalise to the position code the rest of the engine uses', () => {
  const out = extractPlayers({ players: [
    { name: 'Ravens', position: 'DST', team: 'BAL' },
    { name: 'Broncos', position: 'D/ST', team: 'DEN' },
  ] });
  assert.deepEqual(out.map((p) => p.pos), ['DEF', 'DEF']);
});

test('ordering is preserved as rank when the API supplies none', () => {
  const out = extractPlayers({ players: [
    { name: 'First Player', position: 'WR' },
    { name: 'Second Player', position: 'RB' },
  ] });
  assert.deepEqual(out.map((p) => p.rank), [1, 2]);
});

test('strips numeric suffixes from positional codes', () => {
  const out = extractPlayers({ players: [{ name: 'Some Guy', position: 'WR2' }] });
  assert.equal(out[0].pos, 'WR');
});

test('junk and error envelopes yield nothing rather than throwing', () => {
  assert.deepEqual(extractPlayers({}), []);
  assert.deepEqual(extractPlayers({ error: 'invalid key' }), []);
  assert.deepEqual(extractPlayers(null), []);
  assert.deepEqual(extractPlayers(undefined), []);
  assert.deepEqual(extractPlayers('a string'), []);
  assert.deepEqual(extractPlayers({ players: [] }), []);
});

test('entries without a name are dropped rather than imported blank', () => {
  const out = extractPlayers({ players: [
    { name: 'Real Player', position: 'WR' },
    { position: 'RB', team: 'ATL' },
    { name: '   ', position: 'TE' },
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Real Player');
});

test('scoring code follows the league reception value', () => {
  assert.equal(scoringCodeFor({ rec: 1 }), 'PPR');
  assert.equal(scoringCodeFor({ rec: 0.5 }), 'HALF');
  assert.equal(scoringCodeFor({ rec: 0 }), 'STD');
  assert.equal(scoringCodeFor({}), 'STD', 'no reception rule means standard');
  assert.equal(scoringCodeFor(null), 'STD');
});

test('attribution string is available for the UI to display', () => {
  // FantasyPros ask to be credited where their data is used.
  assert.match(ATTRIBUTION, /FantasyPros/);
});

test('the request path matches the published spec exactly', async () => {
  // Regression, asserted without network I/O. The canonical base URL was
  // duplicated in config.mjs, and the stale copy there shadowed the correct one
  // in the provider — dropping the /json path segment. Every request then hit a
  // non-existent route and returned 403 "Missing Authentication Token", which
  // reads like an auth failure and sent the diagnosis in the wrong direction
  // entirely.
  const { buildRequestUrl } = await import('../src/providers/fantasypros.mjs');
  const url = buildRequestUrl('/nfl/2025/consensus-rankings', {
    position: 'ALL', type: 'DRAFT', scoring: 'HALF', week: 0,
  });

  assert.equal(url.origin + url.pathname,
    'https://api.fantasypros.com/public/v2/json/nfl/2025/consensus-rankings',
    'the /json segment from the spec must be present');
  // These enum values are case-sensitive; lowercase fails request validation.
  assert.equal(url.searchParams.get('type'), 'DRAFT');
  assert.equal(url.searchParams.get('scoring'), 'HALF');
  assert.equal(url.searchParams.get('position'), 'ALL', 'position is required by the spec');
});

test('empty and null query parameters are omitted rather than sent blank', async () => {
  const { buildRequestUrl } = await import('../src/providers/fantasypros.mjs');
  const url = buildRequestUrl('/nfl/2025/projections', { position: 'ALL', week: null });
  assert.ok(!url.searchParams.has('week'), 'a null week is left out, not sent as week=');
  assert.equal(url.searchParams.get('position'), 'ALL');
});

// ---------------------------------------------------------------------------
// Positional sweep and merge
// ---------------------------------------------------------------------------

/**
 * The overall (position=ALL) consensus board is not guaranteed to run as deep
 * as a 16-team draft, which is 256 picks. The client therefore also pulls each
 * position's own list and merges what the overall board omitted. These tests
 * pin the two properties that matter: nobody already ranked gets their real
 * overall rank overwritten by an estimate, and the players who arrive only
 * through a positional list still come out in a sane draft order.
 */
test('the positional sweep never overwrites a real overall rank', async () => {
  const { mergePositionalList, nameKey } = await import('../src/providers/fantasypros.mjs');
  const merged = new Map();
  for (const p of [
    { name: 'Bijan Robinson', pos: 'RB', rank: 1 },
    { name: 'Jahmyr Gibbs', pos: 'RB', rank: 3 },
  ]) merged.set(nameKey(p), { ...p, estimatedRank: false });

  mergePositionalList(merged, [
    { name: 'Bijan Robinson', pos: 'RB', rank: 1 },
    { name: 'Jahmyr Gibbs', pos: 'RB', rank: 2 },
    { name: 'Deep Sleeper Back', pos: 'RB', rank: 3 },
  ]);

  assert.equal(merged.get(nameKey({ name: 'Jahmyr Gibbs', pos: 'RB' })).rank, 3,
    'his real overall rank must survive the merge, not become his positional rank of 2');
  assert.equal(merged.size, 3, 'the back the overall board omitted is added');
});

test('players below the overall board are ordered behind it, not ahead of it', async () => {
  const { mergePositionalList, nameKey } = await import('../src/providers/fantasypros.mjs');
  const merged = new Map();
  // A shallow overall board: three backs, thinning out as it goes.
  for (const p of [
    { name: 'Back One', pos: 'RB', rank: 2 },
    { name: 'Back Two', pos: 'RB', rank: 14 },
    { name: 'Back Three', pos: 'RB', rank: 30 },
  ]) merged.set(nameKey(p), { ...p, estimatedRank: false });

  mergePositionalList(merged, [
    { name: 'Back One', pos: 'RB', rank: 1 },
    { name: 'Back Two', pos: 'RB', rank: 2 },
    { name: 'Back Three', pos: 'RB', rank: 3 },
    { name: 'Back Four', pos: 'RB', rank: 4 },
    { name: 'Back Five', pos: 'RB', rank: 5 },
  ]);

  const four = merged.get(nameKey({ name: 'Back Four', pos: 'RB' }));
  const five = merged.get(nameKey({ name: 'Back Five', pos: 'RB' }));
  assert.ok(four.estimatedRank, 'a rank the overall board never gave is flagged as estimated');
  assert.ok(four.rank > 30, `must sit behind the deepest real rank, got ${four.rank}`);
  assert.ok(five.rank > four.rank, 'positional order is preserved down the tail');
  // Slope from the two deepest anchors: (30-14)/(3-2) = 16 picks per back.
  assert.equal(four.rank, 46);
});

test('a positional list adds players even when none of it overlaps the board', async () => {
  const { mergePositionalList, nameKey } = await import('../src/providers/fantasypros.mjs');
  // Kickers routinely miss the overall board entirely; they must still land in
  // the pool, or they cannot be drafted at all.
  const merged = new Map();
  mergePositionalList(merged, [
    { name: 'Some Kicker', pos: 'K', rank: 1 },
    { name: 'Other Kicker', pos: 'K', rank: 2 },
  ]);
  assert.equal(merged.size, 2);
  assert.equal(merged.get(nameKey({ name: 'Some Kicker', pos: 'K' })).rank, null,
    'with no anchor there is nothing honest to extrapolate from');
});

test('the same player from two lists is merged once, not duplicated', async () => {
  const { nameKey } = await import('../src/providers/fantasypros.mjs');
  assert.equal(nameKey({ name: "Ja'Marr Chase", pos: 'WR' }), nameKey({ name: 'JaMarr Chase', pos: 'WR' }),
    'punctuation differences between endpoints must not split one player in two');
  assert.notEqual(nameKey({ name: 'Josh Allen', pos: 'QB' }), nameKey({ name: 'Josh Allen', pos: 'LB' }),
    'two real players share this name at different positions');
});
