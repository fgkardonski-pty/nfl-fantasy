/**
 * Update a hand-entered league from screenshots of the league platform.
 *
 * Three steps, and the middle one is the point. Claude reads the images into
 * structured data (extract); the app resolves every name against its own player
 * table and the league file, and turns the result into a list of proposed
 * changes (propose); only the changes the manager ticks are written (apply).
 * A misread name written straight into a roster would quietly corrupt every
 * recommendation built on it, so nothing reaches the league file unreviewed.
 *
 * Until the platform's API is available, this is how a manual league stays
 * current: a screenshot of Recent Moves, a matchup page or a waiver email.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import config from './config.mjs';
import { all, meta } from './db/index.mjs';
import { normaliseName } from './providers/sleeper.mjs';
import { setupRealLeague } from './realdata.mjs';
import { httpError } from './server/router.mjs';
import { logger } from './util/log.mjs';

const log = logger('screenshots');
let client = null;
const api = () => (client ??= new Anthropic({
  apiKey: config.anthropicKey,
  defaultHeaders: config.anthropicWorkspaceId ? { 'anthropic-workspace-id': config.anthropicWorkspaceId } : undefined,
}));

export const configPathFor = (leagueKey) => meta.get(`league_config:${leagueKey}`) ?? null;

const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const PLAYER = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Full name as shown; for a team defense, the team name (e.g. "Jets"). Empty string when there is no player.' },
    pos: { type: 'string', enum: [...POS, ''] },
    nfl: { type: 'string', description: 'NFL team abbreviation as shown (e.g. "NYJ", "Ari"); empty if not visible.' },
  },
  required: ['name', 'pos', 'nfl'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    screenshots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['transactions', 'matchup', 'team_roster', 'waiver_report', 'standings', 'available_players', 'other'] },
          summary: { type: 'string' },
        },
        required: ['kind', 'summary'],
        additionalProperties: false,
      },
    },
    transactions: {
      type: 'array',
      description: 'Completed roster moves only. Denied waiver claims and players merely listed as available are NOT transactions.',
      items: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'Fantasy team that made the move, exactly as shown. Empty string if the name is cut off or hidden.' },
          add: PLAYER,
          drop: PLAYER,
          fromTeam: { type: 'string', description: 'For trades only: the fantasy team the added player came from. Otherwise empty.' },
          when: { type: 'string' },
        },
        required: ['team', 'add', 'drop', 'fromTeam', 'when'],
        additionalProperties: false,
      },
    },
    rosters: {
      type: 'array',
      description: 'Full rosters visible on matchup or team pages, one per fantasy team.',
      items: {
        type: 'object',
        properties: {
          team: { type: 'string' },
          record: { type: 'string', description: 'W-L-T as shown, e.g. "5-1-0"; empty if not visible.' },
          complete: { type: 'boolean', description: 'True only if every starter, bench and IR row for this team is visible.' },
          players: {
            type: 'array',
            items: {
              type: 'object',
              properties: { ...PLAYER.properties, slot: { type: 'string', description: 'Roster slot as shown: QB, RB, WR, TE, W/T, W/R, W/R/T, K, DEF, BN or IR.' } },
              required: ['name', 'pos', 'nfl', 'slot'],
              additionalProperties: false,
            },
          },
        },
        required: ['team', 'record', 'complete', 'players'],
        additionalProperties: false,
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Anything unreadable, cut off or ambiguous.' },
  },
  required: ['screenshots', 'transactions', 'rosters', 'notes'],
  additionalProperties: false,
};

const PROMPT = `These are screenshots from a fantasy football league platform (usually Yahoo). Extract the roster information they contain.

- Recent Moves / transactions pages: each row is one move by one fantasy team. "+" lines are adds, "-" lines are drops; a row may have both. "Waiver" and "Free Agent" describe how a player was added; "To Waivers" means dropped. The team name is on the right of the row - if a popup or the edge of the image hides it, leave team empty rather than guessing.
- Waiver report emails: only the SUCCESSFUL requests are transactions. Denied requests are not.
- Matchup and team pages: record the full roster of each team shown, with the slot of every player (starters by position slot, bench as BN, injured reserve as IR), and the team's record. Mark a roster complete only if no rows are cut off.
- Copy names exactly as shown, including suffixes like "Jr." and nicknames. Team defenses are listed by team name with position DEF.
- List transactions in the order they appear: top to bottom within a screenshot, screenshots in the order given. Recent Moves pages show the newest move first.
- Never invent a player, team or move that is not visible.`;

/** Read images into structured roster data. images: [{ dataUrl }] */
export async function extract(images) {
  if (!config.anthropicKey) throw httpError(503, 'Reading screenshots needs an Anthropic API key.', 'Set ANTHROPIC_API_KEY in .env and restart the server.');
  if (!images?.length) throw httpError(400, 'Add at least one screenshot.');
  if (images.length > 12) throw httpError(400, 'Up to 12 screenshots at a time.');
  const content = [];
  images.forEach((img, i) => {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(img.dataUrl ?? '');
    if (!m) throw httpError(400, `Screenshot ${i + 1} is not a PNG, JPEG, GIF or WebP image.`);
    content.push({ type: 'text', text: `Screenshot ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  });
  content.push({ type: 'text', text: PROMPT });

  const stream = api().beta.messages.stream({
    model: config.chatModel,
    max_tokens: 64000,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  const reply = await stream.finalMessage();
  if (reply.stop_reason === 'refusal') throw httpError(422, 'The screenshots could not be read.', 'Try cropping them to the roster area.');
  if (reply.stop_reason === 'max_tokens') throw httpError(422, 'Too much in one batch to read.', 'Send fewer screenshots at a time.');
  const text = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); }
  catch { throw httpError(502, 'The screenshot reader returned something unreadable.', 'Try again.'); }
}

// ---------------------------------------------------------------------------
// Resolution against the app's own data
// ---------------------------------------------------------------------------

const teamKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const NFL_FIX = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR', ARZ: 'ARI' };
const nflAbbr = (s) => { const u = String(s ?? '').trim().toUpperCase(); return NFL_FIX[u] ?? u; };

let pool = null;
function playerPool() {
  if (pool && Date.now() - pool.at < 60_000) return pool;
  // Players without a current NFL team stay in: a released player still has
  // to be found to be dropped. Adds prefer players on a team.
  const rows = all("SELECT player_id, name, pos, nfl_team, status FROM players WHERE pos IN ('QB','RB','WR','TE','K','DEF')");
  pool = { at: Date.now(), rows, byName: new Map() };
  for (const p of rows) {
    const k = `${normaliseName(p.name)}|${p.pos}`;
    if (!pool.byName.has(k)) pool.byName.set(k, []);
    pool.byName.get(k).push(p);
  }
  return pool;
}

/**
 * The app's player for a name read off a screenshot. Defenses resolve by NFL
 * team; people by exact name and position, then — for nicknames like "Bam"
 * Knight — by surname, position and NFL team together, but only when exactly
 * one player fits.
 */
export function resolvePlayer(e) {
  if (!e?.name) return null;
  const { rows, byName } = playerPool();
  const pos = e.pos || null;
  const nfl = nflAbbr(e.nfl);
  if (pos === 'DEF' || (!pos && /defen|d\/st/i.test(e.name))) {
    const want = teamKey(e.name);
    return rows.find((p) => p.pos === 'DEF' && (p.nfl_team === nfl || (want && teamKey(p.name).includes(want)))) ?? null;
  }
  const n = normaliseName(e.name);
  const candidates = pos ? (byName.get(`${n}|${pos}`) ?? []) : rows.filter((p) => normaliseName(p.name) === n);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return candidates.find((p) => p.nfl_team === nfl)
      ?? (candidates.filter((p) => p.nfl_team).length === 1 ? candidates.find((p) => p.nfl_team) : null);
  }
  const last = surname(e.name);
  const fuzzy = rows.filter((p) => (!pos || p.pos === pos) && p.nfl_team && p.nfl_team === nfl && surname(p.name) === last);
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function surname(name) {
  const words = String(name ?? '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter((w) => w && !SUFFIXES.has(w));
  return words.pop() ?? '';
}

/** player_id for an entry already in the league file. */
function entryId(entry) { return resolvePlayer(entry)?.player_id ?? null; }

function loadConfig(leagueKey) {
  const file = configPathFor(leagueKey);
  if (!file || !fs.existsSync(file)) {
    throw httpError(409, 'This league was not set up from a league file, so it cannot be updated from screenshots.',
      'Import it once with: node bin/oracle.mjs real league --file <your-league>.json');
  }
  return { file, cfg: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const describe = (p) => p ? { name: p.name, pos: p.pos, nfl: p.nfl_team } : null;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** "Oct 21, 4:43 am" -> epoch ms in the given season, or null. */
function parseWhen(when, season) {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*([ap])m/i.exec(when ?? '');
  if (!m || MONTHS[m[1].toLowerCase()] == null) return null;
  const month = MONTHS[m[1].toLowerCase()];
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'p') hour += 12;
  // Jan-Feb moves belong to the year after the season started.
  return Date.UTC(season + (month < 2 ? 1 : 0), month, Number(m[2]), hour, Number(m[4]));
}

/**
 * Moves newest first, by their timestamps. Page order alone is wrong as soon
 * as screenshots are taken out of sequence, and a whole waiver run shares one
 * timestamp — within it, a row that drops a player must be newer than the row
 * that added him, since nobody drops a player they do not have yet. A row
 * whose time is hidden takes the time of the row above it.
 */
function newestFirst(transactions, season) {
  let last = null;
  const rows = transactions.map((t, i) => {
    const at = parseWhen(t.when, season) ?? last;
    last = at;
    return { t, i, at: at ?? -Infinity };
  });
  const key = (x) => normaliseName(x?.name ?? '');
  return rows.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    const aDropsBAdd = a.t.drop?.name && key(a.t.drop) === key(b.t.add);
    const bDropsAAdd = b.t.drop?.name && key(b.t.drop) === key(a.t.add);
    if (aDropsBAdd && !bDropsAAdd) return -1;
    if (bDropsAAdd && !aDropsBAdd) return 1;
    return a.i - b.i;
  });
}

/** Turn extracted data into reviewable changes against the league file. */
export function propose(leagueKey, extracted) {
  const { cfg } = loadConfig(leagueKey);
  const teams = Object.keys(cfg.rosters ?? {});
  const findTeam = (name) => {
    const k = teamKey(name);
    if (!k) return null;
    return teams.find((t) => teamKey(t) === k) ?? teams.find((t) => teamKey(t).includes(k) || k.includes(teamKey(t))) ?? null;
  };
  // Who holds each player in the league file right now.
  const owner = new Map();
  for (const [team, entries] of Object.entries(cfg.rosters ?? {})) {
    for (const e of entries) { const id = entryId(e); if (id) owner.set(id, team); }
  }

  const changes = [];
  // Recent Moves lists the newest move first. A player picked up and dropped
  // again within the batch must end up dropped, so for each player only the
  // newest move counts; older halves are marked superseded, and moves are
  // applied oldest first.
  const seen = new Set();
  const txs = newestFirst(extracted.transactions ?? [], cfg.season).map(({ t, i }) => {
    const add = t.add?.name ? resolvePlayer(t.add) : null;
    const drop = t.drop?.name ? resolvePlayer(t.drop) : null;
    const addStale = add && seen.has(add.player_id);
    const dropStale = drop && seen.has(drop.player_id);
    if (add) seen.add(add.player_id);
    if (drop) seen.add(drop.player_id);
    return { t, i, rawAdd: add, rawDrop: drop, add: addStale ? null : add, drop: dropStale ? null : drop, superseded: [addStale && add.name, dropStale && drop.name].filter(Boolean) };
  }).reverse();
  // Who holds whom as the batch plays out, oldest move first. A hidden team
  // name is recovered from this, not just from the saved rosters: the team
  // that drops a player picked up earlier in the same batch is the team that
  // picked him up.
  const sim = new Map(owner);
  txs.forEach(({ t, i, rawAdd, rawDrop, add, drop, superseded }) => {
    let team = findTeam(t.team);
    let note = superseded.length ? `A newer move in these screenshots replaces the part about ${superseded.join(' and ')}.` : '';
    if (!team && rawAdd && sim.has(rawAdd.player_id) && owner.get(rawAdd.player_id) === sim.get(rawAdd.player_id)) {
      team = sim.get(rawAdd.player_id); note = `${note} Team inferred: ${team} has ${rawAdd.name}.`.trim();
    }
    if (!team && rawDrop && sim.has(rawDrop.player_id)) { team = sim.get(rawDrop.player_id); note = `${note} Team inferred: ${team} held ${rawDrop.name}.`.trim(); }
    if (team) {
      if (rawDrop && sim.get(rawDrop.player_id) === team) sim.delete(rawDrop.player_id);
      if (rawAdd) sim.set(rawAdd.player_id, team);
    }
    if (!team && !add && !drop && superseded.length) { changes.push({ id: `t${i}`, kind: 'move', team: null, readAs: { team: t.team, add: t.add?.name || null, drop: t.drop?.name || null }, add: null, drop: null, status: 'already', note }); return; }
    const issues = [];
    const lost = (side) => t[side]?.name && !superseded.length && !(side === 'add' ? add : drop);
    if (lost('add')) issues.push(`can't find "${t.add.name}"${t.add.pos ? ` (${t.add.pos})` : ''}`);
    if (lost('drop')) issues.push(`can't find "${t.drop.name}"${t.drop.pos ? ` (${t.drop.pos})` : ''}`);
    if (!add && !drop && superseded.length) { changes.push({ id: `t${i}`, kind: 'move', team, readAs: { team: t.team, add: t.add?.name || null, drop: t.drop?.name || null }, add: null, drop: null, status: 'already', note }); return; }
    if (!team) issues.push(t.team ? `no team called "${t.team}"` : 'team name not visible');
    const applied = team && (!add || owner.get(add.player_id) === team) && (!drop || owner.get(drop.player_id) !== team);
    changes.push({
      id: `t${i}`, kind: 'move', team, readAs: { team: t.team, add: t.add?.name || null, drop: t.drop?.name || null },
      add: describe(add), addId: add?.player_id ?? null, drop: describe(drop), dropId: drop?.player_id ?? null,
      fromTeam: add && owner.has(add.player_id) && owner.get(add.player_id) !== team ? owner.get(add.player_id) : null,
      when: t.when, status: issues.length ? 'problem' : applied ? 'already' : 'ready',
      note: [note, issues.join('; '), applied ? 'Already reflected in the app.' : ''].filter(Boolean).join(' '),
    });
  });

  (extracted.rosters ?? []).forEach((r, i) => {
    const team = findTeam(r.team);
    const resolved = r.players.map((p) => ({ read: p, player: resolvePlayer(p), slot: (p.slot || 'BN').toUpperCase() }));
    const unresolved = resolved.filter((x) => !x.player).map((x) => x.read.name);
    const current = new Set((cfg.rosters?.[team] ?? []).map(entryId).filter(Boolean));
    const next = new Set(resolved.filter((x) => x.player).map((x) => x.player.player_id));
    const added = resolved.filter((x) => x.player && !current.has(x.player.player_id)).map((x) => x.player.name);
    const removed = (cfg.rosters?.[team] ?? []).filter((e) => { const id = entryId(e); return id && !next.has(id); }).map((e) => e.name);
    const rec = /^(\d+)-(\d+)(?:-(\d+))?/.exec(r.record ?? '');
    const cfgTeam = (cfg.teams ?? []).find((t) => t.name === team);
    const recordChange = rec && cfgTeam && (Number(rec[1]) !== (cfgTeam.wins ?? 0) || Number(rec[2]) !== (cfgTeam.losses ?? 0) || Number(rec[3] ?? 0) !== (cfgTeam.ties ?? 0))
      ? { wins: Number(rec[1]), losses: Number(rec[2]), ties: Number(rec[3] ?? 0) } : null;
    const issues = [];
    if (!team) issues.push(`no team called "${r.team}"`);
    if (!r.complete) issues.push('some rows were cut off, so the roster is not replaced (moves on it can still come from Recent Moves)');
    if (unresolved.length) issues.push(`can't find: ${unresolved.join(', ')}`);
    const rosterUsable = team && r.complete && !unresolved.length;
    changes.push({
      id: `r${i}`, kind: 'roster', team, readAs: { team: r.team },
      players: rosterUsable ? resolved.map((x) => ({ ...describe(x.player), id: x.player.player_id, slot: x.slot })) : null,
      added, removed, record: recordChange,
      status: !team ? 'problem' : (!rosterUsable && !recordChange) ? 'problem' : (!added.length && !removed.length && !recordChange && rosterUsable) ? 'already' : 'ready',
      note: [issues.join('; '), rosterUsable && !added.length && !removed.length ? 'Roster already matches; lineup slots will be refreshed.' : ''].filter(Boolean).join(' '),
    });
  });

  return {
    file: configPathFor(leagueKey),
    currentWeek: cfg.currentWeek ?? 1,
    screenshots: extracted.screenshots ?? [],
    notes: extracted.notes ?? [],
    changes,
  };
}

/** Write the accepted changes to the league file and re-import it. */
export function apply(leagueKey, { changes = [], currentWeek = null } = {}) {
  const { file, cfg } = loadConfig(leagueKey);
  const log_ = [];
  const findEntry = (team, id) => (cfg.rosters[team] ?? []).findIndex((e) => entryId(e) === id);
  const entryFor = (id, slot) => {
    const p = all('SELECT name, pos, nfl_team FROM players WHERE player_id = ?', [id])[0];
    return { name: p.name, pos: p.pos, slot, nfl: p.nfl_team };
  };

  for (const c of changes) {
    if (c.kind === 'move' && c.team && cfg.rosters[c.team]) {
      let slot = 'BN';
      if (c.dropId) {
        const i = findEntry(c.team, c.dropId);
        if (i >= 0) {
          const [gone] = cfg.rosters[c.team].splice(i, 1);
          // The newcomer inherits the slot when it is the same position, or a
          // bench/IR spot; a different-position starter slot is left for the
          // lineup optimiser rather than guessed at.
          if (c.add && (gone.pos === c.add.pos || ['BN', 'IR'].includes(gone.slot))) slot = gone.slot ?? 'BN';
          log_.push(`${c.team}: dropped ${gone.name}`);
        }
      }
      if (c.addId) {
        // Remove him wherever he is first — a trade, or a stale entry elsewhere.
        for (const [team, entries] of Object.entries(cfg.rosters)) {
          const i = entries.findIndex((e) => entryId(e) === c.addId);
          if (i >= 0 && team !== c.team) { entries.splice(i, 1); log_.push(`${team}: ${c.add.name} moved to ${c.team}`); }
        }
        if (findEntry(c.team, c.addId) < 0) { cfg.rosters[c.team].push(entryFor(c.addId, slot)); log_.push(`${c.team}: added ${c.add.name}`); }
        cfg.claimedElsewhere = (cfg.claimedElsewhere ?? []).filter((e) => entryId(e) !== c.addId);
      }
    }
    if (c.kind === 'roster' && c.team && cfg.rosters[c.team]) {
      if (c.players) {
        for (const p of c.players) {
          for (const [team, entries] of Object.entries(cfg.rosters)) {
            if (team === c.team) continue;
            const i = entries.findIndex((e) => entryId(e) === p.id);
            if (i >= 0) { entries.splice(i, 1); log_.push(`${team}: ${p.name} is now on ${c.team}`); }
          }
        }
        cfg.rosters[c.team] = c.players.map((p) => entryFor(p.id, p.slot));
        log_.push(`${c.team}: roster replaced (${c.players.length} players)`);
      }
      if (c.record) {
        const t = (cfg.teams ?? []).find((x) => x.name === c.team);
        if (t) { Object.assign(t, c.record); log_.push(`${c.team}: record ${c.record.wins}-${c.record.losses}${c.record.ties ? `-${c.record.ties}` : ''}`); }
      }
    }
  }
  if (currentWeek && Number(currentWeek) !== cfg.currentWeek) {
    log_.push(`week ${cfg.currentWeek} → ${currentWeek}`);
    cfg.currentWeek = Number(currentWeek);
  }
  if (!log_.length) return { ok: true, applied: [], note: 'Nothing to change.' };

  cfg._rosters = `${cfg._rosters ?? ''} ${new Date().toISOString().slice(0, 10)}: updated from screenshots in the app (${log_.length} changes).`.trim();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  const r = setupRealLeague(cfg);
  log.info(`applied ${log_.length} screenshot changes to ${file}`);
  return {
    ok: true, applied: log_,
    unmatched: r.rosters?.unmatched ?? [], contested: (r.rosters?.contested ?? []).map((x) => x.player),
  };
}
