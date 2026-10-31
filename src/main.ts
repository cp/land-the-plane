import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './style.css';
import { AIRPORTS } from './airports';
import { DEG, FT, KT } from './geo';
import { Game } from './game';
import { Hud } from './hud';
import { FLAP_DEGREES, verticalSpeed, type Controls } from './physics';
import { pressable, TiltControl, TouchStick } from './touch';
import { View, type CameraMode } from './view';

const TITLE_HOLD_MS = 2000;
// Top-of-screen sky color, used to tint Safari's status bar area while flying.
const SKY_TINT = '#2c5ec4';
const HINT_SECONDS = 20;
const THROTTLE_RATE = 0.4;
// Slightly taller-than-life terrain so hills read as 3D from altitude.
const TERRAIN_EXAGGERATION = 1.25;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const titleEl = $('title');
const titleSub = $('title-sub');
const curtain = $('curtain');
const flash = $('flash');
const resultEl = $('result');
const pausedEl = $('paused');
const toastEl = $('toast');

const token = import.meta.env.VITE_MAPBOX_TOKEN;
if (!token) {
  titleSub.textContent = 'Missing VITE_MAPBOX_TOKEN. Add it to .env.local and restart the dev server.';
  titleSub.classList.remove('loading');
  titleSub.classList.add('visible', 'error');
  throw new Error('VITE_MAPBOX_TOKEN is not set');
}
mapboxgl.accessToken = token;

// iOS Safari can't allocate a full 3x WebGL drawing buffer with terrain on and
// silently renders the map into a clipped corner. Mapbox v3 has no pixel ratio
// option (it reads window.devicePixelRatio), so cap that at 2 for the page;
// the three.js overlay is already capped at 2 too.
if (window.devicePixelRatio > 2) {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 2 });
}

// The curated list only has KPDX for now; pick randomly once there are more.
const airport = AIRPORTS[Math.floor(Math.random() * AIRPORTS.length)];

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/satellite-v9',
  center: [airport.lng, airport.lat],
  zoom: 13,
  pitch: 80,
  maxPitch: 85,
  interactive: false,
  fadeDuration: 0,
});

// Safari's collapsing toolbars change the visible viewport without always
// firing a window resize, so keep the map's canvas in sync explicitly.
const resizeMap = () => map.resize();
window.visualViewport?.addEventListener('resize', resizeMap);
window.addEventListener('orientationchange', () => setTimeout(resizeMap, 250));

const game = new Game(airport, (x, y) => {
  const [lng, lat] = game.frame.toLngLat(x, y);
  return map.queryTerrainElevation([lng, lat], { exaggerated: true }) ?? null;
});
const view = new View(map, $('plane'));

// Handy for poking at the sim from the console during development.
if (import.meta.env.DEV) Object.assign(window, { __game: game, __map: map });
const hud = new Hud($('hud'), document.body);

// --- Input -------------------------------------------------------------------

const keys = new Set<string>();
const controls: Controls = { pitch: 0, roll: 0, brakes: false };
let running = false;
let paused = false;
let flyingTime = 0;

