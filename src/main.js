import { BEACHES, DEFAULT_BEACH, SATELLITE_ATTRIBUTION } from './config/beaches.js';
import { loadTerrain } from './data/terrain.js';
import { loadForecast, nearestHourIndex, applyWindSource, WIND_SOURCES } from './data/forecast.js';
import { sunPosition } from './data/sun.js';
import { buildContext, computeSeaState, quickSeaState } from './model/seaState.js';
import { Viewer, CAMERA_PRESETS } from './scene/viewer.js';
import { Hud } from './ui/hud.js';
import { Timeline } from './ui/timeline.js';

const params = new URLSearchParams(location.search);
const beach = BEACHES[params.get('beach')] ?? BEACHES[DEFAULT_BEACH];
const $ = (id) => document.getElementById(id);
const setLoading = (text) => { $('loading-text').textContent = text; };

/** Optional overrides for experiments, e.g. ?swell=1.5,13,290&wind=15,60&tide=0.5&cloud=10
 *  (swell: height m, period s, from deg · wind: km/h, from deg · tide: m · cloud: %) */
function applyOverrides(hours) {
  const list = (key) => params.get(key)?.split(',').map(Number);
  const swell = list('swell'), wind = list('wind'), tide = list('tide'), cloud = list('cloud');
  if (!swell && !wind && !tide && !cloud) return false;
  for (const h of hours) {
    if (swell) h.trains = [{ kind: 'swell', height: swell[0], period: swell[1] ?? 12, direction: swell[2] ?? 280, spread: 20 }];
    if (wind) h.wind = { speed: wind[0], direction: wind[1] ?? 60, gust: null };
    if (tide) h.tide = tide[0];
    if (cloud) h.cloud = cloud[0];
  }
  return true;
}

