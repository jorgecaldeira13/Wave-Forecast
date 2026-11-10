#!/usr/bin/env node
// Maps where waves break from free Sentinel-2 satellite images (10 m pixels,
// a new pass every few days). White water marks shallow sandbars, so counting
// how often each spot is white across many clear days gives a map of the bars
// that follows the sand as it moves. The result feeds scripts/bake-beach.mjs.
//
// Data: Copernicus Sentinel-2 L2A via the open Earth Search catalogue (no key).
// Usage: npm run sentinel -- [beach-id] [--scenes 12] [--debug out.png]
// Behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { fromUrl } from 'geotiff';
import { BEACHES, DEFAULT_BEACH, localToLatLon } from '../src/config/beaches.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flagValues = new Set(['scenes', 'debug'].map((n) => opt(n, null)).filter(Boolean));
const beachId = args.find((a) => !a.startsWith('--') && !flagValues.has(a)) ?? DEFAULT_BEACH;
const beach = BEACHES[beachId];
if (!beach) throw new Error(`Unknown beach "${beachId}"`);
const WANT = Number(opt('scenes', 12));
const debugOut = opt('debug', null);

const CELL = 10; // metres, the satellite's pixel size
const { offshore, inland, alongshore } = beach.domain;
const NX = Math.round((offshore + inland) / CELL) + 1;
const NZ = Math.round(alongshore / CELL) + 1;
const xAt = (i) => -offshore + i * CELL;
const zAt = (j) => -alongshore / 2 + j * CELL;

/** WGS84 lat/lon -> UTM easting/northing for a given zone (northern hemisphere). */
function toUtm(lat, lon, zone) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = (lat * Math.PI) / 180, lam = ((lon - (zone * 6 - 183)) * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = lam * Math.cos(phi);
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const east = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const north = k0 * (M + N * Math.tan(phi) * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return [east, north];
}

async function searchScenes() {
  const end = new Date(), start = new Date(end.getTime() - 200 * 86400000);
  const body = {
    collections: ['sentinel-2-l2a'],
    intersects: { type: 'Point', coordinates: [beach.lon, beach.lat] },
    datetime: `${start.toISOString()}/${end.toISOString()}`,
    query: { 'eo:cloud_cover': { lt: 12 } },
    limit: 60,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };
  const res = await fetch('https://earth-search.aws.element84.com/v1/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`catalogue search failed: HTTP ${res.status}`);
  const seen = new Set();
  // one image per day is enough (overlapping orbits give duplicates)
  return (await res.json()).features.filter((f) => {
    const day = f.properties.datetime.slice(0, 10);
    if (seen.has(day)) return false;
    seen.add(day);
    return true;
  });
}

/** Read one band of one scene, resampled onto the beach's local 10 m grid. */
async function readBand(href, zone, scale = 1) {
  const tiff = await fromUrl(href);
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin();
  const [rx] = image.getResolution();
  const res = Math.abs(rx);
  // window that covers the rotated patch
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const [x, z] of [[-offshore, -alongshore / 2], [-offshore, alongshore / 2], [inland, -alongshore / 2], [inland, alongshore / 2]]) {
    const { lat, lon } = localToLatLon(beach, x, z);
    const [e, n] = toUtm(lat, lon, zone);
    minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n);
  }
  const c0 = Math.max(0, Math.floor((minE - ox) / res) - 1), c1 = Math.min(image.getWidth(), Math.ceil((maxE - ox) / res) + 2);
  const r0 = Math.max(0, Math.floor((oy - maxN) / res) - 1), r1 = Math.min(image.getHeight(), Math.ceil((oy - minN) / res) + 2);
  const [data] = await image.readRasters({ window: [c0, r0, c1, r1] });
  const w = c1 - c0;
  const out = new Float32Array(NX * NZ);
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const { lat, lon } = localToLatLon(beach, xAt(i), zAt(j));
      const [e, n] = toUtm(lat, lon, zone);
      const c = Math.floor((e - ox) / res) - c0, r = Math.floor((oy - n) / res) - r0;
      out[j * NX + i] = data[r * w + c] * scale;
    }
  }
  return out;
}

// ------------------------------------------------------------------- main
const outDir = path.join(ROOT, 'public', 'data', beach.id);
// which cells are sea, from the last terrain bake (512 grid -> 10 m grid)
let seaMask = null;
try {
  const meta = JSON.parse(await readFile(path.join(outDir, 'meta.json'), 'utf8'));
  const mask = await readFile(path.join(outDir, 'mask.bin'));
  seaMask = new Uint8Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const bi = Math.min(meta.grid.nx - 1, Math.round((xAt(i) + offshore) / meta.grid.dx));
    const bj = Math.min(meta.grid.nz - 1, Math.round((zAt(j) + alongshore / 2) / meta.grid.dz));
    seaMask[j * NX + i] = mask[bj * meta.grid.nx + bi] === 0 ? 1 : 0;
  }
} catch { /* first run: fall back to the satellite's own water test */ }

