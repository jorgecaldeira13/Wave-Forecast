// CPU twin of the wave shader (src/scene/shaders.js): the height of the sea
// surface at one point and time. Used to float things on the water.

import { envelopeFactor } from '../physics/spectrum.js';

const TAU = Math.PI * 2;
const GAMMA_BORE = 0.5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

function waveShape(q, peaked, skew) {
  const w = q - (skew * (1 - Math.cos(TAU * q))) / TAU;
  const c = 0.5 + 0.5 * Math.cos(TAU * w);
  const n = 1 + 2.6 * peaked;
  const mean = 0.5 * Math.pow(n, -0.45);
  return (Math.pow(c, n) - mean) * 2;
}

/**
 * @param grid solver grid (ctx.grid)
 * @param state result of computeSeaState
 * @returns (x, z, time, exaggeration) => metres above the tide level
 */
export function makeSurfaceSampler(grid, state) {
  const { nx, nz, dx, dz, x0, z0, bed } = grid;
  const [a, b] = state.trains;
  const mess = state.mess;
  const env = state.envelope ?? [];
  const setFactor = (n, z, T) => (env.length ? envelopeFactor(env, n, z, T) : 0.7);
  const windS = state.windEffect?.s ?? 0;
  const comps = state.spectrum?.comps ?? [];
  const bedAt = (x, z) => {
    const fi = clamp((x - x0) / dx, 0, nx - 1.001), fj = clamp((z - z0) / dz, 0, nz - 1.001);
    const i = fi | 0, j = fj | 0;
    return sample(bed, i, j, fi - i, fj - j);
  };
  const sample = (arr, i, j, u, v) =>
    arr[j * nx + i] * (1 - u) * (1 - v) + arr[j * nx + i + 1] * u * (1 - v) +
    arr[(j + 1) * nx + i] * (1 - u) * v + arr[(j + 1) * nx + i + 1] * u * v;
  const sampler = (x, z, time, exag = 1) => {
    const fi = clamp((x - x0) / dx, 0, nx - 1.001);
    const fj = clamp((z - z0) / dz, 0, nz - 1.001);
    const i = fi | 0, j = fj | 0, u = fi - i, v = fj - j;
    const h = Math.max(state.tide - sample(bed, i, j, u, v), 0.05);
    let eta = 0;
    if (a) {
      const f = a.field, T = a.period;
      const ph = (time - sample(f.tau, i, j, u, v)) / T;
      const n = Math.floor(ph), q = ph - n;
      const s0 = setFactor(n, z, T), s1 = setFactor(n + 1, z, T);
      const blend = smoothstep(0.3, 0.7, q);
      const sf = mix(s0, s1, blend);
      // local surf-similarity number, as in the shader
      const slopeBed = Math.abs(bedAt(x + 14, z) - bedAt(x - 14, z)) / 28;
      const xi = (slopeBed / Math.sqrt(Math.max(a.height * sf, 0.05) / (1.56 * T * T))) * (1 - 0.5 * windS);
      const plunge = smoothstep(0.38, 0.62, xi) * (1 - smoothstep(2.6, 3.6, xi));
      const surge = smoothstep(2.6, 3.6, xi);
      const crit = Math.max(sample(f.Hcrit, i, j, u, v), 0.02);
      const broken = mix(smoothstep(0.93, 1.08, (a.height * s0) / crit) * (1 - surge), smoothstep(0.93, 1.08, (a.height * s1) / crit) * (1 - surge), blend);
      const Hu = sample(f.K, i, j, u, v) * a.height * sf;
      const Hl = GAMMA_BORE * Math.max(sample(f.hcap, i, j, u, v), 0);
      const H = Math.min(mix(Hu, Math.min(Hu, Hl), broken), 0.95 * h);
      const steep = clamp(H / (0.78 * h), 0, 1);
      const peaked = Math.min(1, steep * (1 - 0.35 * mess) + 0.3 * plunge * steep * (1 - broken));
      const skew = mix(0.12 + 0.5 * steep + 0.4 * plunge * steep * steep, mix(0.55, 0.9, plunge), broken);
      eta += 0.5 * H * waveShape(q, peaked, skew);
    }
    if (b) {
      const f = b.field, T = b.period;
      const ph = (time - sample(f.tau, i, j, u, v)) / T;
      const n = Math.floor(ph), q = ph - n;
      const sB = mix(setFactor(n + 40, z + 300, T), setFactor(n + 41, z + 300, T), smoothstep(0.3, 0.7, q));
      const HB = Math.min(sample(f.K, i, j, u, v) * b.height * sB, 0.42 * h);
      const steepB = clamp(HB / (0.6 * h), 0, 1);
      eta += 0.5 * HB * waveShape(q, steepB, 0.1 + 0.4 * steepB);
    }
    for (const c of comps) {
      const th = Math.tanh(Math.hypot(c.kx, c.kz) * h);
      const amp = Math.min(c.amp * Math.sqrt(th) * smoothstep(0, 0.6, h), 0.3 * h);
      eta += amp * Math.cos(c.kx * x + c.kz * z - c.omega * time + c.phase);
    }
    return eta * exag;
  };

  /** Typical wave height (crest to trough, m) at a point: what a person standing there meets. */
  sampler.waveHeight = (x, z) => {
    const fi = clamp((x - x0) / dx, 0, nx - 1.001);
    const fj = clamp((z - z0) / dz, 0, nz - 1.001);
    const i = fi | 0, j = fj | 0, u = fi - i, v = fj - j;
    const h = state.tide - sample(bed, i, j, u, v);
    if (h <= 0.03) return 0;
    let HA = 0, HB = 0;
    if (a) {
      const f = a.field;
      HA = sample(f.K, i, j, u, v) * a.height;
      if (a.height > sample(f.Hcrit, i, j, u, v)) HA = Math.min(HA, GAMMA_BORE * Math.max(sample(f.hcap, i, j, u, v), 0));
      HA = Math.min(HA, 0.95 * h);
    }
    if (b) HB = Math.min(sample(b.field.K, i, j, u, v) * b.height, 0.42 * h);
    return Math.hypot(HA, HB);
  };
  // ---- extras for things that ride the wave (the surf trainer) ----------------
  const at = (arr, x, z) => {
    const fi = clamp((x - x0) / dx, 0, nx - 1.001), fj = clamp((z - z0) / dz, 0, nz - 1.001);
    const i = fi | 0, j = fj | 0;
    return sample(arr, i, j, fi - i, fj - j);
  };
  sampler.primary = a ? { period: a.period, height: a.height } : null;
  /** Seconds a crest takes to get here from the offshore edge. */
  sampler.tauAt = (x, z) => (a ? at(a.field.tau, x, z) : 0);
  /** Speed of the wave here, m/s. */
  sampler.speedAt = (x, z) => (a ? 1 / Math.max(Math.hypot(at(a.field.sx, x, z), at(a.field.sz, x, z)), 0.02) : 5);
  sampler.depthAt = (x, z) => state.tide - at(bed, x, z);
  /** Size of wave number n at alongshore z, as a fraction of the forecast height. */
  sampler.factor = (n, z) => (a ? setFactor(n, z, a.period) : 0);
  /** Has wave number n already broken by the time it reaches this point? */
  sampler.brokenAt = (x, z, n) => !!a && a.height * setFactor(n, z, a.period) > at(a.field.Hcrit, x, z);
  return sampler;
}
