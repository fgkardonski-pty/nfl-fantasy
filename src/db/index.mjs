/**
 * Database access built on Node's built-in SQLite (node:sqlite, Node >= 22.5).
 *
 * Choosing the built-in over better-sqlite3 is deliberate: this platform has
 * zero npm dependencies, so `git clone && node bin/oracle.mjs serve` works on a
 * clean machine with no native compilation and no install step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import config from '../config.mjs';
import { logger } from '../util/log.mjs';

const log = logger('db');

let _db = null;

export function getDb(dbPath = config.dbPath) {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  const schema = fs.readFileSync(path.join(config.root, 'src/db/schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  _db = db;
  log.debug(`opened ${dbPath}`);
  return db;
}

/**
 * Additive column migrations.
 *
 * The schema file is all CREATE TABLE IF NOT EXISTS, which means an existing
 * database never picks up a column added to it later. Anyone who has already
 * run this platform would silently keep the old shape, so new columns are added
 * here instead, guarded by what the table actually has.
 */
const ADDED_COLUMNS = {
  adp: {
    // Consensus rank, tier and positional rank, as published. ADP alone says
    // when a player leaves the board; these say how good the experts think he
    // is, which is a different question and the one valuation needs.
    ecr: 'REAL',
    tier: 'INTEGER',
    pos_rank: 'INTEGER',
  },
};

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    let existing;
    try {
      existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    } catch { continue; }          // table absent entirely; schema.sql owns it
    if (!existing.size) continue;
    for (const [name, type] of Object.entries(columns)) {
      if (existing.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      log.debug(`migrated: ${table}.${name} added`);
    }
  }
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

/** Reset the module-level handle (used by tests that open in-memory DBs). */
export function useDb(db) { _db = db; }

// ---------------------------------------------------------------------------
// Thin query helpers. node:sqlite returns null-prototype objects; we spread
// them into plain objects so JSON.stringify and destructuring behave.
// ---------------------------------------------------------------------------

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params).map((r) => ({ ...r }));
}

export function get(sql, params = []) {
  const r = getDb().prepare(sql).get(...params);
  return r ? { ...r } : undefined;
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function exec(sql) {
  return getDb().exec(sql);
}

/** Run `fn` inside a transaction, rolling back on throw. */
export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Bulk upsert. Builds one prepared statement and reuses it across rows inside a
 * single transaction — the difference between 40ms and 4s on a full player sync.
 */
export function upsertMany(table, columns, rows, conflictCols) {
  if (!rows.length) return 0;
  const ph = columns.map(() => '?').join(',');
  const updates = columns
    .filter((c) => !conflictCols.includes(c))
    .map((c) => `${c}=excluded.${c}`)
    .join(',');
  const sql =
    `INSERT INTO ${table} (${columns.join(',')}) VALUES (${ph}) ` +
    `ON CONFLICT(${conflictCols.join(',')}) DO UPDATE SET ${updates || columns[0] + '=' + columns[0]}`;
  const stmt = getDb().prepare(sql);
  return tx(() => {
    let n = 0;
    for (const row of rows) {
      stmt.run(...columns.map((c) => normalise(row[c])));
      n++;
    }
    return n;
  });
}

/** node:sqlite accepts null/number/string/bigint/buffer only. */
function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export const meta = {
  get(key, fallback = null) {
    const r = get('SELECT value FROM meta WHERE key = ?', [key]);
    return r ? r.value : fallback;
  },
  set(key, value) {
    run('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, typeof value === 'string' ? value : JSON.stringify(value)]);
  },
  getJson(key, fallback = null) {
    const v = this.get(key);
    if (v == null) return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  },
};

/** Parse a JSON column safely — bad data must never take down a page render. */
export function j(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function recordProvenance({ source, endpoint, status, ok, bytes, ms, etag, note }) {
  run(
    `INSERT INTO provenance (source,endpoint,status,ok,bytes,ms,etag,note,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [source, endpoint, status ?? null, ok ? 1 : 0, bytes ?? null, ms ?? null, etag ?? null, note ?? null, Date.now()]
  );
}

export function recordJob(job, startedAt, ok, detail) {
  run('INSERT INTO job_runs (job,started_at,ended_at,ok,detail) VALUES (?,?,?,?,?)',
    [job, startedAt, Date.now(), ok ? 1 : 0, detail ?? null]);
}
