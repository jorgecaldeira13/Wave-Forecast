// Stitches satellite tiles into one texture aligned with the beach's local
// frame, so the terrain mesh can use plain (x, z) coordinates as UVs.

import * as THREE from 'three';
import { localToLatLon, latLonToLocal, latLonToTile, SATELLITE_TILE_URL } from '../config/beaches.js';

const ZOOM = 17;

function tileToLatLon(tx, ty, zoom) {
  const n = 2 ** zoom;
  return {
    lon: (tx / n) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI,
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile failed: ${url}`));
    img.src = url;
  });
}

/**
 * @param rect local-frame rectangle to cover: { x0, z0, sizeX, sizeZ } in metres
 * @returns {{ texture: THREE.CanvasTexture, rect, loaded: Promise<number> }}
 *   The texture is usable immediately and fills in as tiles arrive.
 */
export function makeSatelliteTexture(beach, rect, { pxPerMetre = 1.3, onProgress } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(4096, Math.round(rect.sizeX * pxPerMetre));
  canvas.height = Math.min(4096, Math.round(rect.sizeZ * pxPerMetre));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#cdb88e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  const sx = canvas.width / rect.sizeX, sz = canvas.height / rect.sizeZ;
  const toCanvas = (lat, lon) => {
    const p = latLonToLocal(beach, lat, lon);
    return [(p.x - rect.x0) * sx, (p.z - rect.z0) * sz];
  };

  // which tiles touch the rectangle?
  const corners = [
    [rect.x0, rect.z0], [rect.x0 + rect.sizeX, rect.z0],
    [rect.x0, rect.z0 + rect.sizeZ], [rect.x0 + rect.sizeX, rect.z0 + rect.sizeZ],
  ].map(([x, z]) => {
    const { lat, lon } = localToLatLon(beach, x, z);
    return latLonToTile(lat, lon, ZOOM);
  });
  const tx0 = Math.floor(Math.min(...corners.map((c) => c.x)));
  const tx1 = Math.floor(Math.max(...corners.map((c) => c.x)));
  const ty0 = Math.floor(Math.min(...corners.map((c) => c.y)));
  const ty1 = Math.floor(Math.max(...corners.map((c) => c.y)));
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      // affine map from tile pixels to canvas pixels, from three tile corners
      const o = tileToLatLon(tx, ty, ZOOM), r = tileToLatLon(tx + 1, ty, ZOOM), d = tileToLatLon(tx, ty + 1, ZOOM);
      const [ox, oy] = toCanvas(o.lat, o.lon);
      const [rx, ry] = toCanvas(r.lat, r.lon);
      const [dx, dy] = toCanvas(d.lat, d.lon);
      const xs = [ox, rx, dx, rx + dx - ox], ys = [oy, ry, dy, ry + dy - oy];
      if (Math.max(...xs) < 0 || Math.min(...xs) > canvas.width) continue;
      if (Math.max(...ys) < 0 || Math.min(...ys) > canvas.height) continue;
      jobs.push({ tx, ty, m: [(rx - ox) / 256, (ry - oy) / 256, (dx - ox) / 256, (dy - oy) / 256, ox, oy] });
    }
  }

  let done = 0, ok = 0, dirty = false;
  const flush = () => {
    if (dirty) { texture.needsUpdate = true; dirty = false; }
  };
  const timer = setInterval(flush, 400);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const img = await loadImage(SATELLITE_TILE_URL(ZOOM, job.tx, job.ty));
        ctx.setTransform(...job.m);
        // overdraw by half a pixel so no seams show between tiles
        ctx.drawImage(img, -0.5, -0.5, 257, 257);
        ok++; dirty = true;
      } catch {
        /* leave the sand-coloured fill */
      }
      done++;
      onProgress?.(done / jobs.length);
    }
  };
  const loaded = Promise.all(Array.from({ length: 8 }, worker)).then(() => {
    clearInterval(timer);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    texture.needsUpdate = true;
    return ok / Math.max(1, jobs.length);
  });
  return { texture, rect, loaded };
}
