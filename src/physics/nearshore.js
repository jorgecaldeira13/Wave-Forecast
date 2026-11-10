// Nearshore wave transformation: takes the forecast sea state at the model grid
// point and carries it across the real seabed to the sand.
//
//   forecast point --(Snell + directional spreading)--> offshore edge of the patch
//   offshore edge  --(eikonal travel time)-----------> bent, slowing wave crests
//                  --(energy flux conservation)-------> shoaling and focusing
//                  --(depth-limited breaking)---------> where each wave breaks
//
// Grid convention matches the terrain: index = j * nx + i, i runs cross-shore
// from the offshore edge towards land (+x), j runs alongshore (+z).

import { G, celerity, groupVelocity, deepWavelength, makeSpeedTable } from './dispersion.js';

export const GAMMA_BREAK = 0.78; // H/h at which a wave starts breaking
export const GAMMA_BORE = 0.5; // H/h of the broken bore in the surf zone
const MIN_DEPTH = 0.15; // dry land is treated as a very slow medium
const DEG = Math.PI / 180;

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Average the baked terrain down to the solver resolution. */
export function makeSolverGrid(terrain, n = 256) {
  const { nx, nz, height } = terrain;
  const fx = (nx - 1) / (n - 1);
  const fz = (nz - 1) / (n - 1);
  const bed = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ci = Math.round(i * fx), cj = Math.round(j * fz);
      let acc = 0, cnt = 0, top = -Infinity;
      for (let oj = -1; oj <= 1; oj++) {
        for (let oi = -1; oi <= 1; oi++) {
          const qi = Math.min(nx - 1, Math.max(0, ci + oi));
          const qj = Math.min(nz - 1, Math.max(0, cj + oj));
          const v = height[qj * nx + qi];
          acc += v; cnt++; if (v > top) top = v;
        }
      }
      // keep thin rock structures: if anything in the window is well above
      // its neighbours, let it win
      const mean = acc / cnt;
      bed[j * n + i] = top - mean > 1.2 ? top : mean;
    }
  }
  return {
    nx: n,
    nz: n,
    dx: (terrain.dx * (nx - 1)) / (n - 1),
    dz: (terrain.dz * (nz - 1)) / (n - 1),
    x0: terrain.x0,
    z0: terrain.z0,
    bed,
  };
}

/**
 * Carry one wave train from the forecast point to the offshore edge of the
 * patch. Real seas are spread over directions, so the train is split into
 * directional bins; each bin refracts by Snell's law, and bins heading away
 * from the coast are lost. Returns the height and mean angle at the edge.
 */
export function transformToBoundary(train, refDepth, boundaryDepth, seawardBearing) {
  const { height, period, direction, spread = 20 } = train;
  const alpha0 = wrap180(direction - seawardBearing) * DEG;
  const cRef = celerity(period, refDepth);
  const cgRef = groupVelocity(period, refDepth);
  const cB = celerity(period, boundaryDepth);
  const cgB = groupVelocity(period, boundaryDepth);
  let energy = 0, wsum = 0, sx = 0, sz = 0;
  for (let d = -80; d <= 80; d += 4) {
    const w = Math.pow(Math.cos((d * DEG) / 2), 2 * spread);
    wsum += w;
    const a = alpha0 + d * DEG;
    if (Math.abs(a) >= 88 * DEG) continue;
    const sinB = (Math.sin(a) * cB) / cRef;
    if (Math.abs(sinB) >= 0.999) continue;
    const aB = Math.asin(sinB);
    const e = w * (cgRef / cgB) * (Math.cos(a) / Math.cos(aB));
    energy += e;
    sx += e * Math.cos(aB);
    sz += e * Math.sin(aB);
  }
  const ratio = wsum > 0 ? energy / wsum : 0;
  return {
    height: height * Math.sqrt(ratio),
    angle: energy > 0 ? Math.atan2(sz, sx) : 0, // 0 = straight at the beach, + = travelling towards +z
    period,
    exposure: ratio, // share of the offshore energy that reaches the patch
  };
}

