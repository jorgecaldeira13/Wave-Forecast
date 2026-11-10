import test from 'node:test';
import assert from 'node:assert/strict';
import { wavenumber, celerity, groupVelocity, deepWavelength } from '../src/physics/dispersion.js';
import {
  makeSolverGrid, windBreakingEffect, transformToBoundary, solveTrain, measureSurf, quickBreakHeight, centreProfile, runup,
} from '../src/physics/nearshore.js';
import { loadTerrainNode } from '../src/data/terrain-node.mjs';
import { rate, windRelation, describeSize, crossingSeas } from '../src/model/seaState.js';
import { normalise, summariseEnsemble, applyWindSource } from '../src/data/forecast.js';
import { sunPosition } from '../src/data/sun.js';
import { localToLatLon, latLonToLocal, BEACHES } from '../src/config/beaches.js';
import { readFile } from 'node:fs/promises';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('dispersion relation: deep and shallow limits', () => {
  const T = 10;
  close(celerity(T, 500), (9.81 * T) / (2 * Math.PI), 0.05, 'deep-water speed');
  close(celerity(T, 1), Math.sqrt(9.81 * 1), 0.08, 'shallow-water speed');
  close(groupVelocity(T, 500) / celerity(T, 500), 0.5, 0.01, 'deep cg/c');
  close(groupVelocity(T, 0.5) / celerity(T, 0.5), 1, 0.02, 'shallow cg/c');
  const k = wavenumber(T, 12);
  close((2 * Math.PI / T) ** 2, 9.81 * k * Math.tanh(k * 12), 1e-6, 'solves the dispersion relation');
  close(deepWavelength(12), 224.8, 0.5);
});

test('refraction to the patch edge: straight-on swell keeps its energy, sheltered swell loses it', () => {
  const head = transformToBoundary({ height: 1, period: 12, direction: 238, spread: 20 }, 16, 11, 238);
  close(head.angle, 0, 0.01);
  assert.ok(head.height > 0.95 && head.height < 1.2, `head-on height ${head.height}`);
  const oblique = transformToBoundary({ height: 1, period: 12, direction: 300, spread: 20 }, 16, 11, 238);
  assert.ok(oblique.angle > 0.5 && oblique.angle < 62 * Math.PI / 180, 'refracts towards the beach');
  assert.ok(oblique.height < head.height, 'oblique swell is smaller');
  const behind = transformToBoundary({ height: 1, period: 12, direction: 30, spread: 20 }, 16, 11, 238);
  assert.ok(behind.height < 0.1, `swell from behind the beach barely arrives (${behind.height})`);
});

test('full solve on the baked Praia Nova terrain', async () => {
  const terrain = await loadTerrainNode('praia-nova');
  const grid = makeSolverGrid(terrain, 256);
  const tide = 0.3;
  const edgeDepth = centreProfile(grid).boundaryDepth + tide;
  assert.ok(edgeDepth > 8 && edgeDepth < 16, `offshore edge depth ${edgeDepth}`);
  const b = transformToBoundary({ height: 1.5, period: 12, direction: 270, spread: 20 }, terrain.meta.refDepth, edgeDepth, terrain.meta.seawardBearing);
  const f = solveTrain(grid, tide, b);
  for (const key of ['tau', 'sx', 'sz', 'K', 'Hcrit', 'hcap']) {
    assert.ok(f[key].every(Number.isFinite), `${key} is finite everywhere`);
  }
  // crests take minutes, not hours, to cross a kilometre of shelf
  const mid = (grid.nz >> 1) * grid.nx;
  let shoreI = 0;
  while (shoreI < grid.nx - 1 && f.depth[mid + shoreI] > 0.3) shoreI++;
  const travel = f.tau[mid + shoreI - 1] - f.tau[mid];
  assert.ok(travel > 90 && travel < 400, `travel time to the beach ${travel}s`);
  const surf = measureSurf(grid, f, b.height);
  assert.ok(surf, 'waves break somewhere');
  assert.ok(surf.height > 1.2 && surf.height < 2.8, `breaking height ${surf.height}`);
  close(surf.height / surf.depth, 0.78, 0.2, 'breaks at about 0.78 of the depth');
  assert.ok(surf.breakX < 0 && surf.breakX > -500, `break point ${surf.breakX} m from the waterline`);
  const quick = quickBreakHeight(centreProfile(grid), tide, b);
  close(quick, surf.height, 0.6, 'quick 1-D estimate agrees with the full solve');
  // bigger swell breaks further out
  const big = solveTrain(grid, tide, { ...b, height: 3 });
  assert.ok(measureSurf(grid, big, 3).breakX < surf.breakX - 30);
});

test('run-up grows with swell size', () => {
  assert.ok(runup(2, 12).r2 > runup(1, 12).r2);
  close(runup(1, 10).r2, 0.9, 0.5);
});

test('rating and labels', () => {
  const sb = 238;
  const offshore = { speed: 12, direction: 58 }, onshore = { speed: 30, direction: 238 };
  assert.equal(windRelation(offshore, sb).label, 'Offshore');
  assert.equal(windRelation(onshore, sb).label, 'Onshore');
  assert.ok(rate(1.4, 13, offshore, windRelation(offshore, sb)).score > rate(1.4, 13, onshore, windRelation(onshore, sb)).score);
  assert.equal(rate(0.1, 12, null, null).score, 0);
  assert.equal(describeSize(1.4), 'Chest to head high');
});

