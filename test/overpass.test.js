/**
 * Endpoint health and fallback.
 *
 * The bug this file exists for: two of the public mirrors were chronically
 * saturated and returned 504 after half a minute, while the client reshuffled
 * the endpoint list afresh for each of its three layers. Every load therefore
 * re-tried mirrors that had just failed it, and when the one healthy instance
 * hiccuped, the whole city failed to load.
 *
 * Hermetic: `fetch` and `localStorage` are stubbed and `sleep` is replaced, so
 * no test touches the network or waits on a real clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchOsm, buildQuery, _orderEndpoints, _resetHealth, _setSleep,
} from '../src/world/overpass.js';

/* -------------------------------- helpers -------------------------------- */

const BBOX = [40.7466, -73.9900, 40.7576, -73.9750];
const OTHER = [51.5100, -0.0920, 51.5210, -0.0760];

const GOOD = 'overpass-api.de';

function stubStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
  return m;
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts, calls.length);
  };
  return calls;
}

const headers = (h = {}) => ({ get: (k) => h[k.toLowerCase()] ?? null });

const ok = (elements) => ({
  ok: true, status: 200, headers: headers(), json: async () => ({ elements }),
});
const fail = (status, h) => ({ ok: false, status, headers: headers(h) });

/** One building and one road, enough for any layer to count as data. */
const ELEMENTS = [
  { type: 'way', id: 1, tags: { building: 'yes' }, geometry: [{ lat: 40.75, lon: -73.98 }] },
];

const hosts = (calls) => calls.map((u) => new URL(u).host);
const sleeps = () => {
  let n = 0;
  _setSleep(async () => { n++; });
  return () => n;
};

function setup() {
  _resetHealth();
  stubStorage();
  _resetHealth();      // again, now that storage exists, to clear the sticky pick
  return sleeps();
}

/* ------------------------- learning which one works ---------------------- */

test('the healthy mirror is reused for every layer of one load', async () => {
  setup();
  const calls = stubFetch((url) =>
    (url.includes(GOOD) ? ok(ELEMENTS) : fail(504)));

  const els = await fetchOsm(BBOX);
  assert.ok(els.length, 'no elements returned');

  // Three layers. The first may cost a dud attempt or two, but once one
  // instance has answered, nothing else is ever asked again.
  const good = hosts(calls).filter((h) => h === GOOD);
  assert.equal(good.length, 3, `expected 3 successful calls, got ${hosts(calls)}`);
  const firstGood = hosts(calls).indexOf(GOOD);
  assert.deepEqual(hosts(calls).slice(firstGood), [GOOD, GOOD, GOOD],
    'a mirror that already failed was asked again');
});

test('a mirror that failed is not tried again on the next load', async () => {
  setup();
  const calls = stubFetch((url) =>
    (url.includes(GOOD) ? ok(ELEMENTS) : fail(504)));

  await fetchOsm(BBOX);
  calls.length = 0;
  await fetchOsm(OTHER);

  assert.deepEqual(hosts(calls), [GOOD, GOOD, GOOD],
    'the second load paid for the same dead mirrors again');
});

test('every endpoint stays in the list even when all are cooling', async () => {
  setup();
  const all = _orderEndpoints().length;
  stubFetch(() => fail(504));
  await assert.rejects(() => fetchOsm(BBOX));

  assert.equal(_orderEndpoints().length, all,
    'cooling must reorder endpoints, never drop them');
});

/* --------------------------- per-status handling -------------------------- */

test('a 429 is retried once on the same instance', async () => {
  const slept = setup();
  let first = true;
  const calls = stubFetch((url) => {
    if (!url.includes(GOOD)) return fail(504);
    if (first) { first = false; return fail(429, { 'retry-after': '1' }); }
    return ok(ELEMENTS);
  });

  await fetchOsm(BBOX);
  assert.equal(slept(), 1, 'Retry-After was not honoured');
  assert.equal(hosts(calls).filter((h) => h === GOOD).length, 4,
    'expected one retry plus three successful layers');
});

