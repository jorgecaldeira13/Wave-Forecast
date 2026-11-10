// A small patch of real ocean surface, recomputed every frame.
//
// Thousands of tiny waves with random phases, each travelling at the speed
// physics gives its wavelength (Tessendorf's FFT method). The patch tiles
// seamlessly, so the water shader repeats it at several sizes to give the sea
// its fine moving texture: ripples, chop, glitter. Runs on the CPU so it works
// on every phone browser; a 128 x 128 patch costs a few milliseconds.

import * as THREE from 'three';

const G = 9.81;

function fft1d(re, im, n, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function ifft2d(re, im, n, rowRe, rowIm) {
  for (let y = 0; y < n; y++) {
    const o = y * n;
    fft1d(re.subarray(o, o + n), im.subarray(o, o + n), n, true);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { rowRe[y] = re[y * n + x]; rowIm[y] = im[y * n + x]; }
    fft1d(rowRe, rowIm, n, true);
    for (let y = 0; y < n; y++) { re[y * n + x] = rowRe[y]; im[y * n + x] = rowIm[y]; }
  }
}

export class OceanTile {
  /** @param size patch edge in metres; the wind blows along +x of the patch */
  constructor({ n = 128, size = 42, wind = 8, seed = 5 } = {}) {
    this.n = n;
    this.size = size;
    const N = n * n;
    this.kx = new Float32Array(N); this.kz = new Float32Array(N); this.omega = new Float32Array(N);
    this.h0r = new Float32Array(N); this.h0i = new Float32Array(N);
    this.bufs = Array.from({ length: 6 }, () => new Float32Array(N));
    this.rowRe = new Float32Array(n); this.rowIm = new Float32Array(n);
    let s = seed >>> 0;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
    const Lw = (wind * wind) / G; // longest wave this wind can raise
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const kx = ((x < n / 2 ? x : x - n) * 2 * Math.PI) / size;
        const kz = ((y < n / 2 ? y : y - n) * 2 * Math.PI) / size;
        const k = Math.hypot(kx, kz);
        this.kx[i] = kx; this.kz[i] = kz;
        this.omega[i] = Math.sqrt(G * k + 0.000074 * k * k * k); // gravity plus surface tension
        if (k < 1e-6) continue;
        // Phillips spectrum: energy falls as k^-4, waves run mostly downwind,
        // and a soft cut-off removes ripples too small to draw
        const cosw = kx / k;
        const dirn = 0.25 + 0.75 * cosw * cosw * (cosw > 0 ? 1 : 0.35);
        const P = (Math.exp(-1 / (k * Lw) ** 2) / k ** 4) * dirn * Math.exp(-((k * 0.09) ** 2));
        const a = Math.sqrt(P / 2);
        this.h0r[i] = gauss() * a; this.h0i[i] = gauss() * a;
      }
    }
    this.data = new Uint16Array(N * 4);
    this.texture = new THREE.DataTexture(this.data, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.scale = 1;
    // normalise so the patch has a known roughness (r.m.s. slope 0.16); the shader scales it by the wind
    this.update(0);
    let acc = 0;
    const [, , sx, , sz] = this.bufs;
    for (let i = 0; i < N; i++) acc += sx[i] * sx[i] + sz[i] * sz[i];
    this.scale = 0.16 / Math.sqrt(acc / N);
    this.update(0);
  }

  update(t) {
    const { n, kx, kz, omega, h0r, h0i } = this;
    const N = n * n;
    const [hr, hi, sxr, sxi, szr, szi] = this.bufs;
    for (let i = 0; i < N; i++) {
      // h(k, t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}  keeps the surface real
      const y = (i / n) | 0, x = i - y * n;
      const j = ((n - y) % n) * n + ((n - x) % n);
      const c = Math.cos(omega[i] * t), s = Math.sin(omega[i] * t);
      const re = h0r[i] * c - h0i[i] * s + h0r[j] * c - h0i[j] * s;
      const im = h0r[i] * s + h0i[i] * c - h0r[j] * s - h0i[j] * c;
      hr[i] = re; hi[i] = im;
      // slope = i k h
      sxr[i] = -kx[i] * im; sxi[i] = kx[i] * re;
      szr[i] = -kz[i] * im; szi[i] = kz[i] * re;
    }
    ifft2d(hr, hi, n, this.rowRe, this.rowIm);
    ifft2d(sxr, sxi, n, this.rowRe, this.rowIm);
    ifft2d(szr, szi, n, this.rowRe, this.rowIm);
    const d = this.data, k = this.scale, half = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < N; i++) {
      d[i * 4] = half(hr[i] * k);
      d[i * 4 + 1] = half(sxr[i] * k);
      d[i * 4 + 2] = half(szr[i] * k);
      d[i * 4 + 3] = 0;
    }
    this.texture.needsUpdate = true;
  }
}
