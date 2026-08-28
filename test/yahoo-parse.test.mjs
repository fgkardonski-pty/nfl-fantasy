/**
 * Yahoo's JSON is the single most error-prone surface in this platform.
 * These tests run against fixtures reproducing the documented response shapes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  root, extractList, normalise, isIndexedCollection, collectionToArray,
  mergeFragments, num, str, normalisePosition, normaliseStatus,
} from '../src/providers/yahoo/parse.mjs';
import * as F from './fixtures/yahoo.mjs';

test('isIndexedCollection recognises Yahoo pseudo-arrays', () => {
  assert.ok(isIndexedCollection({ 0: { a: 1 }, 1: { a: 2 }, count: 2 }));
  assert.ok(isIndexedCollection({ 0: { a: 1 } }));
  assert.ok(!isIndexedCollection({ a: 1, b: 2 }));
  assert.ok(!isIndexedCollection([1, 2]));
  assert.ok(!isIndexedCollection(null));
  assert.ok(!isIndexedCollection({}));
});

test('collectionToArray preserves numeric order and drops count', () => {
  const out = collectionToArray({ 2: 'c', 0: 'a', 1: 'b', count: 3 });
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('mergeFragments flattens an entity spread across an array', () => {
  const merged = mergeFragments([
    { team_key: 'k' }, { name: 'Team' }, [{ nested: 1 }, { deeper: 2 }], { count: 9 },
  ]);
    assert.deepEqual(merged, { team_key: 'k', name: 'Team', nested: 1, deeper: 2 });
  assert.ok(!('count' in merged), 'count is metadata, not a field');
});

test('mergeFragments does not let an empty fragment clobber a populated one', () => {
  const merged = mergeFragments([{ name: 'Real Name' }, { name: '' }]);
  assert.equal(merged.name, 'Real Name');
});

test('leagues are extracted from deeply nested user/game/league wrapping', () => {
  const leagues = extractList(root(F.LEAGUES_RESPONSE), 'league');
  assert.equal(leagues.length, 2);
  assert.equal(leagues[0].league_key, '449.l.123456');
  assert.equal(leagues[0].name, 'The Championship Belt');
  assert.equal(leagues[1].league_key, '449.l.999999');
});

test('teams are extracted with standings and ownership merged in', () => {
  const teams = extractList(root(F.TEAMS_RESPONSE), 'team');
  assert.equal(teams.length, 2);
  const mine = teams.find((t) => t.is_owned_by_current_login);
  assert.equal(mine.name, 'Gridiron Oracle');
  assert.equal(mine.faab_balance, '67');
  assert.equal(mine.team_standings.outcome_totals.wins, '5');
  assert.equal(mine.team_standings.points_for, '1129.4');
  const rival = teams.find((t) => t.team_key.endsWith('.t.2'));
  assert.equal(rival.faab_balance, '0');
});

test('roster players carry position, bye, status and selected slot', () => {
  const players = extractList(root(F.ROSTER_RESPONSE), 'player');
  assert.equal(players.length, 2);
  const qb = players.find((p) => p.player_id === '30977');
  assert.equal(qb.name.full, 'Marcus Whitfield');
  assert.equal(qb.display_position, 'QB');
  assert.equal(qb.editorial_team_abbr, 'KC');
  assert.equal(qb.bye_weeks.week, '10');
  assert.equal(qb.status, 'Q');
  assert.equal(qb.selected_position.position, 'QB');
  const rb = players.find((p) => p.player_id === '31002');
  assert.equal(rb.selected_position.position, 'BN', 'a benched player is identified as benched');
});

test('transactions parse with faab bid and per-player movement', () => {
  const r = root(F.TRANSACTIONS_RESPONSE);
  const txns = extractList(r, 'transaction');
  assert.equal(txns.length, 1);
  assert.equal(txns[0].type, 'add/drop');
  assert.equal(txns[0].faab_bid, '17');

  const players = extractList(r, 'player');
  assert.equal(players.length, 2);
  // transaction_data arrives as an ARRAY for one player and an OBJECT for the
  // other in the same response — both must parse.
  const add = players.find((p) => p.player_id === '32001');
  const drop = players.find((p) => p.player_id === '31500');
  const td = (p) => (Array.isArray(p.transaction_data)
    ? Object.assign({}, ...p.transaction_data.filter((x) => x && typeof x === 'object'))
    : p.transaction_data);
  assert.equal(td(add).type, 'add');
  assert.equal(td(add).source_type, 'waivers');
  assert.equal(td(drop).type, 'drop');
  assert.equal(td(drop).destination_type, 'waivers');
});

test('scoreboard yields matchup teams in pair order with points', () => {
  const r = root(F.SCOREBOARD_RESPONSE);
  const matchups = extractList(r, 'matchup');
  assert.equal(matchups[0].week, '9');
  const teams = extractList(r, 'team');
  assert.equal(teams.length, 2);
  assert.equal(teams[0].team_points.total, '88.4');
  assert.equal(teams[1].team_projected_points.total, '104.9');
});

test('roster positions and stat modifiers extract from settings', () => {
  const r = root(F.SETTINGS_RESPONSE);
  const slots = extractList(r, 'roster_position');
  assert.equal(slots.length, 8);
  const flex = slots.find((s) => s.position === 'W/R/T');
  assert.equal(flex.count, 1);
  const bench = slots.find((s) => s.position === 'BN');
  assert.equal(bench.count, 6);
  assert.equal(extractList(r, 'stat').length, 9);
});

test('extractList returns an empty array rather than throwing on junk', () => {
  assert.deepEqual(extractList(null, 'team'), []);
  assert.deepEqual(extractList({}, 'team'), []);
  assert.deepEqual(extractList({ unrelated: { nested: true } }, 'team'), []);
});

test('normalise is idempotent on already-clean data', () => {
  const clean = { a: 1, b: [1, 2, 3], c: { d: 'x' } };
  assert.deepEqual(normalise(normalise(clean)), normalise(clean));
});

test('coercion helpers', () => {
  assert.equal(num('12.5'), 12.5);
  assert.equal(num(''), null);
  assert.equal(num(undefined, 7), 7);
  assert.equal(num('not a number', 3), 3);
  assert.equal(str(5), '5');
  assert.equal(str(null, 'fallback'), 'fallback');
});

test('position and status normalisation', () => {
  assert.equal(normalisePosition('DST'), 'DEF');
  assert.equal(normalisePosition('D/ST'), 'DEF');
  assert.equal(normalisePosition('wr'), 'WR');
  assert.equal(normaliseStatus('Questionable'), 'Q');
  assert.equal(normaliseStatus('OUT'), 'O');
  assert.equal(normaliseStatus('IR-R'), 'IR');
  assert.equal(normaliseStatus(''), '');
  assert.equal(normaliseStatus(null), '');
});

test('Yahoo position fields resolve to a single position plus an eligibility list', async () => {
  // Exercises the real sync path: primary_position wins for `pos`, and
  // eligible_positions is preserved so the optimizer can use it.
  const { ROSTER_RESPONSE } = F;
  const players = extractList(root(ROSTER_RESPONSE), 'player');
  const rb = players.find((p) => p.player_id === '31002');
  assert.equal(rb.primary_position, 'RB');
  assert.ok(Array.isArray(rb.eligible_positions), 'the eligibility list survives normalisation');
  const codes = rb.eligible_positions.map((e) => e.position ?? e);
  assert.deepEqual(codes, ['RB', 'W/R/T'], 'flex eligibility is carried through');
});

// ---------------------------------------------------------------------------
// The manual connection fallback.
//
// Yahoo may refuse to redirect to a plain-HTTP localhost callback. When that
// happens the browser still lands on a URL carrying the authorisation code, so
// accepting a pasted address bar is what keeps that restriction from stranding
// someone mid-setup.
// ---------------------------------------------------------------------------

test('parseCallbackInput accepts every form an operator might paste', async () => {
  const { parseCallbackInput } = await import('../src/providers/yahoo/oauth.mjs');
  const got = (input) => {
    const r = parseCallbackInput(input);
    return { code: r.code, state: r.state };
  };

  assert.deepEqual(
    got('http://localhost:4317/auth/yahoo/callback?code=abc123&state=xyz789'),
    { code: 'abc123', state: 'xyz789' }, 'a full redirect URL');

  assert.deepEqual(
    got('https://example.com/cb?state=xyz789&code=abc123'),
    { code: 'abc123', state: 'xyz789' }, 'parameter order does not matter');

  assert.deepEqual(got('?code=abc123&state=xyz789'),
    { code: 'abc123', state: 'xyz789' }, 'a bare query string');

  assert.deepEqual(got('  abc123  '),
    { code: 'abc123', state: null }, 'a bare code, whitespace trimmed');

  assert.deepEqual(got(''), { code: null, state: null });
  assert.deepEqual(got(null), { code: null, state: null });
  assert.deepEqual(got(undefined), { code: null, state: null });
});

/**
 * A REFUSAL arrives in the same redirect as a success would, as an error
 * parameter instead of a code. Reading only the code made a refusal look
 * identical to a typo: the operator was told no code was found, which is true
 * and useless, when the URL in front of them said exactly what went wrong.
 */