test('forecast normalisation reads the saved Open-Meteo sample', async () => {
  const sample = JSON.parse(await readFile(new URL('../public/data/sample-forecast.json', import.meta.url), 'utf8'));
  const hours = normalise(sample.marine, sample.weather);
  assert.ok(hours.length >= 100);
  for (const h of hours) {
    assert.ok(h.trains.length >= 1);
    for (const t of h.trains) assert.ok(t.height > 0 && t.period > 1 && t.direction >= 0 && t.direction <= 360);
    assert.ok(Math.abs(h.tide) < 3);
  }
});

test('geometry helpers', () => {
  const beach = BEACHES['praia-nova'];
  const p = localToLatLon(beach, -400, 250);
  const back = latLonToLocal(beach, p.lat, p.lon);
  close(back.x, -400, 0.01); close(back.z, 250, 0.01);
  // straight out to sea from a WSW-facing beach is south-west of it
  const sea = localToLatLon(beach, -1000, 0);
  assert.ok(sea.lat < beach.lat && sea.lon < beach.lon);
  // midsummer noon sun is high and to the south
  const sun = sunPosition(new Date('2026-06-21T12:40:00Z'), beach.lat, beach.lon);
  close(sun.elevation * 180 / Math.PI, 74.8, 1.5, 'solstice noon elevation');
  close(sun.azimuth * 180 / Math.PI, 180, 12, 'due south');
});

test('Google WeatherNext ensemble is averaged as a vector and keeps its spread', () => {
  const raw = { hourly: {
    time: ['2026-11-10T00:00'],
    wind_speed_10m: [10], wind_direction_10m: [350],
    wind_speed_10m_member01: [20], wind_direction_10m_member01: [10],
  } };
  const s = summariseEnsemble(raw);
  assert.equal(s.members, 2);
  close(s.speed[0], 15, 0.01);
  assert.ok(s.direction[0] < 12 || s.direction[0] > 348, `mean direction near north, got ${s.direction[0]}`);
  close(s.spread[0], 5, 0.01);
});

test('wind source: regional first, Google AI further out, each covers for the other', () => {
  const ref = new Date('2026-11-10T00:00Z');
  const hour = (lead, local, ai) => ({ time: new Date(ref.getTime() + lead * 3600000), windLocal: local, windAI: ai });
  const local = { speed: 10, direction: 90, gust: 20 }, ai = { speed: 30, direction: 90, gust: null, spread: 4 };
  const hours = [hour(6, local, ai), hour(72, local, ai), hour(140, local, ai), hour(6, null, ai), hour(140, local, null), hour(6, null, null)];
  applyWindSource(hours, 'auto', ref);
  assert.equal(hours[0].wind.source, 'local'); close(hours[0].wind.speed, 10, 0.01);
  assert.equal(hours[1].wind.source, 'blend'); close(hours[1].wind.speed, 20, 0.5);
  assert.equal(hours[2].wind.source, 'google'); close(hours[2].wind.speed, 30, 0.01);
  assert.equal(hours[2].wind.gust, 20, 'gusts still come from the regional model');
  assert.equal(hours[3].wind.source, 'google');
  assert.equal(hours[4].wind.source, 'local');
  assert.equal(hours[5].wind, null);
  applyWindSource(hours, 'google', ref);
  assert.equal(hours[0].wind.source, 'google');
  applyWindSource(hours, 'local', ref);
  assert.equal(hours[2].wind.source, 'local');
});

test('wind and breaking: offshore holds waves up, onshore breaks them early (Douglass 1990 direction)', async () => {
  const off = windBreakingEffect(-8), calm = windBreakingEffect(0), on = windBreakingEffect(8);
  assert.ok(off.gamma > calm.gamma && calm.gamma > on.gamma);
  assert.ok(on.s > 0 && off.s < 0);
  close(calm.gamma, 0.78, 1e-9);
  assert.ok(off.gamma < 0.78 * 1.2 && on.gamma > 0.78 * 0.8, 'the effect stays modest');
  const terrain = await loadTerrainNode('praia-nova');
  const grid = makeSolverGrid(terrain, 256);
  const b = transformToBoundary({ height: 1.6, period: 12, direction: 270, spread: 20 }, terrain.meta.refDepth, centreProfile(grid).boundaryDepth + 0.3, terrain.meta.seawardBearing);
  const at = (fx) => measureSurf(grid, solveTrain(grid, 0.3, b, fx.gamma), b.height, { windS: fx.s });
  const sOff = at(off), sOn = at(on);
  assert.ok(sOn.breakX < sOff.breakX, `onshore wind breaks further out (${sOn.breakX} vs ${sOff.breakX})`);
  assert.ok(sOff.height / sOff.depth > sOn.height / sOn.depth, 'higher height-to-depth ratio with offshore wind');
  assert.ok(sOff.iribarren > sOn.iribarren, 'offshore wind pushes the breaker type towards plunging');
});

test('crossing seas need a real wind sea at a real angle', () => {
  const mk = (swellDir, seaDir, seaH) => ({ trains: [
    { kind: 'swell', height: 2, period: 12, direction: swellDir },
    { kind: 'wind', height: seaH, period: 6, direction: seaDir } ] });
  assert.ok(crossingSeas(mk(270, 275, 1.5)) < 0.05, 'aligned systems do not cross');
  assert.ok(crossingSeas(mk(270, 330, 1.5)) > 0.9, 'sixty degrees apart with a decent wind sea');
  assert.equal(crossingSeas(mk(270, 330, 0.2)), 0, 'a tiny wind sea does not count');
});
