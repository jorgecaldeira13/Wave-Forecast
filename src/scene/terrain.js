import * as THREE from 'three';
import { COMMON } from './shaders.js';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float groyne;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vGroyne;
void main() {
  vWorld = position;
  vNormal = normal;
  vGroyne = groyne;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
${COMMON}
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uSat;
uniform vec4 uSatRect;   // x0, z0, sizeX, sizeZ covered by the satellite texture
uniform float uSatMix;   // 0 until tiles have arrived
uniform float uTide;
uniform float uWetLine;  // highest reach of the swash above tide (m)
varying vec3 vWorld;
varying vec3 vNormal;
varying float vGroyne;

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormal);
  float y = vWorld.y;

  // procedural ground, used underwater and wherever there is no imagery
  vec3 sand = vec3(0.60, 0.48, 0.28);
  vec3 dune = vec3(0.17, 0.18, 0.08);
  vec3 town = vec3(0.26, 0.23, 0.19);
  vec3 ground = mix(sand, dune, smoothstep(3.6, 5.2, y));
  ground = mix(ground, town, smoothstep(5.5, 9.0, y) * 0.6);

  vec2 suv = (vWorld.xz - uSatRect.xy) / uSatRect.zw;
  vec2 e = min(suv, 1.0 - suv) * uSatRect.zw;
  float inside = smoothstep(0.0, 50.0, min(e.x, e.y));
  vec3 sat = texture2D(uSat, clamp(suv, 0.0, 1.0)).rgb;
  vec3 blurred = textureLod(uSat, clamp(suv, 0.02, 0.98), 6.0).rgb;
  vec3 land = mix(mix(ground, blurred, 0.6), sat, inside);
  land = mix(ground, land, uSatMix);

  // below the waterline the photo shows old waves, so use clean sand instead
  float above = smoothstep(-0.25, 0.45, y);
  vec3 albedo = mix(sand, land, above);
  vec3 rock = vec3(0.115, 0.10, 0.085);
  float grain = 0.82 + 0.36 * fract(sin(dot(floor(vWorld.xz * 0.9), vec2(12.9898, 78.233))) * 43758.5453);
  albedo = mix(albedo, rock * grain, vGroyne * 0.9);

  // wet sand where the swash reaches
  float wetTop = uTide + uWetLine;
  float wet = (1.0 - smoothstep(wetTop - 0.05, wetTop + 0.3, y)) * (1.0 - vGroyne);
  albedo *= mix(1.0, 0.66, wet * above);

  // the imagery already carries daylight, so shade gently
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 lightCol = mix(vec3(1.0), uSunColor, 0.7);
  vec3 col = albedo * (uAmbient * 1.15 + uSunStrength * (0.32 + 0.5 * ndl)) * lightCol;
  // a little sky sheen on wet sand
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col = mix(col, skyColor(reflect(-V, N)), 0.35 * fres * wet * above);

  col = applyFog(col, -V, length(cameraPosition - vWorld));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Terrain {
  constructor(terrain, shared) {
    const { nx, nz, dx, dz, x0, z0, height, mask } = terrain;
    // every baked node, plus a skirt that carries the edges to the horizon
    const FAR = 30000;
    const xs = [], zs = [], is = [], js = [];
    for (let i = 0; i < nx; i++) { xs.push(x0 + i * dx); is.push(i); }
    for (let j = 0; j < nz; j++) { zs.push(z0 + j * dz); js.push(j); }
    for (const d of [600, FAR]) {
      xs.unshift(x0 - d); is.unshift(0);
      xs.push(x0 + (nx - 1) * dx + d); is.push(nx - 1);
      zs.unshift(z0 - d); js.unshift(0);
      zs.push(z0 + (nz - 1) * dz + d); js.push(nz - 1);
    }
    const mx = xs.length, mz = zs.length;
    const pos = new Float32Array(mx * mz * 3);
    const groyne = new Float32Array(mx * mz);
    for (let j = 0; j < mz; j++) {
      for (let i = 0; i < mx; i++) {
        const k = js[j] * nx + is[i];
        const o = (j * mx + i) * 3;
        pos[o] = xs[i]; pos[o + 1] = height[k]; pos[o + 2] = zs[j];
        groyne[j * mx + i] = mask[k] === 2 ? 1 : 0;
      }
    }
    const idx = new Uint32Array((mx - 1) * (mz - 1) * 6);
    let q = 0;
    for (let j = 0; j < mz - 1; j++) {
      for (let i = 0; i < mx - 1; i++) {
        const a = j * mx + i, b = a + 1, c = a + mx, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('groyne', new THREE.BufferAttribute(groyne, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    this.uniforms = {
      ...shared,
      uSat: { value: null },
      uSatRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatMix: { value: 0 },
      uTide: { value: 0 },
      uWetLine: { value: 0.5 },
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  setSatellite({ texture, rect }) {
    this.uniforms.uSat.value = texture;
    this.uniforms.uSatRect.value.set(rect.x0, rect.z0, rect.sizeX, rect.sizeZ);
    this.uniforms.uSatMix.value = 1;
  }

  setSeaState(state) {
    this.uniforms.uTide.value = state.tide;
    this.uniforms.uWetLine.value = state.runup.setup + state.runup.swash;
  }
}
