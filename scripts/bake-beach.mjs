#!/usr/bin/env node
// Bakes the 3D terrain of a beach from open data:
//
//   1. Satellite imagery (Esri World Imagery) -> where is sea, sand, rock, foam?
//      The waterline and the groynes are traced from the picture itself.
//   2. EMODnet bathymetry (1/16 arc-minute, ~115 m) -> the real seabed slope.
//   3. Close to shore, where no open survey resolves the sandbars, a Dean
//      equilibrium profile is blended in and nudged by where the satellite
//      shows waves breaking (foam = shallow water).
//
// Output: public/data/<beach>/{meta.json,height.bin,mask.bin}
// Usage:  npm run bake -- [beach-id] [--debug out.png]
//
// Behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { fromArrayBuffer } from 'geotiff';
import {
  BEACHES,
  DEFAULT_BEACH,
  localToLatLon,
  latLonToTile,
  SATELLITE_TILE_URL,
} from '../src/config/beaches.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const debugIdx = args.indexOf('--debug');
const debugOut = debugIdx >= 0 ? args[debugIdx + 1] : null;
const beachId = args.find((a, i) => !a.startsWith('--') && (debugIdx < 0 || i !== debugIdx + 1)) ?? DEFAULT_BEACH;
const beach = BEACHES[beachId];
if (!beach) throw new Error(`Unknown beach "${beachId}"`);

const ZOOM = 17;
const { nx: NX, nz: NZ } = beach.grid;
const { offshore, inland, alongshore } = beach.domain;
const DX = (offshore + inland) / (NX - 1);
const DZ = alongshore / (NZ - 1);
const xAt = (i) => -offshore + i * DX;
const zAt = (j) => -alongshore / 2 + j * DZ;
const idx = (i, j) => j * NX + i;

async function fetchBuffer(url, tries = 5) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** t));
    }
  }
  throw lastErr;
}

const smoothstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- satellite
async function loadSatellite() {
  // Bounding box of the rotated domain in tile space.
  const corners = [
    [-offshore, -alongshore / 2],
    [-offshore, alongshore / 2],
    [inland, -alongshore / 2],
    [inland, alongshore / 2],
  ].map(([x, z]) => {
    const { lat, lon } = localToLatLon(beach, x, z);
    return latLonToTile(lat, lon, ZOOM);
  });
  const tx0 = Math.floor(Math.min(...corners.map((c) => c.x)));
  const tx1 = Math.floor(Math.max(...corners.map((c) => c.x)));
  const ty0 = Math.floor(Math.min(...corners.map((c) => c.y)));
  const ty1 = Math.floor(Math.max(...corners.map((c) => c.y)));
  const W = (tx1 - tx0 + 1) * 256;
  const H = (ty1 - ty0 + 1) * 256;
  const rgb = new Uint8Array(W * H * 3);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  console.log(`satellite: ${jobs.length} tiles at z${ZOOM}`);
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < jobs.length) {
        const [tx, ty] = jobs[next++];
        const buf = await fetchBuffer(SATELLITE_TILE_URL(ZOOM, tx, ty));
        const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        if (info.width !== 256 || info.height !== 256) throw new Error('unexpected tile size');
        for (let r = 0; r < 256; r++) {
          const dst = ((ty - ty0) * 256 + r) * W * 3 + (tx - tx0) * 256 * 3;
          rgb.set(data.subarray(r * 768, (r + 1) * 768), dst);
        }
      }
    }),
  );
  /** Mean colour of a small window around a local point. */
  const sample = (x, z) => {
    const { lat, lon } = localToLatLon(beach, x, z);
    const t = latLonToTile(lat, lon, ZOOM);
    const px = Math.round((t.x - tx0) * 256);
    const py = Math.round((t.y - ty0) * 256);
    let r = 0, g = 0, b = 0, n = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const qx = Math.min(W - 1, Math.max(0, px + ox));
        const qy = Math.min(H - 1, Math.max(0, py + oy));
        const o = (qy * W + qx) * 3;
        r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  };
  return { sample };
}

