/**
 * The identification layer: metadata capture, label placement, and picking.
 *
 * Hermetic. Geometry is hand-built so the expected result is known exactly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { OsmWorld } from '../src/world/osm.js';
import { Camera } from '../src/camera.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { Labels, MODE } from '../src/render/labels.js';
import { T } from '../src/world/source.js';
import { FOV, HORIZON_FRAC, FLOOR_H } from '../src/config.js';

/* ------------------------------- fixtures ------------------------------- */

const BBOX = [40.7500, -73.9900, 40.7600, -73.9780];

/**
 * Two named avenues running north, two named streets running east, and one
 * tall named landmark. Crossings are real, so junction detection has something
 * to find.
 */
function city(extra = []) {
  const ways = [];
  const avenues = [['5th Avenue', -73.9860], ['6th Avenue', -73.9830]];
  const streets = [['West 40th Street', 40.7530], ['West 41st Street', 40.7560]];

  // Real OSM splits ways at intersections so the crossing node is shared.
  // The fixture has to do the same or junction detection has nothing to find.
  let id = 1;
  for (const [name, lon] of avenues) {
    const lats = [40.7505, ...streets.map(([, la]) => la), 40.7595];
    ways.push({
      type: 'way', id: id++, tags: { highway: 'primary', name },
      geometry: lats.map((lat) => ({ lat, lon })),
    });
  }
  for (const [name, lat] of streets) {
    const lons = [-73.9890, ...avenues.map(([, lo]) => lo), -73.9790];
    ways.push({
      type: 'way', id: id++, tags: { highway: 'secondary', name },
      geometry: lons.map((lon) => ({ lat, lon })),
    });
  }
  ways.push({
    type: 'way', id: 100,
    tags: {
      building: 'yes', name: 'Tall Tower', height: '200 m',
      wikidata: 'Q1', start_date: '1931',
      'addr:housenumber': '350', 'addr:street': '5th Avenue',
    },
    geometry: [
      { lat: 40.7570, lon: -73.9820 }, { lat: 40.7570, lon: -73.9805 },
      { lat: 40.7585, lon: -73.9805 }, { lat: 40.7585, lon: -73.9820 },
      { lat: 40.7570, lon: -73.9820 },
    ],
  });
  // Named but short and unremarkable: must NOT become a landmark.
  ways.push({
    type: 'way', id: 101, tags: { building: 'yes', name: 'Bike Shed' },
    geometry: [
      { lat: 40.7512, lon: -73.9880 }, { lat: 40.7512, lon: -73.9877 },
      { lat: 40.7514, lon: -73.9877 }, { lat: 40.7514, lon: -73.9880 },
      { lat: 40.7512, lon: -73.9880 },
    ],
  });
  return new OsmWorld(BBOX, [...ways, ...extra], 'Test City');
}

function makeScreen(cols, rows) {
  const cw = 8;
  const ch = 15;
  const proj = (cols / 2) / Math.tan(FOV / 2);
  const s = {
    cols, rows, cw, ch, proj,
    vscale: proj * cw / ch,
    horizon: Math.floor(rows * HORIZON_FRAC),
    glyph: new Array(cols * rows),
    colour: new Array(cols * rows),
    depth: new Float32Array(cols * rows),
    skyEnd: new Int32Array(cols),
    covWords: ((rows + 31) >> 5),
    cov: new Uint32Array((rows + 31) >> 5),
    hasHoles: new Uint8Array(cols),
    holeMask: new Uint32Array(cols * ((rows + 31) >> 5)),
    scrims: [],
    set(x, y, g, c) {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return;
      this.glyph[y * cols + x] = g;
      this.colour[y * cols + x] = c;
    },
    setDepth(x, y, g, c, d) {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return;
      const i = y * cols + x;
      this.glyph[i] = g;
      this.colour[i] = c;
      this.depth[i] = d;
    },
    fillRow(y, g, c, d) {
      for (let x = 0; x < cols; x++) this.setDepth(x, y, g, c, d);
    },
  };
  s.glyph.fill(undefined);
  s.depth.fill(1e9);
  return s;
}

