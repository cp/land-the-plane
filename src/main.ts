import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './style.css';
import { AIRPORTS } from './airports';
import { DEG, FT, KT } from './geo';
import { Game } from './game';
import { Hud } from './hud';
import { FLAP_DEGREES, verticalSpeed, type Controls } from './physics';
import { pressable, TouchStick } from './touch';
import { View } from './view';

const TITLE_HOLD_MS = 2000;
const HINT_SECONDS = 20;
const THROTTLE_RATE = 0.4;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const titleEl = $('title');
const titleSub = $('title-sub');
const curtain = $('curtain');
const flash = $('flash');
const resultEl = $('result');
const pausedEl = $('paused');

const token = import.meta.env.VITE_MAPBOX_TOKEN;
if (!token) {
  titleSub.textContent = 'Missing VITE_MAPBOX_TOKEN. Add it to .env.local and restart the dev server.';
  titleSub.classList.remove('loading');
  titleSub.classList.add('visible', 'error');
  throw new Error('VITE_MAPBOX_TOKEN is not set');
}
mapboxgl.accessToken = token;

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

const game = new Game(airport, (x, y) => {
  const [lng, lat] = game.frame.toLngLat(x, y);
  return map.queryTerrainElevation([lng, lat], { exaggerated: false }) ?? null;
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
const stick = new TouchStick($('stick'), (t) => t instanceof Element && !!t.closest('#hud-bar, #hud-dock, .result.visible, #paused'));
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
  const pitchTarget = Math.max(-1, Math.min(1, pitchKeys + stick.pitch));
  const rollTarget = Math.max(-1, Math.min(1, rollKeys + stick.roll));
  // Ease inputs in so a tap is a nudge rather than a jolt.
  controls.pitch = approach(controls.pitch, pitchTarget, 5);
  controls.roll = approach(controls.roll, rollTarget, 6);
  controls.brakes = keys.has('KeyB');

  const s = game.state;
  if (keys.has('KeyC')) s.throttle = Math.min(1, s.throttle + THROTTLE_RATE * dt);
  if (keys.has('KeyV') || throttleHeld) s.throttle = Math.max(0, s.throttle - THROTTLE_RATE * dt);
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
  map.setTerrain({ source: 'mapbox-dem', exaggeration: 1 });
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
    dt,
  );
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (running && !paused && game.state) {
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
      focal: window.innerHeight / 2 / Math.tan((view.camera.fov * DEG) / 2),
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
