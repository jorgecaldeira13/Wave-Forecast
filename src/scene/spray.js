// Spray and mist thrown off breaking crests (Peachey 1986; Thurey et al. 2007).
// Particles are born on crests inside the surf zone, thrown up, then pushed by
// the wind: offshore wind blows them back off the lip, onshore wind drives them
// over the back of the wave.

import * as THREE from 'three';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAlpha;
attribute float aSize;
uniform float uScale;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.5), 1.5, 26.0);
  vAlpha = aAlpha * smoothstep(4.0, 22.0, -mv.z); // no blobs in your face
  #include <logdepthbuf_vertex>
}
`;
const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = (1.0 - smoothstep(0.2, 1.0, d)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

export class Spray {
  constructor(count = 450) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count); // seconds left; <= 0 means free
    this.maxLife = new Float32Array(count).fill(1);
    this.alpha = new Float32Array(count);
    this.size = new Float32Array(count);
    this.pos.fill(-1e5);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = { uScale: { value: 400 }, uColor: { value: new THREE.Color(0.9, 0.95, 0.97) } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.carry = 0;
  }

  /**
   * @param ctx { dt, state, sampler, time, exag, wind: [x, z] m/s in the beach frame, light: 0..1.2, pxScale }
   */
  update({ dt, state, sampler, time, exag, wind, light, pxScale }) {
    this.uniforms.uScale.value = pxScale;
    this.uniforms.uColor.value.setScalar(0.55 + 0.45 * Math.min(1, light));
    const H = state?.surfHeight ?? 0;
    // spawn along the surf zone, only on crests of waves that are breaking
    if (sampler && H > 1.3) { // small surf throws no visible spray
      this.carry += dt * Math.min(260, 70 * H * H);
      const breakX = Math.min(-30, state.surf?.breakX ?? -100);
      let tries = 0;
      while (this.carry >= 1 && tries++ < 40) {
        const x = breakX - 15 + Math.random() * 90;
        const z = (Math.random() - 0.5) * 420;
        const eta = sampler(x, z, time, exag);
        if (eta < 0.28 * H * exag) continue; // not on a crest
        this.carry -= 1;
        const i = this.life.findIndex((l) => l <= 0);
        if (i < 0) break;
        this.pos[i * 3] = x;
        this.pos[i * 3 + 1] = state.tide + eta;
        this.pos[i * 3 + 2] = z;
        const up = 1.2 + Math.random() * 1.2 * Math.sqrt(H);
        this.vel[i * 3] = 1.5 + Math.random() * 2.5; // thrown shoreward with the wave
        this.vel[i * 3 + 1] = up;
        this.vel[i * 3 + 2] = (Math.random() - 0.5) * 2;
        this.maxLife[i] = this.life[i] = 1.1 + Math.random() * 1.5;
        this.size[i] = 1.0 + Math.random() * 1.8;
      }
      this.carry = Math.min(this.carry, 5);
    }
    const drag = Math.min(1, dt * 1.3);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const o = i * 3;
      this.vel[o] += (wind[0] * 0.8 - this.vel[o]) * drag;
      this.vel[o + 2] += (wind[1] * 0.8 - this.vel[o + 2]) * drag;
      this.vel[o + 1] -= 4 * dt; // mist falls slowly
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 2.2) * Math.min(1, (1 - t) * 6 + 0.2) * 0.42;
      if (this.life[i] <= 0) this.pos[o + 1] = -1e5;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}
