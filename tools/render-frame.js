/**
 * Render one frame to stdout as text, with no browser.
 *
 * The engine's output is a character grid, so it can be inspected directly.
 * Useful for eyeballing a change, for regression diffing, and for checking the
 * drone camera at altitudes that are tedious to fly to by hand.
 *
 *   node tools/render-frame.js --z 1.65 --pitch 0 --cols 150 --rows 44
 *   node tools/render-frame.js --z 60 --pitch -14        # drone view
 *   node tools/render-frame.js --hour 22                 # night
 *   node tools/render-frame.js --colour                  # 24-bit terminal colour
 *   node tools/render-frame.js --city manhattan --z 90 --pitch 16
 *
 * --city fetches from Overpass and caches the response under .cache/.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Camera } from '../src/camera.js';
import { ProceduralWorld } from '../src/world/procedural.js';
import { OsmWorld } from '../src/world/osm.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { julianDay, sunPos, altAz } from '../src/astro.js';
import { FONT_PX, LINE_RATIO, FOV, HORIZON_FRAC, DEFAULT_LAT, DEFAULT_LON } from '../src/config.js';

/* ------------------------------ arguments ------------------------------ */

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.set(key, 'true');
    else { args.set(key, next); i++; }
  }
}
const num = (k, d) => (args.has(k) ? Number(args.get(k)) : d);

const COLS = num('cols', 150);
const ROWS = num('rows', 44);
const CAM_Z = num('z', 1.65);
const PITCH = num('pitch', 0);
const ANGLE = num('angle', Math.PI / 2);
const HOUR = num('hour', 14);
const USE_COLOUR = args.has('colour') || args.has('color');
const CITY = args.get('city');

/* ---------------------------- headless screen ----------------------------
 * The same buffers and the same setDepth/fillRow contract as src/screen.js,
 * minus the canvas. Kept deliberately small rather than importing Screen, so
 * this tool does not need a DOM shim.
 */

const cw = 8;
const ch = Math.round(FONT_PX * LINE_RATIO);

const screen = {
  cols: COLS,
  rows: ROWS,
  cw,
  ch,
  horizon: Math.floor(ROWS * HORIZON_FRAC),
  proj: (COLS / 2) / Math.tan(FOV / 2),
  glyph: new Array(COLS * ROWS),
  colour: new Array(COLS * ROWS),
  depth: new Float32Array(COLS * ROWS),
  skyEnd: new Int32Array(COLS),
  set(x, y, g, c) {
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return;
    this.glyph[y * COLS + x] = g;
    this.colour[y * COLS + x] = c;
  },
  setDepth(x, y, g, c, d) {
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return;
    const i = y * COLS + x;
    this.glyph[i] = g;
    this.colour[i] = c;
    this.depth[i] = d;
  },
  fillRow(y, g, c, d) {
    if (y < 0 || y >= ROWS) return;
    for (let x = 0; x < COLS; x++) {
      this.glyph[y * COLS + x] = g;
      this.colour[y * COLS + x] = c;
      this.depth[y * COLS + x] = d;
    }
  },
};
screen.vscale = screen.proj * cw / ch;

/* -------------------------------- render -------------------------------- */

/* ------------------------------- world -------------------------------- */

/** Disk-backed stand-in for localStorage, so the Overpass cache works here. */
function installCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (k) => path.join(dir, k.replace(/[^\w.-]/g, '_') + '.json');
  globalThis.localStorage = {
    getItem: (k) => (fs.existsSync(file(k)) ? fs.readFileSync(file(k), 'utf8') : null),
    setItem: (k, v) => fs.writeFileSync(file(k), v),
    removeItem: (k) => { try { fs.unlinkSync(file(k)); } catch { /* gone */ } },
  };
}

let world;
let site = { lat: DEFAULT_LAT, lon: DEFAULT_LON };

if (CITY) {
  installCache(new URL('../.cache/', import.meta.url).pathname);
  const { fetchOsm, PRESETS, parseLocation } = await import('../src/world/overpass.js');
  const preset = PRESETS[CITY];
  const bbox = preset?.bbox ?? parseLocation(CITY);
  if (!bbox) {
    console.error(`Unknown city "${CITY}". Try: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }
  const elements = await fetchOsm(bbox, { onProgress: (m) => console.error('  ' + m) });
  world = new OsmWorld(bbox, elements, preset?.label ?? CITY);
  site = { lat: world.lat, lon: world.lon };
  console.error(`  ${world.name}: ${world.width}x${world.height} cells, ` +
    `${world.stats.buildings} buildings, ${world.stats.roads} ways, ` +
    `tallest ${(world.maxHeight * 2.37).toFixed(0)}m`);
} else {
  world = new ProceduralWorld();
}

const light = new Lighting();
const cam = new Camera();

const spawn = world.spawn();
cam.x = num('x', spawn.x);
cam.y = num('y', spawn.y);
cam.angle = ANGLE;
cam.z = CAM_Z;
cam.pitch = PITCH;
cam.hz = screen.horizon - cam.pitch;
cam.buildRays(screen);

const when = new Date(Date.UTC(2026, 5, 21, HOUR - site.lon / 15, 0, 0));
const jd = julianDay(when);
const sun = sunPos(jd);
const sp = altAz(sun.ra / 15, sun.dec, jd, site.lat, site.lon);
light.update(sp.alt);

screen.glyph.fill(undefined);
screen.depth.fill(1e9);

const t0 = process.hrtime.bigint();
renderScene(screen, cam, world, light, when.getTime() / 1000);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

/* -------------------------------- output -------------------------------- */

const rgbOf = (s) => {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(s || '');
  return m ? [m[1], m[2], m[3]] : null;
};

const out = [];
for (let y = 0; y < ROWS; y++) {
  let line = '';
  for (let x = 0; x < COLS; x++) {
    const i = y * COLS + x;
    const g = screen.glyph[i];
    if (g === undefined) { line += USE_COLOUR ? '[0m ' : ' '; continue; }
    if (!USE_COLOUR) { line += g; continue; }
    const c = rgbOf(screen.colour[i]);
    line += c ? `[38;2;${c[0]};${c[1]};${c[2]}m${g}` : g;
  }
  out.push(USE_COLOUR ? line + '[0m' : line.replace(/\s+$/, ''));
}

console.log(out.join('\n'));

/* ------------------------------ diagnostics ------------------------------ */

let drawn = 0;
let nan = 0;
for (let i = 0; i < screen.glyph.length; i++) {
  if (screen.glyph[i] !== undefined) drawn++;
  if (Number.isNaN(screen.depth[i])) nan++;
}
const skyMin = Math.min(...screen.skyEnd);
const skyMax = Math.max(...screen.skyEnd);

console.error(
  `\ncamZ ${CAM_Z}  pitch ${PITCH}  hz ${cam.hz.toFixed(1)}  hour ${HOUR}` +
  `  sunAlt ${sp.alt.toFixed(1)}\n` +
  `${COLS}x${ROWS}  filled ${(drawn / (COLS * ROWS) * 100).toFixed(1)}%` +
  `  skyEnd ${skyMin}..${skyMax}  NaN depths ${nan}  render ${ms.toFixed(1)}ms`);

if (nan > 0) {
  console.error('FAIL: NaN in the depth buffer');
  process.exit(1);
}
