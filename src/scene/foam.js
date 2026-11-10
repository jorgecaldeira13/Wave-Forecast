// Foam that has a history. Breaking waves inject white water into a map; every
// frame the map drifts shoreward with the bores, thins out and fades. The water
// shader reads it, so foam streaks and patches persist between waves instead of
// being redrawn from a formula (the approach of Crest and of Atlas / WaveWorks).

import * as THREE from 'three';
import { COMMON, WAVES } from './shaders.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const FRAG = /* glsl */ `
${COMMON}
${WAVES}
uniform sampler2D uPrev;
uniform float uDt;
varying vec2 vUv;
void main() {
  vec2 p = uFoamRect.xy + vUv * uFoamRect.zw;
  Surf s = surface(p, false);
  // white water rides shoreward with the broken wave, more slowly than the crest
  vec2 from = p - s.dir * 1.1 * uDt;
  float prev = texture2D(uPrev, (from - uFoamRect.xy) / uFoamRect.zw).r;
  // foam lasts longer in the churned inner surf zone, and soaks away on the sand
  float life = s.film > 0.02 ? mix(4.5, 8.0, smoothstep(2.5, 0.6, s.still)) : 1.6;
  prev -= max(prev * (1.0 - exp(-uDt / life)), 0.006 * step(0.0001, uDt));
  gl_FragColor = vec4(clamp(max(prev, s.src), 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

export class FoamSim {
  constructor(renderer, water, terrain) {
    this.renderer = renderer;
    this.water = water;
    // covers the surf zone and the swash, where foam lives
    const rect = new THREE.Vector4(-760, terrain.z0, 930, terrain.sizeZ);
    const floatOk = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    const make = () => {
      const rt = new THREE.WebGLRenderTarget(448, 720, {
        type: floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
      });
      return rt;
    };
    this.a = make();
    this.b = make();
    water.uniforms.uFoamRect.value.copy(rect);
    water.uniforms.uFoamMap.value = this.a.texture;
    // the simulation pass must not read the texture it is drawing into
    this.uniforms = { ...water.uniforms, uFoamMap: { value: water.noise }, uPrev: { value: this.a.texture }, uDt: { value: 0 } };
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  step(dt) {
    this.uniforms.uPrev.value = this.a.texture;
    this.uniforms.uDt.value = dt;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.b);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
    [this.a, this.b] = [this.b, this.a];
    this.water.uniforms.uFoamMap.value = this.a.texture;
  }
}
