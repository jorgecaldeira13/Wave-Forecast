// Linear (Airy) wave theory helpers.

export const G = 9.81;
const TWO_PI = Math.PI * 2;

/** Wavenumber k (rad/m) for period T (s) in water depth h (m). */
export function wavenumber(T, h) {
  const omega = TWO_PI / T;
  const k0 = (omega * omega) / G; // deep water
  const depth = Math.max(h, 0.01);
  // Hunt's approximation, then two Newton steps.
  const y = k0 * depth;
  let k =
    Math.sqrt(
      y * (y + 1 / (1 + 0.6522 * y + 0.4622 * y * y + 0.0864 * y ** 4 + 0.0675 * y ** 5)),
    ) / depth;
  for (let n = 0; n < 2; n++) {
    const th = Math.tanh(k * depth);
    const f = G * k * th - omega * omega;
    const df = G * th + G * k * depth * (1 - th * th);
    k -= f / df;
  }
  return k;
}

/** Phase speed c (m/s). */
export function celerity(T, h) {
  return TWO_PI / T / wavenumber(T, h);
}

/** Group speed cg (m/s). */
export function groupVelocity(T, h) {
  const depth = Math.max(h, 0.01);
  const k = wavenumber(T, depth);
  const c = TWO_PI / T / k;
  const kh2 = 2 * k * depth;
  const n = kh2 > 50 ? 0.5 : 0.5 * (1 + kh2 / Math.sinh(kh2));
  return n * c;
}

/** Deep-water wavelength (m). */
export function deepWavelength(T) {
  return (G * T * T) / TWO_PI;
}

/**
 * Tabulated c(h) and cg(h) for one period, so grid loops avoid Newton solves.
 * Returns { c(h), cg(h) } using linear interpolation in depth.
 */
export function makeSpeedTable(T, maxDepth = 40, step = 0.05) {
  const n = Math.ceil(maxDepth / step) + 2;
  const cTab = new Float32Array(n);
  const cgTab = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = Math.max(0.02, i * step);
    cTab[i] = celerity(T, h);
    cgTab[i] = groupVelocity(T, h);
  }
  const lookup = (tab) => (h) => {
    const f = Math.min(n - 1.001, Math.max(0, h / step));
    const i = f | 0;
    return tab[i] + (tab[i + 1] - tab[i]) * (f - i);
  };
  return { c: lookup(cTab), cg: lookup(cgTab) };
}
