-- Gridiron Oracle schema.
-- Every table that holds a derived number also holds the provenance of the
-- inputs that produced it, so any recommendation can be traced back to source.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Encrypted OAuth material. Never stored in plaintext; see src/util/crypto.mjs.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider      TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  guid          TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leagues (
  league_key         TEXT PRIMARY KEY,
  league_id          TEXT,
  name               TEXT NOT NULL,
  season             INTEGER NOT NULL,
  num_teams          INTEGER NOT NULL,
  scoring_type       TEXT,
  scoring            TEXT NOT NULL DEFAULT '{}',   -- JSON: stat_id -> points
  roster_slots       TEXT NOT NULL DEFAULT '[]',   -- JSON: [{slot,count}]
  waiver_type        TEXT,
  faab_budget        INTEGER DEFAULT 100,
  trade_deadline     TEXT,
  playoff_start_week INTEGER DEFAULT 15,
  end_week           INTEGER DEFAULT 17,
  num_playoff_teams  INTEGER DEFAULT 6,
  current_week       INTEGER DEFAULT 1,
  is_demo            INTEGER NOT NULL DEFAULT 0,
  synced_at          INTEGER
);

CREATE TABLE IF NOT EXISTS teams (
  league_key      TEXT NOT NULL,
  team_key        TEXT NOT NULL,
  team_id         INTEGER,
  name            TEXT NOT NULL,
  manager         TEXT,
  is_mine         INTEGER NOT NULL DEFAULT 0,
  faab_remaining  INTEGER,
  waiver_priority INTEGER,
  wins            INTEGER DEFAULT 0,
  losses          INTEGER DEFAULT 0,
  ties            INTEGER DEFAULT 0,
  points_for      REAL DEFAULT 0,
  points_against  REAL DEFAULT 0,
  moves           INTEGER DEFAULT 0,
  trade_count     INTEGER DEFAULT 0,
  logo            TEXT,
  PRIMARY KEY (league_key, team_key),
  FOREIGN KEY (league_key) REFERENCES leagues(league_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS players (
  player_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  pos          TEXT NOT NULL,
  nfl_team     TEXT,
  bye_week     INTEGER,
  status       TEXT,            -- '', Q, D, O, IR, PUP, SUSP
  injury_note  TEXT,
  age          REAL,
  years_exp    INTEGER,
  depth_rank   INTEGER,
  -- Yahoo's authoritative eligibility list, e.g. ["RB","W/R/T"]. A player can be
  -- eligible for slots his primary position does not imply, and the optimizer
  -- must honour that or it will leave legal points on the bench.
  eligible_positions TEXT,
  yahoo_key    TEXT,
  sleeper_id   TEXT,
  headshot     TEXT,
  updated_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_players_pos  ON players(pos);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(nfl_team);

-- League-wide ownership snapshot: who is rostered where, and by whom.
CREATE TABLE IF NOT EXISTS rosters (
  league_key TEXT NOT NULL,
  team_key   TEXT NOT NULL,
  player_id  TEXT NOT NULL,
  week       INTEGER NOT NULL,
  slot       TEXT,
  is_starter INTEGER NOT NULL DEFAULT 0,
  acquired   TEXT,
  PRIMARY KEY (league_key, team_key, player_id, week)
);
CREATE INDEX IF NOT EXISTS idx_rosters_player ON rosters(league_key, player_id, week);

CREATE TABLE IF NOT EXISTS ownership (
  league_key    TEXT NOT NULL,
  player_id     TEXT NOT NULL,
  pct_owned     REAL DEFAULT 0,
  pct_started   REAL DEFAULT 0,
  pct_change    REAL DEFAULT 0,
  waiver_status TEXT,            -- FA | W (on waivers) | R (rostered)
  PRIMARY KEY (league_key, player_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  league_key TEXT NOT NULL,
  txn_id     TEXT NOT NULL,
  type       TEXT NOT NULL,      -- add | drop | add/drop | trade | commish
  ts         INTEGER NOT NULL,
  week       INTEGER,
  team_key   TEXT,
  player_id  TEXT,
  movement   TEXT,               -- add | drop
  source     TEXT,               -- freeagents | waivers | team_key
  destination TEXT,
  faab_bid   INTEGER,
  raw        TEXT,
  PRIMARY KEY (league_key, txn_id, player_id, movement)
);
CREATE INDEX IF NOT EXISTS idx_txn_team ON transactions(league_key, team_key, ts);
CREATE INDEX IF NOT EXISTS idx_txn_ts   ON transactions(league_key, ts);

CREATE TABLE IF NOT EXISTS matchups (
  league_key   TEXT NOT NULL,
  week         INTEGER NOT NULL,
  team_key     TEXT NOT NULL,
  opp_team_key TEXT,
  points       REAL,
  projected    REAL,
  is_playoffs  INTEGER DEFAULT 0,
  PRIMARY KEY (league_key, week, team_key)
);

-- Observed weekly production, in raw stat units (scoring is applied later so a
-- league-settings change re-prices history without a re-fetch).
CREATE TABLE IF NOT EXISTS player_stats (
  player_id TEXT NOT NULL,
  season    INTEGER NOT NULL,
  week      INTEGER NOT NULL,
  opponent  TEXT,
  stats     TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (player_id, season, week)
);

-- The opportunity signals that lead the box score.
CREATE TABLE IF NOT EXISTS player_usage (
  player_id     TEXT NOT NULL,
  season        INTEGER NOT NULL,
  week          INTEGER NOT NULL,
  snap_pct      REAL,
  route_pct     REAL,
  target_share  REAL,
  rush_share    REAL,
  air_yard_share REAL,
  rz_touches    REAL,
  gl_carries    REAL,
  PRIMARY KEY (player_id, season, week)
);

CREATE TABLE IF NOT EXISTS projections (
  league_key TEXT NOT NULL,
  player_id  TEXT NOT NULL,
  season     INTEGER NOT NULL,
  week       INTEGER NOT NULL,
  mean       REAL NOT NULL,
  sd         REAL NOT NULL,
  floor      REAL NOT NULL,
  ceiling    REAL NOT NULL,
  components TEXT NOT NULL DEFAULT '{}',
  model      TEXT,
  updated_at INTEGER,
  PRIMARY KEY (league_key, player_id, season, week)
);
CREATE INDEX IF NOT EXISTS idx_proj_week ON projections(league_key, season, week);

-- Positional strength of each NFL defense, expressed as fantasy points allowed
-- above/below the league average to that position.
CREATE TABLE IF NOT EXISTS team_defense (
  nfl_team TEXT NOT NULL,
  season   INTEGER NOT NULL,
  pos      TEXT NOT NULL,
  pts_allowed_over_avg REAL DEFAULT 0,
  sample   INTEGER DEFAULT 0,
  PRIMARY KEY (nfl_team, season, pos)
);

CREATE TABLE IF NOT EXISTS games (
  season      INTEGER NOT NULL,
  week        INTEGER NOT NULL,
  home        TEXT NOT NULL,
  away        TEXT NOT NULL,
  kickoff     INTEGER,
  total       REAL,
  spread      REAL,             -- negative = home favored
  implied_home REAL,
  implied_away REAL,
  roof        TEXT,
  weather     TEXT,
  PRIMARY KEY (season, week, home, away)
);

CREATE TABLE IF NOT EXISTS news (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  player_id   TEXT,
  headline    TEXT NOT NULL,
  body        TEXT,
  source      TEXT,
  url         TEXT,
  impact      REAL,             -- signed multiplier delta on projection, -1..1
  confidence  REAL,
  rationale   TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_player ON news(player_id, ts);

CREATE TABLE IF NOT EXISTS draft_picks (
  league_key TEXT NOT NULL,
  pick       INTEGER NOT NULL,
  round      INTEGER,
  team_key   TEXT,
  player_id  TEXT,
  cost       INTEGER,
  PRIMARY KEY (league_key, pick)
);

CREATE TABLE IF NOT EXISTS adp (
  player_id TEXT NOT NULL,
  season    INTEGER NOT NULL,
  source    TEXT NOT NULL,
  adp       REAL,
  adp_sd    REAL,
  PRIMARY KEY (player_id, season, source)
);

CREATE TABLE IF NOT EXISTS opponent_profiles (
  league_key TEXT NOT NULL,
  team_key   TEXT NOT NULL,
  profile    TEXT NOT NULL,
  updated_at INTEGER,
  PRIMARY KEY (league_key, team_key)
);

-- Cached simulation output so the dashboard is instant and reproducible.
CREATE TABLE IF NOT EXISTS sim_cache (
  league_key TEXT NOT NULL,
  kind       TEXT NOT NULL,
  week       INTEGER NOT NULL,
  seed       INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (league_key, kind, week, seed)
);

-- Every outbound fetch is logged: endpoint, status, timing, bytes. This is what
-- makes "where did this number come from" answerable.
CREATE TABLE IF NOT EXISTS provenance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  status     INTEGER,
  ok         INTEGER,
  bytes      INTEGER,
  ms         INTEGER,
  etag       TEXT,
  note       TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prov_time ON provenance(fetched_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job        TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  ok         INTEGER,
  detail     TEXT
);
