/**
 * Stadium weather via Open-Meteo (free, keyless).
 *
 * Only wind and precipitation get applied to projections, and only for outdoor
 * stadiums — those are the conditions with a measurable, repeatable effect on
 * passing and kicking. Temperature is deliberately ignored: the "cold weather
 * kills offenses" folk wisdom does not survive contact with the data.
 */
import { getJson } from '../util/http.mjs';
import { all, run, get } from '../db/index.mjs';
import { logger } from '../util/log.mjs';

const log = logger('weather');

/** Stadium coordinates and roof type by home team. */
export const STADIUMS = {
  ARI: { lat: 33.5277, lon: -112.2626, roof: 'retractable' },
  ATL: { lat: 33.7554, lon: -84.4008, roof: 'retractable' },
  BAL: { lat: 39.2780, lon: -76.6227, roof: 'outdoor' },
  BUF: { lat: 42.7738, lon: -78.7870, roof: 'outdoor' },
  CAR: { lat: 35.2258, lon: -80.8528, roof: 'outdoor' },
  CHI: { lat: 41.8623, lon: -87.6167, roof: 'outdoor' },
  CIN: { lat: 39.0955, lon: -84.5160, roof: 'outdoor' },
  CLE: { lat: 41.5061, lon: -81.6995, roof: 'outdoor' },
  DAL: { lat: 32.7473, lon: -97.0945, roof: 'retractable' },
  DEN: { lat: 39.7439, lon: -105.0201, roof: 'outdoor' },
  DET: { lat: 42.3400, lon: -83.0456, roof: 'dome' },
  GB:  { lat: 44.5013, lon: -88.0622, roof: 'outdoor' },
  HOU: { lat: 29.6847, lon: -95.4107, roof: 'retractable' },
  IND: { lat: 39.7601, lon: -86.1639, roof: 'retractable' },
  JAX: { lat: 30.3239, lon: -81.6373, roof: 'outdoor' },
  KC:  { lat: 39.0489, lon: -94.4839, roof: 'outdoor' },
  LAC: { lat: 33.9535, lon: -118.3392, roof: 'dome' },
  LAR: { lat: 33.9535, lon: -118.3392, roof: 'dome' },
  LV:  { lat: 36.0909, lon: -115.1833, roof: 'dome' },
  MIA: { lat: 25.9580, lon: -80.2389, roof: 'outdoor' },
  MIN: { lat: 44.9736, lon: -93.2575, roof: 'dome' },
  NE:  { lat: 42.0909, lon: -71.2643, roof: 'outdoor' },
  NO:  { lat: 29.9511, lon: -90.0812, roof: 'dome' },
  NYG: { lat: 40.8135, lon: -74.0745, roof: 'outdoor' },
  NYJ: { lat: 40.8135, lon: -74.0745, roof: 'outdoor' },
  PHI: { lat: 39.9008, lon: -75.1675, roof: 'outdoor' },
  PIT: { lat: 40.4468, lon: -80.0158, roof: 'outdoor' },
  SEA: { lat: 47.5952, lon: -122.3316, roof: 'outdoor' },
  SF:  { lat: 37.4033, lon: -121.9694, roof: 'outdoor' },
  TB:  { lat: 27.9759, lon: -82.5033, roof: 'outdoor' },
  TEN: { lat: 36.1665, lon: -86.7713, roof: 'outdoor' },
  WAS: { lat: 38.9077, lon: -76.8645, roof: 'outdoor' },
};

/**
 * Fetch the forecast at kickoff for each outdoor game in a week and store it
 * alongside the game row.
 */
export async function fetchWeather({ season, week }) {
  const games = all('SELECT season, week, home, away, kickoff FROM games WHERE season = ? AND week = ?', [season, week]);
  if (!games.length) return { ok: false, reason: 'no games stored for this week', updated: 0 };

  let updated = 0;
  for (const g of games) {
    const stadium = STADIUMS[g.home];
    if (!stadium) continue;
    if (stadium.roof === 'dome') {
      run('UPDATE games SET roof = ?, weather = ? WHERE season=? AND week=? AND home=? AND away=?',
        ['dome', JSON.stringify({ indoor: true }), g.season, g.week, g.home, g.away]);
      updated++;
      continue;
    }
    const kickoff = g.kickoff ? new Date(Number(g.kickoff)) : null;
    if (!kickoff || Number.isNaN(kickoff.getTime())) continue;
    const date = kickoff.toISOString().slice(0, 10);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${stadium.lat}&longitude=${stadium.lon}` +
      `&hourly=temperature_2m,precipitation,wind_speed_10m&wind_speed_unit=mph&temperature_unit=fahrenheit` +
      `&start_date=${date}&end_date=${date}`;
    const j = await getJson(url, { source: 'open-meteo', cache: true, maxAgeMs: 6 * 36e5 });
    if (!j?.hourly?.time) continue;

    const hour = kickoff.getUTCHours();
    const idx = j.hourly.time.findIndex((t) => Number(t.slice(11, 13)) === hour);
    const i = idx >= 0 ? idx : Math.min(13, j.hourly.time.length - 1);
    const weather = {
      temp_f: j.hourly.temperature_2m?.[i] ?? null,
      wind_mph: j.hourly.wind_speed_10m?.[i] ?? null,
      precip_mm: j.hourly.precipitation?.[i] ?? null,
      source: 'open-meteo',
      fetched_at: Date.now(),
    };
    run('UPDATE games SET roof = ?, weather = ? WHERE season=? AND week=? AND home=? AND away=?',
      [stadium.roof, JSON.stringify(weather), g.season, g.week, g.home, g.away]);
    updated++;
  }
  log.info(`weather updated for ${updated} games`);
  return { ok: true, updated };
}
