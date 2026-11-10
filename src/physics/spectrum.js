// Directional wind-sea spectrum: JONSWAP shape (Hasselmann et al. 1973), the
// finite-depth TMA correction (Bouws et al. 1985, Kitaigorodskii depth factor)
// and cos^2s directional spreading (Mitsuyasu / Goda form, as used in
// graphics ocean papers). Turned into a small set of plane waves the shader
// can sum; amplitudes come from the energy in each frequency/direction cell.

import { G } from './dispersion.js';

const TWO_PI = Math.PI * 2;

/** JONSWAP shape (unnormalised, per frequency f in Hz). gamma = 3.3 is a young sea; 1 is Pierson-Moskowitz. */
export function jonswap(f, fp, gamma = 3.3) {
  const sigma = f <= fp ? 0.07 : 0.09;
  const r = Math.exp(-((f - fp) ** 2) / (2 * sigma * sigma * fp * fp));
  return f ** -5 * Math.exp(-1.25 * (fp / f) ** 4) * gamma ** r;
}

/** Kitaigorodskii depth function: 1 in deep water, falling towards 0 as the sea floor takes over. */
export function kitaigorodskii(f, depth) {
  const wh = TWO_PI * f * Math.sqrt(Math.max(depth, 0.1) / G);
  if (wh < 1) return 0.5 * wh * wh;
  if (wh < 2) return 1 - 0.5 * (2 - wh) ** 2;
  return 1;
}

/** Spreading exponent: broad below the peak, tightening above it. */
export function spreadingExponent(f, fp, smax) {
  return f < fp ? smax * (f / fp) ** 5 : smax * (f / fp) ** -2.5;
}

// small seeded generator so a given sea state always looks the same
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * @param Hs significant wave height of this wind sea (m)
 * @param Tp peak period (s)
 * @param angle travel direction in the beach frame (rad; 0 = straight at the beach, + towards +z)
 * @param depth water depth for the TMA correction (m)
 * @param smax spreading strength (about 10 for a wind sea; larger is more long-crested)
 * @returns {{ comps: {kx,kz,omega,amp,phase}[], hs: number }}
 */
export function buildSpectrum({ Hs, Tp, angle = 0, depth = 12, gamma = 3.3, smax = 10, nf = 5, nd = 4, seed = 7 }) {
  if (!(Hs > 0.02)) return { comps: [], hs: 0 };
  const fp = 1 / Math.max(Tp, 2);
  const rand = rng(seed);
  const f0 = 0.7 * fp, f1 = 2.6 * fp;
  const edges = Array.from({ length: nf + 1 }, (_, i) => f0 * (f1 / f0) ** (i / nf));
  const cells = [];
  let m0 = 0;
  for (let i = 0; i < nf; i++) {
    const f = Math.sqrt(edges[i] * edges[i + 1]);
    const df = edges[i + 1] - edges[i];
    const s = spreadingExponent(f, fp, smax);
    const dirs = [];
    let dsum = 0;
    for (let j = 0; j < nd; j++) {
      const th = (-70 + (140 * (j + 0.5)) / nd) * (Math.PI / 180);
      const d = Math.cos(th / 2) ** (2 * s);
      dirs.push({ th, d });
      dsum += d;
    }
    const S = jonswap(f, fp, gamma) * kitaigorodskii(f, depth);
    for (const { th, d } of dirs) {
      const energy = S * df * (d / dsum);
      cells.push({ f, th, energy });
      m0 += energy;
    }
  }
  const target = (Hs / 4) ** 2; // Hs = 4 sqrt(m0)
  const comps = cells.map(({ f, th, energy }) => {
    const omega = TWO_PI * f;
    const k = (omega * omega) / G;
    const a = angle + th;
    return {
      kx: k * Math.cos(a),
      kz: k * Math.sin(a),
      omega,
      amp: Math.sqrt(2 * energy * (target / m0)),
      phase: rand() * TWO_PI,
    };
  });
  return { comps, hs: Hs };
}

/** Significant height recovered from a component list: 4 sqrt(sum a^2 / 2). */
export const hsOf = (comps) => 4 * Math.sqrt(comps.reduce((e, c) => e + (c.amp * c.amp) / 2, 0));

/**
 * Wave groups from first principles. A swell is a narrow band of frequencies and
 * directions; added together they beat, which is why waves arrive in sets and why
 * crests have a finite length. For a narrow band the sea is a carrier wave times a
 * slowly varying envelope E(s, z) = sum a_j exp(i (dw_j s + kappa_j z + theta_j)),
 * with s the time since a crest left the offshore edge and z the alongshore
 * position. |E| is then Rayleigh distributed, as measured wave heights are
 * (Longuet-Higgins 1952). Returns six components with sum a^2 = 1.
 *
 * @param period peak period (s): longer-period swell is narrower, so its sets are longer
 * @param kind 'swell' | 'swell2' | 'wind'
 */
export function buildEnvelope({ period, kind = 'swell', seed = 11 }) {
  const rand = rng(seed + Math.round(period * 10));
  const wp = TWO_PI / period;
  const width = Math.min(0.2, Math.max(0.06, 0.25 - 0.012 * period)) * (kind === 'wind' ? 1.4 : 1);
  const spreadDeg = kind === 'wind' ? 16 : kind === 'swell2' ? 10 : 7;
  const kShore = TWO_PI / (period * 5.5); // wavenumber around the break point
  const q = [-1.6, -0.95, -0.32, 0.32, 0.95, 1.6]; // quantiles of a Gaussian band
  let norm = 0;
  const comps = q.map((g) => {
    const a = Math.exp(-0.25 * g * g);
    norm += a * a;
    return {
      dw: wp * width * g * (0.85 + 0.3 * rand()),
      kappa: kShore * Math.sin(((rand() * 2 - 1) * spreadDeg * 1.6 * Math.PI) / 180),
      theta: rand() * TWO_PI,
      a,
    };
  });
  for (const c of comps) c.a /= Math.sqrt(norm);
  return comps;
}

/** Height of wave number n (crest time n * period) at alongshore z, as a fraction of Hs. */
export function envelopeFactor(env, n, z, period) {
  const s = n * period;
  let re = 0, im = 0;
  for (const c of env) {
    const ph = c.dw * s + c.kappa * z + c.theta;
    re += c.a * Math.cos(ph);
    im += c.a * Math.sin(ph);
  }
  // H = Hrms |E| and Hs = 1.416 Hrms
  return Math.min(1.5, Math.max(0.15, Math.hypot(re, im) * 0.706));
}
