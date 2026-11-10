// Live forecast from Open-Meteo (no API key):
//   - Marine API: swell, wind waves, tide and water temperature
//   - Weather API: wind from the best high-resolution regional model
//   - Ensemble API: wind from Google DeepMind's WeatherNext 2, an AI model that
//     runs 64 possible futures; their average is the forecast and their spread
//     tells us how sure it is
//
// All directions are "coming from", in compass degrees.

import { localToLatLon } from '../config/beaches.js';

const MARINE_VARS = [
  'wave_height', 'wave_direction', 'wave_period',
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period', 'swell_wave_peak_period',
  'secondary_swell_wave_height', 'secondary_swell_wave_period', 'secondary_swell_wave_direction',
  'wind_wave_height', 'wind_wave_direction', 'wind_wave_period', 'wind_wave_peak_period',
  'sea_level_height_msl', 'sea_surface_temperature',
];
const WEATHER_VARS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'temperature_2m', 'cloud_cover'];
const AI_MODEL = 'google_weathernext2_ensemble';
export const WIND_SOURCES = [
  { id: 'auto', label: 'Wind: Auto' },
  { id: 'local', label: 'Wind: Hi-res' },
  { id: 'google', label: 'Wind: Google AI' },
];
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

/**
 * Boil the 64-member ensemble down to what we use: per hour, the mean wind
 * (vector average, so 350 and 10 degrees average to north, not south) and the
 * spread of wind speed across members.
 */
export function summariseEnsemble(raw) {
  const h = raw.hourly;
  const speedKeys = Object.keys(h).filter((k) => k.startsWith('wind_speed_10m'));
  const out = { time: h.time, speed: [], direction: [], spread: [], members: speedKeys.length };
  for (let i = 0; i < h.time.length; i++) {
    let u = 0, v = 0, sum = 0, sum2 = 0, n = 0;
    for (const sk of speedKeys) {
      const sp = h[sk][i];
      const dir = h[sk.replace('wind_speed_10m', 'wind_direction_10m')]?.[i];
      if (typeof sp !== 'number' || typeof dir !== 'number') continue;
      const rad = (dir * Math.PI) / 180;
      u += sp * Math.sin(rad); v += sp * Math.cos(rad);
      sum += sp; sum2 += sp * sp; n++;
    }
    if (!n) { out.speed.push(null); out.direction.push(null); out.spread.push(null); continue; }
    const mean = sum / n;
    out.speed.push(+mean.toFixed(1));
    out.direction.push(Math.round(((Math.atan2(u, v) * 180) / Math.PI + 360) % 360));
    out.spread.push(+Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1));
  }
  return out;
}

const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Decide which wind each hour uses.
 *   local  : the high-resolution regional model (sharp on sea breezes, short range)
 *   google : Google WeatherNext 2 ensemble mean (strong on the weather pattern days ahead)
 *   auto   : regional for the first two days, easing over to Google by day four
 * Sets hour.wind = { speed, direction, gust, source, spread } (or null).
 */
export function applyWindSource(hours, mode, reference = new Date()) {
  for (const h of hours) {
    const local = h.windLocal, ai = h.windAI;
    let w = mode === 'google' ? 1 : mode === 'local' ? 0 : sstep(48, 96, (h.time - reference) / 3600000);
    if (!local) w = 1;
    if (!ai) w = 0;
    if (!local && !ai) { h.wind = null; continue; }
    if (w <= 0.02) h.wind = { ...local, source: 'local', spread: ai?.spread ?? null };
    else if (w >= 0.98) h.wind = { ...ai, gust: local?.gust ?? null, source: 'google' };
    else {
      const rad = Math.PI / 180;
      const u = (1 - w) * local.speed * Math.sin(local.direction * rad) + w * ai.speed * Math.sin(ai.direction * rad);
      const v = (1 - w) * local.speed * Math.cos(local.direction * rad) + w * ai.speed * Math.cos(ai.direction * rad);
      h.wind = {
        speed: (1 - w) * local.speed + w * ai.speed,
        direction: ((Math.atan2(u, v) / rad) + 360) % 360,
        gust: local.gust,
        source: 'blend',
        spread: ai.spread,
      };
    }
  }
  return hours;
}

