import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COMMON } from './shaders.js';
import { Water, makeBedTexture } from './water.js';
import { Terrain } from './terrain.js';
import { makeSatelliteTexture } from './satellite.js';
import { bedAt } from '../data/terrain.js';
import { sunPosition, bearingToLocal, skyPalette } from '../data/sun.js';
import { makeSurfaceSampler } from '../model/surface.js';
import { Spray } from './spray.js';
import { FoamSim } from './foam.js';

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
  { id: 'free', label: 'Free' },
  { id: 'walk', label: 'On foot' },
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

    this.foam = new FoamSim(renderer, this.water, terrain);
    this.spray = new Spray(quality < 1 ? 250 : 450);
    this.scene.add(this.spray.points);
    this.windLocal = [0, 0];

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

    // first-person mode: you, 1.7 m tall, free to look around and walk into the sea
    this.walk = { active: false, x: 0, z: 0, yaw: Math.PI / 2, pitch: -0.03, goal: null, eye: 2, keys: new Set(), told: 0, since: 0 };
    this.onPov = null;
    this.bindWalkControls(renderer.domElement);
    this.freeKeys = new Set();
    this.freeHint = 0;
    const freeKey = (ev, on) => {
      const k = ev.key.toLowerCase();
      if (this.preset !== 'free' || !['w', 'a', 's', 'd'].includes(k) || ev.target.closest?.('input, textarea')) return;
      if (on) this.freeKeys.add(k); else this.freeKeys.delete(k);
    };
    window.addEventListener('keydown', (ev) => freeKey(ev, true));
    window.addEventListener('keyup', (ev) => freeKey(ev, false));
    window.addEventListener('blur', () => this.freeKeys.clear());

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
    // keep a wide enough horizontal view on tall phone screens; human eyes see wider than a drone lens
    if (this.walk?.active) this.camera.fov = w / h < 0.8 ? 80 : 64;
    else this.camera.fov = w / h < 0.8 ? 68 : 50;
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
    if (id === 'walk') { this.enterWalk(); return; }
    if (this.walk.active) this.leaveWalk();
    // Free: you fly the camera yourself. Drag moves you over the beach like a map,
    // right-drag (or two fingers) turns and tilts, scroll or pinch zooms.
    const free = id === 'free';
    const c = this.controls;
    c.screenSpacePanning = false;
    c.mouseButtons = free
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.touches = free
      ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }
      : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    c.minDistance = free ? 1.5 : 4;
    c.maxDistance = free ? 6000 : 2600;
    this.freeHint = free ? 9 : 0;
    if (!free) this.onPov?.(null);
    if (free) {
      this.flight = null;
      // start from wherever you are, looking at the sea surface in front of you
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const tide = this.state?.tide ?? 0;
      const reach = dir.y < -0.05 ? Math.min(600, (this.camera.position.y - tide) / -dir.y) : 120;
      c.target.copy(this.camera.position).addScaledVector(dir, reach);
      c.target.y = tide;
      return;
    }
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

  // ---- on foot -------------------------------------------------------------
  enterWalk() {
    const w = this.walk;
    w.active = true;
    w.goal = null;
    w.since = 0;
    // start on the sand a few steps above the swash, facing the sea
    w.x = this.walker.position.x + 7;
    w.z = this.walker.position.z - 12;
    w.yaw = Math.PI / 2;
    w.pitch = -0.03;
    w.eye = bedAt(this.terrain, w.x, w.z) + 1.7;
    this.controls.enabled = false;
    this.flight = null;
    this.resize();
  }

  leaveWalk() {
    this.walk.active = false;
    this.walk.keys.clear();
    this.controls.enabled = true;
    // hand the orbit camera a sensible thing to look at
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.controls.target.copy(this.camera.position).addScaledVector(dir, 60);
    this.resize();
    this.onPov?.(null);
  }

  bindWalkControls(dom) {
    const w = this.walk;
    let down = null;
    dom.addEventListener('pointerdown', (ev) => {
      if (!w.active) return;
      down = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: 0, t: performance.now() };
      dom.setPointerCapture(ev.pointerId);
    });
    dom.addEventListener('pointermove', (ev) => {
      if (!w.active || !down || ev.pointerId !== down.id) return;
      const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
      down.x = ev.clientX; down.y = ev.clientY;
      down.moved += Math.abs(dx) + Math.abs(dy);
      // drag the view like a street-level panorama
      const k = (0.0034 * this.camera.fov) / 64;
      w.yaw += dx * k;
      w.pitch = Math.min(1.25, Math.max(-1.25, w.pitch + dy * k));
    });
    const up = (ev) => {
      if (!down || ev.pointerId !== down.id) return;
      const tap = down.moved < 8 && performance.now() - down.t < 500;
      down = null;
      if (w.active && tap) this.walkTo(ev.clientX, ev.clientY);
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', () => { down = null; });
    dom.addEventListener('wheel', (ev) => {
      if (!w.active) return;
      ev.preventDefault();
      this.camera.fov = Math.min(85, Math.max(25, this.camera.fov + ev.deltaY * 0.03));
      this.camera.updateProjectionMatrix();
    }, { passive: false });
    const key = (ev, on) => {
      if (!w.active || ev.target.closest?.('input, textarea')) return;
      const k = ev.key.toLowerCase();
      if (!['w', 'a', 's', 'd'].includes(k)) return;
      if (on) w.keys.add(k); else w.keys.delete(k);
    };
    window.addEventListener('keydown', (ev) => key(ev, true));
    window.addEventListener('keyup', (ev) => key(ev, false));
    window.addEventListener('blur', () => w.keys.clear());
  }

  /** Tap the sand or the sea: walk (or wade, or swim) to that spot. */
  walkTo(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const tide = this.state?.tide ?? 0;
    const t = this.terrain;
    let hit = null;
    for (let s = 1.5; s < 700; s += 0.4 + s * 0.02) {
      const x = o.x + d.x * s, y = o.y + d.y * s, z = o.z + d.z * s;
      if (y <= Math.max(bedAt(t, x, z), tide)) { hit = [x, z]; break; }
    }
    // tapping the sky means "that way": go 40 m in that direction
    if (!hit) hit = [o.x + d.x * 40, o.z + d.z * 40];
    this.walk.goal = {
      x: Math.min(t.x0 + t.sizeX - 40, Math.max(t.x0 + 60, hit[0])),
      z: Math.min(t.z0 + t.sizeZ - 40, Math.max(t.z0 + 40, hit[1])),
    };
  }

  updateWalk(dt, tide, exag) {
    const w = this.walk, t = this.terrain;
    const ground = bedAt(t, w.x, w.z);
    const depth = Math.max(0, tide - ground);
    // run on sand, wade when it is knee deep, swim when you cannot stand
    const speed = depth > 1.3 ? 2.4 : depth > 0.35 ? 3.4 : 6;
    const fwd = [-Math.sin(w.yaw), -Math.cos(w.yaw)], right = [Math.cos(w.yaw), -Math.sin(w.yaw)];
    let mx = 0, mz = 0;
    if (w.keys.has('w')) { mx += fwd[0]; mz += fwd[1]; }
    if (w.keys.has('s')) { mx -= fwd[0]; mz -= fwd[1]; }
    if (w.keys.has('d')) { mx += right[0]; mz += right[1]; }
    if (w.keys.has('a')) { mx -= right[0]; mz -= right[1]; }
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      w.goal = null;
      w.x += (mx / len) * speed * dt;
      w.z += (mz / len) * speed * dt;
    } else if (w.goal) {
      const gx = w.goal.x - w.x, gz = w.goal.z - w.z;
      const dist = Math.hypot(gx, gz);
      if (dist < 0.4) w.goal = null;
      else {
        const step = Math.min(dist, speed * dt * Math.min(1, 0.25 + dist / 6)); // ease in to a stop
        w.x += (gx / dist) * step;
        w.z += (gz / dist) * step;
      }
    }
    w.x = Math.min(t.x0 + t.sizeX - 40, Math.max(t.x0 + 60, w.x));
    w.z = Math.min(t.z0 + t.sizeZ - 40, Math.max(t.z0 + 40, w.z));

    // eyes 1.7 m above your feet; once the water is over your chin you float with it
    const bed = bedAt(t, w.x, w.z);
    const surface = tide + (this.sampler ? this.sampler(w.x, w.z, this.time, exag) : 0);
    const eye = Math.max(bed + 1.7, surface + 0.3);
    w.eye += (eye - w.eye) * Math.min(1, dt * 9);
    this.camera.position.set(w.x, w.eye, w.z);
    this.camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ');

    // tell the interface what you are standing in, a few times a second
    w.since += dt;
    w.told -= dt;
    if (this.onPov && w.told <= 0) {
      w.told = 0.3;
      this.onPov(w.since < 7 ? 'Drag to look around · tap the sand or the sea to go there · W A S D to walk' : this.describeSpot(bed, tide));
    }
  }

  describeSpot(bed, tide) {
    const w = this.walk;
    const depth = tide - bed;
    const H = this.sampler?.waveHeight(w.x, w.z) ?? 0;
    const against = (h) => (h < 0.3 ? 'ankle high' : h < 0.6 ? 'knee high' : h < 1.0 ? 'waist high' : h < 1.35 ? 'chest high' : h < 1.75 ? 'head high' : `${(h / 1.75).toFixed(1)}× your height`);
    if (depth < 0.05) {
      const surf = this.state?.surfHeight ?? 0;
      const out = Math.max(0, Math.round(w.x - (this.state?.surf?.breakX ?? 0)));
      return surf > 0.25
        ? `On the sand · waves break ${out} m in front of you at about ${surf.toFixed(1)} m (${against(surf)})`
        : 'On the sand · nothing much breaking';
    }
    const where = depth < 0.3 ? 'ankle deep' : depth < 0.6 ? 'knee deep' : depth < 1.0 ? 'waist deep' : depth < 1.35 ? 'chest deep' : depth < 1.6 ? 'neck deep' : 'out of your depth, swimming';
    return `Water ${depth.toFixed(1)} m (${where}) · waves here about ${H.toFixed(1)} m, ${against(H)}`;
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

    // wind in the beach frame (m/s, direction it blows towards) for the spray
    if (state.wind) {
      const rad = Math.PI / 180, to = (state.wind.direction + 180) * rad;
      const bx = (this.beach.seawardBearing + 180) * rad, bz = (this.beach.seawardBearing - 90) * rad;
      const v = state.wind.speed / 3.6;
      this.windLocal = [Math.cos(to - bx) * v, Math.cos(to - bz) * v];
    } else this.windLocal = [0, 0];

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
    this.foam.step(dt * this.speed);
    this.spray.update({
      dt, state: this.state, sampler: this.sampler, time: this.time, exag, wind: this.windLocal,
      light: this.shared.uSunStrength.value + this.shared.uAmbient.value,
      pxScale: this.renderer.domElement.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360)),
    });
    if (this.preset === 'free' && !this.walk.active) {
      // W A S D glides over the water in the direction you are facing
      const k = this.freeKeys;
      if (k.size) {
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        dir.y = 0; dir.normalize();
        const right = new THREE.Vector3(-dir.z, 0, dir.x);
        const move = new THREE.Vector3();
        if (k.has('w')) move.add(dir);
        if (k.has('s')) move.sub(dir);
        if (k.has('d')) move.add(right);
        if (k.has('a')) move.sub(right);
        const dist = this.camera.position.distanceTo(this.controls.target);
        move.multiplyScalar(dt * Math.max(8, dist * 0.9));
        this.camera.position.add(move);
        this.controls.target.add(move);
      }
      if (this.freeHint > 0) {
        this.freeHint -= dt;
        this.onPov?.(this.freeHint > 0 ? 'Drag to move · right-drag or two fingers to turn · scroll or pinch to zoom · W A S D to glide' : null);
      }
    }
    if (this.walk.active) {
      this.updateWalk(dt, tide, exag);
    } else {
      this.controls.update();
      // never let the camera sink below the sand or the sea
      const p = this.camera.position;
      const floor = Math.max(bedAt(this.terrain, p.x, p.z), tide) + 0.6;
      if (p.y < floor) p.y = floor;
    }
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
