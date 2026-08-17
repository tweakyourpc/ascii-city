/**
 * Links on the identify card.
 *
 * The card quotes a Wikipedia summary, so it should let you read the rest.
 * The hazard is not the fetching but the geometry: panel.js already warns that
 * the recorded rect "must agree exactly with draw(), or clicks land in a box
 * that is not there", and a link region is that same problem at one-row
 * resolution, in two render modes.
 *
 * Hermetic: `fetch` and `localStorage` are stubbed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Panel } from '../src/render/panel.js';
import { summary, _reset } from '../src/wiki.js';
import { T } from '../src/world/source.js';
import { makeScreen, MODE } from './support/screen.js';

/* -------------------------------- helpers -------------------------------- */

function stubStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
  return m;
}

function stubFetch(body) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

const ask = (key) => new Promise((r) => summary(key, r));

const CAM = { x: 10, y: 10, z: 2 };

/** A building with a name, a website and an OSM id, drawn on a real Screen. */
function building(extra = {}) {
  return {
    kind: 'building',
    x: 20, y: 40, d: 30,
    b: {
      name: 'Empire State Building',
      osm: 'way/34633854',
      h: 40,
      tags: { building: 'yes', website: 'https://www.esbnyc.com/', ...extra },
    },
  };
}

function drawn(panel, mode = MODE.GLYPH) {
  const screen = makeScreen(90, 40, mode);
  screen.clear();
  panel.draw(screen, CAM, { label: 'Manhattan' });
  return screen;
}

/** Find the output line whose text contains `needle`. */
function lineOf(screen, needle) {
  for (let y = 0; y < screen.rows; y++) {
    let s = '';
    for (let x = 0; x < screen.cols; x++) {
      const g = screen.glyph[y * screen.cols + x];
      s += g === undefined ? ' ' : g;
    }
    if (s.includes(needle)) return { row: y, col: s.indexOf(needle), text: s };
  }
  return null;
}

/* ------------------------------ the URL itself ---------------------------- */

test('the article URL comes back with the summary', async () => {
  _reset();
  stubStorage();
  stubFetch({
    extract: 'A 102-storey Art Deco skyscraper in Midtown Manhattan.',
    title: 'Empire State Building',
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Empire_State_Building' } },
  });

  const v = await ask('w:en:Empire State Building');
  assert.equal(v.url, 'https://en.wikipedia.org/wiki/Empire_State_Building');
});

test('a missing content_urls is reconstructed, spaces and all', async () => {
  _reset();
  stubStorage();
  stubFetch({ extract: 'A skyscraper.', title: 'Empire State Building' });

  const v = await ask('w:en:Empire State Building');
  assert.equal(v.url, 'https://en.wikipedia.org/wiki/Empire_State_Building');
});

test('a non-English article keeps its own language host', async () => {
  _reset();
  stubStorage();
  stubFetch({ extract: 'Un gratte-ciel.', title: 'Tour Eiffel' });

  const v = await ask('w:fr:Tour Eiffel');
  assert.equal(v.url, 'https://fr.wikipedia.org/wiki/Tour_Eiffel');
});

/* ------------------------------ the link rows ----------------------------- */

test('the card offers the article, and the click lands on it', () => {
  const p = new Panel();
  p.select(building());
  p.wiki = {
    state: 'ok', text: 'A 102-storey Art Deco skyscraper.',
    title: 'Empire State Building',
    url: 'https://en.wikipedia.org/wiki/Empire_State_Building',
  };
  const screen = drawn(p);

  const at = lineOf(screen, 'Read on Wikipedia');
  assert.ok(at, 'no link row was drawn');

  // Every cell of the visible text must resolve, and nothing beyond it.
  const row = at.row;
  for (let c = at.col; c < at.col + 'Read on Wikipedia'.length; c++) {
    assert.equal(p.linkAt(screen, c, row), p.wiki.url, `column ${c} is not a link`);
  }
  assert.equal(p.linkAt(screen, at.col - 3, row), null, 'the region leaks left');
  assert.equal(p.linkAt(screen, at.col + 40, row), null, 'the region leaks right');
  // One row up is summary text; the row below is the OSM attribution, which
  // is deliberately a link of its own.
  assert.equal(p.linkAt(screen, at.col, row - 1), null, 'the region leaks up');
});

test('the hit region survives the switch to block mode', () => {
  for (const mode of [MODE.GLYPH, MODE.BLOCK]) {
    const p = new Panel();
    p.select(building());
    p.wiki = { state: 'ok', text: 'A skyscraper.', url: 'https://en.wikipedia.org/wiki/X' };
    const screen = drawn(p, mode);

    const at = lineOf(screen, 'Read on Wikipedia');
    assert.ok(at, `no link row in mode ${mode}`);
    assert.equal(p.linkAt(screen, at.col + 1, at.row), p.wiki.url,
      `link not clickable in mode ${mode}`);

    // And it must sit inside the box that clicks are tested against first.
    const box = p.rect(screen);
    assert.ok(at.row >= box.y && at.row < box.y + box.h,
      `link row ${at.row} is outside the panel rect in mode ${mode}`);
  }
});

test('the website and the OSM attribution are links too', () => {
  const p = new Panel();
  p.select(building());
  const screen = drawn(p);

  const web = lineOf(screen, 'esbnyc.com');
  assert.ok(web, 'no website row');
  assert.equal(p.linkAt(screen, web.col, web.row), 'https://www.esbnyc.com/');

  const osm = lineOf(screen, 'way/34633854');
  assert.ok(osm, 'no attribution row');
  assert.equal(p.linkAt(screen, osm.col, osm.row),
    'https://www.openstreetmap.org/way/34633854');
});

test('no link row before the summary arrives, or when there is none', () => {
  for (const wiki of [null, { state: 'pending', text: '' }, { state: 'none', text: '' },
    { state: 'ok', text: 'No article link.', url: undefined }]) {
    const p = new Panel();
    p.select(building());
    p.wiki = wiki;
    const screen = drawn(p);
    assert.equal(lineOf(screen, 'Read on Wikipedia'), null,
      `a link row appeared for ${JSON.stringify(wiki)}`);
  }
});

test('a cramped window trims the summary, never the link', () => {
  const p = new Panel();
  p.select(building());
  p.wiki = {
    state: 'ok',
    text: ('An extremely long summary that will not fit. ').repeat(12),
    url: 'https://en.wikipedia.org/wiki/Empire_State_Building',
  };
  const screen = makeScreen(90, 16, MODE.GLYPH);
  screen.clear();
  p.draw(screen, CAM, { label: 'Manhattan' });

  const at = lineOf(screen, 'Read on Wikipedia');
  assert.ok(at, 'the link was cut instead of the summary it links to');
  assert.equal(p.linkAt(screen, at.col, at.row), p.wiki.url);
});

test('the ground card still works, and offers no stale links', () => {
  const p = new Panel();
  p.select({ kind: 'ground', x: 26, y: 40, d: 20, type: T.FIELD, street: null, poi: null });
  const screen = drawn(p);
  const box = p.rect(screen);
  assert.ok(box, 'no panel drawn');
  assert.equal(p.linkAt(screen, box.x + 3, box.y + 3), null);
});
