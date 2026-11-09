// Node-side loader for the baked terrain (tests and tooling).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadTerrainNode(beachId) {
  const dir = path.join(ROOT, 'public', 'data', beachId);
  const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
  const hb = await readFile(path.join(dir, 'height.bin'));
  const mb = await readFile(path.join(dir, 'mask.bin'));
  const h16 = new Int16Array(hb.buffer, hb.byteOffset, hb.byteLength / 2);
  const height = Float32Array.from(h16, (v) => v / 100);
  return {
    meta,
    nx: meta.grid.nx,
    nz: meta.grid.nz,
    dx: meta.grid.dx,
    dz: meta.grid.dz,
    x0: -meta.domain.offshore,
    z0: -meta.domain.alongshore / 2,
    height,
    mask: new Uint8Array(mb.buffer, mb.byteOffset, mb.byteLength),
  };
}
