// Surf trainer. Two thumbs are two feet on the board; where you press is where
// your weight goes. The aim is to learn WHEN each movement happens on a wave,
// so a coach shows the zones to press and every turn is graded for timing.
//
// The rider lives in the wave's own frame: `d` is how far ahead of the crest
// they are (0 = at the lip, `face` = at the bottom), `z` is the position along
// the beach, `theta` is the board's heading (0 = straight to shore, +-90 deg =
// along the wave). The wave itself comes from the forecast model.

import * as THREE from 'three';

const G = 9.81;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class SurfGame {
  /**
   * @param viewer the 3-D viewer (camera, scene, wave sampler)
   * @param ui { pad, coach, score, flash } DOM elements
   */
  constructor(viewer, ui) {
    this.viewer = viewer;
    this.ui = ui;
    this.active = false;
    this.stance = 'regular'; // regular = left foot forward, toes on the right rail
    this.input = { front: false, back: false, frontLean: 0, backLean: 0, taps: [] };
    this.rider = makeRider();
    this.rider.visible = false;
    viewer.scene.add(this.rider);
    this.auto = false; // a simple bot that follows the coach (a demo, and used for testing)
    this.score = 0;
    this.bindPad();
    this.bindKeys();
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    this.active = true;
    this.score = 0;
    this.ui.score.textContent = '0';
    this.viewer.controls.enabled = false;
    this.viewer.gameHook = (dt) => this.update(dt);
    this.viewer.surfer.visible = false;
    this.rider.visible = true;
    this.toWaiting('Sit tight. A wave is coming.');
  }

  stop() {
    this.active = false;
    this.viewer.gameHook = null;
    this.viewer.controls.enabled = true;
    this.viewer.surfer.visible = true;
    this.rider.visible = false;
    this.viewer.resize();
    this.viewer.setCamera('drone');
  }

  toWaiting(message) {
    const [sx, sz] = this.viewer.surferSpot ?? [-120, 30];
    this.phase = 'waiting';
    this.x = sx; this.z = sz;
    this.paddle = 0;
    this.wave = null;
    this.target = null;
    this.say(message, 'When the wave is close, tap the two pads in turn to paddle');
    this.hint([]);
  }

  // ------------------------------------------------------------------- update
  update(dt) {
    const v = this.viewer, S = v.sampler;
    if (!S?.primary) return;
    const t = v.time, tide = v.state.tide, exag = v.water.uniforms.uExag.value;
    const T = S.primary.period;
    if (this.auto) this.botInput(t);

    if (this.phase === 'waiting' || this.phase === 'paddling') {
      // which crest arrives next at our spot, and when?
      const phase = (t - S.tauAt(this.x, this.z)) / T;
      if (this.phase === 'waiting') {
        const n = Math.ceil(phase);
        const eta = (n - phase) * T; // seconds until that crest reaches us
        const worthIt = S.factor(n, this.z) > 0.6; // let the small ones go
        if (worthIt && eta < 4.5 && eta > 1.5) {
          this.phase = 'paddling';
          this.wave = n;
          this.paddle = 0;
        }
      }
      if (this.phase === 'paddling') {
        const eta = (this.wave - phase) * T;
        // alternating taps are paddle strokes
        const taps = this.input.taps.filter((tp) => t - tp.t < 3.5);
        let strokes = 0;
        for (let i = 1; i < taps.length; i++) if (taps[i].foot !== taps[i - 1].foot) strokes++;
        this.paddle = clamp(strokes / 4, 0, 1);
        const both = this.input.front && this.input.back;
        if (eta > 1.4) {
          this.say(`Wave in ${Math.ceil(eta)} s: paddle!`, `Paddle power ${Math.round(this.paddle * 100)}%`);
          this.hint(['front', 'back'], true);
        } else if (eta > -0.6) {
          this.say('Pop up now: both feet down', this.paddle < 0.5 ? 'Not enough paddle power' : 'The wave is lifting you');
          this.hint(['front', 'back']);
          if (both && this.paddle >= 0.5) this.startRide();
        } else {
          this.toWaiting(this.paddle < 0.5
            ? 'Missed it: paddle harder. Next wave.'
            : 'Missed the pop-up: press both pads as the wave lifts you.');
        }
      }
      if (this.phase !== 'riding') {
        const y = tide + S(this.x, this.z, t, exag);
        this.rider.position.set(this.x, y, this.z);
        this.rider.rotation.set(0, 0, 0);
        this.pose(0, true);
        this.chaseCamera(dt, 1, y, true);
        return;
      }
    }

    if (this.phase === 'riding') this.ride(dt, S, t, tide, exag, T);
    else if (this.phase === 'done') {
      this.doneTimer -= dt;
      const y = tide + S(this.x, this.z, t, exag);
      this.rider.position.set(this.x, y - 0.3, this.z);
      this.pose(0, true);
      this.chaseCamera(dt, Math.sin(this.theta) >= 0 ? 1 : -1, y, false);
      if (this.doneTimer <= 0) this.toWaiting('Paddle back out. Next wave coming.');
    }
  }

  startRide() {
    this.phase = 'riding';
    this.theta = this.stance === 'regular' ? 0.9 : -0.9; // angle off towards your frontside
    this.speed = 3.5;
    this.d = null; // set on the first ride step
    this.turn = null;
    this.log = [];
    this.rideTime = 0;
    this.rideScore = 0;
    this.stalled = 0;
    this.say('Up and riding!', 'Slide your thumbs to the rails to turn');
  }

  ride(dt, S, t, tide, exag, T) {
    const c = S.speedAt(this.x, this.z);
    const H = Math.max(0.4, S.waveHeight(this.x, this.z));
    const face = clamp(0.2 * c * T, 6, 26); // metres from the lip to the bottom of the wave
    if (this.d === null) this.d = face * 0.55;

    // ---- your feet -----------------------------------------------------------
    const inp = this.input;
    const n = (inp.front ? 1 : 0) + (inp.back ? 1 : 0);
    const lean = n ? ((inp.front ? inp.frontLean : 0) + (inp.back ? inp.backLean : 0)) / n : 0; // +1 toes, -1 heels
    const weight = (inp.front ? 1 : 0) - (inp.back ? 1 : 0); // +1 forward, -1 back
    const stanceSign = this.stance === 'regular' ? 1 : -1; // toes are on the right rail for a regular-footer

    // ---- the board -----------------------------------------------------------
    // leaning on a rail turns the board; weight on the tail makes it pivot faster
    const pivot = weight < 0 ? 1.9 : weight > 0 ? 0.75 : 1.2;
    const turnRate = lean * stanceSign * pivot * 1.5;
    this.theta += turnRate * dt;
    const f = this.d / face; // 0 at the lip .. 1 at the bottom
    let down = Math.cos(this.theta);
    // gravity down the face is strongest in the steep middle; the flats give nothing
    const steep = (H / face) * 2.2 * Math.sin(Math.PI * clamp(f, 0, 1));
    let acc = G * steep * down;
    // the wave itself drives you along while you stay on its face (this is what makes surfing possible)
    acc += 2.3 * Math.sin(Math.PI * clamp(f, 0, 1)) + (this.speed < 2.5 ? 1.5 : 0);
    if (weight > 0) acc += 1.4 * clamp(1 - Math.abs(f - 0.5) * 2, 0, 1); // trimming: weight forward
    if (weight < 0) acc -= 1.0; // stalling: weight back
    acc -= 0.22 * this.speed + 0.7 * Math.abs(lean) * (weight < 0 ? 1.6 : 0.6); // drag, more in hard turns
    const broken = S.brokenAt(this.x, this.z, this.wave);
    if (broken) acc -= 0.5 * this.speed; // white water is slow
    this.speed = clamp(this.speed + acc * dt, 0, 10);
    this.d += this.speed * down * dt;
    this.z += this.speed * Math.sin(this.theta) * dt;
    // out on the flat in front of the wave you are no longer carried: it catches up
    if (f > 1) this.d -= c * 2.1 * (f - 1) * dt;

    // ---- forgiving edges -------------------------------------------------------
    // at the lip the wave turns you back down the face instead of throwing you off
    if (this.d < 0.4) {
      this.d = 0.4;
      if (down < 0.1) this.theta += (Math.sin(this.theta) >= 0 ? -1 : 1) * 2.4 * dt;
    }
    this.theta = ((this.theta + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    down = Math.cos(this.theta);

    // ---- where that puts you in the world --------------------------------------
    const tauTarget = t - this.wave * T + this.d / c;
    for (let i = 0; i < 5; i++) this.x += (tauTarget - S.tauAt(this.x, this.z)) * S.speedAt(this.x, this.z) * 0.9;
    const y = tide + S(this.x, this.z, t, exag);
    this.rider.position.set(this.x, y + 0.05, this.z);
    this.rider.rotation.set(0, -this.theta, 0);
    this.pose(lean * stanceSign, false, weight);
    this.chaseCamera(dt, Math.sin(this.theta) >= 0 ? 1 : -1, y, false);

    // ---- coach and timing ------------------------------------------------------
    this.rideTime += dt;
    this.coach(f, down, lean, turnRate, stanceSign);

    // ---- how a ride ends -------------------------------------------------------
    const tr = this.viewer.terrain;
    this.stalled = this.speed < 0.8 ? this.stalled + dt : 0;
    const shallow = S.depthAt(this.x, this.z) < 0.45;
    const outside = this.z < tr.z0 + 60 || this.z > tr.z0 + tr.sizeZ - 60;
    if (shallow || outside || this.stalled > 3 || this.rideTime > 45) {
      this.finish(shallow ? 'Rode it to the sand' : this.stalled > 3 ? 'Lost your speed' : 'End of the wave');
    }
  }

  /** Tell the player what the wave is asking for, and grade the turns they make. */
  coach(f, down, lean, turnRate, stanceSign) {
    const along = Math.sin(this.theta) >= 0 ? 1 : -1; // riding towards +z or -z
    // the turn direction (sign of heading change) that points the board up the face
    const upTurn = along;
    const railUp = upTurn * stanceSign > 0 ? 'toe' : 'heel';
    const railDown = railUp === 'toe' ? 'heel' : 'toe';
    let want = null;
    if (f > 0.62 && down > -0.15) {
      want = { name: 'Bottom turn', text: `Both feet on your ${railUp}s: drive back up the face`, zones: [`front-${railUp}`, `back-${railUp}`] };
    } else if (f < 0.32 && down < 0.15) {
      want = { name: 'Top turn', text: `Back foot, hard on your ${railDown}s: come back down`, zones: [`back-${railDown}`] };
    } else if (Math.abs(down) < 0.5) {
      want = { name: 'Trim', text: 'Front foot down for speed', zones: ['front'] };
    }
    this.target = want;
    if (want) { this.say(want.name, want.text); this.hint(want.zones); } else this.hint([]);

    // a turn starts when you commit to a rail, and is graded on where on the wave you started it
    const dir = Math.abs(lean) > 0.45 ? Math.sign(turnRate) : 0;
    if (dir && !this.turn) this.turn = { dir, f0: f, theta0: this.theta, up: dir === upTurn };
    else if (this.turn && dir !== this.turn.dir) {
      const tu = this.turn;
      this.turn = null;
      const angle = Math.abs((((this.theta - tu.theta0) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (angle > 0.7) this.grade(tu);
    }
  }

  grade(turn) {
    const name = turn.up ? 'Bottom turn' : 'Top turn';
    const [lo, hi] = turn.up ? [0.62, 1.05] : [0.0, 0.34];
    let verdict, pts;
    if (turn.f0 >= lo && turn.f0 <= hi) { verdict = 'perfect timing'; pts = 100; }
    else if (turn.up) { verdict = turn.f0 < lo ? 'too early: wait until you reach the bottom' : 'too late: you were out on the flat'; pts = 40; }
    else { verdict = 'too early: climb higher before you turn'; pts = 40; }
    pts = Math.round(pts * clamp(this.speed / 6, 0.5, 1.4));
    this.rideScore += pts;
    this.log.push({ name, verdict, pts, perfect: verdict === 'perfect timing' });
    this.flash(`${name}: ${verdict}  +${pts}`, verdict === 'perfect timing');
    this.ui.score.textContent = `${this.score + this.rideScore}`;
  }

  finish(why) {
    this.phase = 'done';
    this.doneTimer = 4;
    this.score += this.rideScore;
    const perfect = this.log.filter((l) => l.perfect).length;
    this.say(`${why}`, `${this.log.length} turns, ${perfect} with perfect timing. Ride score ${this.rideScore}`);
    this.hint([]);
    this.ui.score.textContent = `${this.score}`;
  }

  // ----------------------------------------------------------------- display
  say(title, detail = '') {
    if (this._said === title + detail) return;
    this._said = title + detail;
    this.ui.coach.querySelector('strong').textContent = title;
    this.ui.coach.querySelector('span').textContent = detail;
  }

  flash(text, good) {
    const el = this.ui.flash;
    el.textContent = text;
    el.className = `game-flash show ${good ? 'good' : 'ok'}`;
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => { el.className = 'game-flash'; }, 2000);
  }

  /** Light up the zones the coach wants pressed. */
  hint(zones, alternate = false) {
    const key = zones.join(',') + alternate;
    if (this._hint === key) return;
    this._hint = key;
    for (const el of this.ui.pad.querySelectorAll('[data-zone]')) {
      const z = el.dataset.zone; // e.g. front-toe, front-mid
      const foot = z.split('-')[0];
      const on = zones.includes(z) || (zones.includes(foot) && z.endsWith('mid'));
      el.classList.toggle('want', on);
      el.classList.toggle('alt', on && alternate);
    }
  }

  pose(lean, sitting, weight = 0) {
    const body = this.rider.userData.body;
    if (sitting) { body.position.set(0, -0.5, 0); body.rotation.set(0, 0, 0); return; }
    body.position.set(weight * 0.18, 0.06 - 0.12 * Math.abs(lean), 0); // crouch into turns, shift with weight
    body.rotation.set(lean * 0.5, Math.PI / 2, 0); // sideways on the board, leaning over the rail
  }

  chaseCamera(dt, along, y, waiting) {
    const cam = this.viewer.camera;
    // on the shore side, a little ahead of the rider, looking back at the wave face
    const want = waiting
      ? new THREE.Vector3(this.x + 12, y + 2.8, this.z + 7)
      : new THREE.Vector3(this.x + 13, y + 3.4, this.z + along * 9);
    cam.position.lerp(want, 1 - Math.exp(-dt * 3.5));
    cam.lookAt(this.x - 2, y + 0.9, this.z + (waiting ? 0 : along * 2));
    const fov = cam.aspect < 0.8 ? 74 : 58;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  // ------------------------------------------------------------------- input
  setStance(stance) {
    this.stance = stance;
    this.ui.pad.classList.toggle('goofy', stance === 'goofy');
  }

  bindPad() {
    const pad = this.ui.pad;
    const feet = { front: pad.querySelector('[data-foot=front]'), back: pad.querySelector('[data-foot=back]') };
    const owner = new Map(); // pointer id -> foot
    const read = (foot, ev) => {
      const r = feet[foot].getBoundingClientRect();
      // across the board: the right rail is the toe side for a regular-footer, the heel side for a goofy-footer
      const across = clamp(((ev.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      const lean = this.stance === 'regular' ? across : -across;
      this.input[`${foot}Lean`] = Math.abs(lean) < 0.3 ? 0 : lean;
      feet[foot].style.setProperty('--px', `${((across + 1) / 2) * 100}%`);
    };
    for (const foot of ['front', 'back']) {
      const el = feet[foot];
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        el.setPointerCapture(ev.pointerId);
        owner.set(ev.pointerId, foot);
        this.input[foot] = true;
        this.input.taps.push({ foot, t: this.viewer.time });
        if (this.input.taps.length > 24) this.input.taps.shift();
        el.classList.add('down');
        read(foot, ev);
      });
      el.addEventListener('pointermove', (ev) => { if (owner.get(ev.pointerId) === foot) read(foot, ev); });
      const up = (ev) => {
        if (owner.get(ev.pointerId) !== foot) return;
        owner.delete(ev.pointerId);
        this.input[foot] = false;
        this.input[`${foot}Lean`] = 0;
        el.classList.remove('down');
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
  }

  /** Keyboard, for desktops: Z / X paddle, space = both feet, arrows = lean and weight. */
  bindKeys() {
    const held = new Set();
    const apply = () => {
      const lean = (held.has('arrowright') ? 1 : 0) - (held.has('arrowleft') ? 1 : 0);
      const any = held.has(' ') || lean !== 0;
      this.input.front = (any && !held.has('arrowdown')) || held.has('arrowup') || held.has('x');
      this.input.back = (any && !held.has('arrowup')) || held.has('arrowdown') || held.has('z');
      const l = this.stance === 'regular' ? lean : -lean;
      this.input.frontLean = l; this.input.backLean = l;
    };
    const keys = ['z', 'x', ' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'];
    window.addEventListener('keydown', (ev) => {
      const k = ev.key.toLowerCase();
      if (!this.active || !keys.includes(k)) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (!held.has(k) && (k === 'z' || k === 'x')) this.input.taps.push({ foot: k === 'z' ? 'back' : 'front', t: this.viewer.time });
      held.add(k); apply();
    }, true);
    window.addEventListener('keyup', (ev) => {
      if (!this.active) return;
      held.delete(ev.key.toLowerCase()); apply();
    }, true);
  }

  /** Follows the coach: paddles, pops up and presses the zones it lights. */
  botInput(t) {
    const inp = this.input;
    if (this.phase === 'paddling') {
      const beat = Math.floor(t * 4);
      if (beat !== this._beat) { this._beat = beat; inp.taps.push({ foot: beat % 2 ? 'front' : 'back', t }); }
      inp.front = inp.back = this.paddle >= 0.5;
      inp.frontLean = inp.backLean = 0;
    } else if (this.phase === 'riding') {
      const z = this.target?.zones ?? ['front', 'back'];
      inp.front = z.some((q) => q.startsWith('front'));
      inp.back = z.some((q) => q.startsWith('back'));
      const lean = z.some((q) => q.endsWith('toe')) ? 1 : z.some((q) => q.endsWith('heel')) ? -1 : 0;
      inp.frontLean = inp.backLean = lean;
    } else { inp.front = inp.back = false; }
  }
}

function makeRider() {
  const g = new THREE.Group();
  const dark = new THREE.MeshBasicMaterial({ color: 0x14181c });
  const white = new THREE.MeshBasicMaterial({ color: 0xf4f1e8 });
  const board = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.45, 3, 10), white);
  board.scale.set(1, 1, 0.14);
  board.rotation.set(Math.PI / 2, 0, Math.PI / 2, 'YXZ'); // lying flat, nose along +x
  board.position.y = 0.04;
  const body = new THREE.Group();
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.42, 3, 8), dark);
  legs.position.y = 0.38; legs.scale.set(1, 1, 1.9); // a wide, low stance
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.36, 3, 10), dark);
  torso.position.y = 0.95;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), dark);
  head.position.y = 1.36;
  body.add(legs, torso, head);
  g.add(board, body);
  g.userData.body = body;
  return g;
}
