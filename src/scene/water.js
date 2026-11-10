import * as THREE from 'three';
import { COMMON, WAVES } from './shaders.js';
import { OceanTile } from './oceanTile.js';

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
varying vec3 vWorld;
varying vec2 vBase;

void main() {
  #include <logdepthbuf_fragment>
  Surf s = surface(vBase, true);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // fine surface detail: the live ocean patch at three sizes, fading with distance
  float chop = chopAmount();
  vec2 d1 = tileSample(vWorld.xz, uTileSize).yz;
  vec2 d2 = tileSample(vWorld.xz + 13.7, uTileSize * 0.23).yz;
  vec2 d3 = tileSample(vWorld.xz - 31.0, uTileSize * 4.3).yz;
  float f1 = 1.0 / (1.0 + dist / 320.0), f2 = 1.0 / (1.0 + dist / 55.0);
  vec2 detail = (d1 * f1 + d2 * 0.8 * f2 + d3 * 0.55) * chop;
  // how rough the part we can no longer resolve is: it widens the sun's glitter
  float unresolved = chop * (0.16 * (1.0 - f1) + 0.13 * (1.0 - f2));
  vec2 g = s.grad + detail * (1.0 - 0.75 * s.foam);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

  float sunUp = clamp(uSunDir.y * 2.5, 0.0, 1.0);
  float light = uAmbient + uSunStrength * (0.25 + 0.75 * sunUp);

  // ---- what you see through the surface --------------------------------------
  // Sand seen through water: red light is absorbed within a metre or two, green
  // and blue travel further. Light scattered back by the water itself takes over
  // with depth. This is what paints the shallows turquoise and the deep sea dark.
  float depth = max(s.film, 0.0);
  float path = depth * (1.0 + 0.6 * (1.0 - abs(V.y)));
  vec3 sand = vec3(0.60, 0.49, 0.30) * mix(0.62, 1.0, smoothstep(0.0, 0.3, depth));
  // Atlantic surf-zone water is cloudy with stirred sand: the bottom fades within about a metre
  vec3 through = sand * exp(-path * vec3(1.5, 0.85, 0.8));
  vec3 scatter = vec3(0.030, 0.082, 0.090);
  // churned-up water carries sand and bubbles: paler and greener
  float churn = clamp(s.foam * 0.6 + textureLod(uFoamMap, (vBase - uFoamRect.xy) / uFoamRect.zw, 2.0).r * 0.9, 0.0, 1.0);
  scatter = mix(scatter, vec3(0.11, 0.20, 0.19), churn * 0.7);
  vec3 body = (through + scatter * (1.0 - exp(-path * 1.1))) * light;
  // sunlight passing through the thin upper part of a steep wave face
  float back = pow(clamp(dot(V, -uSunDir) * 0.5 + 0.5, 0.0, 1.0), 2.0);
  body += vec3(0.010, 0.15, 0.115) * s.face * (0.45 + 1.3 * back) * uSunStrength;
  body += vec3(0.02, 0.20, 0.15) * s.plunge * smoothstep(0.1, 0.3, s.slope) * (0.3 + back) * uSunStrength;

  // ---- what bounces off it ----------------------------------------------------
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  // a rough surface reflects a blur of the sky, never a perfect mirror at the horizon
  fres *= 1.0 - 0.45 * clamp(unresolved * 4.0, 0.0, 1.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + unresolved * 0.6;
  vec3 sky = skyColor(normalize(R));
  // sun glitter: a tight sparkle up close, a broad shimmering path far away
  vec3 Hv = normalize(V + uSunDir);
  float rough = clamp(0.035 + unresolved * 1.4, 0.03, 0.4);
  float a2 = rough * rough;
  float ndh = clamp(dot(N, Hv), 0.0, 1.0);
  float dGGX = a2 / (3.14159 * pow(ndh * ndh * (a2 - 1.0) + 1.0, 2.0));
  vec3 spec = uSunColor * uSunStrength * uSunGlow * min(dGGX, 60.0) * 0.045 * (0.3 + 0.7 * fres) * sunUp;

  vec3 col = mix(body, sky, fres) + spec * (1.0 - s.foam);
  // faces a touch darker, backs lighter, so the swell reads from any angle
  col *= 1.0 - 0.26 * smoothstep(0.0, 0.22, s.slope) + 0.08 * smoothstep(0.0, 0.15, -s.slope);

  // ---- white water ------------------------------------------------------------
  // lit like a rough white solid, with pits and shadows from its own bubbles
  float pit = texture(uNoise, vWorld.xz * 0.9 + uTime * 0.04).a * 0.6 + texture(uNoise, vWorld.xz * 3.7 - uTime * 0.07).r * 0.4;
  vec3 Nf = normalize(vec3(-g.x * 0.5, 1.0, -g.y * 0.5));
  float foamLight = uAmbient * 1.25 + uSunStrength * 0.85 * (0.35 + 0.65 * max(dot(Nf, uSunDir), 0.0));
  vec3 foamCol = mix(vec3(0.80, 0.86, 0.88), vec3(0.97, 0.98, 0.96), pit) * mix(vec3(1.0), uSunColor, 0.3) * foamLight;
  // thin foam lets the water colour through
  col = mix(col, mix(col * 1.25 + 0.05 * light, foamCol, smoothstep(0.15, 0.75, s.foam)), smoothstep(0.0, 0.25, s.foam));

  float alpha = smoothstep(0.0, 0.035, s.film);
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
    this.tile = new OceanTile({ n: quality < 1 ? 64 : 128 });
    this.uniforms = {
      ...shared,
      uFieldA: { value: this.fieldA },
      uFieldA2: { value: this.fieldA2 },
      uFieldB: { value: this.fieldB },
      uBed: { value: bedTexture },
      uNoise: { value: this.noise },
      uTile: { value: this.tile.texture },
      uTileSize: { value: this.tile.size },
      uDomain: { value: new THREE.Vector4(terrain.x0, terrain.z0, terrain.sizeX, terrain.sizeZ) },
      uTime: { value: 0 },
      uTide: { value: 0 },
      uExag: { value: 1 },
      uEdgeH: { value: new THREE.Vector2(0, 0) },
      uPeriod: { value: new THREE.Vector2(10, 5) },
      uSwash: { value: new THREE.Vector2(0, 0) },
      uMess: { value: 0 },
      uWindS: { value: 0 },
      uEnv: { value: Array.from({ length: 6 }, (_, i) => new THREE.Vector4(0, 0, 0, i === 0 ? 1 : 0)) },
      uFoamMap: { value: this.noise },
      uFoamRect: { value: new THREE.Vector4(-760, -750, 930, 1500) },
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
    (state.envelope ?? []).slice(0, 6).forEach((c, i) => u.uEnv.value[i].set(c.dw, c.kappa, c.theta, c.a));
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
