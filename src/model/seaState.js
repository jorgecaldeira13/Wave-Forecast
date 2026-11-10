// Turns one forecast hour into what you would actually see at the beach:
// the solved wave fields for the renderer plus a human summary.

import { buildSpectrum, buildEnvelope } from '../physics/spectrum.js';
import {
  makeSolverGrid,
  windBreakingEffect,
  transformToBoundary,
  solveTrain,
  measureSurf,
  runup,
  centreProfile,
  quickBreakHeight,
} from '../physics/nearshore.js';

const DEG = Math.PI / 180;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export function buildContext(terrain, calibration = null) {
  const grid = makeSolverGrid(terrain, 256);
  return {
    grid,
    profile: centreProfile(grid),
    refDepth: terrain.meta.refDepth,
    seawardBearing: terrain.meta.seawardBearing,
    // per-beach corrections from comparing the model with reality (see README, "Calibrating")
    calibration: { height: 1, breakIndex: 1, ...(calibration ?? {}) },
  };
}

/** Wave trains at the offshore edge of the patch, strongest first. */
function boundaryTrains(ctx, hour) {
  const edgeDepth = Math.max(ctx.profile.boundaryDepth + hour.tide, 2);
  const gain = ctx.calibration?.height ?? 1;
  return hour.trains
    .map((train) => ({
      ...transformToBoundary({ ...train, height: train.height * gain }, ctx.refDepth, edgeDepth, ctx.seawardBearing),
      kind: train.kind,
      offshore: train,
    }))
    .filter((b) => b.height > 0.03)
    .sort((a, b) => b.height ** 2 * b.period - a.height ** 2 * a.period);
}

/** How the wind sits relative to the beach. onshore: +1 from the sea, -1 from the land. */
export function windRelation(wind, seawardBearing) {
  if (!wind) return null;
  const rel = wrap180(wind.direction - seawardBearing);
  const onshore = Math.cos(rel * DEG);
  let label;
  if (wind.speed < 6) label = 'Glassy';
  else if (onshore < -0.7) label = 'Offshore';
  else if (onshore < -0.25) label = 'Cross-offshore';
  else if (onshore <= 0.25) label = 'Cross-shore';
  else if (onshore <= 0.7) label = 'Cross-onshore';
  else label = 'Onshore';
  return { onshore, label, rel };
}

/** Wind's grip on breaking waves for this hour (see windBreakingEffect). */
export function windEffect(wind, relation, trains) {
  if (!wind || !relation) return { s: 0, gamma: windBreakingEffect(0).gamma, label: null };
  const crossMs = (wind.speed / 3.6) * relation.onshore;
  const hb = Math.max(0.8, (trains[0]?.height ?? 1) / 0.7);
  const fx = windBreakingEffect(crossMs, hb);
  const label =
    wind.speed < 8 || Math.abs(fx.s) < 0.25 ? null
      : fx.s > 0 ? 'onshore wind breaks the waves early and soft'
      : 'offshore wind holds the faces up: later, steeper breaks';
  return { ...fx, label };
}

/**
 * Wind sea and swell from clearly different directions ("crossing seas") make a
 * lumpier, less organised surface: the two systems interact nonlinearly, most
 * strongly when they meet at roughly 40-60 degrees (see README, "The science").
 * @returns 0..1
 */
export function crossingSeas(hour) {
  const swell = hour.trains.find((t) => t.kind === 'swell');
  const sea = hour.trains.find((t) => t.kind === 'wind');
  if (!swell || !sea || sea.height < 0.4) return 0;
  const angle = Math.abs(wrap180(swell.direction - sea.direction));
  const t = Math.min(1, Math.max(0, (angle - 20) / 40));
  return t * t * (3 - 2 * t) * Math.min(1, sea.height / 1.2);
}

/** 0 = groomed lines, 1 = blown-out mess. Drives the look of the water. */
function messiness(wind, relation) {
  if (!wind || !relation) return 0.12;
  const v = wind.speed;
  if (v < 6) return 0.02;
  const side = relation.onshore > 0 ? 1 : 0.25 + 0.2 * (1 - Math.abs(relation.onshore));
  return Math.min(1, (v / 38) * side + (v > 45 ? 0.2 : 0));
}

export function describeSize(h) {
  if (h < 0.25) return 'Flat';
  if (h < 0.5) return 'Ankle to knee high';
  if (h < 0.85) return 'Knee to waist high';
  if (h < 1.2) return 'Waist to chest high';
  if (h < 1.6) return 'Chest to head high';
  if (h < 2.2) return 'Head high to overhead';
  if (h < 3.0) return 'Well overhead';
  return 'Double overhead or bigger';
}