function blur3(src, nx, nz, passes = 1) {
  let a = src, b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const il = i > 0 ? i - 1 : i, ir = i < nx - 1 ? i + 1 : i;
        b[j * nx + i] = 0.25 * a[j * nx + il] + 0.5 * a[j * nx + i] + 0.25 * a[j * nx + ir];
      }
    }
    const c = p === 0 ? new Float32Array(src.length) : a;
    for (let j = 0; j < nz; j++) {
      const jl = j > 0 ? j - 1 : j, jr = j < nz - 1 ? j + 1 : j;
      for (let i = 0; i < nx; i++) {
        c[j * nx + i] = 0.25 * b[jl * nx + i] + 0.5 * b[j * nx + i] + 0.25 * b[jr * nx + i];
      }
    }
    a = c;
  }
  return a;
}

/**
 * Solve the full nearshore field for one wave train at one tide level.
 * @returns typed arrays over the solver grid plus scalars:
 *   tau   travel time of a crest from the offshore edge (s)
 *   sx,sz slowness vector = grad(tau) (s/m); crest lines are tau = const
 *   K     amplification of wave height relative to the offshore edge
 *   Hcrit edge wave height above which a wave has already broken here (m)
 *   hcap  depth that limits the broken bore here (m)
 */
export function solveTrain(grid, tide, boundary) {
  const { nx, nz, dx, dz, bed } = grid;
  const N = nx * nz;
  const T = boundary.period;
  const speeds = makeSpeedTable(T);
  const depth = new Float32Array(N);
  const c = new Float32Array(N);
  const cg = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const h = tide - bed[k];
    depth[k] = h;
    const hw = Math.max(h, MIN_DEPTH);
    c[k] = speeds.c(hw);
    cg[k] = speeds.cg(hw);
  }

  // Mean depth along the offshore edge.
  let hB = 0;
  for (let j = 0; j < nz; j++) hB += Math.max(depth[j * nx], 1);
  hB /= nz;
  const cB = speeds.c(hB);
  // Alongshore slowness is conserved when contours are parallel (Snell).
  const m = Math.sin(boundary.angle) / cB;

  // ---- eikonal |grad tau| = 1/c by fast sweeping --------------------------
  const INF = 1e9;
  const tau = new Float32Array(N).fill(INF);
  const fixed = new Uint8Array(N);
  for (let j = 0; j < nz; j++) {
    tau[j * nx] = j * dz * m;
    fixed[j * nx] = 1;
  }
  if (Math.abs(boundary.angle) > 1 * DEG) {
    // up-wave side: 1-D Snell march along the edge row
    const j = m > 0 ? 0 : nz - 1;
    let t = j * dz * m;
    for (let i = 1; i < nx; i++) {
      const k = j * nx + i;
      const s2 = 1 / (c[k] * c[k]) - m * m;
      t += Math.sqrt(Math.max(s2, 0.04 / (c[k] * c[k]))) * dx;
      tau[k] = t;
      fixed[k] = 1;
    }
  }
  const update = (i, j) => {
    const k = j * nx + i;
    if (fixed[k]) return;
    const a = Math.min(i > 0 ? tau[k - 1] : INF, i < nx - 1 ? tau[k + 1] : INF);
    const b = Math.min(j > 0 ? tau[k - nx] : INF, j < nz - 1 ? tau[k + nx] : INF);
    const f = dx / c[k];
    let t;
    if (Math.abs(a - b) >= f) t = Math.min(a, b) + f;
    else t = 0.5 * (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b)));
    if (t < tau[k]) tau[k] = t;
  };
  for (let it = 0; it < 3; it++) {
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) update(i, j);
    for (let j = nz - 1; j >= 0; j--) for (let i = 0; i < nx; i++) update(i, j);
    for (let j = 0; j < nz; j++) for (let i = nx - 1; i >= 0; i--) update(i, j);
    for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) update(i, j);
  }
  let tmin = INF;
  for (let k = 0; k < N; k++) if (tau[k] < tmin) tmin = tau[k];
  for (let k = 0; k < N; k++) tau[k] -= tmin;

  // ---- slowness / direction ----------------------------------------------
  let sx = new Float32Array(N), sz = new Float32Array(N);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const il = i > 0 ? k - 1 : k, ir = i < nx - 1 ? k + 1 : k;
      const jl = j > 0 ? k - nx : k, jr = j < nz - 1 ? k + nx : k;
      sx[k] = (tau[ir] - tau[il]) / ((ir - il) * dx || dx);
      sz[k] = (tau[jr] - tau[jl]) / (((jr - jl) / nx) * dz || dz);
    }
  }
  // Smoothed unit direction field for energy transport.
  const dirx = new Float32Array(N), dirz = new Float32Array(N);
  {
    const bx = blur3(sx, nx, nz, 3), bz = blur3(sz, nx, nz, 3);
    for (let k = 0; k < N; k++) {
      const len = Math.hypot(bx[k], bz[k]) || 1;
      let ux = bx[k] / len, uz = bz[k] / len;
      if (ux < 0.5) { // never steeper than 60 degrees to the marching direction
        ux = 0.5; uz = Math.sign(uz) * 0.866;
      }
      dirx[k] = ux; dirz[k] = uz;
    }
  }

  // ---- energy flux, breaking threshold and bore cap, marched shoreward ----
  // d . grad(F) = -F div(d)  with F = E * cg, solved semi-Lagrangian in x.
  const K = new Float32Array(N);
  const Hcrit = new Float32Array(N);
  const hcap = new Float32Array(N);
  let F = new Float32Array(nz), Fn = new Float32Array(nz);
  let Hc = new Float32Array(nz), Hcn = new Float32Array(nz);
  let hc = new Float32Array(nz), hcn = new Float32Array(nz);
  for (let j = 0; j < nz; j++) {
    const k = j * nx;
    F[j] = cg[k];
    K[k] = 1;
    Hc[j] = (GAMMA_BREAK * Math.max(depth[k], 0)) / 1;
    hc[j] = Math.max(depth[k], 0);
    Hcrit[k] = Hc[j];
    hcap[k] = hc[j];
  }
  const lerpRow = (row, jf) => {
    const q = Math.min(nz - 1.001, Math.max(0, jf));
    const j0 = q | 0;
    return row[j0] + (row[j0 + 1] - row[j0]) * (q - j0);
  };
  const BORE_RECOVERY = 0.012; // m of depth cap regained per metre travelled
  for (let i = 1; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const k = j * nx + i;
      const ux = dirx[k], uz = dirz[k];
      const jf = j - ((uz / ux) * dx) / dz; // where this ray was one column ago
      const jl = j > 0 ? k - nx : k, jr = j < nz - 1 ? k + nx : k;
      const div =
        (dirx[k] - dirx[k - 1]) / dx + (dirz[jr] - dirz[jl]) / (((jr - jl) / nx) * dz || dz);
      const step = dx / ux;
      const growth = Math.exp(Math.min(0.35, Math.max(-0.35, -div * step)));
      const h = depth[k];
      const wet = h > 0.03;
      Fn[j] = wet ? lerpRow(F, jf) * growth : 0;
      const hPos = Math.max(h, 0);
      const flux = Math.max(Fn[j], 1e-4);
      const kHere = Math.min(4, Math.sqrt(flux / cg[k]));
      const crit = (GAMMA_BREAK * hPos) / Math.max(kHere, 0.05);
      Hcn[j] = Math.min(crit, lerpRow(Hc, jf));
      hcn[j] = Math.min(hPos, lerpRow(hc, jf) + BORE_RECOVERY * step);
    }
    // lateral mixing: directional spreading and diffraction smear energy
    for (let j = 0; j < nz; j++) {
      const k = j * nx + i;
      const jl = j > 0 ? j - 1 : j, jr = j < nz - 1 ? j + 1 : j;
      const f = 0.15 * Fn[jl] + 0.7 * Fn[j] + 0.15 * Fn[jr];
      F[j] = f;
      K[k] = Math.min(4, Math.sqrt(Math.max(f, 0) / cg[k]));
      Hcrit[k] = Hcn[j];
      hcap[k] = hcn[j];
    }
    [Hc, Hcn] = [Hcn, Hc];
    [hc, hcn] = [hcn, hc];
  }

  return { tau, sx, sz, K, Hcrit, hcap, depth, boundaryDepth: hB, boundary };
}

