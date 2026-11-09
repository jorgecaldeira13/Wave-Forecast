import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COMMON } from './shaders.js';
import { Water, makeBedTexture } from './water.js';
import { Terrain } from './terrain.js';
import { makeSatelliteTexture } from './satellite.js';
import { bedAt } from '../data/terrain.js';
import { sunPosition, bearingToLocal, skyPalette } from '../data/sun.js';
import { makeSurfaceSampler } from '../model/surface.js';

const SKY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(position * 20000.0 + cameraPosition, 1.0);
  gl_Position = p;
  #include <logdepthbuf_vertex>
}
`;
const SKY_FRAG = /* glsl */ `
${COMMON}
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  vec3 col = skyColor(vec3(d.x, max(d.y, 0.0), d.z));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * uSunStrength * uSunGlow * smoothstep(0.99985, 0.99996, s) * 14.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const CAMERA_PRESETS = [
  { id: 'drone', label: 'Drone' },
  { id: 'lineup', label: 'Line-up' },
  { id: 'beach', label: 'Beach' },
  { id: 'groyne', label: 'Groyne' },
  { id: 'top', label: 'Map' },
];

export class Viewer {
  constructor(container, beach, terrain, { quality = 1, solverGrid = null } = {}) {
    this.beach = beach;
    this.solverGrid = solverGrid;
    this.terrain = terrain;
    this.state = null;
    this.speed = 1;
    this.clock = new THREE.Clock();
    this.time = 40; // start with waves already across the patch

    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, quality < 1 ? 1.5 : 2);
    renderer.setPixelRatio(this.pixelRatio);
    this.perf = { acc: 0, n: 0, warmup: 3 };
    renderer.toneMapping = THREE.NeutralToneMapping; // keeps authored colours, only tames highlights
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.container = container;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.3, 80000);

    // light and atmosphere shared by every material
    this.shared = {
      uSkyZenith: { value: new THREE.Color(0.13, 0.33, 0.7) },
      uSkyHorizon: { value: new THREE.Color(0.68, 0.8, 0.92) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSunStrength: { value: 1 },
      uSunGlow: { value: 1 },
      uAmbient: { value: 0.55 },
      uFogDensity: { value: 0.00011 },
    };

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({ uniforms: this.shared, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false }),
    );
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.scene.add(sky);

    this.ground = new Terrain(terrain, this.shared);
    this.scene.add(this.ground.mesh);
    this.water = new Water(terrain, this.shared, makeBedTexture(terrain), { quality });
    this.scene.add(this.water.mesh);

    // satellite photo for everything from just seaward of the groynes to the town
    const rect = { x0: -190, z0: terrain.z0, sizeX: terrain.x0 + terrain.sizeX + 190, sizeZ: terrain.sizeZ };
    const sat = makeSatelliteTexture(beach, rect);
    this.ground.setSatellite(sat);
    this.satelliteLoaded = sat.loaded;

    // people for scale: a surfer waiting in the line-up and someone on the sand
    this.surfer = makeSurfer();
    this.walker = makePerson();
    this.scene.add(this.surfer, this.walker);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.497;
    controls.minDistance = 4;
    controls.maxDistance = 2600;
    controls.zoomSpeed = 0.8;
    controls.rotateSpeed = 0.55;
    this.controls = controls;
    controls.addEventListener('start', () => { this.flight = null; this.userMoved = true; });

    this.flight = null;
    this.setCamera('drone', true);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // keep a wide enough horizontal view on tall phone screens
    this.camera.fov = w / h < 0.8 ? 68 : 50;
    this.camera.updateProjectionMatrix();
  }

  /** Where each camera sits depends on the tide and on where waves are breaking. */
  presetPose(id) {
    const tide = this.state?.tide ?? 0;
    const breakX = Math.min(-45, this.state?.surf?.breakX ?? -120);
    const exag = this.water.uniforms.uExag.value;
    const waveH = (this.state?.setHeight ?? 1) * exag;
    switch (id) {
      case 'lineup': {
        // in the water on the shoulder of the peak: sets stand up and break right in front of you
        const x = Math.max(breakX + 8, this.terrain.x0 + 150);
        return { pos: [x, tide + 1.15, 64], target: [x - 55, tide + 0.9, -90] };
      }
      case 'beach': {
        // standing on dry sand just above the highest swash
        const reach = tide + (this.state?.runup.setup ?? 0) + 0.5 * (this.state?.runup.swash ?? 0) + 0.5;
        let x = 0;
        while (x < this.terrain.x0 + this.terrain.sizeX - 20 && bedAt(this.terrain, x, 20) < reach) x += 2;
        x += 14;
        return { pos: [x, bedAt(this.terrain, x, 20) + 1.7, 20], target: [breakX, tide + 0.5, -10] };
      }
      case 'groyne': {
        const g = this.terrain.meta.groynes?.reduce((a, b) => (Math.abs(b.z) < Math.abs(a.z) ? b : a), { z: 160, tipX: -60 });
        const side = g.z > 0 ? -1 : 1;
        return { pos: [g.tipX - 14, tide + 4.2 + 0.3 * waveH, g.z + side * 6], target: [breakX * 0.4, tide + 0.4, g.z + side * 190] };
      }
      case 'top':
        return { pos: [-170, 760, 0.01], target: [-170, 0, 0] };
      case 'drone':
      default:
        return { pos: [150, 105, 300], target: [Math.max(breakX, -260) * 0.7, 0, -40] };
    }
  }

  setCamera(id, instant = false) {
    this.preset = id;
    this.userMoved = false;
    const pose = this.presetPose(id);
    const pos = new THREE.Vector3(...pose.pos), target = new THREE.Vector3(...pose.target);
    if (instant) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.flight = null;
    } else {
      this.flight = {
        t: 0,
        fromPos: this.camera.position.clone(), toPos: pos,
        fromTarget: this.controls.target.clone(), toTarget: target,
      };
    }
  }

  setExaggeration(v) {
    this.water.uniforms.uExag.value = v;
  }

  /** Show a solved sea state and light the scene for its hour. */
  setSeaState(state) {
    const first = !this.state;
    this.state = state;
    this.water.setSeaState(state, this.beach.seawardBearing);
    this.ground.setSeaState(state);

    const sun = sunPosition(state.hour.time, this.beach.lat, this.beach.lon);
    const pal = skyPalette(sun.elevation, state.hour.cloud ?? 0);
    // below the horizon the moon takes over so the night is still readable
    const night = sun.elevation < (-4 * Math.PI) / 180;
    const dir = night
      ? bearingToLocal(sun.azimuth + Math.PI, (35 * Math.PI) / 180, this.beach.seawardBearing)
      : bearingToLocal(sun.azimuth, Math.max(sun.elevation, 0.012), this.beach.seawardBearing);
    const s = this.shared;
    s.uSkyZenith.value.setRGB(...pal.zenith);
    s.uSkyHorizon.value.setRGB(...pal.horizon);
    s.uSunColor.value.setRGB(...pal.sun);
    s.uSunDir.value.set(...dir).normalize();
    s.uSunStrength.value = pal.strength;
    s.uSunGlow.value = pal.glow;
    s.uAmbient.value = pal.ambient;
    this.sun = sun;

    // float the surfer just outside the break; stand the walker above the swash
    this.sampler = this.solverGrid ? makeSurfaceSampler(this.solverGrid, state) : null;
    this.surferSpot = [Math.max(Math.min(-50, state.setBreakX ?? -120) - 10, this.terrain.x0 + 150), 34];
    const reach = state.tide + state.runup.setup + 0.5 * state.runup.swash + 0.35;
    let wx = -10;
    while (wx < this.terrain.x0 + this.terrain.sizeX - 20 && bedAt(this.terrain, wx, 9) < reach) wx += 1;
    this.walker.position.set(wx, bedAt(this.terrain, wx, 9), 9);

    // viewpoints that track the break follow it when conditions change
    if (first) this.setCamera(this.preset, true);
    else if (!this.userMoved && ['lineup', 'beach'].includes(this.preset)) this.setCamera(this.preset);
  }

  /** If the GPU cannot keep up, render fewer pixels rather than stutter. */
  adaptResolution(dt) {
    const p = this.perf;
    if (p.warmup > 0) { p.warmup -= dt; return; }
    p.acc += dt; p.n++;
    if (p.n < 45) return;
    const avg = p.acc / p.n;
    p.acc = 0; p.n = 0;
    if (avg > 0.042 && this.pixelRatio > 0.6) {
      this.pixelRatio = Math.max(0.6, this.pixelRatio * 0.8);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
      p.warmup = 1;
    }
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.adaptResolution(dt);
    this.time += dt * this.speed;
    this.water.uniforms.uTime.value = this.time;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / 1.4);
      const k = f.t * f.t * (3 - 2 * f.t);
      this.camera.position.lerpVectors(f.fromPos, f.toPos, k);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
      if (f.t >= 1) this.flight = null;
    }
    // the surfer rides up and down with the swell
    const exag = this.water.uniforms.uExag.value;
    const tide = this.state?.tide ?? 0;
    if (this.sampler && this.surferSpot) {
      const [sx, sz] = this.surferSpot;
      this.surfer.position.set(sx, tide + this.sampler(sx, sz, this.time, exag), sz);
      // in the line-up view you sit on the water too, until you grab the camera
      if (this.preset === 'lineup' && !this.userMoved && !this.flight) {
        const pose = this.presetPose('lineup');
        const bob = this.sampler(pose.pos[0], pose.pos[2], this.time, exag);
        this.camera.position.set(pose.pos[0], tide + 1.15 + bob, pose.pos[2]);
        this.controls.target.set(pose.target[0], tide + 0.9 + bob * 0.6, pose.target[2]);
      }
    }
    this.controls.update();
    // never let the camera sink below the sand or the sea
    const p = this.camera.position;
    const floor = Math.max(bedAt(this.terrain, p.x, p.z), this.state?.tide ?? 0) + 0.6;
    if (p.y < floor) p.y = floor;
    this.renderer.render(this.scene, this.camera);
  }
}

const FIGURE = new THREE.MeshBasicMaterial({ color: 0x14181c });
const BOARD = new THREE.MeshBasicMaterial({ color: 0xf2efe6 });

/** A 1.75 m person standing, origin at the feet. */
function makePerson() {
  const g = new THREE.Group();
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.62, 3, 8), FIGURE);
  legs.position.y = 0.44;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 3, 10), FIGURE);
  torso.position.y = 1.17;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), FIGURE);
  head.position.y = 1.63;
  g.add(legs, torso, head);
  return g;
}

/** A surfer sitting on a board, origin at the waterline. */
function makeSurfer() {
  const g = new THREE.Group();
  const board = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.5, 3, 10), BOARD);
  board.scale.set(1, 1, 0.16); // flatten, then lay it down pointing out to sea
  board.rotation.set(Math.PI / 2, 0, Math.PI / 2, 'YXZ');
  board.position.y = 0.03;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.38, 3, 10), FIGURE);
  torso.position.y = 0.42;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), FIGURE);
  head.position.y = 0.86;
  g.add(board, torso, head);
  return g;
}
