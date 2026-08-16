import { Screen } from './screen.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Traffic } from './agents.js';
import { ProceduralWorld } from './world/procedural.js';
import { OsmWorld } from './world/osm.js';
import { fetchOsm } from './world/overpass.js';
import { Lighting } from './render/materials.js';
import { renderScene } from './render/raycaster.js';
import { drawSky } from './render/sky.js';
import { drawLoading, drawError } from './render/loading.js';
import { Labels, MODE } from './render/labels.js';
import { canMoveTo, settle, floorAt } from './collision.js';
import { julianDay, sunPos, altAz } from './astro.js';
import {
  WALK_SPEED, RUN_MULT, Z_ACCEL, Z_DAMP,
  DEFAULT_LAT, DEFAULT_LON,
} from './config.js';
import { wrap } from './world/source.js';

const canvas = document.getElementById('c');
const screen = new Screen(canvas);
const cam = new Camera();
const input = new Input(canvas);
const light = new Lighting();

/** Everything that changes when a different city is loaded. */
const state = {
  world: null,
  site: { lat: DEFAULT_LAT, lon: DEFAULT_LON },
  view: { preset: 'procedural', bbox: null, label: 'Procedural City' },
  phase: 'ready',            // 'ready' | 'loading' | 'error'
  message: '',
  error: null,
  token: 0,                  // invalidates in-flight loads
};

const traffic = new Traffic(null);
const labels = new Labels();
const hud = new Hud({ onLoad: (view) => loadView(view) });

let simTime = Date.now();

/** Set the simulated clock to a given local hour today, for a chosen light. */
function setLocalHour(hour, lon) {
  const now = new Date();
  const utcNoon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  simTime = utcNoon + (hour - lon / 15) * 3600000;
}

window.addEventListener('resize', () => screen.resize());

/* ------------------------------ world load ------------------------------ */

function adoptWorld(world, { lat, lon }, camera = null) {
  state.world = world;
  state.site = { lat, lon };
  traffic.setWorld(world);
  cam.placeAt(world.spawn());
  cam.pitch = 0;

  // An explicit camera from the URL wins, so a shared link reproduces the
  // exact view. This is also how the screenshots in docs/ are regenerated.
  if (camera) {
    if (camera.x !== undefined) cam.x = camera.x;
    if (camera.y !== undefined) cam.y = camera.y;
    if (camera.z !== undefined) cam.z = camera.z;
    if (camera.angle !== undefined) cam.angle = camera.angle;
    if (camera.pitch !== undefined) cam.pitch = camera.pitch;
  }

  settle(world, cam);
  hud.setAttribution(world);
}

function loadProcedural(camera = null) {
  const world = new ProceduralWorld();
  world.bbox = null;
  world.label = 'Procedural City';
  world.stats = { buildings: 0, roads: 0 };
  adoptWorld(world, { lat: DEFAULT_LAT, lon: DEFAULT_LON }, camera);
  state.phase = 'ready';
}

async function loadView(view) {
  const token = ++state.token;
  state.view = view;
  hud.select(view.preset);
  hud.syncHash(view);

  if (!view.bbox) {
    loadProcedural(view.camera);
    return;
  }

  state.phase = 'loading';
  state.message = 'Loading map data';
  hud.setBusy(true);

  try {
    const elements = await fetchOsm(view.bbox, {
      onProgress: (msg) => { if (token === state.token) state.message = msg; },
    });
    if (token !== state.token) return;      // superseded by a newer request

    state.message = 'Building the city';
    // Yield once so the message paints before the rasterizer blocks.
    await new Promise((r) => requestAnimationFrame(r));
    if (token !== state.token) return;

    const world = new OsmWorld(view.bbox, elements, view.label);
    if (world.roadCells.length === 0) {
      throw new Error('No streets in this area. Try somewhere more built up.');
    }
    adoptWorld(world, { lat: world.lat, lon: world.lon }, view.camera);
    state.phase = 'ready';
  } catch (err) {
    if (token !== state.token) return;
    state.phase = 'error';
    state.error = err;
    hud.setError(err.message);
  } finally {
    if (token === state.token) hud.setBusy(false);
  }
}

/* -------------------------------- update -------------------------------- */