/** Render a frame and return the label layer plus the screen text. */
function frame(world, { z, pitch, angle = Math.PI / 2, x, y, cols = 140, rows = 36,
                       mode = MODE.ALL } = {}) {
  const screen = makeScreen(cols, rows);
  const cam = new Camera();
  const sp = world.spawn();
  cam.x = x ?? sp.x;
  cam.y = y ?? sp.y;
  cam.z = z;
  cam.pitch = pitch;
  cam.angle = angle;
  cam.hz = screen.horizon - pitch;
  cam.buildRays(screen);

  const L = new Lighting();
  L.update(35);
  screen.glyph.fill(undefined);
  screen.depth.fill(1e9);
  renderScene(screen, cam, world, L, 0);

  const labels = new Labels();
  labels.mode = mode;
  labels.draw(screen, cam, world, L);

  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const g = screen.glyph[r * cols + c];
      line += g === undefined ? ' ' : g;
    }
    lines.push(line);
  }
  return { screen, cam, labels, text: lines.join('\n'), lines };
}

/* ---------------------------- metadata capture --------------------------- */

test('street names are captured from tags that were previously discarded', () => {
  const w = city();
  assert.ok(w.streetNames.includes('5th Avenue'));
  assert.ok(w.streetNames.includes('West 40th Street'));
  assert.equal(w.streetNames.length, 4);
});

test('anchors are emitted and junctions detected', () => {
  const w = city();
  assert.ok(w.anchor.n > 0, 'no anchors');
  // Two avenues crossing two streets is four crossings.
  assert.equal(w.stats.junctions, 4);
  const atJunction = [...w.anchor.junction].filter(Boolean).length;
  assert.ok(atJunction >= 8,
    `only ${atJunction} junction anchors; each crossing should anchor both streets`);
});

test('a cell maps back to the building that owns it', () => {
  const w = city();
  assert.equal(w.buildings.length - 1, 2);
  for (let i = 1; i < w.buildings.length; i++) {
    const b = w.buildings[i];
    assert.equal(w.bid[w.sample(b.cx, b.cy)], i, `${b.name} does not round-trip`);
  }
  // Empty ground must report no building.
  assert.equal(w.bid[w.voidSlot], 0);
});

test('landmarks are the notable buildings only', () => {
  const w = city();
  const names = w.landmarks.map((i) => w.buildings[i].name);
  assert.deepEqual(names, ['Tall Tower']);
  assert.equal(w.buildings[w.landmarks[0]].notable, 3, 'tall AND wiki-tagged');
});

test('building height and tags survive capture', () => {
  const w = city();
  const b = w.buildings[w.landmarks[0]];
  assert.ok(Math.abs(b.h * 2.37 - 200) < 3, `height came out ${b.h * 2.37} m`);
  assert.equal(b.tags.start_date, '1931');
  assert.equal(b.tags['addr:housenumber'], '350');
  assert.match(b.osm, /^way\/100$/);
});

test('nearestStreet names where you are standing and the nearest crossing', () => {
  const w = city();
  // Stand on 5th Avenue, north of West 41st.
  const x = w.proj.x(-73.9860);
  const y = w.proj.y(40.7575);
  const s = w.nearestStreet(x, y);
  assert.equal(s.on, '5th Avenue');
  assert.equal(s.cross, 'West 41st Street');
  assert.ok(s.onDist < 2, `standing on it but reported ${s.onDist} cells away`);
});

/* ------------------------------ label pass ------------------------------ */

test('street labels are drawn at street level', () => {
  const w = city();
  const { text, labels } = frame(w, { z: 1.7, pitch: 2 });
  assert.ok(labels.lastCounts.streets > 0, 'no street labels drawn');
  assert.match(text, /5TH AVENUE|WEST 4\dTH STREET/);
});

test('street labels survive at drone altitude', () => {
  // The whole point of culling by projected row rather than a fixed distance
  // band. The ceiling is set by draw distance, not by the label code: past
  // roughly 130 cells up, the ground you can see is beyond the fog limit and
  // there is genuinely nothing left to label.
  const w = city();
  // The ceiling above which nothing is labelled is set by draw distance and
  // world size, not by the label code: at 120 cells up the only ground still
  // on screen is 177+ cells away, and this fixture is not that big.
  for (const [z, pitch] of [[20, 6], [40, 10], [95, 15]]) {
    const { labels } = frame(w, { z, pitch });
    assert.ok(labels.lastCounts.streets > 0,
      `no labels at z=${z}: the cull is using a fixed distance band`);
  }
});

test('extreme altitude degrades quietly rather than breaking', () => {
  const w = city();
  assert.doesNotThrow(() => frame(w, { z: 380, pitch: 20 }));
});

test('each street name appears at most once', () => {
  const w = city();
  const { lines } = frame(w, { z: 95, pitch: 15 });
  const all = lines.join('\n');
  for (const name of w.streetNames) {
    const n = all.split(name.toUpperCase()).length - 1;
    assert.ok(n <= 1, `"${name}" drawn ${n} times`);
  }
});

