/**
 * Place-name lookup. Hermetic: `fetch` is stubbed, so no test touches the
 * network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { lookup, _reset } from '../src/geocode.js';
import {
  parseLocation, bboxArea, boxAround, MAX_BBOX_DEG2, DEFAULT_SPAN_DEG,
} from '../src/world/overpass.js';

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

/** Nominatim's real response shape, including a city-sized bounding box. */
const KYOTO = [{
  lat: '35.0115754',
  lon: '135.7681441',
  display_name: 'Kyoto, Kyoto Prefecture, Japan',
  type: 'administrative',
  boundingbox: ['34.8749160', '35.3212207', '135.5590060', '135.8784420'],
}];

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts, calls.length);
  };
  return calls;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

const ask = (q) => new Promise((r) => lookup(q, r));

/* --------------------------------- tests --------------------------------- */

test('a place name resolves to a loadable box', async () => {
  _reset();
  stubStorage();
  const calls = stubFetch(() => ok(KYOTO));

  const r = await ask('Kyoto');
  assert.ok(r, 'no result');
  assert.equal(r.label, 'Kyoto');
  assert.equal(r.display, 'Kyoto, Kyoto Prefecture, Japan');
  assert.match(calls[0], /nominatim\.openstreetmap\.org/);
  assert.match(calls[0], /q=Kyoto/);

  const [s, w, n, e] = r.bbox;
  assert.ok(n > s && e > w, 'degenerate box');
  // Centred on the result.
  assert.ok(Math.abs((s + n) / 2 - 35.0115754) < 1e-6);
  assert.ok(Math.abs((w + e) / 2 - 135.7681441) < 1e-6);
});

test("the geocoder's own city-sized box is not used", () => {
  // Kyoto's bounding box is about 0.45 by 0.32 degrees, some 2500 times what
  // the engine will load. Using it verbatim would fail the area cap on every
  // city in the world.
  const theirs = [34.8749160, 135.5590060, 35.3212207, 135.8784420];
  assert.ok(bboxArea(theirs) > MAX_BBOX_DEG2 * 100,
    'fixture no longer demonstrates the problem');
});

test('the resolved box is inside the area cap the loader enforces', async () => {
  _reset();
  stubStorage();
  stubFetch(() => ok(KYOTO));
  const r = await ask('Kyoto');
  assert.ok(bboxArea(r.bbox) <= MAX_BBOX_DEG2,
    `resolved area ${bboxArea(r.bbox)} exceeds the cap ${MAX_BBOX_DEG2}`);
});

test('a resolved box is the same size as a typed coordinate pair', async () => {
  // Both paths must land you in a world of the same size, or "Kyoto" and
  // "35.01,135.77" would behave differently.
  _reset();
  stubStorage();
  stubFetch(() => ok(KYOTO));
  const r = await ask('Kyoto');
  const typed = parseLocation('35.0115754,135.7681441');
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(r.bbox[i] - typed[i]) < 1e-9,
      `edge ${i}: ${r.bbox[i]} vs ${typed[i]}`);
  }
});

test('the second lookup of a name is served from cache', async () => {
  _reset();
  stubStorage();
  const calls = stubFetch(() => ok(KYOTO));
  await ask('Kyoto');
  const n = calls.length;
  const again = await ask('  KYOTO  ');    // normalised: same query
  assert.equal(calls.length, n, 'a cached lookup hit the network');
  assert.equal(again.display, 'Kyoto, Kyoto Prefecture, Japan');
});

test('Photon takes over when Nominatim fails', async () => {
  _reset();
  stubStorage();
  const calls = stubFetch((url) => {
    if (url.includes('nominatim')) return { ok: false, status: 429, json: async () => ({}) };
    return ok({
      features: [{
        geometry: { type: 'Point', coordinates: [135.7681441, 35.0115754] },
        properties: { name: 'Kyoto', country: 'Japan', osm_value: 'city' },
      }],
    });
  });

  const r = await ask('Kyoto');
  assert.ok(r, 'fallback produced nothing');
  assert.equal(r.label, 'Kyoto');
  assert.match(r.display, /Kyoto/);
  assert.match(r.display, /Japan/);
  assert.equal(calls.length, 2, 'expected exactly one retry');
  assert.match(calls[1], /photon\.komoot\.io/);
});

test('an unknown place resolves to null rather than throwing', async () => {
  _reset();
  stubStorage();
  stubFetch(() => ok([]));
  assert.equal(await ask('zzzz nowhere zzzz'), null);
});

test('a network failure resolves to null rather than throwing', async () => {
  _reset();
  stubStorage();
  stubFetch(() => { throw new Error('offline'); });
  assert.equal(await ask('Kyoto'), null);
});

test('being offline short-circuits without a request', async () => {
  _reset();
  stubStorage();
  const calls = stubFetch(() => ok(KYOTO));
  // navigator is getter-only on globalThis in Node, so swap the descriptor.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: false }, configurable: true, writable: true,
  });
  try {
    assert.equal(await ask('Kyoto'), null);
    assert.equal(calls.length, 0, 'made a request while offline');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});

test('an empty query never reaches the network', async () => {
  _reset();
  stubStorage();
  const calls = stubFetch(() => ok(KYOTO));
  assert.equal(await ask('   '), null);
  assert.equal(calls.length, 0);
});

test('a garbled response does not produce a broken box', async () => {
  _reset();
  stubStorage();
  stubFetch((url) => (url.includes('nominatim')
    ? ok([{ lat: 'north', lon: 'west', display_name: 'Nowhere' }])
    : ok({ features: [] })));
  assert.equal(await ask('Kyoto'), null);
});

test('the identifying User-Agent is sent, as the usage policy asks', async () => {
  _reset();
  stubStorage();
  let headers = null;
  globalThis.fetch = async (url, opts) => { headers = opts.headers; return ok(KYOTO); };
  await ask('Kyoto');
  assert.ok(headers, 'no headers sent');
  assert.match(headers['User-Agent'], /ascii-city/);
});

/* ------------------------- the coordinate path ---------------------------- */

test('coordinates and map links still resolve with no network at all', () => {
  // parseLocation is what the HUD tries first, and it must stay synchronous.
  globalThis.fetch = () => { throw new Error('geocoder must not be called'); };
  assert.ok(parseLocation('40.7580,-73.9855'));
  assert.ok(parseLocation('40.74,-74.00,40.76,-73.98'));
  assert.ok(parseLocation('https://www.openstreetmap.org/#map=16/51.5074/-0.1278'));
  // And a place name is explicitly NOT its job.
  assert.equal(parseLocation('Kyoto'), null);
});

test('boxAround is the one place the span is defined', () => {
  const a = boxAround(40, -74);
  const b = boxAround(40, -74, DEFAULT_SPAN_DEG);
  assert.deepEqual(a, b);
  assert.ok(bboxArea(a) <= MAX_BBOX_DEG2);
  // Square on the ground, not in degrees.
  const kmNS = (a[2] - a[0]) * 110.54;
  const kmEW = (a[3] - a[1]) * 111.32 * Math.cos(40 * Math.PI / 180);
  assert.ok(Math.abs(kmNS - kmEW) < 0.05);
});