window.addEventListener('keydown', (e) => {
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyR' && running) restart();
  // Camera keys keep working after a crash or landing, to look around.
  if (running && e.code in CAMERA_KEYS) setCameraMode(CAMERA_KEYS[e.code]);
  if (running && e.code === 'Digit0' && view.mode === 'orbit') view.resetOrbit();
  if (!running || game.outcome) return;
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'KeyF' && !paused) {
    const n = FLAP_DEGREES.length;
    game.state.flaps = (game.state.flaps + (e.shiftKey ? n - 1 : 1)) % n;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// Touch: drag anywhere to fly; tap THR/FLAPS to increase, hold to decrease.
const stick = new TouchStick(
  $('stick'),
  (t) => t instanceof Element && !!t.closest('#hud-bar, #hud-dock, .result.visible, #paused, #tilt-prompt'),
);

// On phones, tilt is the default; long-press the top bar to switch to the drag stick.
const tilt = new TiltControl();
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
let controlMode: 'tilt' | 'drag' = isTouchDevice ? 'tilt' : 'drag';
const tiltPrompt = $('tilt-prompt');
stick.enabled = controlMode === 'drag';

/** Waiting on the tap that unlocks motion sensors (and sets the neutral angle). */
const awaitingTilt = () => controlMode === 'tilt' && !tiltPrompt.hidden;

tiltPrompt.addEventListener('click', async () => {
  const ok = await tilt.start();
  tilt.calibrate();
  tiltPrompt.hidden = true;
  if (!ok) setControlMode('drag', 'Tilt unavailable · drag to fly');
  else showToast('Tilt to fly · hold top bar for drag');
});

function setControlMode(mode: 'tilt' | 'drag', message?: string): void {
  controlMode = mode;
  stick.enabled = mode === 'drag';
  if (mode === 'tilt') {
    tilt.calibrate();
    if (!tilt.enabled) {
      tiltPrompt.hidden = false;
      return;
    }
  }
  showToast(message ?? (mode === 'tilt' ? 'Tilt to fly' : 'Drag to fly'));
}

if (isTouchDevice) {
  // Toggle on release: iOS only grants sensor access from within a real tap.
  pressable(hud.barElement, {
    onTap: () => {},
    onHoldStart: () => {},
    onHoldEnd: () => {
      if (running && !game.outcome) setControlMode(controlMode === 'tilt' ? 'drag' : 'tilt');
    },
  });
}
let throttleHeld = false;
const canAct = () => running && !paused && !game.outcome;
for (const el of hud.throttleButtons) {
  pressable(el, {
    onTap: () => {
      if (canAct()) game.state.throttle = Math.min(1, Math.round(game.state.throttle * 10 + 1) / 10);
    },
    onHoldStart: () => (throttleHeld = true),
    onHoldEnd: () => (throttleHeld = false),
  });
}
for (const el of hud.flapsButtons) {
  pressable(el, {
    onTap: () => {
      if (canAct()) game.state.flaps = Math.min(FLAP_DEGREES.length - 1, game.state.flaps + 1);
    },
    onHoldStart: () => {
      if (canAct()) game.state.flaps = Math.max(0, game.state.flaps - 1);
    },
  });
}
resultEl.addEventListener('click', () => {
  if (resultEl.classList.contains('visible')) restart();
});
pausedEl.addEventListener('click', () => {
  if (paused) togglePause();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && canAct()) togglePause();
});

function readControls(dt: number): void {
  const approach = (cur: number, target: number, rate: number) =>
    cur + Math.max(-rate * dt, Math.min(rate * dt, target - cur));
  // Yoke-style: push forward (up) for nose down, pull back (down) for nose up.
  const pitchKeys = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0);
  const rollKeys = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
  const touch = controlMode === 'tilt' ? tilt : stick;
  const pitchTarget = Math.max(-1, Math.min(1, pitchKeys + touch.pitch));
  const rollTarget = Math.max(-1, Math.min(1, rollKeys + touch.roll));
  // Ease inputs in so a tap is a nudge rather than a jolt.
  controls.pitch = approach(controls.pitch, pitchTarget, 5);
  controls.roll = approach(controls.roll, rollTarget, 6);
  controls.brakes = keys.has('KeyB');

  const s = game.state;
  if (keys.has('KeyC')) s.throttle = Math.min(1, s.throttle + THROTTLE_RATE * dt);
  if (keys.has('KeyV') || throttleHeld) s.throttle = Math.max(0, s.throttle - THROTTLE_RATE * dt);
}

const CAMERA_KEYS: Record<string, CameraMode> = { Digit1: 'chase', Digit2: 'orbit', Digit3: 'cockpit' };
const CAMERA_NAMES: Record<CameraMode, string> = {
  chase: 'Chase',
  orbit: 'Orbit · WASD move · Q/E zoom · 0 reset',
  cockpit: 'Cockpit',
};
let toastTimer: number | undefined;

function showToast(text: string, ms = 1800): void {
  toastEl.textContent = text;
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('visible'), ms);
}