test('a refusal in the redirect is read, not mistaken for a missing code', async () => {
  const { parseCallbackInput } = await import('../src/providers/yahoo/oauth.mjs');
  const r = parseCallbackInput(
    'https://example.com/cb?error=invalid_scope&error_description=Invalid%20scope&state=xyz');
  assert.equal(r.code, null);
  assert.equal(r.error, 'invalid_scope');
  assert.equal(r.errorDescription, 'Invalid scope');
  assert.equal(r.state, 'xyz');
});

test('a Yahoo error slug is explained in terms of what to do about it', async () => {
  const { explainOAuthError } = await import('../src/providers/yahoo/oauth.mjs');

  // The one that actually blocked setup. It must say plainly that no local
  // change fixes it, or the next hour goes into re-checking credentials.
  const scope = explainOAuthError('invalid_scope');
  assert.match(scope, /not approved/i);
  assert.match(scope, /one to two weeks|1 to 2 weeks/i);
  assert.match(scope, /not a\s*\n?\s*problem with this software|nothing you change/i);

  assert.match(explainOAuthError('invalid_client'), /CLIENT_ID|client id/i);
  assert.match(explainOAuthError('redirect_uri_mismatch'), /redirect/i);
  assert.match(explainOAuthError('access_denied'), /declined/i);
  assert.match(explainOAuthError('invalid_grant'), /expired|single-use/i);

  // An unknown slug still names itself rather than vanishing.
  assert.match(explainOAuthError('something_new'), /something_new/);
  // And any description Yahoo supplied is carried through verbatim.
  assert.match(explainOAuthError('invalid_scope', 'scope not permitted'), /scope not permitted/);
});

test('exchangeCode refuses an unknown state rather than guessing', async () => {
  const { exchangeCode } = await import('../src/providers/yahoo/oauth.mjs');
  await assert.rejects(
    () => exchangeCode('somecode', 'a-state-nobody-issued'),
    /does not match any connection|No Yahoo connection/,
    'a forged or stale state is rejected with an actionable message'
  );
});

test('exchangeCode explains itself when nothing is in flight', async () => {
  const { exchangeCode } = await import('../src/providers/yahoo/oauth.mjs');
  await assert.rejects(
    () => exchangeCode('somecode'),
    /No Yahoo connection is in progress/,
    'pasting a code with no pending authorisation says exactly that'
  );
});
