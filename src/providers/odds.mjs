/**
 * Betting market data.
 *
 * The Vegas total and spread are the single most useful pre-kickoff signal
 * available for free: they are the market's aggregate forecast of how many
 * points each offense will score, which is exactly the quantity a fantasy
 * projection needs. We derive implied team totals from them and feed those
 * straight into the game-environment multiplier.
 *
 * Requires a free key from https://the-odds-api.com. Without one, the platform
 * simply reports that market data is unavailable and the environment
 * multiplier stays at 1.0 — it does not invent lines.
 */
import config from '../config.mjs';
import { getJson } from '../util/http.mjs';
import { upsertMany, get, run } from '../db/index.mjs';
import { logger } from '../util/log.mjs';

const log = logger('odds');

/** Odds-API team names -> our abbreviations. */
const TEAM_MAP = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LAR', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
  'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
};

export const abbr = (name) => TEAM_MAP[name] ?? String(name ?? '').slice(0, 3).toUpperCase();

export async function fetchLines({ season, week }) {
  if (!config.oddsApiKey) {
    return { ok: false, reason: 'no ODDS_API_KEY configured', games: 0 };
  }
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/` +
    `?apiKey=${config.oddsApiKey}&regions=us&markets=spreads,totals&oddsFormat=american`;
  const j = await getJson(url, { source: 'odds-api', cache: true, maxAgeMs: 36e5 });
  if (!Array.isArray(j)) return { ok: false, reason: 'odds API returned no data', games: 0 };

  const rows = [];
  for (const g of j) {
    const home = abbr(g.home_team);
    const away = abbr(g.away_team);
    const { spread, total } = consensus(g);
    if (spread == null && total == null) continue;
    // Implied team totals: half the total, shifted by half the spread.
    const impliedHome = total != null && spread != null ? total / 2 - spread / 2 : null;
    const impliedAway = total != null && spread != null ? total / 2 + spread / 2 : null;
    rows.push({
      season, week, home, away,
      kickoff: g.commence_time ? Date.parse(g.commence_time) : null,
      total, spread,
      implied_home: impliedHome != null ? Math.round(impliedHome * 10) / 10 : null,
      implied_away: impliedAway != null ? Math.round(impliedAway * 10) / 10 : null,
      roof: null,
      weather: null,
    });
  }
  if (rows.length) {
    // Preserve any roof/weather already stored for these games.
    for (const r of rows) {
      const existing = get('SELECT roof, weather FROM games WHERE season=? AND week=? AND home=? AND away=?', [r.season, r.week, r.home, r.away]);
      if (existing) { r.roof = existing.roof; r.weather = existing.weather; }
    }
    upsertMany('games', Object.keys(rows[0]), rows, ['season', 'week', 'home', 'away']);
  }
  log.info(`stored lines for ${rows.length} games`);
  return { ok: true, games: rows.length };
}

/** Median spread and total across all books — robust to one book being stale. */
function consensus(game) {
  const spreads = [];
  const totals = [];
  for (const bk of game.bookmakers ?? []) {
    for (const m of bk.markets ?? []) {
      if (m.key === 'spreads') {
        const homeOutcome = (m.outcomes ?? []).find((o) => o.name === game.home_team);
        if (homeOutcome?.point != null) spreads.push(Number(homeOutcome.point));
      }
      if (m.key === 'totals') {
        const over = (m.outcomes ?? []).find((o) => o.name === 'Over');
        if (over?.point != null) totals.push(Number(over.point));
      }
    }
  }
  return { spread: median(spreads), total: median(totals) };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