// --------------------------------------------------------------- bathymetry
async function loadBathymetry() {
  const pad = 0.07; // degrees, wide enough to reach the forecast grid point
  const lat0 = beach.lat - pad, lat1 = beach.lat + pad;
  const lon0 = beach.lon - pad * 1.4, lon1 = beach.lon + pad * 0.6;
  const url =
    'https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage' +
    `&coverageId=emodnet__mean&format=image/tiff&subset=Lat(${lat0},${lat1})&subset=Long(${lon0},${lon1})`;
  const buf = await fetchBuffer(url);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const image = await tiff.getImage();
  const [data] = await image.readRasters();
  const W = image.getWidth(), H = image.getHeight();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  console.log(`bathymetry: ${W}x${H} cells from EMODnet`);
  const at = (c, r) => {
    const v = data[Math.min(H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, c))];
    return Number.isFinite(v) ? v : 0;
  };
  /** Bilinear elevation (m, negative below sea level). */
  const elevation = (lat, lon) => {
    // origin is the top-left corner; rows run north -> south
    const fc = (lon - ox) / Math.abs(rx) - 0.5;
    const fr = (oy - lat) / Math.abs(ry) - 0.5;
    const c = Math.floor(fc), r = Math.floor(fr);
    const u = fc - c, v = fr - r;
    return (
      at(c, r) * (1 - u) * (1 - v) + at(c + 1, r) * u * (1 - v) +
      at(c, r + 1) * (1 - u) * v + at(c + 1, r + 1) * u * v
    );
  };
  return { elevation };
}

// ------------------------------------------------------------ grid helpers
function boxBlur(src, radius, passes = 2) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < NZ; j++) {
      let acc = 0, n = 0;
      for (let i = -radius; i < NX; i++) {
        if (i + radius < NX) { acc += a[idx(i + radius, j)]; n++; }
        if (i - radius - 1 >= 0) { acc -= a[idx(i - radius - 1, j)]; n--; }
        if (i >= 0) b[idx(i, j)] = acc / n;
      }
    }
    for (let i = 0; i < NX; i++) {
      let acc = 0, n = 0;
      for (let j = -radius; j < NZ; j++) {
        if (j + radius < NZ) { acc += b[idx(i, j + radius)]; n++; }
        if (j - radius - 1 >= 0) { acc -= b[idx(i, j - radius - 1)]; n--; }
        if (j >= 0) a[idx(i, j)] = acc / n;
      }
    }
  }
  return a;
}

/** Distance (m) from every cell to the nearest cell where `inside` is true. */
function distanceTo(inside) {
  const INF = 1e9;
  const d = new Float32Array(NX * NZ).fill(INF);
  for (let k = 0; k < d.length; k++) if (inside[k]) d[k] = 0;
  const diag = Math.hypot(DX, DZ);
  const relax = (i, j, oi, oj, w) => {
    const ni = i + oi, nj = j + oj;
    if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) return;
    const v = d[idx(ni, nj)] + w;
    if (v < d[idx(i, j)]) d[idx(i, j)] = v;
  };
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    relax(i, j, -1, 0, DX); relax(i, j, 0, -1, DZ); relax(i, j, -1, -1, diag); relax(i, j, 1, -1, diag);
  }
  for (let j = NZ - 1; j >= 0; j--) for (let i = NX - 1; i >= 0; i--) {
    relax(i, j, 1, 0, DX); relax(i, j, 0, 1, DZ); relax(i, j, 1, 1, diag); relax(i, j, -1, 1, diag);
  }
  return d;
}

// --------------------------------------------------------------------- main
const [sat, bathy] = await Promise.all([loadSatellite(), loadBathymetry()]);

// 1. Classify every cell from its colour.
const seaLike = new Uint8Array(NX * NZ); // water or foam by colour alone
const foam = new Float32Array(NX * NZ);
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const [r, g, b] = sat.sample(xAt(i), zAt(j));
    const lum = (r + g + b) / 3;
    const warm = r - b; // sand and rock are warm, water and foam are not
    seaLike[idx(i, j)] = warm < 14 ? 1 : 0;
    foam[idx(i, j)] = warm < 14 ? smoothstep(120, 200, lum) : 0;
  }
}

