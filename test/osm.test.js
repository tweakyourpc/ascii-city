/**
 * OSM ingestion: tag parsing, projection, and rasterization.
 *
 * All hermetic. Geometry is hand-built so the expected grid is known exactly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OsmWorld, heightOfCells, parseMetres, makeProjection, scanFill, strokePath,
} from '../src/world/osm.js';
import { T } from '../src/world/source.js';
import { FLOOR_H, METERS_PER_CELL } from '../src/config.js';
import {
  parseLocation, bboxArea, buildQuery, MAX_BBOX_DEG2, PRESETS,
} from '../src/world/overpass.js';

/* -------------------------------- tags --------------------------------- */

test('distance tags parse, including imperial', () => {
  assert.equal(parseMetres('25'), 25);
  assert.equal(parseMetres('25 m'), 25);
  assert.equal(parseMetres('25.5m'), 25.5);
  assert.ok(Math.abs(parseMetres("100'") - 30.48) < 1e-9);
  assert.ok(Math.abs(parseMetres('100 ft') - 30.48) < 1e-9);
  assert.equal(parseMetres('rubbish'), null);
  assert.equal(parseMetres(undefined), null);
});

test('height comes from the height tag first', () => {
  const h = heightOfCells({ height: '100 m', 'building:levels': '2' });
  assert.ok(Math.abs(h * METERS_PER_CELL - 100) < 1e-6);
});

test('levels map onto whole rendered floors', () => {
  // This is the point of deriving the metric scale from the facade texture:
  // 10 real storeys must be exactly 10 rendered floors.
  assert.ok(Math.abs(heightOfCells({ 'building:levels': '10' }) - 10 * FLOOR_H) < 1e-9);
  assert.ok(Math.abs(heightOfCells({ 'building:levels': '10', 'roof:levels': '2' })
    - 12 * FLOOR_H) < 1e-9);
});

test('a building with no height data defaults to three levels', () => {
  assert.ok(Math.abs(heightOfCells({ building: 'yes' }) - 3 * FLOOR_H) < 1e-9);
  assert.ok(Math.abs(heightOfCells({}) - 3 * FLOOR_H) < 1e-9);
  // Nonsense must fall back rather than produce NaN.
  assert.ok(Number.isFinite(heightOfCells({ height: 'about 4 storeys' })));
});

/* ----------------------------- projection ------------------------------ */

test('projection puts north at increasing y', () => {
  // The sky code treats +y as north; getting this backwards mirrors the city
  // and makes the sun rise in the west.
  const bbox = [40.74, -74.00, 40.76, -73.98];
  const p = makeProjection(bbox);
  assert.ok(p.y(40.76) > p.y(40.74), '+y must be north');
  assert.ok(p.x(-73.98) > p.x(-74.00), '+x must be east');
});

test('projection scale is metric and roughly square', () => {
  const bbox = [40.7466, -73.9900, 40.7576, -73.9750];
  const p = makeProjection(bbox);
  const km = (n) => n * METERS_PER_CELL / 1000;
  // 0.011 deg of latitude is about 1.22 km.
  assert.ok(Math.abs(km(p.height) - 1.216) < 0.05, `height ${km(p.height)} km`);
  // 0.015 deg of longitude at 40.75N is about 1.27 km.
  assert.ok(Math.abs(km(p.width) - 1.266) < 0.05, `width ${km(p.width)} km`);
});

/* ---------------------------- raster helpers ---------------------------- */

test('scanFill fills a rectangle exactly', () => {
  const ring = [[2, 2], [8, 2], [8, 6], [2, 6], [2, 2]];
  const hit = new Set();
  scanFill([ring], 20, 20, (x, y) => hit.add(`${x},${y}`));
  // Cell centres inside [2,8] x [2,6] are x in 2..7, y in 2..5.
  assert.equal(hit.size, 6 * 4);
  assert.ok(hit.has('2,2'));
  assert.ok(hit.has('7,5'));
  assert.ok(!hit.has('8,2'), 'right edge should be exclusive');
  assert.ok(!hit.has('1,2'));
});

