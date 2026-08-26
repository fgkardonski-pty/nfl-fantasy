/**
 * Research jobs.
 *
 * Each job is small, independent, idempotent, and records its own success or
 * failure. A failing job must never take down the scheduler or corrupt state:
 * the platform's guarantee is that stale data is labelled stale, not that every
 * fetch succeeds.
 */
import crypto from 'node:crypto';
import config from '../config.mjs';
import { all, get, run, upsertMany, recordJob, j } from '../db/index.mjs';
import * as sleeper from '../providers/sleeper.mjs';
import * as odds from '../providers/odds.mjs';
import * as weather from '../providers/weather.mjs';
import * as yahooSync from '../providers/yahoo/sync.mjs';
import { connectionStatus } from '../providers/yahoo/oauth.mjs';
import * as llm from './llm.mjs';
import { getLeague, activeLeagueKey, refreshDefensiveRatings, invalidateOutlook, intel } from '../service.mjs';
import { logger } from '../util/log.mjs';

const log = logger('research');

/** Run a job with timing, error isolation and a job_runs record. */
async function runJob(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    recordJob(name, started, true, JSON.stringify(result ?? {}));
    log.info(`${name} ok (${Date.now() - started}ms)`, result);
    return { job: name, ok: true, ms: Date.now() - started, result };
  } catch (err) {
    recordJob(name, started, false, err.message);
    log.warn(`${name} failed: ${err.message}`);
    return { job: name, ok: false, ms: Date.now() - started, error: err.message };
  }
}

export const JOBS = {
  /** Refresh injury designations, depth chart order and player metadata. */
  'players:enrich': () => runJob('players:enrich', () => sleeper.enrichPlayers()),

  /** Pull the betting market and derive implied team totals. */
  'market:lines': () => runJob('market:lines', async () => {
    const league = getLeague();
    if (!league) return { skipped: 'no active league' };
    return odds.fetchLines({ season: league.season, week: league.current_week });
  }),

  /** Forecast at kickoff for every outdoor stadium. */
  'market:weather': () => runJob('market:weather', async () => {
    const league = getLeague();
    if (!league) return { skipped: 'no active league' };
    return weather.fetchWeather({ season: league.season, week: league.current_week });
  }),

  /** What the wider fantasy market is adding — a leading indicator of waiver competition. */
  'market:trending': () => runJob('market:trending', async () => {
    const [adds, drops] = await Promise.all([sleeper.trendingAdds({ limit: 60 }), sleeper.trendingDrops({ limit: 40 })]);
    const league = getLeague();
    if (!league || !adds.length) return { adds: adds.length, drops: drops.length, applied: 0 };

    const bySleeper = new Map(
      all('SELECT player_id, sleeper_id FROM players WHERE sleeper_id IS NOT NULL')
        .map((p) => [String(p.sleeper_id), p.player_id])
    );
    const maxAdd = Math.max(1, ...adds.map((a) => a.count));
    const rows = [];
    for (const a of adds) {
      const local = bySleeper.get(a.sleeper_id);
      if (!local) continue;
      const existing = get('SELECT * FROM ownership WHERE league_key = ? AND player_id = ?', [league.league_key, local]);
      rows.push({
        league_key: league.league_key,
        player_id: local,
        pct_owned: existing?.pct_owned ?? 0,
        pct_started: existing?.pct_started ?? 0,
        // Normalise national add volume onto a 0..25 "ownership velocity" scale.
        pct_change: Math.round((a.count / maxAdd) * 25 * 10) / 10,
        waiver_status: existing?.waiver_status ?? 'FA',
      });
    }
    if (rows.length) upsertMany('ownership', Object.keys(rows[0]), rows, ['league_key', 'player_id']);
    return { adds: adds.length, drops: drops.length, applied: rows.length };
  }),

  /** Re-sync the connected Yahoo league. */
  'yahoo:sync': () => runJob('yahoo:sync', async () => {
    const status = connectionStatus();
    if (!status.connected) return { skipped: 'Yahoo not connected' };
    const key = activeLeagueKey();
    if (!key) return { skipped: 'no active league' };
    const report = await yahooSync.syncLeague(key, { includeHistory: false });
    invalidateOutlook();
    return { ok: report.ok, partial: report.partial, errors: report.errors };
  }),

  /** Rebuild positional defensive ratings from observed scoring. */
  'model:defense': () => runJob('model:defense', async () => {
    const league = getLeague();
    if (!league) return { skipped: 'no active league' };
    return { rows: refreshDefensiveRatings(league) };
  }),

  /** Rebuild every rival's behavioural dossier and claim predictions. */
  'model:opponents': () => runJob('model:opponents', async () => {
    const league = getLeague();
    if (!league) return { skipped: 'no active league' };
    const result = intel(league);
    return { dossiers: result.dossiers.length, contested: result.contention.length };
  }),

  /** Score unscored news items into structured projection impacts. */
  'news:score': () => runJob('news:score', async () => {
    if (!llm.isEnabled()) return { skipped: 'ANTHROPIC_API_KEY not set' };
    const pending = all(
      `SELECT n.id, n.headline, n.body, n.player_id, p.name, p.pos, p.nfl_team
       FROM news n LEFT JOIN players p ON p.player_id = n.player_id
       WHERE n.impact IS NULL ORDER BY n.ts DESC LIMIT 25`
    );
    if (!pending.length) return { scored: 0 };
    const scored = await llm.scoreNews(pending.map((n) => ({
      id: n.id, playerName: n.name ?? 'Unknown', pos: n.pos ?? '', team: n.nfl_team ?? '',
      headline: n.headline, body: n.body,
    })));
    for (const s of scored) {
      run('UPDATE news SET impact = ?, confidence = ?, rationale = ? WHERE id = ?',
        [s.impact, s.confidence, s.rationale, s.id]);
    }
    invalidateOutlook();
    return { scored: scored.length, pending: pending.length };
  }),
};

/** Insert a news item for later scoring. Deduplicated by content hash. */
export function addNews({ playerId, headline, body, source, url, ts = Date.now() }) {
  const id = crypto.createHash('sha256').update(`${playerId ?? ''}|${headline}`).digest('hex').slice(0, 24);
  run(
    `INSERT INTO news (id, ts, player_id, headline, body, source, url)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    [id, ts, playerId ?? null, headline, body ?? null, source ?? null, url ?? null]
  );
  return id;
}

/** Run a named job, or every job. */
export async function run_(name) {
  if (name && JOBS[name]) return [await JOBS[name]()];
  const results = [];
  for (const [key, fn] of Object.entries(JOBS)) results.push(await fn());
  return results;
}

export { run_ as runJobs };