// 2. Sea = sea-coloured cells connected to the offshore edge (flood fill), so
//    grey roofs and shadows inland never count as water.
const sea = new Uint8Array(NX * NZ);
{
  const stack = [];
  for (let j = 0; j < NZ; j++) { sea[idx(0, j)] = 1; stack.push(idx(0, j)); }
  while (stack.length) {
    const k = stack.pop();
    const i = k % NX, j = (k / NX) | 0;
    for (const [oi, oj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + oi, nj = j + oj;
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
      const nk = idx(ni, nj);
      if (!sea[nk] && seaLike[nk]) { sea[nk] = 1; stack.push(nk); }
    }
  }
}

// 3. Waterline per alongshore row, then a median filter to get the natural
//    beach line with the groynes removed.
const rawShore = new Float32Array(NZ);
for (let j = 0; j < NZ; j++) {
  let i = 0;
  // first run of 4 consecutive land cells coming in from the sea
  for (; i < NX - 4; i++) {
    if (!sea[idx(i, j)] && !sea[idx(i + 1, j)] && !sea[idx(i + 2, j)] && !sea[idx(i + 3, j)]) break;
  }
  rawShore[j] = i;
}
const shore = new Float32Array(NZ);
{
  const half = Math.round(80 / DZ);
  for (let j = 0; j < NZ; j++) {
    const win = [];
    for (let o = -half; o <= half; o++) win.push(rawShore[Math.min(NZ - 1, Math.max(0, j + o))]);
    win.sort((a, b) => a - b);
    shore[j] = win[Math.floor(win.length * 0.6)];
  }
  // light smoothing of the median line
  const tmp = Float32Array.from(shore);
  const r = Math.round(25 / DZ);
  for (let j = 0; j < NZ; j++) {
    let acc = 0, n = 0;
    for (let o = -r; o <= r; o++) { acc += tmp[Math.min(NZ - 1, Math.max(0, j + o))]; n++; }
    shore[j] = acc / n;
  }
}

// 4. Masks: 0 sea, 1 land, 2 groyne (rock that sticks out past the beach line).
const mask = new Uint8Array(NX * NZ);
const groyneMargin = Math.round(14 / DX);
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const k = idx(i, j);
    if (i >= shore[j]) mask[k] = 1;
    else if (!sea[k] && i < shore[j] - groyneMargin) mask[k] = 2;
  }
}
// keep only groyne blobs that are big enough and reach the beach
{
  const seen = new Uint8Array(NX * NZ);
  for (let k0 = 0; k0 < mask.length; k0++) {
    if (mask[k0] !== 2 || seen[k0]) continue;
    const blob = [k0];
    seen[k0] = 1;
    let maxI = 0;
    for (let q = 0; q < blob.length; q++) {
      const k = blob[q];
      const i = k % NX, j = (k / NX) | 0;
      maxI = Math.max(maxI, i - shore[j]);
      for (const [oi, oj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const ni = i + oi, nj = j + oj;
        if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
        const nk = idx(ni, nj);
        if (mask[nk] === 2 && !seen[nk]) { seen[nk] = 1; blob.push(nk); }
      }
    }
    const attached = maxI >= -groyneMargin - 2;
    if (blob.length < 30 || !attached) for (const k of blob) mask[k] = 0;
  }
}
// rejoin each groyne to the beach across the margin we skipped
for (let j = 0; j < NZ; j++) {
  for (let i = Math.floor(shore[j]) - groyneMargin - 1; i < shore[j]; i++) {
    if (i < 1) continue;
    const k = idx(i, j);
    if (mask[k] === 0 && !sea[k] && mask[idx(i - 1, j)] === 2) mask[k] = 2;
  }
}

// 5. Distances to the natural beach line, on both sides.
const isLand = Array.from(mask, (m) => m === 1);
const isSea = Array.from(mask, (m) => m !== 1);
const dSea = distanceTo(isLand); // metres seaward of the beach line
const dLand = distanceTo(isSea); // metres inland of the beach line
const dGroyne = distanceTo(Array.from(mask, (m) => m === 2));

// 6. Foam density from the satellite: persistent white water marks the bars.
//    Prefer the Sentinel-2 map (many recent days, see scripts/sentinel-bars.mjs);
//    fall back to the single high-resolution photo.
let barSource = 'single satellite photo (Esri)';
try {
  const dir = path.join(ROOT, 'public', 'data', beach.id);
  const info = JSON.parse(await readFile(path.join(dir, 'sentinel.json'), 'utf8'));
  const freq = await readFile(path.join(dir, 'sentinel-foam.bin'));
  const g = info.grid;
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const fi = Math.min(g.nx - 1.001, Math.max(0, (xAt(i) - g.x0) / g.cell));
      const fj = Math.min(g.nz - 1.001, Math.max(0, (zAt(j) - g.z0) / g.cell));
      const i0 = fi | 0, j0 = fj | 0, u = fi - i0, v = fj - j0;
      const at = (a, b) => freq[b * g.nx + a] / 255;
      const val = at(i0, j0) * (1 - u) * (1 - v) + at(i0 + 1, j0) * u * (1 - v) + at(i0, j0 + 1) * (1 - u) * v + at(i0 + 1, j0 + 1) * u * v;
      // white water on a third of the days is already a strong, persistent bar
      foam[idx(i, j)] = mask[idx(i, j)] === 0 ? Math.min(1, val * 2.5) : 0;
    }
  }
  barSource = `Sentinel-2 white-water frequency, ${info.scenes.length} scenes ${info.scenes[info.scenes.length - 1].date} to ${info.scenes[0].date}`;
  console.log('bars from', barSource);
} catch { console.log('no Sentinel-2 map found: bars from the single photo'); }
const foamSmooth = boxBlur(foam, Math.round(18 / DX), 2);
const foamByDist = new Map();
for (let k = 0; k < mask.length; k++) {
  if (mask[k] !== 0) continue;
  const bin = Math.round(dSea[k] / 10);
  const e = foamByDist.get(bin) ?? { s: 0, n: 0 };
  e.s += foamSmooth[k]; e.n++;
  foamByDist.set(bin, e);
}

