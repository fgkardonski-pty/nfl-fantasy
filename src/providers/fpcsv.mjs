/**
 * FantasyPros draft-rankings CSV.
 *
 * WHY THIS EXISTS. The public API answers with a `count` in the hundreds and a
 * `players` array of exactly ten, on every endpoint, and no documented or
 * conventional paging parameter changes that. The CSV export from the site
 * carries the whole board — five hundred players rather than ten — so for
 * drafting purposes it is not a fallback, it is the better source.
 *
 * It also carries more per player than the API does:
 *
 *   RK             overall expert consensus rank (ECR)
 *   TIERS          FantasyPros' own tier breaks
 *   POS            position WITH its positional rank, e.g. RB7, WR12, DST1
 *   BYE WEEK       needed to avoid stacking a roster's byes
 *   ECR VS. ADP    how far the market is off the consensus
 *
 * The positional rank matters most. Every valuation in this platform prices a
 * player by turning "he is the RB7" into an archetype stat line and running it
 * through the league's own scoring rules. Reading that rank directly is both
 * more accurate and more honest than re-deriving it by sorting ADP.
 *
 * TERMS. FantasyPros issue this export for personal, non-commercial use, same
 * as the API key. Nothing here is redistributed.
 */
import { logger } from '../util/log.mjs';

const log = logger('fp-csv');

export const ATTRIBUTION = 'Rankings: FantasyPros.com';

/**
 * Split one CSV line into fields, honouring quotes and doubled quotes.
 *
 * Hand-rolled because the export mixes quoted and bare fields on the same line
 * ("RK",TIERS,"PLAYER NAME",TEAM,...) and a naive split on commas would break
 * on any team or player name containing one.
 */
export function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** FantasyPros writes "-" for a value it does not have. */
const cell = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || s === '-' ? null : s;
};

const number = (v) => {
  const s = cell(v);
  if (s == null) return null;
  // Handles "+12", "-6", "0" and plain "183".
  const n = Number(s.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Split "RB7" into its position and positional rank.
 *
 * DST is FantasyPros' code for a team defense; the rest of the engine calls it
 * DEF, and mixing the two would leave every defense unmatched and undraftable.
 */
export function parsePosition(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  const m = s.match(/^([A-Z/]+?)(\d+)?$/);
  if (!m) return { pos: null, posRank: null };
  let pos = m[1];
  if (pos === 'DST' || pos === 'D/ST') pos = 'DEF';
  return { pos, posRank: m[2] ? Number(m[2]) : null };
}

/**
 * Parse the whole export.
 *
 * Header names are matched case-insensitively by keyword rather than by exact
 * string or column index, because the export's headings carry stray spaces
 * ("UPSIDE ") and the column set differs between the scoring variants.
 */
export function parseRankingsCsv(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { rows: [], skipped: 0 };

  const header = parseCsvLine(lines[0]).map((h) => h.toUpperCase().replace(/[^A-Z]/g, ''));
  const col = (...keywords) => header.findIndex((h) => keywords.some((k) => h === k));

  const iRank = col('RK', 'RANK');
  const iTier = col('TIERS', 'TIER');
  const iName = col('PLAYERNAME', 'PLAYER', 'NAME');
  const iTeam = col('TEAM');
  const iPos = col('POS', 'POSITION');
  const iBye = col('BYEWEEK', 'BYE');
  const iVsAdp = col('ECRVSADP', 'VSADP');

  if (iName < 0 || iRank < 0) {
    throw new Error(
      'This does not look like a FantasyPros rankings export — no RK and PLAYER NAME columns found.\n' +
      `  Header read as: ${header.join(', ')}`
    );
  }

  const rows = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const rank = number(f[iRank]);
    const name = cell(f[iName]);
    // The export contains tier-separator rows with an empty rank and nothing
    // else. They are structure, not players.
    if (rank == null || !name) { skipped++; continue; }

    const { pos, posRank } = parsePosition(iPos >= 0 ? f[iPos] : null);
    const vsAdp = iVsAdp >= 0 ? number(f[iVsAdp]) : null;

    rows.push({
      rank,
      name,
      pos,
      posRank,
      tier: iTier >= 0 ? number(f[iTier]) : null,
      team: iTeam >= 0 ? cell(f[iTeam]) : null,
      bye: iBye >= 0 ? number(f[iBye]) : null,
      vsAdp,
      // FantasyPros publish the gap between consensus rank and market ADP, not
      // the ADP itself. A positive gap means the player goes LATER than the
      // consensus rates him. Reconstructing ADP is what lets the draft board
      // model when a player will actually leave the pool, which is a different
      // question from how good he is.
      adp: vsAdp != null ? Math.max(1, rank + vsAdp) : rank,
      adpIsEstimate: vsAdp == null,
    });
  }

  log.info(`parsed ${rows.length} players from CSV (${skipped} non-player rows skipped)`);
  return { rows, skipped };
}