const RATING_LABELS = ['Flat', 'Poor', 'Poor to fair', 'Fair', 'Good', 'Very good', 'Epic'];

/** A simple, explainable 0..5 score. Heuristic: tune it to taste. */
export function rate(surfHeight, period, wind, relation) {
  const h = surfHeight;
  const seg = (x, x0, x1, y0, y1) => y0 + ((y1 - y0) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0))));
  let score;
  if (h < 0.3) score = 0;
  else if (h < 0.6) score = seg(h, 0.3, 0.6, 0.6, 1.6);
  else if (h < 1.0) score = seg(h, 0.6, 1.0, 1.6, 3.0);
  else if (h < 2.0) score = seg(h, 1.0, 2.0, 3.0, 3.5);
  else if (h < 3.0) score = seg(h, 2.0, 3.0, 3.5, 2.4); // a beach break starts closing out
  else score = seg(h, 3.0, 4.5, 2.4, 1.0);
  if (score > 0) {
    if (period >= 13) score += 0.6;
    else if (period >= 10) score += 0.3;
    else if (period < 7) score -= 0.8;
    if (wind && relation) {
      const v = wind.speed;
      if (v < 6) score += 0.7;
      else if (relation.onshore < -0.25) score += v < 25 ? 0.7 : v < 40 ? 0.3 : -0.5;
      else if (relation.onshore <= 0.25) score -= 0.4 * (v / 20);
      else score -= Math.min(2.5, (v / 12) * relation.onshore);
    }
  }
  score = Math.round(Math.min(5, Math.max(0, score)) * 2) / 2;
  const label = h < 0.3 ? RATING_LABELS[0] : RATING_LABELS[Math.min(6, Math.max(1, Math.round(score) + 1))];
  return { score, label };
}

/** Fast summary for every hour of the week (1-D profile, no field solve). */
export function quickSeaState(ctx, hour) {
  const trains = boundaryTrains(ctx, hour);
  if (!trains.length) return { surfHeight: 0, rating: { score: 0, label: 'Flat' } };
  const combined = Math.hypot(...trains.map((t) => t.height));
  const relation = windRelation(hour.wind, ctx.seawardBearing);
  const fx = windEffect(hour.wind, relation, trains);
  fx.gamma *= ctx.calibration.breakIndex;
  const surfHeight = quickBreakHeight(ctx.profile, hour.tide, { ...trains[0], height: combined }, fx.gamma);
  return { surfHeight, rating: rate(surfHeight, trains[0].period, hour.wind, relation) };
}

/** Full solve for the hour being shown. */
export function computeSeaState(ctx, hour) {
  const trains = boundaryTrains(ctx, hour).slice(0, 2);
  const relation = windRelation(hour.wind, ctx.seawardBearing);
  const fx = windEffect(hour.wind, relation, trains);
  fx.gamma *= ctx.calibration.breakIndex;
  const solved = trains.map((b) => ({ ...b, field: solveTrain(ctx.grid, hour.tide, b, fx.gamma) }));
  const crossing = crossingSeas(hour);
  let surf = null, sets = null, wash = { setup: 0, swash: 0, r2: 0 };
  if (solved.length) {
    const primary = solved[0];
    const combined = Math.hypot(...solved.map((t) => t.height));
    surf = measureSurf(ctx.grid, primary.field, combined, { windS: fx.s });
    sets = measureSurf(ctx.grid, primary.field, combined * 1.3, { windS: fx.s });
    wash = runup(combined, primary.period);
  }
  const surfHeight = surf?.height ?? 0;
  // the wind-sea train, if any, becomes a JONSWAP/TMA directional spectrum
  const sea = solved.find((t) => t.kind === 'wind');
  const spectrum = sea
    ? buildSpectrum({ Hs: sea.height, Tp: sea.period, angle: sea.angle, depth: sea.field.boundaryDepth })
    : { comps: [], hs: 0 };
  return {
    hour,
    spectrum,
    envelope: solved.length ? buildEnvelope({ period: solved[0].period, kind: solved[0].kind }) : [],
    trains: solved,
    surf,
    setHeight: sets?.height ?? surfHeight,
    setBreakX: sets?.breakX ?? surf?.breakX ?? -120,
    surfHeight,
    sizeLabel: describeSize(surfHeight),
    runup: wash,
    wind: hour.wind,
    windRelation: relation,
    mess: Math.min(1, messiness(hour.wind, relation) + 0.25 * crossing),
    windEffect: fx,
    crossing,
    rating: rate(surfHeight, solved[0]?.period ?? 0, hour.wind, relation),
    tide: hour.tide,
  };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassPoint = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
