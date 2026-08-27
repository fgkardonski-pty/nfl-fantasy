/**
 * FantasyPros CSV export parsing.
 *
 * This is the primary rankings path: the public API caps every response at ten
 * players with no working paging parameter, while the export carries the whole
 * five-hundred-player board. The failure mode guarded against here is a board
 * that looks complete and is not — a draft run off a partial or mis-parsed
 * export is worse than no board at all, because it looks authoritative.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvLine, parsePosition, parseRankingsCsv } from '../src/providers/fpcsv.mjs';

// Taken verbatim from a real export, including its inconsistent quoting, the
// stray space in "UPSIDE ", and a tier-separator row with no player on it.
const HEADER = '"RK",TIERS,"PLAYER NAME",TEAM,"POS","BYE WEEK","UPSIDE ","BUST ","SOS SEASON","ECR VS. ADP"';
const SAMPLE = [
  HEADER,
  '"1",1,"Jahmyr Gibbs",DET,"RB1","6","5 out of 5","1 out of 5","5 out of 5 stars","0"',
  '"2",1,"Ja\'Marr Chase",CIN,"WR1","6","5 out of 5","1 out of 5","4 out of 5 stars","+1"',
  '"",4',
  '"183",10,"Brandon Aubrey",DAL,"K1","14","4 out of 5","1 out of 5","2 out of 5 stars","-59"',
  '"154",9,"Houston Texans",HOU,"DST1","8","-","-","2 out of 5 stars","-21"',
  '"315",13,"Tyreek Hill",FA,"WR110","-","1 out of 5","5 out of 5","-","-119"',
  '"516",16,"Luke Schoonmaker",DAL,"TE79","14","-","-","2 out of 5 stars","-"',
].join('\n');

test('splits quoted and bare fields on the same line', () => {
  // The export quotes some columns and not others; a naive comma split breaks.
  assert.deepEqual(parseCsvLine('"1",1,"Jahmyr Gibbs",DET,"RB1"'),
    ['1', '1', 'Jahmyr Gibbs', 'DET', 'RB1']);
});

test('a comma inside a quoted field does not end the field', () => {
  assert.deepEqual(parseCsvLine('"1","Smith, Jr.",DAL'), ['1', 'Smith, Jr.', 'DAL']);
});

test('doubled quotes are one literal quote', () => {
  assert.deepEqual(parseCsvLine('"He said ""hi""",X'), ['He said "hi"', 'X']);
});

test('position splits into code and positional rank', () => {
  assert.deepEqual(parsePosition('RB1'), { pos: 'RB', posRank: 1 });
  assert.deepEqual(parsePosition('WR100'), { pos: 'WR', posRank: 100 });
  assert.deepEqual(parsePosition('QB12'), { pos: 'QB', posRank: 12 });
});

test('DST becomes the position code the rest of the engine uses', () => {
  // Storing FantasyPros' DST verbatim would leave every defense unmatched and
  // undraftable, which is silent and total.
  assert.equal(parsePosition('DST1').pos, 'DEF');
  assert.equal(parsePosition('D/ST3').pos, 'DEF');
  assert.equal(parsePosition('DST1').posRank, 1);
});

test('tier-separator rows are skipped, not imported as players', () => {
  const { rows, skipped } = parseRankingsCsv(SAMPLE);
  assert.equal(skipped, 1, 'the `"",4` row carries a tier and no player');
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.name && Number.isFinite(r.rank)));
});

test('every player carries a position and a positional rank', () => {
  // Positional rank is the input the archetype valuation actually consumes; a
  // player missing it gets priced as roster filler regardless of how good he is.
  const { rows } = parseRankingsCsv(SAMPLE);
  assert.ok(rows.every((r) => r.pos), 'no player may be left without a position');
  assert.ok(rows.every((r) => r.posRank != null), 'no player may be left without a positional rank');
});

test('ADP is reconstructed from the consensus rank and the published gap', () => {
  const { rows } = parseRankingsCsv(SAMPLE);
  const aubrey = rows.find((r) => r.name === 'Brandon Aubrey');
  // A kicker ranked 183rd who goes at 124 is the single clearest case for
  // keeping rank and ADP apart: he is not a better kicker for going early.
  assert.equal(aubrey.rank, 183);
  assert.equal(aubrey.adp, 124, '183 + (-59)');
  assert.equal(aubrey.posRank, 1, 'still only the first kicker');

  const chase = rows.find((r) => r.name.includes('Chase'));
  assert.equal(chase.adp, 3, 'a positive gap means he goes LATER than his rank');
});

test('ADP falls back to the consensus rank when no gap is published', () => {
  const { rows } = parseRankingsCsv(SAMPLE);
  const deep = rows.find((r) => r.name === 'Luke Schoonmaker');
  assert.equal(deep.adp, 516);
  assert.equal(deep.adpIsEstimate, true, 'flagged so it is never mistaken for a real ADP');
});

test('reconstructed ADP never lands before the first pick', () => {
  // A large negative gap on a highly ranked player could otherwise produce a
  // zero or negative ADP, which would sort ahead of the first overall pick.
  const { rows } = parseRankingsCsv([
    HEADER,
    '"3",1,"Someone Overdrafted",DAL,"RB1","6","-","-","-","-40"',
  ].join('\n'));
  assert.equal(rows[0].adp, 1);
});

test('missing values read as absent rather than as the string "-"', () => {
  const { rows } = parseRankingsCsv(SAMPLE);
  const hill = rows.find((r) => r.name === 'Tyreek Hill');
  assert.equal(hill.bye, null, 'a free agent has no bye week');
  assert.equal(hill.team, 'FA');
});

test('team defenses keep their full name for matching', () => {
  const { rows } = parseRankingsCsv(SAMPLE);
  const hou = rows.find((r) => r.pos === 'DEF');
  assert.equal(hou.name, 'Houston Texans');
  assert.equal(hou.posRank, 1);
  assert.equal(hou.bye, 8);
});

test('a file that is not a rankings export is rejected with a readable reason', () => {
  assert.throws(
    () => parseRankingsCsv('name,score\nfoo,1'),
    /does not look like a FantasyPros rankings export/,
  );
});

test('an empty file yields nothing rather than throwing', () => {
  assert.deepEqual(parseRankingsCsv(''), { rows: [], skipped: 0 });
  assert.deepEqual(parseRankingsCsv(null), { rows: [], skipped: 0 });
});

test('carriage returns from a Windows download do not corrupt the last column', () => {
  // The export is downloaded on Windows; CRLF left unhandled would make every
  // ECR-vs-ADP value unparseable and silently blank every reconstructed ADP.
  const { rows } = parseRankingsCsv(SAMPLE.split('\n').join('\r\n'));
  assert.equal(rows.find((r) => r.name === 'Brandon Aubrey').adp, 124);
});