/** Merge the raw API responses into one tidy list of hours. */
export function normalise(marine, weather, aiWind = null) {
  const m = marine.hourly;
  const w = weather?.hourly ?? null;
  const wIndex = new Map();
  if (w) w.time.forEach((t, i) => wIndex.set(t, i));
  const aIndex = new Map();
  if (aiWind) aiWind.time.forEach((t, i) => aIndex.set(t, i));
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
    const ai = aIndex.get(m.time[i]);
    const aiSpeed = ai !== undefined ? num(aiWind.speed[ai]) : null;
    hours.push({
      time: new Date(`${m.time[i]}:00Z`),
      total: { height: total, period: num(m.wave_period[i]), direction: num(m.wave_direction[i]) },
      trains,
      windLocal:
        windSpeed !== null
          ? { speed: windSpeed, direction: num(w.wind_direction_10m[wi]) ?? 0, gust: num(w.wind_gusts_10m[wi]) }
          : null,
      windAI:
        aiSpeed !== null
          ? { speed: aiSpeed, direction: num(aiWind.direction[ai]) ?? 0, gust: null, spread: num(aiWind.spread[ai]) }
          : null,
      wind: null, // chosen by applyWindSource()
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
 * @returns {{ hours, source: 'live' | 'sample', capturedAt: Date, point, windMissing, aiMissing, error? }}
 * Call applyWindSource(hours, mode, capturedAt) on the result to pick the wind.
 */
export async function loadForecast(beach, { forceSample = false } = {}) {
  const point = forecastPoint(beach);
  const cacheKey = `wave-forecast:${beach.id}:v3`;
  const pack = (marine, weather, aiWind, source, capturedAt) => ({
    hours: normalise(marine, weather, aiWind),
    source,
    capturedAt,
    point,
    windMissing: !weather && !aiWind,
    localWindMissing: !weather,
    aiMissing: !aiWind,
  });
  if (!forceSample) {
    const cached = readCache(cacheKey);
    if (cached) return pack(cached.marine, cached.weather, cached.aiWind, 'live', new Date(cached.savedAt));
    const where = `latitude=${point.lat}&longitude=${point.lon}`;
    const when = `forecast_days=${FORECAST_DAYS}&timezone=GMT`;
    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?${where}&hourly=${MARINE_VARS.join(',')}&${when}`;
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?${where}&hourly=${WEATHER_VARS.join(',')}&wind_speed_unit=kmh&${when}`;
    const aiUrl =
      `https://ensemble-api.open-meteo.com/v1/ensemble?${where}&hourly=wind_speed_10m,wind_direction_10m` +
      `&models=${AI_MODEL}&wind_speed_unit=kmh&${when}`;
    try {
      // waves are essential; either wind source may be missing and the app carries on
      const [marine, weather, aiWind] = await Promise.all([
        withRetry(() => getJson(marineUrl)),
        withRetry(() => getJson(weatherUrl)).catch(() => null),
        getJson(aiUrl).then(summariseEnsemble).catch(() => null),
      ]);
      const result = pack(marine, weather, aiWind, 'live', new Date());
      if (!result.hours.length) throw new Error('forecast came back empty');
      if (weather && aiWind) writeCache(cacheKey, { savedAt: Date.now(), marine, weather, aiWind });
      return result;
    } catch (err) {
      return { ...(await loadSample(pack)), error: err.message };
    }
  }
  return loadSample(pack);
}

async function loadSample(pack) {
  const sample = await fetch(`${import.meta.env.BASE_URL}data/sample-forecast.json`).then((r) => r.json());
  return pack(sample.marine, sample.weather, sample.aiWind ?? null, 'sample', new Date(sample.capturedAt));
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
