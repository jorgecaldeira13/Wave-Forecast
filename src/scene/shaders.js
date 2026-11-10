// GLSL shared by the sky, the terrain and the water.

export const COMMON = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunStrength;
uniform float uSunGlow;
uniform float uAmbient;
uniform float uFogDensity;
uniform sampler2D uSkyNoise;
uniform float uSkyTime;
uniform float uCloud;

// Drifting cloud cover, so the sky (and its reflection in the water and on wet
// sand) has structure. uCloud is the forecast cloud fraction.
float cloudCover(vec3 d) {
  vec2 uv = d.xz / (d.y + 0.2) * 0.06 + vec2(uSkyTime * 0.0012, uSkyTime * 0.0004);
  float n = texture(uSkyNoise, uv).r * 0.55 + texture(uSkyNoise, uv * 2.9 + 0.31).g * 0.3 + texture(uSkyNoise, uv * 8.3 + 0.7).b * 0.15;
  float edge = mix(0.74, 0.34, uCloud);
  return smoothstep(edge, edge + 0.2, n) * smoothstep(0.0, 0.1, d.y);
}

vec3 skyColor(vec3 d) {
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(h, 0.42));
  // haze: the sky whitens towards the horizon
  col = mix(col, uSkyHorizon * 1.08 + 0.03, exp(-h * 9.0) * 0.55);
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * uSunStrength * uSunGlow * (pow(s, 6.0) * 0.10 + pow(s, 48.0) * 0.28);
  float c = cloudCover(d);
  float lum = dot(uSkyHorizon, vec3(0.3, 0.55, 0.15));
  vec3 cloudCol = mix(vec3(lum) * 0.85, uSunColor * uSunStrength * 0.75 + uSkyHorizon * 0.5, 0.55 + 0.35 * pow(s, 3.0));
  return mix(col, cloudCol, c * 0.9);
}

vec3 applyFog(vec3 col, vec3 viewRay, float dist) {
  float f = 1.0 - exp(-dist * uFogDensity);
  vec3 dir = normalize(vec3(viewRay.x, max(viewRay.y, 0.0) * 0.4 + 0.015, viewRay.z));
  return mix(col, skyColor(dir), f);
}