test('a second 429 abandons the instance rather than hammering it', async () => {
  setup();
  const n = _orderEndpoints().length;
  const calls = stubFetch(() => fail(429));

  await assert.rejects(() => fetchOsm(BBOX));
  assert.equal(calls.length, n * 2,
    'each rate-limited instance should be asked exactly twice, no more');
  for (const h of new Set(hosts(calls))) {
    assert.equal(hosts(calls).filter((x) => x === h).length, 2, `${h} asked wrong number of times`);
  }
});

test('a rejected query is not resent to every other mirror', async () => {
  setup();
  const calls = stubFetch(() => fail(400));

  await assert.rejects(() => fetchOsm(BBOX), /rejected the query/);
  assert.equal(calls.length, 1, 'our own bad query was sent to other servers');
});

test('an empty 200 falls through, and that mirror is skipped next time', async () => {
  setup();
  const calls = stubFetch((url) =>
    (url.includes(GOOD) ? ok(ELEMENTS) : ok([])));

  const els = await fetchOsm(BBOX);
  assert.ok(els.length, 'an empty mirror was believed');

  calls.length = 0;
  await fetchOsm(OTHER);
  assert.deepEqual(hosts(calls), [GOOD, GOOD, GOOD],
    'a mirror with no coverage here was asked again');
});

/* ------------------------------ what it says ----------------------------- */

test('the all-busy message counts the mirrors instead of naming one', async () => {
  setup();
  stubFetch(() => fail(504));

  await assert.rejects(() => fetchOsm(BBOX), (err) => {
    assert.match(err.message, /All \d+ Overpass mirrors are busy/);
    assert.doesNotMatch(err.message, /That Overpass instance/);
    assert.ok(err.hint, 'no hint for the user to act on');
    assert.ok(err.causes.length > 1, 'only one cause was recorded');
    return true;
  });
});

/* ---------------------------- bounded worst case -------------------------- */

test('the expendable layers do not fall through the whole list', async () => {
  setup();
  const calls = stubFetch((url, opts) => {
    const body = String(opts.body);
    const core = body.includes('highway');
    if (!url.includes(GOOD)) return fail(504);
    return core ? ok(ELEMENTS) : fail(504);
  });

  const els = await fetchOsm(BBOX);
  assert.ok(els.length, 'core data was lost when the extras failed');

  // Core may probe around; water/parks and places get one attempt each.
  const after = hosts(calls).slice(hosts(calls).indexOf(GOOD));
  assert.equal(after.length, 3,
    `extras fanned out: ${after.join(', ')}`);
});

test('the server timeout never outlives the client budget', () => {
  const q = buildQuery(BBOX, 'core', 20);
  assert.match(q, /\[timeout:20\]/);
  // The default keeps existing callers, and test/osm.test.js, working.
  assert.match(buildQuery(BBOX, 'core'), /\[timeout:60\]/);
});

/* -------------------------------- aborting ------------------------------- */

test('an already-aborted load never reaches the network', async () => {
  setup();
  const calls = stubFetch(() => ok(ELEMENTS));
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(() => fetchOsm(BBOX, { signal: ac.signal }),
    (err) => err.name === 'AbortError');
  assert.equal(calls.length, 0, 'a cancelled load still queried Overpass');
});

test('aborting mid-load stops the remaining layers', async () => {
  setup();
  const ac = new AbortController();
  // Let the core layer through, then cancel before the extras run.
  const calls = stubFetch(() => { ac.abort(); return ok(ELEMENTS); });

  await assert.rejects(() => fetchOsm(BBOX, { signal: ac.signal }),
    (err) => err.name === 'AbortError');
  assert.equal(calls.length, 1, 'the expendable layers ran after cancellation');
});

test('a cache hit makes no request at all', async () => {
  setup();
  const calls = stubFetch(() => ok(ELEMENTS));
  await fetchOsm(BBOX);
  const before = calls.length;

  await fetchOsm(BBOX);
  assert.equal(calls.length, before, 'the cache was bypassed');
});
