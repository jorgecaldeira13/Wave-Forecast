// Loads the baked terrain of a beach (see scripts/bake-beach.mjs).

export async function loadTerrain(beachId) {
  const base = `${import.meta.env.BASE_URL}data/${beachId}`;
  const [meta, heightBuf, maskBuf] = await Promise.all([
    fetch(`${base}/meta.json`).then((r) => r.json()),
    fetch(`${base}/height.bin`).then((r) => r.arrayBuffer()),
    fetch(`${base}/mask.bin`).then((r) => r.arrayBuffer()),
  ]);
  const h16 = new Int16Array(heightBuf);
  const height = new Float32Array(h16.length);
  for (let k = 0; k < h16.length; k++) height[k] = h16[k] / 100;
  return {
    meta,
    nx: meta.grid.nx,
    nz: meta.grid.nz,
    dx: meta.grid.dx,
    dz: meta.grid.dz,
    x0: -meta.domain.offshore,
    z0: -meta.domain.alongshore / 2,
    sizeX: meta.domain.offshore + meta.domain.inland,
    sizeZ: meta.domain.alongshore,
    height,
    mask: new Uint8Array(maskBuf),
  };
}

/** Bilinear bed elevation (m above mean sea level) at a local point. */
export function bedAt(terrain, x, z) {
  const fi = Math.min(terrain.nx - 1.001, Math.max(0, (x - terrain.x0) / terrain.dx));
  const fj = Math.min(terrain.nz - 1.001, Math.max(0, (z - terrain.z0) / terrain.dz));
  const i = fi | 0, j = fj | 0;
  const u = fi - i, v = fj - j;
  const h = terrain.height, nx = terrain.nx;
  return (
    h[j * nx + i] * (1 - u) * (1 - v) + h[j * nx + i + 1] * u * (1 - v) +
    h[(j + 1) * nx + i] * (1 - u) * v + h[(j + 1) * nx + i + 1] * u * v
  );
}