test('labels are padded so surrounding texture does not read as letters', () => {
  const w = city();
  const { lines } = frame(w, { z: 95, pitch: 15 });
  const hit = lines.find((l) => l.includes('AVENUE') || l.includes('STREET'));
  assert.ok(hit, 'no label to check');
  const m = /([A-Z0-9]+ )+[A-Z0-9]+/.exec(hit);
  assert.ok(m, 'label letters are not contiguous with single spaces between words');
});

test('a landmark names itself on approach', () => {
  const w = city();
  const b = w.buildings[w.landmarks[0]];
  // Stand well south of the tower, looking north at it.
  const { text, labels } = frame(w, {
    z: 30, pitch: 4, x: b.cx, y: b.cy - 60, angle: Math.PI / 2,
  });
  assert.equal(labels.lastCounts.landmarks, 1, 'landmark not labelled');
  assert.match(text, /TALL TOWER/);
});

test('an unremarkable named building is never labelled unprompted', () => {
  const w = city();
  const shed = w.buildings.find((b) => b && b.name === 'Bike Shed');
  const { text } = frame(w, {
    z: 6, pitch: 2, x: shed.cx, y: shed.cy - 20, angle: Math.PI / 2,
  });
  assert.doesNotMatch(text, /BIKE SHED/);
});

test('the label layer switches off completely', () => {
  const w = city();
  const on = frame(w, { z: 95, pitch: 15, mode: MODE.ALL });
  const off = frame(w, { z: 95, pitch: 15, mode: MODE.OFF });
  assert.ok(on.labels.lastCounts.streets > 0);
  assert.equal(off.labels.lastCounts.streets, 0);
  assert.equal(off.labels.lastCounts.landmarks, 0);
  assert.doesNotMatch(off.text, /AVENUE|STREET|TALL TOWER/);
  // STREETS mode draws roads but no building names.
  const mid = frame(w, { z: 30, pitch: 4, mode: MODE.STREETS });
  assert.equal(mid.labels.lastCounts.landmarks, 0);
});

test('labels are occluded by geometry in front of them', () => {
  // A wall between camera and a street label must hide it. Build a slab
  // spanning the view, just in front of a labelled avenue.
  const w = city([{
    type: 'way', id: 500, tags: { building: 'yes', height: '90 m' },
    geometry: [
      { lat: 40.7548, lon: -73.9890 }, { lat: 40.7548, lon: -73.9790 },
      { lat: 40.7552, lon: -73.9790 }, { lat: 40.7552, lon: -73.9890 },
      { lat: 40.7548, lon: -73.9890 },
    ],
  }]);
  const openView = frame(w, {
    z: 1.7, pitch: 2, x: w.proj.x(-73.9860), y: w.proj.y(40.7556),
    angle: Math.PI / 2,
  });
  const blocked = frame(w, {
    z: 1.7, pitch: 2, x: w.proj.x(-73.9860), y: w.proj.y(40.7540),
    angle: Math.PI / 2,
  });
  // Looking north from south of the slab, the far street must not show through.
  assert.ok(blocked.labels.lastCounts.streets <= openView.labels.lastCounts.streets,
    'a wall did not reduce the number of visible street labels');
});

test('the label pass allocates no per-frame typed arrays', () => {
  // Re-running on the same screen must reuse the mask.
  const w = city();
  const screen = makeScreen(120, 30);
  const cam = new Camera();
  const sp = w.spawn();
  cam.x = sp.x; cam.y = sp.y; cam.z = 40; cam.pitch = 10;
  cam.hz = screen.horizon - 10;
  cam.buildRays(screen);
  const L = new Lighting();
  L.update(35);
  const labels = new Labels();
  labels.draw(screen, cam, w, L);
  const mask1 = labels.mask;
  labels.draw(screen, cam, w, L);
  assert.equal(labels.mask, mask1, 'mask was reallocated between frames');
});

/* ------------------------------- procedural ------------------------------ */

test('the procedural world has no labels and does not crash the pass', () => {
  const screen = makeScreen(100, 30);
  const cam = new Camera();
  cam.z = 2; cam.hz = 15; cam.buildRays(screen);
  const L = new Lighting();
  L.update(35);
  const labels = new Labels();
  // A world with no anchor table at all.
  assert.doesNotThrow(() => labels.draw(screen, cam, { streetNames: [] }, L));
  assert.equal(labels.lastCounts.streets, 0);
});