const scenes = await searchScenes();
console.log(`catalogue: ${scenes.length} clear days in the last 200`);
const foamCount = new Float32Array(NX * NZ);
const used = [];
let lastRgb = null;
for (const scene of scenes) {
  if (used.length >= WANT) break;
  const zone = Number(String(scene.properties['proj:epsg'] ?? scene.properties['proj:code'] ?? '32629').replace(/\D/g, '').slice(-2));
  try {
    const a = scene.assets;
    const [scl, red, green, blue, nir] = await Promise.all([
      readBand(a.scl.href, zone), // scene classification, 20 m
      readBand(a.red.href, zone), readBand(a.green.href, zone), readBand(a.blue.href, zone), readBand(a.nir.href, zone),
    ]);
    // skip days with cloud or cloud shadow over the patch
    let cloudy = 0;
    for (let k = 0; k < scl.length; k++) if ([3, 8, 9, 10].includes(scl[k])) cloudy++;
    if (cloudy / scl.length > 0.03) { console.log(`  skip ${scene.id}: cloud over the beach`); continue; }
    // digital numbers -> reflectance (offset applies to processing baseline 04.00 and later)
    const refl = (v) => (v - 1000) / 10000;
    let foamCells = 0;
    const foamNow = new Uint8Array(NX * NZ);
    for (let k = 0; k < NX * NZ; k++) {
      const r = refl(red[k]), b = refl(blue[k]);
      const n = refl(nir[k]), vis = (r + refl(green[k]) + b) / 3;
      const water = seaMask ? seaMask[k] === 1 : n < 0.12;
      // Open water is nearly black in near-infrared; foam is bright and white.
      // Sand is bright too, but warm (more red than blue) and much brighter in
      // near-infrared, so it is excluded even where the waterline has moved.
      const sandy = r > b * 1.12 || n > 0.2;
      if (water && !sandy && n > 0.055 && vis > 0.085) { foamNow[k] = 1; foamCells++; }
    }
    // a flat day teaches us nothing about where the bars are
    if (foamCells < 25) { console.log(`  skip ${scene.id}: no surf that day`); continue; }
    for (let k = 0; k < NX * NZ; k++) foamCount[k] += foamNow[k];
    used.push({ id: scene.id, date: scene.properties.datetime.slice(0, 10), foamCells });
    lastRgb = { red, green, blue, refl };
    console.log(`  used ${scene.id}  white-water cells: ${foamCells}`);
  } catch (err) {
    console.log(`  skip ${scene.id}: ${err.message}`);
  }
}
if (used.length < 3) throw new Error(`only ${used.length} usable scenes; need at least 3`);

const freq = new Uint8Array(NX * NZ);
for (let k = 0; k < freq.length; k++) freq[k] = Math.round((foamCount[k] / used.length) * 255);
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'sentinel-foam.bin'), Buffer.from(freq.buffer));
await writeFile(path.join(outDir, 'sentinel.json'), JSON.stringify({
  note: 'How often each 10 m cell showed white water in recent clear Sentinel-2 images. Used by the terrain bake to place sandbars.',
  source: 'Copernicus Sentinel-2 L2A via Earth Search (element84)',
  grid: { nx: NX, nz: NZ, cell: CELL, x0: -offshore, z0: -alongshore / 2 },
  encoding: 'uint8, 255 = white water in every scene, index = j * nx + i',
  scenes: used,
  updatedAt: new Date().toISOString(),
}, null, 2) + '\n');
console.log(`wrote sentinel-foam.bin from ${used.length} scenes (${used[used.length - 1].date} to ${used[0].date})`);

if (debugOut && lastRgb) {
  const img = Buffer.alloc(NX * NZ * 3);
  const { red, green, blue, refl } = lastRgb;
  for (let k = 0; k < NX * NZ; k++) {
    const tone = (v) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(refl(v), 0) * 3.2, 0.7) * 255)));
    let c = [tone(red[k]), tone(green[k]), tone(blue[k])];
    const f = freq[k] / 255;
    if (f > 0.08) c = [Math.round(c[0] * (1 - f) + 255 * f), Math.round(c[1] * (1 - f) + 40 * f), Math.round(c[2] * (1 - f) + 200 * f)];
    img.set(c, k * 3);
  }
  await sharp(img, { raw: { width: NX, height: NZ, channels: 3 } }).resize(NX * 4, NZ * 4, { kernel: 'nearest' }).png().toFile(debugOut);
  console.log('debug image ->', debugOut);
}