function update(dt) {
  const world = state.world;
  const look = input.takeLook();
  if (look.x || look.y) {
    cam.angle += look.x * 0.004;
    // Wide enough to look straight down at the city from altitude.
    cam.pitch = Math.max(-screen.rows * 0.9,
                 Math.min(screen.rows * 1.5, cam.pitch - look.y * 0.35));
  }

  const running = input.down('shift');
  const speed = WALK_SPEED * (running ? RUN_MULT : 1) * dt;
  const fx = Math.cos(cam.angle);
  const fy = Math.sin(cam.angle);

  let mx = 0;
  let my = 0;
  if (input.down('w') || input.down('arrowup')) { mx += fx; my += fy; }
  if (input.down('s') || input.down('arrowdown')) { mx -= fx; my -= fy; }
  if (input.down('a')) { mx += fy; my -= fx; }
  if (input.down('d')) { mx -= fy; my += fx; }
  if (input.down('arrowleft')) cam.angle -= 1.8 * dt;
  if (input.down('arrowright')) cam.angle += 1.8 * dt;

  for (let i = input.takeTaps('n'); i > 0; i--) labels.cycle();

  // Vertical: Q down, E up, damped so it flies rather than jumps.
  let thrust = 0;
  if (input.down('e')) thrust += 1;
  if (input.down('q')) thrust -= 1;
  if (thrust !== 0) cam.vz += thrust * Z_ACCEL * dt * (running ? 2.5 : 1);
  cam.vz *= Math.pow(Z_DAMP, dt);
  cam.z += cam.vz * dt;
  cam.clampZ();

  const len = Math.sqrt(mx * mx + my * my);
  if (len > 0) {
    mx = mx / len * speed;
    my = my / len * speed;
    // Axis-separated, so you slide along a wall instead of sticking to it.
    if (canMoveTo(world, cam.x + mx, cam.y, cam.z)) cam.x += mx;
    if (canMoveTo(world, cam.x, cam.y + my, cam.z)) cam.y += my;
    if (world.size > 0) {
      cam.x = wrap(cam.x, world.size);
      cam.y = wrap(cam.y, world.size);
    } else {
      // Bounded extract: stay inside it.
      cam.x = Math.max(0.5, Math.min(world.width - 0.5, cam.x));
      cam.y = Math.max(0.5, Math.min(world.height - 0.5, cam.y));
    }
  }

  settle(world, cam);
  traffic.update(dt, cam);
}

/* --------------------------------- draw --------------------------------- */

function draw() {
  const sim = new Date(simTime);
  const jd = julianDay(sim);
  const sun = sunPos(jd);
  const sp = altAz(sun.ra / 15, sun.dec, jd, state.site.lat, state.site.lon);
  const sunAlt = sp.alt;

  const dayK = light.update(sunAlt);

  cam.hz = screen.horizon - cam.pitch;
  cam.buildRays(screen);
  screen.clear();

  const t = simTime / 1000;
  renderScene(screen, cam, state.world, light, t);
  drawSky(screen, cam, light, state.site, jd, sp, sunAlt, dayK);
  traffic.draw(screen, cam, light);
  labels.draw(screen, cam, state.world, light);
  screen.blit();

  return sunAlt;
}

/* --------------------------------- loop --------------------------------- */

let lastT = performance.now();
let lastHashSync = 0;
let fps = 60;
let acc = 0;
let frames = 0;

function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  acc += dt;
  frames++;
  if (acc > 0.5) { fps = frames / acc; acc = 0; frames = 0; }

  if (state.phase === 'loading') {
    drawLoading(screen, {
      title: 'LOADING MAP DATA',
      detail: state.message,
      t: now / 1000,
    });
    requestAnimationFrame(frame);
    return;
  }

  if (state.phase === 'error') {
    drawError(screen, {
      title: 'COULD NOT LOAD THAT AREA',
      detail: state.error?.message ?? 'Unknown error',
      hint: 'Pick another city, or try again in a moment.',
    });
    requestAnimationFrame(frame);
    return;
  }

  const warp = hud.warpFactor();
  simTime += dt * 1000 * warp;
  simTime += input.takeHourShift() * 3600000;

  update(dt);
  const sunAlt = draw();

  hud.update({
    warp, simTime, lon: state.site.lon, sunAlt, cam, screen, fps,
    where: state.world.nearestStreet
      ? state.world.nearestStreet(cam.x, cam.y)
      : null,
    labelMode: labels.mode,
  });

  // Keep the URL in step with where you are, so any view can be shared.
  if (now - lastHashSync > 1000) {
    lastHashSync = now;
    const local = new Date(simTime + state.site.lon / 15 * 3600000);
    hud.syncHash(state.view, cam,
      local.getUTCHours() + local.getUTCMinutes() / 60);
  }

  requestAnimationFrame(frame);
}

/* --------------------------------- boot --------------------------------- */

// `hud=0` hides the overlay, for clean screenshots and kiosk display.
if (new URLSearchParams(location.hash.slice(1)).get('hud') === '0') {
  const el = document.getElementById('hud');
  if (el) el.style.display = 'none';
}

const initial = Hud.initialView();
if (initial.hour !== undefined) {
  setLocalHour(initial.hour, initial.bbox
    ? (initial.bbox[1] + initial.bbox[3]) / 2
    : DEFAULT_LON);
}

loadProcedural(initial.bbox ? null : initial.camera);   // something immediately
requestAnimationFrame(frame);

if (initial.bbox) loadView(initial);

// Handy for poking at the engine from the console.
Object.assign(window, { cam, screen, state, floorAt, labels, MODE });
