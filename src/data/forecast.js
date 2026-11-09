// Live forecast from Open-Meteo (no API key): the Marine API for swell, wind
// waves, tide and water temperature, the Weather API for wind.
//
// Open-Meteo wave directions are "coming from", in compass degrees.

import { localToLatLon } from '../config/beaches.js';

const MARINE_VARS = [
  'wave_height', 'wave_direction', 'wave_period',
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period', 'swell_wave_peak_period',
  'secondary_swell_wave_height', 'secondary_swell_wave_period', 'secondary_swell_wave_direction',
  'wind_wave_height', 'wind_wave_direction', 'wind_wave_period', 'wind_wave_peak_period',
  'sea_level_height_msl', 'sea_surface_temperature',
];
const WEATHER_VARS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'temperature_2m', 'cloud_cover'];
const CACHE_MINUTES = 30;
const FORECAST_DAYS = 7;

/** The sea point the forecast is requested for: a few km straight out. */
export function forecastPoint(beach) {
  const p = localToLatLon(beach, -4000, 0);
  return { lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4) };
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) throw new Error(body?.reason ?? `HTTP ${res.status}`);
  return body;
}

async function withRetry(fn, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Merge the two raw API responses into one tidy list of hours. */
export function normalise(marine, weather) {
  const m = marine.hourly;
  const w = weather?.hourly ?? null;
  const wIndex = new Map();
  if (w) w.time.forEach((t, i) => wIndex.set(t, i));
  const hours = [];
  for (let i = 0; i < m.time.length; i++) {
    const total = num(m.wave_height[i]);
    if (total === null) continue;
    const trains = [];
    const swellH = num(m.swell_wave_height?.[i]);
    if (swellH !== null && swellH > 0.02) {
      const mean = num(m.swell_wave_period?.[i]);
      trains.push({
        kind: 'swell',
        height: swellH,
        period: num(m.swell_wave_peak_period?.[i]) ?? (mean !== null ? mean * 1.2 : 10),
        direction: num(m.swell_wave_direction?.[i]) ?? num(m.wave_direction[i]) ?? 270,
        spread: 20,
      });
    }
    const swell2H = num(m.secondary_swell_wave_height?.[i]);
    if (swell2H !== null && swell2H > 0.05) {
      trains.push({
        kind: 'swell2',
        height: swell2H,
        period: num(m.secondary_swell_wave_period?.[i]) ?? 9,
        direction: num(m.secondary_swell_wave_direction?.[i]) ?? 270,
        spread: 18,
      });
    }
    const windH = num(m.wind_wave_height?.[i]);
    if (windH !== null && windH > 0.05) {
      const mean = num(m.wind_wave_period?.[i]);
      trains.push({
        kind: 'wind',
        height: windH,
        period: Math.max(2.5, num(m.wind_wave_peak_period?.[i]) ?? (mean !== null ? mean * 1.2 : 5)),
        direction: num(m.wind_wave_direction?.[i]) ?? 270,
        spread: 6,
      });
    }
    if (!trains.length) {
      trains.push({
        kind: 'swell',
        height: total,
        period: (num(m.wave_period[i]) ?? 8) * 1.2,
        direction: num(m.wave_direction[i]) ?? 270,
        spread: 14,
      });
    }
    const wi = wIndex.get(m.time[i]);
    const windSpeed = wi !== undefined ? num(w.wind_speed_10m[wi]) : null;
    hours.push({
      time: new Date(`${m.time[i]}:00Z`),
      total: { height: total, period: num(m.wave_period[i]), direction: num(m.wave_direction[i]) },
      trains,
      wind:
        windSpeed !== null
          ? { speed: windSpeed, direction: num(w.wind_direction_10m[wi]) ?? 0, gust: num(w.wind_gusts_10m[wi]) }
          : null,
      tide: num(m.sea_level_height_msl?.[i]) ?? 0,
      waterTemp: num(m.sea_surface_temperature?.[i]),
      airTemp: wi !== undefined ? num(w.temperature_2m[wi]) : null,
      cloud: wi !== undefined ? num(w.cloud_cover[wi]) : null,
    });
  }
  return hours;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.savedAt > CACHE_MINUTES * 60000) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(key, entry) {
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    /* storage unavailable: fine, we just refetch next time */
  }
}

/**
 * @returns {{ hours, source: 'live' | 'sample', capturedAt: Date, point, windMissing, error? }}
 */
export async function loadForecast(beach, { forceSample = false } = {}) {
  const point = forecastPoint(beach);
  const cacheKey = `wave-forecast:${beach.id}:v2`;
  if (!forceSample) {
    const cached = readCache(cacheKey);
    if (cached) {
      return {
        hours: normalise(cached.marine, cached.weather),
        source: 'live',
        capturedAt: new Date(cached.savedAt),
        point,
        windMissing: !cached.weather,
      };
    }
    const marineUrl =
      `https://marine-api.open-meteo.com/v1/marine?latitude=${point.lat}&longitude=${point.lon}` +
      `&hourly=${MARINE_VARS.join(',')}&forecast_days=${FORECAST_DAYS}&timezone=GMT`;
    const weatherUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${point.lat}&longitude=${point.lon}` +
      `&hourly=${WEATHER_VARS.join(',')}&wind_speed_unit=kmh&forecast_days=${FORECAST_DAYS}&timezone=GMT`;
    try {
      const [marine, weather] = await Promise.all([
        withRetry(() => getJson(marineUrl)),
        withRetry(() => getJson(weatherUrl)).catch(() => null), // waves still work without wind
      ]);
      const hours = normalise(marine, weather);
      if (!hours.length) throw new Error('forecast came back empty');
      if (weather) writeCache(cacheKey, { savedAt: Date.now(), marine, weather });
      return { hours, source: 'live', capturedAt: new Date(), point, windMissing: !weather };
    } catch (err) {
      const sample = await loadSample();
      return { ...sample, point, error: err.message };
    }
  }
  return { ...(await loadSample()), point };
}

async function loadSample() {
  const sample = await fetch(`${import.meta.env.BASE_URL}data/sample-forecast.json`).then((r) => r.json());
  return {
    hours: normalise(sample.marine, sample.weather),
    source: 'sample',
    capturedAt: new Date(sample.capturedAt),
    windMissing: !sample.weather,
  };
}

/** Index of the hour closest to `date`. */
export function nearestHourIndex(hours, date = new Date()) {
  let best = 0, bestD = Infinity;
  hours.forEach((h, i) => {
    const d = Math.abs(h.time - date);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
