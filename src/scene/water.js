import * as THREE from 'three';
import { COMMON, WAVES } from './shaders.js';

const VERT = /* glsl */ `
${COMMON}
${WAVES}
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
varying vec2 vBase;
void main() {
  vec3 p = position;
  Surf s = surface(p.xz, false);
  vBase = p.xz;
  p.y = uTide + s.eta;
  p.xz += s.lean;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
${COMMON}
${WAVES}
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uWind;   // unit direction the wind blows towards (x, z) and speed in m/s
varying vec3 vWorld;
varying vec2 vBase;

void main() {
  #include <logdepthbuf_fragment>
  Surf s = surface(vBase, true);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // wind chop: small ripples that the mesh does not carry
  float chop = clamp(uWind.z / 11.0, 0.03, 1.0);
  vec2 drift = uWind.xy * uTime;
  vec2 r1 = texture(uNoise, vWorld.xz * 0.090 - drift * 0.030).rg - 0.5;
  vec2 r2 = texture(uNoise, vWorld.xz * 0.310 - drift * 0.055).gb - 0.5;
  vec2 r3 = texture(uNoise, vWorld.xz * 1.300 - drift * 0.110).br - 0.5;
  float nearFade = 1.0 / (1.0 + dist * 0.012);
  vec2 ripple = (r1 * 0.55 * mix(0.3, 1.0, nearFade) + r2 * 0.45 * mix(0.15, 1.0, nearFade) + r3 * 0.5 * nearFade) * (0.035 + 0.9 * chop * chop + 0.12 * chop);
  vec2 g = s.grad + ripple * (1.0 - 0.7 * s.foam);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

  // water body: the deeper, the darker; green light glows through steep faces
  float depth = max(s.film, 0.0);
  vec3 shallow = vec3(0.050, 0.300, 0.270);
  vec3 deep = vec3(0.004, 0.046, 0.082);
  vec3 body = mix(shallow, deep, 1.0 - exp(-depth * 0.32));
  float light = uAmbient + uSunStrength * (0.25 + 0.75 * clamp(uSunDir.y * 2.5, 0.0, 1.0));
  body *= light;
  float back = pow(clamp(dot(V, -uSunDir) * 0.5 + 0.5, 0.0, 1.0), 2.0);
  body += vec3(0.008, 0.13, 0.10) * s.face * (0.4 + 1.2 * back) * uSunStrength;
  // sunlight through the thin pitching lip of a plunging wave
  body += vec3(0.02, 0.20, 0.15) * s.plunge * smoothstep(0.1, 0.3, s.slope) * (0.3 + back) * uSunStrength;

  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 sky = skyColor(R);
  float sunSpec = pow(max(dot(R, uSunDir), 0.0), mix(900.0, 90.0, chop));
  vec3 spec = uSunColor * uSunStrength * uSunGlow * sunSpec * mix(6.0, 1.6, chop);

  vec3 col = mix(body, sky, fres) + spec;
  // make the swell readable from any angle: faces a touch darker, backs lighter
  col *= 1.0 - 0.34 * smoothstep(0.0, 0.22, s.slope) + 0.10 * smoothstep(0.0, 0.15, -s.slope);

  // white water, lit by sun and sky, with soft shadows in its own texture
  float foamLight = uAmbient * 1.3 + uSunStrength * 0.8 * (0.4 + 0.6 * max(dot(N, uSunDir), 0.0));
  float foamTex = 0.84 + 0.16 * texture(uNoise, vWorld.xz * 0.35 + uTime * 0.03).a;
  vec3 foamCol = mix(vec3(0.86, 0.93, 0.96), uSunColor, 0.3) * foamLight * foamTex;
  col = mix(col, foamCol, s.foam);

  float alpha = clamp(1.0 - exp(-depth * 1.9) + s.foam, 0.0, 1.0);
  alpha *= smoothstep(0.0, 0.03, s.film);

  col = applyFog(col, -V, dist);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Vertex positions: dense through the surf zone, coarse far out, with a far skirt. */
function makeGeometry(terrain, quality) {
  const xs = [];
  const xShore = 170; // high enough up the beach for the biggest run-up
  const fine = 1.5 / quality, coarse = 6.5 / quality;
  let x = terrain.x0;
  while (x < xShore) {
    xs.push(x);
    const t = Math.min(1, Math.max(0, (x + 620) / 340)); // 0 offshore .. 1 inside the surf zone
    x += coarse + (fine - coarse) * t * t * (3 - 2 * t);
  }
  xs.push(xShore);
  const zs = [];
  const stepZ = 3.4 / quality;
  const nzSeg = Math.round(terrain.sizeZ / stepZ);
  for (let j = 0; j <= nzSeg; j++) zs.push(terrain.z0 + (terrain.sizeZ * j) / nzSeg);
  // skirt out to the horizon
  const FAR = 30000;
  for (const d of [400, 2500, FAR]) {
    xs.unshift(terrain.x0 - d);
    zs.unshift(terrain.z0 - d);
    zs.push(terrain.z0 + terrain.sizeZ + d);
  }
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const o = (j * nx + i) * 3;
      pos[o] = xs[i]; pos[o + 1] = 0; pos[o + 2] = zs[j];
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let q = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), FAR * 2);
  return geo;
}

function makeNoiseTexture(size = 256) {
  // tileable value noise, four independent channels, two octaves each
  const data = new Uint8Array(size * size * 4);
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let ch = 0; ch < 4; ch++) {
    const layers = [8, 32].map((cells) => {
      const g = new Float32Array(cells * cells);
      for (let k = 0; k < g.length; k++) g[k] = rand();
      return { cells, g };
    });
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let v = 0, wsum = 0;
        layers.forEach(({ cells, g }, li) => {
          const fx = (x / size) * cells, fy = (y / size) * cells;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          let u = fx - x0, w = fy - y0;
          u = u * u * (3 - 2 * u); w = w * w * (3 - 2 * w);
          const at = (ix, iy) => g[(iy % cells) * cells + (ix % cells)];
          const val =
            at(x0, y0) * (1 - u) * (1 - w) + at(x0 + 1, y0) * u * (1 - w) +
            at(x0, y0 + 1) * (1 - u) * w + at(x0 + 1, y0 + 1) * u * w;
          const weight = li === 0 ? 0.62 : 0.38;
          v += val * weight; wsum += weight;
        });
        data[(y * size + x) * 4 + ch] = Math.round((v / wsum) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function fieldTexture(n) {
  const tex = new THREE.DataTexture(new Float32Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export function makeBedTexture(terrain) {
  const { nx, nz, height, mask } = terrain;
  // channel G: how close we are to a groyne (1 on the rock, fading over ~20 m),
  // so the beach swash does not climb the rocks
  let near = new Float32Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) near[k] = mask[k] === 2 ? 1 : 0;
  for (let pass = 0; pass < 6; pass++) {
    const next = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let m = near[j * nx + i];
        if (i > 0) m = Math.max(m, near[j * nx + i - 1] - 0.14);
        if (i < nx - 1) m = Math.max(m, near[j * nx + i + 1] - 0.14);
        if (j > 0) m = Math.max(m, near[(j - 1) * nx + i] - 0.14);
        if (j < nz - 1) m = Math.max(m, near[(j + 1) * nx + i] - 0.14);
        next[j * nx + i] = m;
      }
    }
    near = next;
  }
  const data = new Float32Array(nx * nz * 4);
  for (let k = 0; k < nx * nz; k++) {
    data[k * 4] = height[k];
    data[k * 4 + 1] = near[k];
  }
  const tex = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export class Water {
  constructor(terrain, shared, bedTexture, { quality = 1 } = {}) {
    this.n = 256;
    this.fieldA = fieldTexture(this.n);
    this.fieldA2 = fieldTexture(this.n);
    this.fieldB = fieldTexture(this.n);
    this.noise = makeNoiseTexture();
    this.uniforms = {
      ...shared,
      uFieldA: { value: this.fieldA },
      uFieldA2: { value: this.fieldA2 },
      uFieldB: { value: this.fieldB },
      uBed: { value: bedTexture },
      uNoise: { value: this.noise },
      uDomain: { value: new THREE.Vector4(terrain.x0, terrain.z0, terrain.sizeX, terrain.sizeZ) },
      uTime: { value: 0 },
      uTide: { value: 0 },
      uExag: { value: 1 },
      uEdgeH: { value: new THREE.Vector2(0, 0) },
      uPeriod: { value: new THREE.Vector2(10, 5) },
      uSwash: { value: new THREE.Vector2(0, 0) },
      uMess: { value: 0 },
      uWindS: { value: 0 },
      uComp: { value: Array.from({ length: 20 }, () => new THREE.Vector4()) },
      uCompPh: { value: new Float32Array(20) },
      uCompN: { value: 0 },
      uWind: { value: new THREE.Vector3(1, 0, 0) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(makeGeometry(terrain, quality), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Upload a solved sea state (see src/model/seaState.js). */
  setSeaState(state, seawardBearing) {
    const n2 = this.n * this.n;
    const [a, b] = state.trains;
    const A = this.fieldA.image.data, A2 = this.fieldA2.image.data, B = this.fieldB.image.data;
    if (a) {
      const f = a.field;
      for (let k = 0; k < n2; k++) {
        A[k * 4] = f.tau[k]; A[k * 4 + 1] = f.sx[k]; A[k * 4 + 2] = f.sz[k]; A[k * 4 + 3] = f.K[k];
        A2[k * 4] = f.Hcrit[k]; A2[k * 4 + 1] = f.hcap[k];
      }
    } else {
      A.fill(0); A2.fill(0);
    }
    if (b) {
      const f = b.field;
      for (let k = 0; k < n2; k++) {
        B[k * 4] = f.tau[k]; B[k * 4 + 1] = f.sx[k]; B[k * 4 + 2] = f.sz[k]; B[k * 4 + 3] = f.K[k];
      }
    } else {
      B.fill(0);
    }
    this.fieldA.needsUpdate = this.fieldA2.needsUpdate = this.fieldB.needsUpdate = true;
    const u = this.uniforms;
    // a wind sea is drawn by the spectrum layer instead of the single-period train
    const spec = state.spectrum?.comps ?? [];
    u.uCompN.value = Math.min(20, spec.length);
    spec.slice(0, 20).forEach((c, i) => {
      u.uComp.value[i].set(c.kx, c.kz, c.omega, c.amp);
      u.uCompPh.value[i] = c.phase;
    });
    u.uWindS.value = state.windEffect?.s ?? 0;
    u.uEdgeH.value.set(a?.height ?? 0, spec.length ? 0 : b?.height ?? 0);
    u.uPeriod.value.set(a?.period ?? 10, b?.period ?? 5);
    u.uTide.value = state.tide;
    u.uSwash.value.set(state.runup.setup, state.runup.swash);
    u.uMess.value = state.mess;
    if (state.wind) {
      // wind direction is "from"; convert to the local direction it blows towards
      const rad = Math.PI / 180;
      const to = (state.wind.direction + 180) * rad;
      const bx = (seawardBearing + 180) * rad, bz = (seawardBearing - 90) * rad;
      u.uWind.value.set(Math.cos(to - bx), Math.cos(to - bz), state.wind.speed / 3.6);
    } else {
      u.uWind.value.set(1, 0, 2.5);
    }
  }
}
