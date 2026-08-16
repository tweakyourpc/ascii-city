/**
 * Picking, the info panel, and the Wikipedia summary.
 *
 * Hermetic: `fetch` is stubbed, so no test touches the network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { OsmWorld } from '../src/world/osm.js';
import { Camera } from '../src/camera.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { pick, unproject, wind, bearingTo, SkyMarks } from '../src/pick.js';
import { Panel, wrap } from '../src/render/panel.js';
import { wikiKey, summary, _reset } from '../src/wiki.js';
import { T } from '../src/world/source.js';
import { FOV, HORIZON_FRAC } from '../src/config.js';

/* ------------------------------- fixture -------------------------------- */

const BBOX = [40.7500, -73.9900, 40.7600, -73.9780];

function world() {
  return new OsmWorld(BBOX, [
    {
      type: 'way', id: 1, tags: { highway: 'primary', name: 'Test Avenue' },
      geometry: [{ lat: 40.7505, lon: -73.9840 }, { lat: 40.7595, lon: -73.9840 }],
    },
    {
      type: 'way', id: 42,
      tags: {
        building: 'office', name: 'Pick Tower', height: '160 m',
        wikidata: 'Q1', start_date: '1930',
        'addr:housenumber': '1', 'addr:street': 'Test Avenue',
      },
      // About 50 m square: a realistic tower footprint. Bigger than this and
      // it fills the entire view from any sensible camera, leaving no sky or
      // ground to click.
      geometry: [
        { lat: 40.7558, lon: -73.9843 }, { lat: 40.7558, lon: -73.9837 },
        { lat: 40.7562, lon: -73.9837 }, { lat: 40.7562, lon: -73.9843 },
        { lat: 40.7558, lon: -73.9843 },
      ],
    },
  ], 'Pick City');
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
      this.glyph[i] = g; this.colour[i] = c; this.depth[i] = d;
    },
    fillRow(y, g, c, d) { for (let x = 0; x < cols; x++) this.setDepth(x, y, g, c, d); },
    text(x, y, str, c) {
      for (let i = 0; i < str.length; i++) {
        const cx = x + i;
        if (cx < 0) continue;
        if (cx >= cols) break;
        if (str[i] === ' ') continue;
        this.glyph[y * cols + cx] = str[i];
        this.colour[y * cols + cx] = c;
      }
    },
    scrim(...a) { this.scrims.push(a); },
  };
  s.vscale = s.proj * cw / ch;
  s.glyph.fill(undefined);
  s.depth.fill(1e9);
  return s;
}

/** Render looking north at the tower, and return everything needed to pick. */
function scene({ z = 20, pitch = 3, cols = 120, rows = 36 } = {}) {
  const w = world();
  const b = w.buildings[1];
  const screen = makeScreen(cols, rows);
  const cam = new Camera();
  cam.x = b.cx;
  cam.y = b.cy - 60;
  cam.z = z;
  cam.pitch = pitch;
  cam.angle = Math.PI / 2;
  cam.hz = screen.horizon - pitch;
  cam.buildRays(screen);
  const L = new Lighting();
  L.update(30);
  screen.glyph.fill(undefined);
  screen.depth.fill(1e9);
  renderScene(screen, cam, w, L, 0);
  return { w, b, screen, cam };
}

/* -------------------------------- picking -------------------------------- */

test('clicking a building identifies it', () => {
  const { w, b, screen, cam } = scene();
  const hit = pick(screen, cam, w, Math.floor(screen.cols / 2),
    Math.floor(screen.rows * 0.6));
  assert.ok(hit, 'nothing picked');
  assert.equal(hit.kind, 'building');
  assert.equal(hit.b.name, 'Pick Tower');
  assert.equal(hit.id, 1);
  assert.equal(w.buildings[hit.id], b);
});

/** First cell whose depth says nothing was drawn there. */
function findSky(screen) {
  for (let r = 0; r < screen.rows; r++) {
    for (let c = 0; c < screen.cols; c++) {
      if (screen.depth[r * screen.cols + c] >= 1e8) return [c, r];
    }
  }
  return null;
}

test('clicking the sky returns a real direction, not nothing', () => {
  const { w, screen, cam } = scene({ z: 3, pitch: -6 });
  const at = findSky(screen);
  assert.ok(at, 'fixture has no visible sky to click');
  const hit = pick(screen, cam, w, at[0], at[1]);
  assert.equal(hit.kind, 'sky');
  assert.ok(Number.isFinite(hit.alt) && Number.isFinite(hit.az));
  assert.ok(hit.az >= 0 && hit.az < 360);
});