/**
 * Read the surf off a solved field: where and how big do waves of a given
 * offshore-edge height break in front of the middle of the beach?
 */
export function measureSurf(grid, field, edgeHeight, { zMin = -110, zMax = 110 } = {}) {
  const { nx, nz, dx, dz, x0, z0, bed } = grid;
  const T = field.boundary.period;
  const hits = [];
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * dz;
    if (z < zMin || z > zMax) continue;
    for (let i = 1; i < nx - 4; i++) {
      const k = j * nx + i;
      if (edgeHeight > field.Hcrit[k]) {
        const i0 = Math.max(0, i - 4), i1 = Math.min(nx - 1, i + 4);
        const slope = Math.max(0.004, (bed[j * nx + i1] - bed[j * nx + i0]) / ((i1 - i0) * dx));
        hits.push({
          x: x0 + i * dx,
          height: Math.min(field.K[k - 1] * edgeHeight, GAMMA_BREAK * Math.max(field.depth[k - 1], 0.05) * 1.15),
          depth: field.depth[k],
          slope,
        });
        break;
      }
    }
  }
  if (!hits.length) return null;
  const med = (key) => {
    const v = hits.map((h) => h[key]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const height = med('height');
  const slope = med('slope');
  const iribarren = slope / Math.sqrt(Math.max(height, 0.05) / deepWavelength(T));
  return {
    height,
    depth: med('depth'),
    slope,
    breakX: med('x'),
    iribarren,
    breakerType: iribarren < 0.4 ? 'spilling' : iribarren < 2 ? 'plunging' : 'surging',
  };
}

/** Wave run-up on the sand (Stockdon et al. 2006), metres above still water. */
export function runup(edgeHeight, period, foreshoreSlope = 0.075) {
  const L0 = deepWavelength(period);
  const hl = Math.max(edgeHeight, 0) * L0;
  const setup = 0.35 * foreshoreSlope * Math.sqrt(hl);
  const swash = Math.sqrt(hl * (0.563 * foreshoreSlope * foreshoreSlope + 0.004));
  return { setup, swash, r2: 1.1 * (setup + swash / 2) };
}

/**
 * Cheap 1-D estimate of the breaking height on a single cross-shore profile.
 * Used to fill the whole week of the timeline without 168 full 2-D solves.
 */
export function quickBreakHeight(profile, tide, boundary) {
  const { depths, boundaryDepth } = profile; // depths below MSL, offshore -> shore
  const T = boundary.period;
  if (boundary.height < 0.02) return 0;
  const hB = Math.max(boundaryDepth + tide, 1);
  const cB = celerity(T, hB), cgB = groupVelocity(T, hB);
  const sinB = Math.sin(boundary.angle);
  const cosB = Math.cos(boundary.angle);
  let last = boundary.height;
  for (let i = 0; i < depths.length; i++) {
    const h = depths[i] + tide;
    if (h <= 0.1) break;
    const c = celerity(T, h), cg = groupVelocity(T, h);
    const sinA = Math.min(0.99, Math.abs((sinB * c) / cB));
    const Hloc = boundary.height * Math.sqrt((cgB / cg) * (cosB / Math.sqrt(1 - sinA * sinA)));
    if (Hloc > GAMMA_BREAK * h) return Math.min(Hloc, GAMMA_BREAK * h * 1.15);
    last = Hloc;
  }
  return last;
}

/** Mean cross-shore depth profile in front of the middle of the beach. */
export function centreProfile(grid, { zMin = -110, zMax = 110, stride = 2 } = {}) {
  const { nx, nz, dz, z0, bed } = grid;
  const depths = [];
  for (let i = 0; i < nx; i += stride) {
    let acc = 0, n = 0;
    for (let j = 0; j < nz; j++) {
      const z = z0 + j * dz;
      if (z < zMin || z > zMax) continue;
      acc += -bed[j * nx + i]; n++;
    }
    depths.push(acc / n);
  }
  return { depths, boundaryDepth: depths[0] };
}

export { G };
