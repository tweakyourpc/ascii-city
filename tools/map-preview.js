/**
 * Print a top-down map of a rasterized world, so an OSM import can be checked
 * against the real street layout at a glance.
 *
 *   node tools/map-preview.js --city manhattan
 *   node tools/map-preview.js --city london --width 150
 *   node tools/map-preview.js --city 51.5074,-0.1278      # lat,lon
 *   node tools/map-preview.js --heights                   # show storeys, not types
 *
 * Legend (types):  . plaza   , field   ~ water   = road   - path/sidewalk
 *                  o house   # tower   ^ forest
 * Legend (heights): digits are storeys / 4, capped at z.
 */
import fs from 'node:fs';
import path from 'node:path';

import { OsmWorld } from '../src/world/osm.js';
import { ProceduralWorld } from '../src/world/procedural.js';
import { T } from '../src/world/source.js';
import { FLOOR_H, METERS_PER_CELL } from '../src/config.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.set(k, 'true');
    else { args.set(k, next); i++; }
  }
}

const OUT_W = Number(args.get('width') ?? 140);
const CITY = args.get('city');
const SHOW_H = args.has('heights');

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
let W;
let H;
let originX = 0;
let originY = 0;

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
  W = world.width;
  H = world.height;
  console.error(`${world.name}  bbox ${bbox.join(', ')}`);
  console.error(`${W}x${H} cells at ${METERS_PER_CELL.toFixed(2)} m/cell ` +
    `= ${(W * METERS_PER_CELL / 1000).toFixed(2)} x ` +
    `${(H * METERS_PER_CELL / 1000).toFixed(2)} km`);
  console.error(`${world.stats.buildings} buildings, ${world.stats.roads} ways, ` +
    `${world.stats.water} water, ${world.stats.green} green`);
  console.error(`tallest ${(world.maxHeight * METERS_PER_CELL).toFixed(0)} m ` +
    `(${(world.maxHeight / FLOOR_H).toFixed(0)} storeys)`);
} else {
  world = new ProceduralWorld();
  W = 700;
  H = 700;
  originX = 1024 - W / 2;
  originY = 1024 - H / 2;
  console.error(`Procedural City, ${W}x${H} cells around the park`);
}

const GLYPH = {
  [T.VOID]: ' ', [T.ROAD]: '=', [T.PATH]: '-', [T.SIDEWALK]: '-',
  [T.PLAZA]: '.', [T.YARD]: ',', [T.FIELD]: ',', [T.FARM]: ',',
  [T.WATER]: '~', [T.TREE]: '^', [T.FOREST]: '^', [T.HOUSE]: 'o',
  [T.TOWER]: '#',
};
const HEIGHT_RAMP = '.123456789abcdefghijklmnopqrstuvwxyz';

// Terminal cells are about twice as tall as wide, so sample half as many rows.
const step = Math.max(1, W / OUT_W);
const rows = Math.floor(H / (step * 2));
const cols = Math.floor(W / step);

const lines = [];
for (let ry = rows - 1; ry >= 0; ry--) {      // +y is north: print north at top
  let line = '';
  for (let rx = 0; rx < cols; rx++) {
    // Sample the block this output cell covers and take the most significant
    // feature in it, so thin streets survive downsampling.
    let best = null;
    let bestH = 0;
    const gx0 = originX + rx * step;
    const gy0 = originY + ry * step * 2;

    for (let sy = 0; sy < step * 2; sy += Math.max(1, step / 2)) {
      for (let sx = 0; sx < step; sx += Math.max(1, step / 2)) {
        const s = world.sample(gx0 + sx, gy0 + sy);
        const t = world.type[s];
        const h = world.h[s];
        if (h > bestH) bestH = h;
        // Streets are thinner than one output cell at this zoom, so they win
        // the tie. Ranking buildings first erases the grid entirely.
        const rank = t === T.ROAD ? 4
                   : t === T.WATER ? 3
                   : t === T.SIDEWALK ? 2
                   : t === T.TOWER || t === T.HOUSE ? 1 : 0;
        if (best === null || rank > best.rank) best = { t, rank };
      }
    }
    line += SHOW_H
      ? (bestH > 0
          ? HEIGHT_RAMP[Math.min(HEIGHT_RAMP.length - 1,
              Math.max(1, Math.round(bestH / FLOOR_H / 4)))]
          : (best.t === T.WATER ? '~' : '.'))
      : (GLYPH[best.t] ?? '?');
  }
  lines.push(line);
}

console.log(lines.join('\n'));
console.error(SHOW_H
  ? '\nheights: digit/letter = storeys/4, . = ground, ~ = water'
  : '\n. plaza   , field   ~ water   = road   - footway   o house   # tower   ^ trees');