// 7. Elevation.
const height = new Float32Array(NX * NZ);
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const k = idx(i, j);
    const { lat, lon } = localToLatLon(beach, xAt(i), zAt(j));
    const survey = bathy.elevation(lat, lon);
    if (mask[k] === 1) {
      const d = dLand[k];
      const face = Math.min(3.2, d * 0.075) + Math.min(1.2, Math.max(0, d - 45) * 0.02);
      const hinterland = Math.max(4.2, Math.min(survey, 60));
      height[k] = face + (hinterland - face) * smoothstep(70, 220, d);
    } else {
      const d = dSea[k];
      const dean = -beach.deanA * Math.pow(d, 2 / 3); // Dean: h = A d^(2/3)
      const deep = Math.min(survey, -1);
      let zb = dean + (deep - dean) * smoothstep(150, 450, d);
      // sandbar estimate from satellite foam
      const bin = foamByDist.get(Math.round(d / 10));
      const meanFoam = bin ? bin.s / bin.n : 0;
      const window = smoothstep(25, 70, d) * (1 - smoothstep(240, 380, d));
      zb += 1.1 * (foamSmooth[k] - meanFoam) * window;
      height[k] = Math.min(zb, -0.05 - 0.02 * Math.min(d, 20));
    }
  }
}
// Smooth sea and land a little so the 115 m survey cells do not show.
{
  const blurred = boxBlur(height, 3, 2);
  for (let k = 0; k < height.length; k++) height[k] = blurred[k];
}
// Rock groynes on top: crest ~2.6 m at the beach falling to ~1.6 m at the tip.
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const k = idx(i, j);
    const dg = dGroyne[k];
    if (dg > 12) continue;
    const reach = Math.max(0, dSea[k]);
    const crest = 2.6 - Math.min(1.0, reach / 120);
    const rock = crest - Math.max(0, dg - 1.5) * 0.55; // rubble slope ~1:1.8
    if (rock > height[k]) height[k] = rock;
  }
}

// 8. Depth the wave model output refers to: the forecast grid point offshore.
let refDepth = 0, refN = 0;
for (const dist of [3500, 4500, 5500]) {
  const { lat, lon } = localToLatLon(beach, -dist, 0);
  refDepth += -bathy.elevation(lat, lon); refN++;
}
refDepth = Math.max(8, refDepth / refN);