// Bilinear read of a float texture whose texels sit on grid nodes.
vec4 fetchGrid(sampler2D tex, vec2 uv) {
  ivec2 size = textureSize(tex, 0);
  vec2 p = clamp(uv, 0.0, 1.0) * vec2(size - 1);
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  ivec2 mx = size - 1;
  vec4 a = texelFetch(tex, min(i, mx), 0);
  vec4 b = texelFetch(tex, min(i + ivec2(1, 0), mx), 0);
  vec4 c = texelFetch(tex, min(i + ivec2(0, 1), mx), 0);
  vec4 d = texelFetch(tex, min(i + ivec2(1, 1), mx), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

// The moving sea surface. Everything here is driven by fields solved on the
// CPU (src/physics/nearshore.js): the shader only animates them.
export const WAVES = /* glsl */ `
uniform sampler2D uFieldA;   // primary train:   travel time, slowness x, slowness z, amplification
uniform sampler2D uFieldA2;  // primary train:   breaking threshold, bore depth cap
uniform sampler2D uFieldB;   // secondary train: travel time, slowness x, slowness z, amplification
uniform sampler2D uBed;      // bed elevation (m), groyne mask
uniform sampler2D uNoise;
uniform vec4 uDomain;        // x0, z0, sizeX, sizeZ of the modelled patch
uniform float uTime;
uniform float uTide;
uniform float uExag;
uniform vec2 uEdgeH;         // wave height of each train at the offshore edge
uniform vec2 uPeriod;
uniform vec2 uSwash;         // wave setup, swash height
uniform float uMess;         // 0 groomed .. 1 blown out
uniform float uWindS;        // -1 offshore .. +1 onshore (shifts breaker type)
#define NC 20
uniform vec4 uComp[NC];      // wind-sea plane waves: kx, kz, omega, amplitude
uniform float uCompPh[NC];
uniform float uCompN;
uniform vec4 uEnv[6];        // wave-group envelope: d-omega, alongshore k, phase, amplitude
uniform sampler2D uFoamMap;  // simulated foam that lingers, drifts and fades
uniform vec4 uFoamRect;      // x0, z0, sizeX, sizeZ covered by the foam map

uniform vec3 uWind;           // unit direction the wind blows towards (x, z) and speed in m/s
uniform sampler2D uTile;      // live ocean patch: height, slope x, slope z
uniform float uTileSize;

const float TAU = 6.28318530718;

// Read the ocean patch, turned so its waves run downwind. Returns height and world-space slopes.
vec3 tileSample(vec2 p, float size) {
  vec2 w = uWind.xy;
  vec2 q = vec2(dot(p, w), dot(p, vec2(-w.y, w.x))) / size;
  vec3 t = texture(uTile, q).rgb;
  return vec3(t.r * size / uTileSize, w * t.g + vec2(-w.y, w.x) * t.b);
}
float chopAmount() { return 0.2 + 1.1 * clamp(uWind.z / 11.0, 0.0, 1.0); }

const float GAMMA_BORE = 0.5;

// Waves arrive in sets because a swell is a narrow band of frequencies and
// directions that beat against each other. This is the envelope of that band
// (see buildEnvelope in src/physics/spectrum.js; mirrored on the CPU).
float setFactor(float n, float z, float T) {
  float sT = n * T;
  vec2 e = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    float ph = uEnv[i].x * sT + uEnv[i].y * z + uEnv[i].z;
    e += uEnv[i].w * vec2(cos(ph), sin(ph));
  }
  return clamp(length(e) * 0.706, 0.15, 1.5);
}

// One wave over phase q in [0,1): crest at q = 0. 'peaked' sharpens the crest
// and flattens the trough (shallow water), 'skew' pitches the face forward.
float waveShape(float q, float peaked, float skew) {
  float w = q - skew * (1.0 - cos(TAU * q)) / TAU;
  float c = 0.5 + 0.5 * cos(TAU * w);
  float n = 1.0 + 2.6 * peaked;
  float mean = 0.5 * pow(n, -0.45);
  return (pow(c, n) - mean) * 2.0;
}

struct Surf {
  float eta;     // surface elevation above the tide level (m, exaggeration applied)
  vec2 grad;     // d(eta)/d(x,z)
  float foam;    // 0..1 white water
  float film;    // water thickness above the bed (m)
  float still;   // still-water depth (m)
  float face;    // 0..1 how steep and tall the wave face is here
  float slope;   // surface slope along the direction of travel: + on the front face
  float steepSea; // slope of the wind-sea waves alone (whitecaps)
  vec2 lean;      // horizontal throw of the crest (m): choppy peaks, pitching lips
  float plunge;   // 0 spilling .. 1 plunging
  float src;      // fresh white water being made right now (feeds the foam simulation)
  vec2 dir;       // direction of travel
};

Surf surface(vec2 p, bool detail) {
  Surf s;
  vec2 uv = (p - uDomain.xy) / uDomain.zw;
  vec4 bedInfo = fetchGrid(uBed, uv);
  float bed = bedInfo.r;
  float still = uTide - bed;
  float h = max(still, 0.05);
  vec4 a = fetchGrid(uFieldA, uv);
  vec4 a2 = fetchGrid(uFieldA2, uv);
  vec4 b = fetchGrid(uFieldB, uv);

  // waves fade to a flat sea outside the modelled patch
  vec2 e = min(uv, 1.0 - uv) * uDomain.zw;
  float inside = smoothstep(0.0, 90.0, e.x) * smoothstep(0.0, 90.0, e.y);
  if (uv.x > 0.5) inside = smoothstep(0.0, 90.0, e.y);

  float jitter = (texture(uNoise, p / 330.0).r - 0.5) * uMess;

  // ---- primary train -------------------------------------------------------
  float T = uPeriod.x;
  float ph = (uTime - a.x) / T + jitter * 0.4;
  float n = floor(ph);
  float q = ph - n;
  float s0 = setFactor(n, p.y, T);        // the wave that just passed
  float s1 = setFactor(n + 1.0, p.y, T);  // the wave about to arrive
  float blend = smoothstep(0.3, 0.7, q);
  float sf = mix(s0, s1, blend);
  // local surf-similarity (Iribarren) number: beach slope over the square root of
  // deep-water steepness. Spilling < 0.5 < plunging < 3.3 < surging (Battjes 1974);
  // onshore wind pushes it down, offshore wind up.
  float dm = 14.0 / uDomain.z;
  float slopeBed = abs(fetchGrid(uBed, uv + vec2(dm, 0.0)).r - fetchGrid(uBed, uv - vec2(dm, 0.0)).r) / 28.0;
  float xi = slopeBed / sqrt(max(uEdgeH.x * sf, 0.05) / (1.56 * T * T)) * (1.0 - 0.5 * uWindS);
  float plunge = smoothstep(0.38, 0.62, xi) * (1.0 - smoothstep(2.6, 3.6, xi));
  float surge = smoothstep(2.6, 3.6, xi);
  float crit = max(a2.x, 0.02);
  float br0 = smoothstep(0.93, 1.08, uEdgeH.x * s0 / crit) * (1.0 - surge);
  float br1 = smoothstep(0.93, 1.08, uEdgeH.x * s1 / crit) * (1.0 - surge);
  float broken = mix(br0, br1, blend);
  float Hu = a.w * uEdgeH.x * sf;
  float Hl = GAMMA_BORE * max(a2.y, 0.0);
  float H = mix(Hu, min(Hu, Hl), broken);
  H = min(H, 0.95 * h) * inside;
  float steep = clamp(H / (0.78 * h), 0.0, 1.0);
  float peaked = min(1.0, steep * (1.0 - 0.35 * uMess) + 0.3 * plunge * steep * (1.0 - broken));
  float skew = mix(0.12 + 0.5 * steep + 0.4 * plunge * steep * steep, mix(0.55, 0.9, plunge), broken);
  float shape = waveShape(q, peaked, skew);
  float dshape = (waveShape(q + 0.012, peaked, skew) - waveShape(q - 0.012, peaked, skew)) / 0.024;
  float eta = 0.5 * H * shape;
  vec2 grad = 0.5 * H * dshape * (-a.yz / T) * (1.0 + 0.5 * plunge * steep);

  // ---- secondary train -----------------------------------------------------
  float TB = uPeriod.y;
  float phB = (uTime - b.x) / TB + jitter * 0.6;
  float nB = floor(phB);
  float qB = phB - nB;
  float sB = mix(setFactor(nB + 40.0, p.y + 300.0, TB), setFactor(nB + 41.0, p.y + 300.0, TB), smoothstep(0.3, 0.7, qB));
  float HB = min(b.w * uEdgeH.y * sB, 0.42 * h) * inside;
  float steepB = clamp(HB / (0.6 * h), 0.0, 1.0);
  float shapeB = waveShape(qB, steepB, 0.1 + 0.4 * steepB);
  float dshapeB = (waveShape(qB + 0.012, steepB, 0.3) - waveShape(qB - 0.012, steepB, 0.3)) / 0.024;
  eta += 0.5 * HB * shapeB;
  grad += 0.5 * HB * dshapeB * (-b.yz / TB);

  // ---- wind sea: JONSWAP/TMA plane waves, thinned out by depth -------------
  vec2 gradS = vec2(0.0);
  for (int i = 0; i < NC; i++) {
    if (float(i) >= uCompN) break;
    vec4 c = uComp[i];
    float kk = length(c.xy);
    float th = tanh(kk * h);
    float amp = min(c.w * sqrt(th) * smoothstep(0.0, 0.6, h), 0.3 * h) * inside;
    float phs = dot(c.xy, p) - c.z * uTime + uCompPh[i];
    eta += amp * cos(phs);
    gradS += -amp * sin(phs) * c.xy;
  }
  grad += gradS;

  // ---- fine texture of the sea surface from the live ocean patch -----------
  eta += min(tileSample(p, uTileSize).x * chopAmount() * 1.6, 0.25 * h) * smoothstep(0.0, 0.5, h);

  // ---- setup and swash at the water's edge --------------------------------
  float nearEdge = 1.0 - smoothstep(0.0, 0.7, still);
  float sw = (1.0 - q) * (1.0 - q);
  float beachOnly = 1.0 - smoothstep(0.05, 0.6, bedInfo.g);  // no run-up on the rock groynes
  eta += inside * beachOnly * (uSwash.x * (1.0 - smoothstep(0.0, 2.5, still)) + 0.5 * uSwash.y * sw * s0 * nearEdge);

  s.eta = eta * uExag;
  s.grad = grad * uExag;
  s.still = still;
  s.film = uTide + s.eta - bed;
  s.face = steep * smoothstep(0.55, 1.0, q) * (1.0 - broken) * (1.0 + 0.6 * plunge);
  s.steepSea = length(gradS);
  // Gerstner-style horizontal motion: crests bunch up and, when plunging, the lip
  // is thrown ahead of the face (the profile idea behind Surf's Up's wave rigs)
  vec2 dirA = a.yz / max(length(a.yz), 1e-5);
  float crest01 = clamp(shape * 0.62, 0.0, 1.0);
  s.lean = (dirA * 0.5 * H * crest01 * (0.22 * steep + 1.1 * plunge * steep * steep) * (1.0 - 0.6 * broken)
            - gradS * 1.6) * uExag;
  s.plunge = plunge * steep;
  s.slope = 0.5 * H * dshape * length(a.yz) / T * uExag;
  s.foam = 0.0;
  s.dir = dirA;
  float dissip = smoothstep(0.5, 0.88, a2.y / h);
  float big = smoothstep(0.04, 0.3, H);
  float roller = br1 * dissip * smoothstep(0.78, 0.94, q) * mix(1.0, 0.75, plunge);
  float lip = br1 * (1.0 - br0) * smoothstep(0.9, 1.0, q) * (1.0 + 1.6 * plunge); // first white at the crest: a violent burst when plunging
  s.src = clamp(max(roller, lip) * big * inside + 0.55 * smoothstep(0.24, 0.44, s.steepSea) * inside, 0.0, 1.0);

  if (detail) {
    // foam left behind by earlier waves comes from the simulation
    vec2 fm = (p - uFoamRect.xy) / uFoamRect.zw;
    float inMap = step(0.0, fm.x) * step(fm.x, 1.0) * step(0.0, fm.y) * step(fm.y, 1.0);
    float trail = texture(uFoamMap, fm).r * inMap * 0.92;
    float foam = max(max(roller, lip) * big * inside, trail);
    foam += 0.8 * smoothstep(0.22, 0.42, s.steepSea) * inside; // whitecaps where wind-sea waves steepen
    foam += 0.25 * uMess * smoothstep(0.75, 1.0, shapeB * 0.5 + 0.5) * steepB; // whitecaps on wind chop
    // lacy foam: ridged noise leaves a net of white lines as the foam thins out
    vec2 fuv = p * 0.05 + vec2(uTime * 0.012, 0.0);
    float n1 = texture(uNoise, fuv).g;
    float n2 = texture(uNoise, fuv * 3.3 + 0.37).b;
    float n3 = texture(uNoise, fuv * 11.0 + 0.11).r;
    float lace = (1.0 - abs(2.0 * n1 - 1.0)) * 0.5 + (1.0 - abs(2.0 * n2 - 1.0)) * 0.32 + n3 * 0.18;
    float cut = 1.0 - foam;
    foam = smoothstep(cut - 0.08, cut + 0.22, lace + 0.5 * foam * foam) * smoothstep(0.0, 0.08, foam);
    float edgeLace = (1.0 - smoothstep(0.0, 0.16, s.film)) * smoothstep(-0.02, 0.02, s.film);
    foam = max(foam, edgeLace * (0.55 + 0.45 * lace) * inside);
    s.foam = foam;
    // turbulence on the white water
    s.grad += (texture(uNoise, p * 0.21 + uTime * 0.05).rg - 0.5) * 0.9 * foam;
  }
  return s;
}
`;
