// Where is the sun? Low-precision solar position (good to a fraction of a
// degree), so the scene is lit the way the beach will be at the forecast hour.

const RAD = Math.PI / 180;

/** @returns {{ elevation: number, azimuth: number }} radians; azimuth clockwise from north. */
export function sunPosition(date, lat, lon) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = 18.697374558 + 24.06570982441908 * d; // hours
  const ha = (gmst * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { elevation, azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI) };
}

/** Unit vector in the beach's local frame for a compass bearing and elevation. */
export function bearingToLocal(bearingRad, elevationRad, seawardBearingDeg) {
  const bx = (seawardBearingDeg + 180) * RAD;
  const bz = (seawardBearingDeg - 90) * RAD;
  const ch = Math.cos(elevationRad);
  return [ch * Math.cos(bearingRad - bx), Math.sin(elevationRad), ch * Math.cos(bearingRad - bz)];
}

const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const sstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Colours are written as they should look on screen (sRGB 0..1) and converted
// to linear light for the shaders.
const lin = (c) => c.map((v) => Math.pow(v, 2.2));
const KEYS = [
  { el: -18, zenith: [0.03, 0.045, 0.10], horizon: [0.07, 0.10, 0.17], sun: [0.62, 0.72, 0.95], strength: 0.10, ambient: 0.10 },
  { el: -6, zenith: [0.08, 0.13, 0.27], horizon: [0.44, 0.33, 0.36], sun: [1.0, 0.62, 0.42], strength: 0.10, ambient: 0.16 },
  { el: 0, zenith: [0.20, 0.31, 0.54], horizon: [0.98, 0.64, 0.40], sun: [1.0, 0.60, 0.32], strength: 0.42, ambient: 0.24 },
  { el: 6, zenith: [0.25, 0.42, 0.70], horizon: [0.97, 0.81, 0.62], sun: [1.0, 0.80, 0.58], strength: 0.62, ambient: 0.31 },
  { el: 18, zenith: [0.24, 0.47, 0.80], horizon: [0.73, 0.84, 0.94], sun: [1.0, 0.95, 0.86], strength: 0.72, ambient: 0.37 },
  { el: 60, zenith: [0.19, 0.44, 0.82], horizon: [0.66, 0.80, 0.95], sun: [1.0, 0.98, 0.94], strength: 0.76, ambient: 0.40 },
].map((k) => ({ ...k, zenith: lin(k.zenith), horizon: lin(k.horizon), sun: lin(k.sun) }));

/** Sky and light colours for a sun elevation and cloud cover (0..100). */
export function skyPalette(elevationRad, cloud = 0) {
  const el = Math.max(KEYS[0].el, Math.min(KEYS[KEYS.length - 1].el, elevationRad / RAD));
  let i = 0;
  while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = sstep(a.el, b.el, el);
  let zenith = lerp3(a.zenith, b.zenith, t);
  let horizon = lerp3(a.horizon, b.horizon, t);
  let sun = lerp3(a.sun, b.sun, t);
  let strength = lerp(a.strength, b.strength, t);
  let ambient = lerp(a.ambient, b.ambient, t);
  // overcast: grey the sky, dim and soften the sun
  const c = Math.min(1, Math.max(0, cloud / 100));
  const k = c * c * 0.85;
  const lum = (v) => 0.3 * v[0] + 0.55 * v[1] + 0.15 * v[2];
  const grey = (v, lift) => { const l = lum(v) * lift; return [l, l * 1.02, l * 1.06]; };
  zenith = lerp3(zenith, grey(horizon, 0.75), k);
  horizon = lerp3(horizon, grey(horizon, 0.95), k);
  sun = lerp3(sun, [0.9, 0.92, 0.95], k);
  strength *= 1 - 0.7 * k;
  ambient *= 1 + 0.25 * k;
  return { zenith, horizon, sun, strength, ambient, glow: 1 - 0.8 * k };
}
