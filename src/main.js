import { Screen } from './screen.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Traffic } from './agents.js';
import { ProceduralWorld } from './world/procedural.js';
import { Lighting } from './render/materials.js';
import { renderScene } from './render/raycaster.js';
import { drawSky } from './render/sky.js';
import { canMoveTo, settle, floorAt } from './collision.js';
import { julianDay, sunPos, altAz } from './astro.js';
import {
  WALK_SPEED, RUN_MULT, Z_ACCEL, Z_DAMP, EYE_HEIGHT,
  DEFAULT_LAT, DEFAULT_LON, WORLD,
} from './config.js';
import { wrap } from './world/source.js';

const canvas = document.getElementById('c');
const screen = new Screen(canvas);
const cam = new Camera();
const input = new Input(canvas);
const hud = new Hud();
const light = new Lighting();

const site = { lat: DEFAULT_LAT, lon: DEFAULT_LON };
const world = new ProceduralWorld();
const traffic = new Traffic(world);

cam.placeAt(world.spawn());

let simTime = Date.now();

window.addEventListener('resize', () => screen.resize());

/* ------------------------------ update ------------------------------ */

function update(dt) {
  const look = input.takeLook();
  if (look.x || look.y) {
    cam.angle += look.x * 0.004;
    // Pitch range is wide enough to look down at the city from altitude.
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

  // Vertical: Q down, E up, with damping so it feels like a drone rather than
  // a lift. Shift multiplies here too.
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
    }
  }

  settle(world, cam);
  traffic.update(dt, cam);
}

/* ------------------------------- draw ------------------------------- */

function draw() {
  const sim = new Date(simTime);
  const jd = julianDay(sim);
  const sun = sunPos(jd);
  const sp = altAz(sun.ra / 15, sun.dec, jd, site.lat, site.lon);
  const sunAlt = sp.alt;

  const dayK = light.update(sunAlt);

  cam.hz = screen.horizon - cam.pitch;
  cam.buildRays(screen);

  screen.clear();

  const t = simTime / 1000;
  renderScene(screen, cam, world, light, t);
  drawSky(screen, cam, light, site, jd, sp, sunAlt, dayK);
  traffic.draw(screen, cam, light);
  screen.blit();

  return sunAlt;
}

/* ------------------------------- loop ------------------------------- */

let lastT = performance.now();
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

  const warp = hud.warpFactor();
  simTime += dt * 1000 * warp;
  simTime += input.takeHourShift() * 3600000;

  update(dt);
  const sunAlt = draw();

  hud.update({ warp, simTime, lon: site.lon, sunAlt, cam, screen, fps });
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Handy for poking at the engine from the console.
Object.assign(window, { cam, world, screen, floorAt, EYE_HEIGHT, WORLD });
