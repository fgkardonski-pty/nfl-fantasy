/**
 * The research daemon.
 *
 * Runs continuously so the war room is already correct when you open it on
 * Sunday morning, rather than starting a five-minute data pull at the moment
 * you need an answer.
 *
 * Cadences are chosen around how fast each source actually changes: injury
 * designations move hourly on game day and barely at all on Tuesday; betting
 * lines drift all week; league transactions land whenever a rival is awake.
 */
import { JOBS } from './jobs.mjs';
import { logger } from '../util/log.mjs';

const log = logger('daemon');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** job -> interval. Jitter is applied so jobs do not all fire together. */
export const SCHEDULE = [
  { job: 'leagues:refresh',  everyMs: 30 * MINUTE, description: 'all leagues: rosters, activity, weekly evidence' },
  { job: 'players:enrich',   everyMs: 6 * HOUR,    description: 'injury designations and depth charts' },
  { job: 'market:lines',     everyMs: 3 * HOUR,    description: 'Vegas totals and spreads' },
  { job: 'market:weather',   everyMs: 6 * HOUR,    description: 'stadium forecasts at kickoff' },
  { job: 'market:trending',  everyMs: 60 * MINUTE, description: 'league-wide add/drop velocity' },
  { job: 'news:score',       everyMs: 45 * MINUTE, description: 'news to projection impact' },
  { job: 'model:defense',    everyMs: 12 * HOUR,   description: 'positional defensive ratings' },
  { job: 'model:opponents',  everyMs: 2 * HOUR,    description: 'rival dossiers and claim predictions' },
];

export class ResearchDaemon {
  constructor({ schedule = SCHEDULE, runOnStart = true } = {}) {
    this.schedule = schedule;
    this.runOnStart = runOnStart;
    this.timers = [];
    this.running = false;
    this.history = [];
    this.inFlight = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.info(`starting research daemon with ${this.schedule.length} jobs`);
    for (const entry of this.schedule) {
      // Stagger initial runs so a cold start does not fire eight fetches at once.
      const jitter = Math.floor(Math.random() * 30_000);
      const kick = async () => {
        if (!this.running) return;
        const res = await this.runOne(entry.job);
        this.record(res);
      };
      if (this.runOnStart) this.timers.push(setTimeout(kick, jitter));
      const timer = setInterval(kick, entry.everyMs);
      timer.unref?.();
      this.timers.push(timer);
    }
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    log.info('research daemon stopped');
  }

  async runOne(job) {
    if (this.inFlight.has(job)) return this.inFlight.get(job);
    const fn = JOBS[job];
    if (!fn) return { job, ok: false, error: 'unknown job' };
    const pending = Promise.resolve().then(fn).catch((err) => ({ job, ok: false, error: err.message }));
    this.inFlight.set(job, pending);
    try { return await pending; } finally { this.inFlight.delete(job); }
  }

  record(result) {
    this.history.unshift({ ...result, at: Date.now() });
    this.history = this.history.slice(0, 80);
  }

  status() {
    return {
      running: this.running,
      jobs: this.schedule.map((s) => ({
        ...s,
        everyMinutes: Math.round(s.everyMs / MINUTE),
        last: this.history.find((h) => h.job === s.job) ?? null,
      })),
      recent: this.history.slice(0, 20),
    };
  }
}

export const daemon = new ResearchDaemon({ runOnStart: true });