// 9. Write.
const outDir = path.join(ROOT, 'public', 'data', beach.id);
await mkdir(outDir, { recursive: true });
const h16 = new Int16Array(NX * NZ);
for (let k = 0; k < h16.length; k++) h16[k] = Math.max(-32000, Math.min(32000, Math.round(height[k] * 100)));
await writeFile(path.join(outDir, 'height.bin'), Buffer.from(h16.buffer));
await writeFile(path.join(outDir, 'mask.bin'), Buffer.from(mask.buffer));

const groyneRows = [];
for (let j = 0; j < NZ; j++) {
  let has = false;
  for (let i = 0; i < NX; i++) if (mask[idx(i, j)] === 2) { has = true; break; }
  groyneRows.push(has);
}
const groynes = [];
for (let j = 0; j < NZ; j++) {
  if (groyneRows[j] && !groyneRows[j - 1]) groynes.push({ z0: zAt(j) });
  if (groyneRows[j] && !groyneRows[j + 1]) groynes[groynes.length - 1].z1 = zAt(j);
}
for (const g of groynes) {
  let minI = NX;
  for (let j = 0; j < NZ; j++) {
    if (zAt(j) < g.z0 || zAt(j) > g.z1) continue;
    for (let i = 0; i < NX; i++) if (mask[idx(i, j)] === 2) { minI = Math.min(minI, i); break; }
  }
  g.z = +((g.z0 + g.z1) / 2).toFixed(1);
  g.tipX = +xAt(minI).toFixed(1);
  delete g.z0; delete g.z1;
}

let minH = Infinity, maxH = -Infinity;
for (const v of height) { minH = Math.min(minH, v); maxH = Math.max(maxH, v); }
const profile = [];
for (const d of [50, 100, 200, 300, 500, 800, 1000]) {
  const i = Math.round((shore[NZ >> 1] * DX - d) / DX);
  if (i >= 0) profile.push({ distance: d, depth: +(-height[idx(i, NZ >> 1)]).toFixed(2) });
}
const meta = {
  id: beach.id,
  name: beach.name,
  lat: beach.lat,
  lon: beach.lon,
  seawardBearing: beach.seawardBearing,
  domain: beach.domain,
  grid: { nx: NX, nz: NZ, dx: DX, dz: DZ },
  heightEncoding: 'int16 little-endian, centimetres above mean sea level, index = j * nx + i',
  maskEncoding: 'uint8: 0 sea, 1 land, 2 groyne',
  heightRange: [+minH.toFixed(2), +maxH.toFixed(2)],
  refDepth: +refDepth.toFixed(1),
  groynes,
  profile,
  bakedAt: new Date().toISOString(),
  sources: {
    imagery: 'Esri World Imagery (waterline, groynes and foam traced from tiles at zoom 17)',
    bathymetry: 'EMODnet Bathymetry DTM, 1/16 arc-minute',
    nearshore: 'Dean equilibrium profile blended with EMODnet; bars estimated from satellite foam',
    bars: barSource,
  },
};
await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(`wrote ${path.relative(ROOT, outDir)}  height ${minH.toFixed(1)}..${maxH.toFixed(1)} m, refDepth ${refDepth.toFixed(1)} m`);
console.log('groynes:', JSON.stringify(groynes));
console.log('profile:', JSON.stringify(profile));

if (debugOut) {
  const img = Buffer.alloc(NX * NZ * 3);
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const k = idx(i, j);
      const [r, g, b] = sat.sample(xAt(i), zAt(j));
      let c = [r, g, b];
      const h = height[k];
      if (mask[k] === 2) c = [255, 40, 40];
      else if (mask[k] === 0) {
        const t = Math.min(1, -h / 12);
        c = [20 + 60 * (1 - t), 90 + 140 * (1 - t), 150 + 100 * (1 - t)];
        if (Math.abs((-h * 2) % 1) < 0.08) c = [255, 255, 255]; // 0.5 m contours
      }
      if (Math.abs(i - shore[j]) < 0.6) c = [255, 255, 0];
      img.set(c, k * 3);
    }
  }
  await sharp(img, { raw: { width: NX, height: NZ, channels: 3 } }).png().toFile(debugOut);
  console.log('debug image ->', debugOut);
}