test('clicking the ground names the street', () => {
  const { w, screen, cam } = scene();
  // Find a cell the renderer filled with ground rather than with the tower.
  let hit = null;
  for (let r = screen.rows - 1; r >= 0 && !hit; r--) {
    for (let c = 0; c < screen.cols; c++) {
      const h = pick(screen, cam, w, c, r);
      if (h && h.kind === 'ground') { hit = h; break; }
    }
  }
  assert.ok(hit, 'no ground cell anywhere in the frame');
  assert.ok(hit.street, 'no street resolved');
  assert.equal(hit.street.on, 'Test Avenue');
});

test('picking outside the grid is null, not a crash', () => {
  const { w, screen, cam } = scene();
  assert.equal(pick(screen, cam, w, -1, 5), null);
  assert.equal(pick(screen, cam, w, 5, -1), null);
  assert.equal(pick(screen, cam, w, screen.cols, 5), null);
  assert.equal(pick(screen, cam, w, 5, screen.rows), null);
});

test('the pick agrees with what was drawn at that cell', () => {
  // Every cell showing the tower must identify as the tower, not as the
  // ground behind it. This is what the depth readback buys over a recast ray.
  const { w, screen, cam } = scene();
  let building = 0;
  let wrong = 0;
  for (let row = 0; row < screen.rows; row++) {
    for (let col = 0; col < screen.cols; col++) {
      const d = screen.depth[row * screen.cols + col];
      if (d >= 1e8) continue;
      const hit = pick(screen, cam, w, col, row);
      if (hit.kind === 'building') {
        building++;
        if (hit.b.name !== 'Pick Tower') wrong++;
      }
    }
  }
  assert.ok(building > 20, `only ${building} cells picked as a building`);
  assert.equal(wrong, 0);
});

/* ------------------------------ orientation ------------------------------ */

test('bearings and compass points agree with north being +y', () => {
  const cam = { x: 0, y: 0 };
  assert.equal(wind(bearingTo(cam, 0, 10)), 'N');
  assert.equal(wind(bearingTo(cam, 10, 0)), 'E');
  assert.equal(wind(bearingTo(cam, 0, -10)), 'S');
  assert.equal(wind(bearingTo(cam, -10, 0)), 'W');
});

test('unproject inverts the sky projection at the screen centre', () => {
  const screen = makeScreen(120, 36);
  const cam = new Camera();
  cam.angle = Math.PI / 2;      // facing north
  cam.hz = 18;
  cam.vscale = screen.vscale;
  const p = unproject(screen, cam, screen.cols / 2 - 0.5, 18);
  assert.ok(Math.abs(p.az) < 1 || Math.abs(p.az - 360) < 1,
    `facing north should read azimuth 0, got ${p.az}`);
  assert.ok(Math.abs(p.alt) < 0.5, `horizon should be altitude 0, got ${p.alt}`);
});

test('sky marks resolve the nearest catalogued object', () => {
  const m = new SkyMarks();
  m.add(10, 5, { name: 'Vega' });
  m.add(40, 9, { name: 'Altair' });
  assert.equal(m.nearest(11, 6).name, 'Vega');
  assert.equal(m.nearest(41, 9).name, 'Altair');
  assert.equal(m.nearest(80, 30), null, 'a distant click must not snap to a star');
  m.reset();
  assert.equal(m.nearest(10, 5), null);
});

/* -------------------------------- panel ---------------------------------- */

function panelText(p, screen, cam, w) {
  p.draw(screen, cam, w);
  const out = [];
  for (let r = 0; r < screen.rows; r++) {
    let line = '';
    for (let c = 0; c < screen.cols; c++) {
      const g = screen.glyph[r * screen.cols + c];
      line += g === undefined ? ' ' : g;
    }
    out.push(line);
  }
  return out.join('\n');
}

test('the panel shows what OSM knows, with no network at all', () => {
  const { w, screen, cam } = scene();
  const hit = pick(screen, cam, w, Math.floor(screen.cols / 2),
    Math.floor(screen.rows * 0.6));
  const p = new Panel();
  p.select(hit);
  const text = panelText(p, screen, cam, w);

  assert.match(text, /PICK TOWER/);
  assert.match(text, /160 m/);
  assert.match(text, /1930/);
  assert.match(text, /way\/42/);
  assert.match(text, /esc/);
});