function setCameraMode(mode: CameraMode): void {
  view.mode = mode;
  showToast(`Camera · ${CAMERA_NAMES[mode]}`);
}

/** WASD swings / raises the orbit camera, Q/E zooms. Only read in orbit mode. */
function orbitInput() {
  if (view.mode !== 'orbit') return { yaw: 0, elevation: 0, zoom: 0 };
  const axis = (pos: string, neg: string) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
  return { yaw: axis('KeyD', 'KeyA'), elevation: axis('KeyW', 'KeyS'), zoom: axis('KeyE', 'KeyQ') };
}

function togglePause(): void {
  paused = !paused;
  pausedEl.hidden = !paused;
}

// --- Map setup ---------------------------------------------------------------

map.on('style.load', () => {
  map.addSource('mapbox-dem', {
    type: 'raster-dem',
    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
    tileSize: 512,
    maxzoom: 14,
  });
  map.setTerrain({ source: 'mapbox-dem', exaggeration: TERRAIN_EXAGGERATION });
  map.setFog({
    range: [1, 14],
    color: 'rgb(200, 216, 235)',
    'high-color': 'rgb(70, 130, 220)',
    'horizon-blend': 0.08,
    'space-color': 'rgb(40, 90, 180)',
    'star-intensity': 0,
  });

  // Dashed extended centerline for the target runway, draped on the terrain.
  map.addSource('approach', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'approach',
    type: 'line',
    source: 'approach',
    paint: {
      'line-color': '#7cf3c8',
      'line-width': 2,
      'line-opacity': 0.55,
      'line-dasharray': [3, 3],
    },
  });

  // Real building footprints from Mapbox Streets, extruded to their heights.
  map.addSource('streets', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: 'streets',
    'source-layer': 'building',
    minzoom: 13,
    filter: ['==', ['get', 'extrude'], 'true'],
    paint: {
      // Warm concrete, a touch lighter for taller buildings.
      'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'height'], 0, '#cfc8ba', 60, '#e4e0d8', 150, '#eef0f2'],
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-base': ['get', 'min_height'],
      'fill-extrusion-opacity': 0.92,
      'fill-extrusion-vertical-gradient': true,
      'fill-extrusion-ambient-occlusion-intensity': 0.35,
    },
  });
});

function drawApproachLine(): void {
  const t = game.target;
  const far = 8 * 1852;
  const coords = [game.frame.toLngLat(t.x, t.y), game.frame.toLngLat(t.x - t.dx * far, t.y - t.dy * far)];
  (map.getSource('approach') as mapboxgl.GeoJSONSource | undefined)?.setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords },
  });
}

/** Resolve once the map has finished loading tiles for the current view. */
function waitForIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve();
    });
    map.triggerRepaint();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn and position the camera, then wait for terrain so the 3,000 ft AGL is real. */
async function prepareFlight(timeoutMs: number): Promise<void> {
  game.spawn();
  view.snap(game.state);
  renderFrame(0);
  drawApproachLine();
  await waitForIdle(timeoutMs);
  game.settleSpawnAltitude();
  renderFrame(0);
  await waitForIdle(timeoutMs / 2);
}

let restarting = false;
async function restart(): Promise<void> {
  if (restarting || !game.state) return;
  restarting = true;
  running = false;
  paused = false;
  pausedEl.hidden = true;
  resultEl.classList.remove('visible');
  curtain.classList.add('visible');
  await sleep(350);
  flash.classList.remove('go'); // clear the crash tint while the screen is black
  await prepareFlight(6000);
  flyingTime = 0;
  tilt.calibrate();
  running = true;
  curtain.classList.remove('visible');
  restarting = false;
}

map.on('load', async () => {
  const minTitle = sleep(1200);
  await prepareFlight(15000);
  await minTitle;
  titleSub.textContent = `${airport.icao} · ${airport.name}`;
  titleSub.classList.remove('loading');
  await sleep(TITLE_HOLD_MS);
  running = true;
  titleEl.classList.add('hidden');
  if (controlMode === 'tilt' && !tilt.enabled) tiltPrompt.hidden = false;
  $('theme-color').setAttribute('content', SKY_TINT);
  // Safari tints its status bar from the page background color.
  document.body.style.background = SKY_TINT;
});