test('scanFill punches holes with an inner ring', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const inner = [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]];
  const hit = new Set();
  scanFill([outer, inner], 20, 20, (x, y) => hit.add(`${x},${y}`));
  assert.ok(hit.has('1,1'), 'outer ring should fill');
  assert.ok(!hit.has('5,5'), 'inner ring should be a hole');
  assert.equal(hit.size, 100 - 16);
});

test('scanFill clips to the grid instead of writing out of bounds', () => {
  const ring = [[-50, -50], [50, -50], [50, 50], [-50, 50], [-50, -50]];
  let min = Infinity;
  let max = -Infinity;
  scanFill([ring], 10, 10, (x, y) => {
    min = Math.min(min, x, y);
    max = Math.max(max, x, y);
  });
  assert.ok(min >= 0 && max <= 9, `plotted outside the grid: ${min}..${max}`);
});

test('strokePath lays down a band of the requested width', () => {
  const hit = new Map();
  strokePath([[5, 0], [5, 20]], 6, 30, 30, (x, y, d) => hit.set(`${x},${y}`, d));
  assert.ok(hit.has('5,10'), 'centre of the road is missing');
  assert.ok(hit.has('3,10') && hit.has('7,10'), 'road is too narrow');
  assert.ok(!hit.has('0,10'), 'road bled beyond its width');
  assert.ok(hit.get('5,10') < hit.get('7,10'), 'distance-to-centre is wrong');
});

/* ------------------------------ the world ------------------------------- */

const BBOX = [40.7550, -73.9880, 40.7610, -73.9820];

function buildWorld(extra = []) {
  const elements = [
    {
      type: 'way', id: 7, tags: { building: 'yes', 'building:levels': '20' },
      geometry: [
        { lat: 40.7570, lon: -73.9860 }, { lat: 40.7570, lon: -73.9845 },
        { lat: 40.7585, lon: -73.9845 }, { lat: 40.7585, lon: -73.9860 },
        { lat: 40.7570, lon: -73.9860 },
      ],
    },
    {
      type: 'way', id: 8, tags: { highway: 'primary' },
      geometry: [{ lat: 40.7555, lon: -73.9870 }, { lat: 40.7605, lon: -73.9870 }],
    },
    ...extra,
  ];
  return new OsmWorld(BBOX, elements, 'Test');
}

test('a building rasterizes to the right height and type', () => {
  const w = buildWorld();
  const s = w.sample(w.proj.x(-73.9852), w.proj.y(40.7577));
  assert.equal(w.type[s], T.TOWER);
  assert.ok(Math.abs(w.h[s] - 20 * FLOOR_H) < 1e-4,
    `height ${w.h[s]} cells, expected ${20 * FLOOR_H}`);
  assert.ok(Math.abs(w.maxHeight - 20 * FLOOR_H) < 1e-4);
});

test('a road rasterizes as walkable ground', () => {
  const w = buildWorld();
  const s = w.sample(w.proj.x(-73.9870), w.proj.y(40.7580));
  assert.equal(w.type[s], T.ROAD);
  assert.equal(w.h[s], 0, 'roads must not be solid');
  assert.ok(w.roadCells.length > 0, 'no road cells collected');
});

test('outside the extract is flat, unclaimed ground', () => {
  const w = buildWorld();
  const s = w.sample(-500, -500);
  assert.equal(s, w.voidSlot);
  assert.equal(w.h[s], 0, 'the edge of the data must not be a wall');
  // Not FIELD: inventing grass past the extract would assert something about
  // the world that the map data does not say.
  assert.equal(w.type[s], T.VOID);
  // Sampling far outside must stay in bounds of the arrays.
  assert.ok(Number.isFinite(w.h[w.sample(1e9, 1e9)]));
});

test('the spawn point is on a street and not inside a building', () => {
  const w = buildWorld();
  const s = w.spawn();
  const slot = w.sample(s.x, s.y);
  assert.equal(w.h[slot], 0, 'spawned inside geometry');
  assert.ok(w.type[slot] === T.ROAD || w.type[slot] === T.SIDEWALK);
});