test('the panel clears the cells it covers', () => {
  // Otherwise the city blits straight over the top of the backdrop.
  const { w, screen, cam } = scene();
  const hit = pick(screen, cam, w, Math.floor(screen.cols / 2),
    Math.floor(screen.rows * 0.6));
  const p = new Panel();
  p.select(hit);
  p.draw(screen, cam, w);
  const box = p.rect(screen);
  assert.ok(box);
  assert.ok(screen.scrims.length > 0, 'no backdrop queued');

  // The interior right of the text must be blank, not city texture.
  let cityGlyphs = 0;
  for (let r = box.y + 1; r < box.y + box.h - 1; r++) {
    for (let c = box.x + 1; c < box.x + box.w - 1; c++) {
      const g = screen.glyph[r * screen.cols + c];
      if (g !== undefined && ':;.,%#8=+|-&*"~'.includes(g) && g !== '-' && g !== '|') {
        cityGlyphs++;
      }
    }
  }
  assert.equal(cityGlyphs, 0, `${cityGlyphs} city glyphs still inside the panel`);
});

test('the panel opens and closes', () => {
  const { w, screen, cam } = scene();
  const p = new Panel();
  assert.equal(p.open, false);
  assert.equal(p.rect(screen), null);
  p.select(pick(screen, cam, w, 5, screen.rows - 1));
  assert.equal(p.open, true);
  p.close();
  assert.equal(p.open, false);
});

test('text wrapping only marks an ellipsis when it actually truncates', () => {
  assert.deepEqual(wrap('one two three', 20, 4), ['one two three']);
  const cut = wrap('aa bb cc dd ee ff gg hh ii jj kk ll', 5, 2);
  assert.equal(cut.length, 2);
  assert.match(cut[1], /\.\.\.$/);
  // Exactly filling the line budget is not truncation.
  const exact = wrap('aaaa bbbb', 4, 2);
  assert.deepEqual(exact, ['aaaa', 'bbbb']);
});

/* ------------------------------- wikipedia ------------------------------- */

test('wikiKey prefers the wikipedia tag and falls back to wikidata', () => {
  assert.equal(wikiKey({ wikipedia: 'en:Foo', wikidata: 'Q1' }), 'w:en:Foo');
  assert.equal(wikiKey({ wikidata: 'Q1' }), 'q:Q1');
  assert.equal(wikiKey({}), null);
  assert.equal(wikiKey(null), null);
});

test('a summary is fetched, then served from cache', async () => {
  _reset();
  let calls = 0;
  globalThis.localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ extract: 'A tall building.' }) };
  };

  const first = await new Promise((r) => summary('w:en:Pick Tower', r));
  assert.equal(first.text, 'A tall building.');
  assert.equal(calls, 1);

  const second = await new Promise((r) => summary('w:en:Pick Tower', r));
  assert.equal(second.text, 'A tall building.');
  assert.equal(calls, 1, 'second lookup should not hit the network');
});

test('a failed summary is silent and the panel still renders', async () => {
  _reset();
  globalThis.localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  globalThis.fetch = async () => { throw new Error('offline'); };

  const v = await new Promise((r) => summary('w:en:Nope', r));
  assert.equal(v, null, 'a failure must resolve to null, not reject');

  const { w, screen, cam } = scene();
  const hit = pick(screen, cam, w, Math.floor(screen.cols / 2),
    Math.floor(screen.rows * 0.6));
  const p = new Panel();
  p.select(hit);
  p.wiki = { state: 'none', text: '' };
  const text = panelText(p, screen, cam, w);
  assert.match(text, /PICK TOWER/, 'panel must survive a failed lookup');
  assert.doesNotMatch(text, /error|fail|could not/i,
    'a failed lookup must not put an error message inside the city');
});

test('a wikidata id is resolved to an article before the summary', async () => {
  _reset();
  const urls = [];
  globalThis.localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes('wikidata.org')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          entities: { Q9188: { sitelinks: { enwiki: { title: 'Empire State Building' } } } },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ extract: 'Art Deco.' }) };
  };

  const v = await new Promise((r) => summary('q:Q9188', r));
  assert.equal(v.text, 'Art Deco.');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /wikidata\.org.*origin=\*/, 'CORS param missing');
  assert.match(urls[1], /Empire_State_Building/);
});
