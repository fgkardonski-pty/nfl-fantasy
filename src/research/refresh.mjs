/** Refresh every registered league without changing the selected league. */
import { all, get, meta, upsertMany } from '../db/index.mjs';
import * as sleeper from '../providers/sleeper.mjs';
import { syncLeague } from '../providers/yahoo/sync.mjs';
import { connectionStatus } from '../providers/yahoo/oauth.mjs';
import { importSleeperLeague, importWeeklyFromSleeper, importScheduleFromSleeper, seedRealPlayers } from '../realdata.mjs';
import { invalidateOutlook } from '../service.mjs';

export function saveSleeperTransactions(leagueKey, transactions, week) {
  const byId = new Map(all('SELECT player_id, sleeper_id FROM players WHERE sleeper_id IS NOT NULL').map((p) => [String(p.sleeper_id), p.player_id]));
  const rows = [];
  for (const t of transactions) {
    if (t.status !== 'complete') continue;
    for (const [field, movement] of [['adds', 'add'], ['drops', 'drop']]) {
      for (const [id, rosterId] of Object.entries(t[field] ?? {})) {
        const player = byId.get(id);
        if (!player) throw new Error('Activity includes an unknown player; refresh player index.');
        rows.push({ league_key: leagueKey, txn_id: String(t.transaction_id),
          type: t.type === 'trade' ? 'trade' : t.adds && t.drops ? 'add/drop' : movement,
          ts: Number(t.status_updated ?? t.created), week: Number(t.leg ?? week),
          team_key: `${leagueKey}.t.${rosterId}`, player_id: player, movement,
          source: t.type === 'waiver' ? 'waivers' : t.type === 'trade' ? 'trade' : 'freeagents',
          destination: movement === 'add' ? `${leagueKey}.t.${rosterId}` : 'freeagents',
          faab_bid: t.settings?.waiver_bid ?? null, raw: JSON.stringify(t) });
      }
    }
  }
  if (rows.length) upsertMany('transactions', Object.keys(rows[0]), rows, ['league_key', 'txn_id', 'player_id', 'movement']);
  return rows.length;
}

let running = null;
export function refreshLeagues() {
  if (running) return running;
  running = refreshAll().finally(() => { running = null; });
  return running;
}

async function refreshAll() {
  const leagues = all('SELECT * FROM leagues WHERE is_demo = 0');
  const results = [];
  if (!leagues.length) return { ok: true, skipped: 'No live leagues registered', results };
  // Refresh the public player universe daily; never reseed fictional demo data.
  const lastIndex = Number(meta.get('refresh:player-index') ?? 0);
  if (Date.now() - lastIndex > 86400000) {
    try {
      await seedRealPlayers();
      meta.set('refresh:player-index', String(Date.now()));
    } catch { /* Existing players remain usable; league sync validates IDs. */ }
  }
  const evidence = new Map();
  for (const saved of leagues) {
    const key = saved.league_key;
    const prior = meta.getJson(`refresh:${key}`, {});
    const report = { attemptedAt: Date.now(), lastSuccess: prior.lastSuccess ?? null, errors: [], leagueKey: key };
    try {
      if (key.startsWith('sleeper.l.')) {
        const id = saved.league_id || key.slice('sleeper.l.'.length);
        const username = meta.get(`sleeper_username:${key}`) ?? meta.get('sleeper_username');
        const r = await importSleeperLeague(id, { username });
        if (!r.ok) throw new Error(r.note ?? 'Sleeper sync failed');
        const through = Math.min(18, r.week);
        // Backfill once, then reread current + previous week for late corrections.
        const from = prior.activitySuccess ? Math.max(1, through - 1) : 1;
        for (let w = from; w <= through; w++) saveSleeperTransactions(key, await sleeper.leagueTransactions(id, w), w);
        report.activitySuccess = Date.now();
      } else if (/^\d+\.l\.\d+$/.test(key)) {
        if (!connectionStatus().connected) throw new Error('Yahoo authorization required for automatic league refresh.');
        const r = await syncLeague(key, { includeHistory: false });
        if (!r.ok) throw new Error(r.errors.join('; '));
        report.activitySuccess = Date.now();
      } else {
        throw new Error('Manually imported league: connect its live provider to refresh opponent rosters automatically.');
      }
      report.lastSuccess = Date.now();
    } catch (err) { report.errors.push(err.message); }

    const league = get('SELECT * FROM leagues WHERE league_key = ?', [key]);
    const week = Math.max(1, Math.min(18, league.current_week));
    const batch = `${league.season}:${week}`;
    if (!evidence.has(batch)) {
      const errs = [];
      const stamp = Number(meta.get(`evidence:${batch}`) ?? 0);
      if (Date.now() - stamp > 6 * 3600000) {
        for (const [kind, w] of [['projections', week], ...(week > 1 ? [['stats', week - 1]] : [])]) {
          try {
            const r = await importWeeklyFromSleeper({ season: league.season, week: w, kind });
            if (!r.ok || !r.written) errs.push(`${kind}: ${r.note ?? 'no player evidence returned'}`);
          } catch (err) { errs.push(`${kind}: ${err.message}`); }
        }
        try {
          const r = await importScheduleFromSleeper({ season: league.season });
          if (!r.ok) errs.push(`schedule: ${r.note}`);
        }
        catch (err) { errs.push(`schedule: ${err.message}`); }
        if (!errs.length) meta.set(`evidence:${batch}`, String(Date.now()));
      }
      evidence.set(batch, errs);
    }
    report.evidenceErrors = evidence.get(batch);
    report.ok = report.errors.length === 0;
    report.activitySuccess ??= prior.activitySuccess ?? null;
    meta.set(`refresh:${key}`, JSON.stringify(report));
    results.push(report);
  }
  invalidateOutlook();
  return { ok: results.every((r) => r.ok && !r.evidenceErrors.length), results };
}