test('water and parks rasterize when present', () => {
  const w = buildWorld([
    {
      type: 'way', id: 9, tags: { natural: 'water' },
      geometry: [
        { lat: 40.7590, lon: -73.9835 }, { lat: 40.7590, lon: -73.9825 },
        { lat: 40.7600, lon: -73.9825 }, { lat: 40.7600, lon: -73.9835 },
        { lat: 40.7590, lon: -73.9835 },
      ],
    },
  ]);
  const s = w.sample(w.proj.x(-73.9830), w.proj.y(40.7595));
  assert.equal(w.type[s], T.WATER);
});

test('a multipolygon relation rasterizes from its members', () => {
  const w = buildWorld([
    {
      type: 'relation', id: 10, tags: { building: 'yes', 'building:levels': '5' },
      members: [{
        role: 'outer', type: 'way',
        geometry: [
          { lat: 40.7558, lon: -73.9840 }, { lat: 40.7558, lon: -73.9830 },
          { lat: 40.7565, lon: -73.9830 }, { lat: 40.7565, lon: -73.9840 },
          { lat: 40.7558, lon: -73.9840 },
        ],
      }],
    },
  ]);
  const s = w.sample(w.proj.x(-73.9835), w.proj.y(40.7561));
  assert.ok(w.h[s] > 0, 'relation members were not rasterized');
  assert.ok(Math.abs(w.h[s] - 5 * FLOOR_H) < 1e-4);
});

test('elements with unusable geometry are skipped, not fatal', () => {
  assert.doesNotThrow(() => buildWorld([
    { type: 'way', id: 11, tags: { building: 'yes' } },                    // no geometry
    { type: 'way', id: 12, tags: { building: 'yes' }, geometry: [] },      // empty
    { type: 'way', id: 13, tags: { highway: 'residential' }, geometry: [{ lat: 40.757, lon: -73.985 }] },
    { type: 'way', id: 14, tags: { building: 'yes' }, geometry: [{ lat: 40.757, lon: -73.985 }] },
  ]));
});

/* ------------------------------- overpass ------------------------------- */

test('location input accepts the forms a user would actually paste', () => {
  const box = parseLocation('40.7580,-73.9855');
  assert.ok(box && box[0] < 40.758 && box[2] > 40.758);

  const explicit = parseLocation('40.74,-74.00,40.76,-73.98');
  assert.deepEqual(explicit, [40.74, -74.00, 40.76, -73.98]);

  // Corners either way round.
  assert.deepEqual(parseLocation('40.76,-73.98,40.74,-74.00'),
    [40.74, -74.00, 40.76, -73.98]);

  const url = parseLocation('https://www.openstreetmap.org/#map=16/51.5074/-0.1278');
  assert.ok(url && url[0] < 51.5074 && url[2] > 51.5074);

  assert.equal(parseLocation('somewhere nice'), null);
  assert.equal(parseLocation(''), null);
  assert.equal(parseLocation('999,999'), null);
});

test('a box built around a point is roughly square on the ground', () => {
  for (const lat of [0, 40, 60]) {
    const [s, w, n, e] = parseLocation(`${lat},0`);
    const kmNS = (n - s) * 110.54;
    const kmEW = (e - w) * 111.32 * Math.cos(lat * Math.PI / 180);
    assert.ok(Math.abs(kmNS - kmEW) < 0.05,
      `at ${lat}N the box is ${kmNS.toFixed(2)} x ${kmEW.toFixed(2)} km`);
  }
});

test('preset boxes are within the area cap', () => {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (!p.bbox) continue;
    assert.ok(bboxArea(p.bbox) <= MAX_BBOX_DEG2,
      `${key} exceeds the area cap and would be rejected on load`);
  }
});

test('the query asks for inline geometry', () => {
  const q = buildQuery([40.74, -74, 40.76, -73.98], 'core');
  assert.match(q, /out geom;/);
  assert.match(q, /\[out:json\]/);
  assert.match(q, /nwr\["building"\]/);
  assert.match(q, /way\["highway"\]/);
});