async function start() {
  const hud = new Hud(beach);
  if (params.get('ui') === '0') document.body.classList.add('bare'); // clean view for screenshots
  document.title = `${beach.name} — 3D surf forecast`;

  setLoading('Reading the seabed…');
  const [terrain, forecast] = await Promise.all([
    loadTerrain(beach.id),
    loadForecast(beach, { forceSample: params.has('sample') }),
  ]);
  const { hours } = forecast;
  let windMode = WIND_SOURCES.some((w) => w.id === params.get('windsrc')) ? params.get('windsrc') : 'auto';
  applyWindSource(hours, windMode, forecast.capturedAt);
  const overridden = applyOverrides(hours);

  setLoading('Bending the swell around the sandbars…');
  const ctx = buildContext(terrain);
  const quick = hours.map((h) => quickSeaState(ctx, h));

  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const viewer = new Viewer($('scene'), beach, terrain, { quality: small ? 0.75 : 1, solverGrid: ctx.grid });
  if (params.get('cam')) viewer.preset = params.get('cam');
  const campos = params.get('campos')?.split(',').map(Number); // debug: x,y,z,targetX,targetY,targetZ

  const isNight = (h) => sunPosition(h.time, beach.lat, beach.lon).elevation < -0.04;
  let index = -1, pending = null;
  const timeline = new Timeline({
    canvas: $('timeline'), daysEl: $('days'), hours, quick, timezone: beach.timezone, isNight,
    onSelect: (i) => select(i),
  });

  function select(i, force = false) {
    if (i === index && !force) return;
    index = i;
    timeline.setIndex(i);
    // solve once per frame at most, however fast the scrubbing
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const state = computeSeaState(ctx, hours[index]);
      viewer.setSeaState(state);
      hud.update(state, hours[index + 1]);
      window.__wave = { state, index, viewer }; // handy in the console
    });
  }

  // cameras
  const camButtons = CAMERA_PRESETS.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label;
    b.addEventListener('click', () => { viewer.setCamera(p.id); markCam(); });
    return b;
  });
  const markCam = () => camButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(CAMERA_PRESETS[i].id === viewer.preset)));
  $('cameras').replaceChildren(...camButtons);
  markCam();

  // wave height exaggeration
  const exags = [1, 1.5, 2];
  let exagIndex = Math.max(0, exags.indexOf(Number(params.get('exag'))));
  const setExag = () => {
    viewer.setExaggeration(exags[exagIndex]);
    $('btn-exag').textContent = `Waves ×${exags[exagIndex]}`;
    $('btn-exag').setAttribute('aria-pressed', String(exagIndex > 0));
  };
  $('btn-exag').addEventListener('click', () => { exagIndex = (exagIndex + 1) % exags.length; setExag(); });
  setExag();

  // which wind forecast drives the rating and the chop
  const windButton = $('btn-wind');
  const showWindMode = () => {
    windButton.textContent = WIND_SOURCES.find((w) => w.id === windMode).label;
    windButton.setAttribute('aria-pressed', String(windMode !== 'auto'));
  };
  windButton.addEventListener('click', () => {
    windMode = WIND_SOURCES[(WIND_SOURCES.findIndex((w) => w.id === windMode) + 1) % WIND_SOURCES.length].id;
    applyWindSource(hours, windMode, forecast.capturedAt);
    if (params.has('wind')) applyOverrides(hours);
    hours.forEach((h, i) => { quick[i] = quickSeaState(ctx, h); });
    showWindMode();
    select(index, true);
  });
  showWindMode();

  // nearest public webcam, to compare the simulation with the real thing
  if (beach.webcam) {
    const cam = $('btn-webcam');
    cam.href = beach.webcam.url;
    cam.title = beach.webcam.note;
    cam.hidden = false;
  }

  // first-person readout: how deep is the water where you stand, how big are the waves
  viewer.onPov = (info) => {
    const el = $('pov');
    el.hidden = !info;
    if (info) el.textContent = info;
  };

  // play through the week
  let playTimer = null;
  const setPlaying = (on) => {
    clearInterval(playTimer);
    playTimer = on ? setInterval(() => select((index + 1) % hours.length), 900) : null;
    $('btn-play').textContent = on ? '❚❚ Pause' : '▶ Play week';
    $('btn-play').setAttribute('aria-pressed', String(on));
  };
  $('btn-play').addEventListener('click', () => setPlaying(!playTimer));
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, textarea')) return;
    if (ev.key === 'ArrowRight') select(Math.min(hours.length - 1, index + 1));
    else if (ev.key === 'ArrowLeft') select(Math.max(0, index - 1));
    else if (ev.key === ' ') { ev.preventDefault(); setPlaying(!playTimer); }
  });

  // notices and credits
  const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: beach.timezone });
  if (overridden) hud.showNotice('Experiment mode: conditions overridden from the address bar.');
  else if (forecast.source === 'sample') {
    const why = params.has('sample') ? 'Sample mode' : 'Live forecast unreachable';
    hud.showNotice(`${why} — showing a saved forecast from ${dateFmt.format(forecast.capturedAt)}.`);
  }
  else if (forecast.windMissing) hud.showNotice('Wind forecast is unavailable right now; waves and tide are live.');
  else if (forecast.aiMissing) hud.showNotice('Google WeatherNext wind is unavailable right now; using the regional model only.');
  $('credits').innerHTML =
    `Forecast <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> · ` +
    `AI wind <a href="https://open-meteo.com/en/docs/google-weathernext-api" target="_blank" rel="noopener">Google WeatherNext 2</a> · ` +
    `Bathymetry <a href="https://emodnet.ec.europa.eu/en/bathymetry" target="_blank" rel="noopener">EMODnet</a> · ${SATELLITE_ATTRIBUTION}`;

  // start at the requested hour, or now
  const wanted = params.get('hour');
  let startIndex = nearestHourIndex(hours, new Date());
  if (wanted !== null) startIndex = /^\d+$/.test(wanted) ? Math.min(hours.length - 1, Number(wanted)) : nearestHourIndex(hours, new Date(wanted));
  select(startIndex);
  if (campos?.length === 6) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      viewer.camera.position.set(campos[0], campos[1], campos[2]);
      viewer.controls.target.set(campos[3], campos[4], campos[5]);
      viewer.flight = null;
    }));
  }

  setLoading('Laying out the satellite view…');
  await Promise.race([viewer.satelliteLoaded, new Promise((r) => setTimeout(r, 6000))]);
  $('loading').classList.add('done');
  window.__ready = true;
}

start().catch((err) => {
  console.error(err);
  setLoading(`Something went wrong: ${err.message}`);
});