// --- Loop --------------------------------------------------------------------

let last = performance.now();
let shownOutcome: object | null = null;

function renderFrame(dt: number): void {
  const s = game.state;
  view.update(
    s,
    game.frame,
    (x, y) => game.groundAt(x, y),
    game.groundAt(s.x, s.y),
    { pitch: controls.pitch, roll: controls.roll, flapDeg: game.flapDegrees() },
    orbitInput(),
    dt,
  );
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (running && !paused && !awaitingTilt() && game.state) {
    readControls(dt);
    game.update(controls, dt);
    flyingTime += dt;
  }

  if (game.state) {
    renderFrame(running && !paused ? dt : 0);
    hud.setVisible(running);
    if (running) drawHud(now / 1000);
    if (game.outcome && game.outcome !== shownOutcome) showOutcome();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function drawHud(time: number): void {
  const s = game.state;
  const t = game.target;
  const approach = game.approach();
  const cam = view.toCameraSpace(t.x - s.x, t.y - s.y, game.fieldElevation - s.z);
  hud.draw(
    {
      speedKt: s.speed / KT,
      aglFt: game.agl() / FT,
      vsFpm: verticalSpeed(s) * 196.85,
      headingDeg: ((s.heading / DEG) % 360 + 360) % 360,
      throttle: s.throttle,
      flapDeg: game.flapDegrees(),
      flapNotch: s.flaps,
      brakes: controls.brakes,
      stall: game.nearStall(),
      onGround: s.onGround,
      target: { ident: t.ident, distNm: approach.distance / 1852 },
      glideslope: approach.glideslope,
      localizer: approach.localizer,
      targetCam: { x: cam.x, y: cam.y, z: cam.z },
      focal: $('plane').clientHeight / 2 / Math.tan((view.camera.fov * DEG) / 2),
      showHints: flyingTime < HINT_SECONDS,
    },
    time,
  );
}

function showOutcome(): void {
  const o = game.outcome!;
  shownOutcome = o;
  if (o.phase === 'crashed') {
    flash.classList.remove('go');
    void flash.offsetWidth; // restart the CSS animation
    flash.classList.add('go');
  }

  resultEl.className = `result ${o.phase}`;
  // Same per-letter arcade treatment as the title screen.
  const heading = $('result-title');
  heading.innerHTML = '';
  heading.setAttribute('aria-label', o.title);
  let i = 0;
  for (const word of o.title.toUpperCase().split(' ')) {
    const w = document.createElement('span');
    w.className = 'word';
    for (const ch of word) {
      const l = document.createElement('span');
      l.textContent = ch;
      l.style.setProperty('--i', String(i++));
      w.appendChild(l);
    }
    heading.appendChild(w);
  }
  $('result-reason').textContent = o.reason;
  const stats = $('result-stats');
  stats.innerHTML = '';
  const gradeEl = $('result-grade');
  gradeEl.textContent = o.grade ? o.grade.letter : '';
  if (o.touchdown) {
    const td = o.touchdown;
    const rows: [string, string][] = [
      ['Sink rate', `${Math.round(td.sinkFpm)} fpm`],
      ['Centerline', `${Math.round(td.centerlineFt)} ft off`],
      ['Touchdown speed', `${Math.round(td.speedKt)} kt`],
      ['Past threshold', `${Math.round(td.pastThresholdFt).toLocaleString('en-US')} ft`],
      ['Score', `${o.grade!.score} / 100`],
    ];
    rows.forEach(([k, v], idx) => {
      const row = document.createElement('div');
      row.style.setProperty('--row', String(idx));
      row.innerHTML = `<span></span><b></b>`;
      row.children[0].textContent = k;
      row.children[1].textContent = v;
      stats.appendChild(row);
    });
  }
  setTimeout(() => resultEl.classList.add('visible'), o.phase === 'crashed' ? 700 : 150);
}
