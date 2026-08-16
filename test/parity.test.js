/**
 * Parity between the refactored ProceduralWorld and the original engine.
 *
 * `cellInfo` below is copied verbatim from legacy/ascii-city.html. The module
 * refactor restructured that function into chunked typed arrays with an integer
 * type enum, which is exactly the kind of change that can silently alter the
 * world. This pins it: every terrain ring, every derived field.
 *
 * If the procedural generator is ever deliberately changed, this test should be
 * updated in the same commit, not deleted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ProceduralWorld } from '../src/world/procedural.js';
import { T } from '../src/world/source.js';

/* ---- original implementation, unmodified ---- */

const WORLD = 2048, BLOCK = 14, SEED = 1337;

function hash(x, y) {
  var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ SEED;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function wrap(v, m) { return ((v % m) + m) % m; }

function cellInfo(cx, cy) {
  var ax = wrap(Math.floor(cx), WORLD), ay = wrap(Math.floor(cy), WORLD);
  var mx = ax % BLOCK, my = ay % BLOCK;
  var bx = (ax / BLOCK) | 0, by = (ay / BLOCK) | 0;
  var ddx = ax - 1024, ddy = ay - 1024;
  var dist = Math.sqrt(ddx * ddx + ddy * ddy);
  var rb = hash(bx, by), rb2 = hash(bx + 911, by + 733), rc = hash(ax, ay);
  var type, h = 0, stripe = false, pal = (hash(bx + 5, by + 9) * 4) | 0;
  var pdx = ax - 1036, pdy = ay - 1031;
  var pondD = Math.sqrt(pdx * pdx + pdy * pdy);

  if (dist < 54) {
    if (pondD < 9.5) type = 'water';
    else if (Math.abs(ax - 1024) < 1.5 || Math.abs(ay - 1024) < 1.5 ||
             (dist > 28.5 && dist < 30.5)) type = 'plaza';
    else if (rc < 0.018 && Math.abs(ax - 1024) > 7 && Math.abs(ay - 1024) > 7)
         { type = 'tree'; h = 3.4 + rc * 90; }
    else type = 'field';
  } else if (mx < 3 || my < 3) {
    type = dist < 780 ? 'road' : 'path';
    if (mx === 1 && my >= 3 && (ay % 4) < 2) stripe = true;
    if (my === 1 && mx >= 3 && (ax % 4) < 2) stripe = true;
  } else if (mx === 3 || mx === 13 || my === 3 || my === 13) {
    type = 'sidewalk';
    if (dist < 560 && rc < 0.05) { type = 'tree'; h = 3.2 + rc * 20; }
  } else if (dist < 265) {
    if (rb < 0.07) type = 'plaza';
    else {
      type = 'tower';
      var lf = Math.max(0, 1 - dist / 320);
      h = rb < 0.46 ? 4 + rb2 * 6 : 10 + rb2 * 10 + lf * rc * 21;
    }
  } else if (dist < 480) {
    if (rb < 0.74) { type = 'house'; h = 2.4 + rb2 * 2.2; }
    else type = 'yard';
  } else if (dist < 790) {
    if (rb < 0.35) type = 'field';
    else { type = 'farm'; h = rc < 0.5 ? 1.1 : 0; }
  } else {
    if (rb < 0.55) {
      if (rc < 0.55) { type = 'forest'; h = 3 + rc * 5; } else type = 'field';
    } else type = 'water';
  }

  var lamp = 0;
  if (type === 'road' || type === 'sidewalk' || type === 'plaza' || type === 'path') {
    var kx = Math.min(Math.abs(ax - (bx * BLOCK - 1)), Math.abs(ax - (bx * BLOCK + 3)),
                      Math.abs(ax - (bx * BLOCK + 13)), Math.abs(ax - (bx * BLOCK + BLOCK + 3)));
    var ky = Math.min(Math.abs(ay - (by * BLOCK - 1)), Math.abs(ay - (by * BLOCK + 3)),
                      Math.abs(ay - (by * BLOCK + 13)), Math.abs(ay - (by * BLOCK + BLOCK + 3)));
    var sx2 = Math.abs(ax - Math.round(ax / 7) * 7), sy2 = Math.abs(ay - Math.round(ay / 7) * 7);
    var dA = kx * kx + sy2 * sy2, dB = ky * ky + sx2 * sx2;
    lamp = Math.exp(-Math.min(dA, dB) / 7.5);
  }
  return { t: type, h: h, r: rc, stripe: stripe, pal: pal, lamp: lamp };
}


/* ---- comparison ---- */

const NAME = {
  [T.ROAD]: 'road', [T.PATH]: 'path', [T.SIDEWALK]: 'sidewalk',
  [T.PLAZA]: 'plaza', [T.YARD]: 'yard', [T.FIELD]: 'field',
  [T.FARM]: 'farm', [T.WATER]: 'water', [T.TREE]: 'tree',
  [T.FOREST]: 'forest', [T.HOUSE]: 'house', [T.TOWER]: 'tower',
};

// Heights are stored in a Float32Array, so compare at float32 precision.
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

test('the refactored world matches the original cellInfo exactly', () => {
  const w = new ProceduralWorld();

  // A stride of 7 over the whole world is coprime with the 14-cell block
  // pitch, so it lands on roads, kerbs, sidewalks and interiors alike.
  const samples = [];
  for (let y = 0; y < WORLD; y += 7) {
    for (let x = 0; x < WORLD; x += 7) samples.push([x, y]);
  }
  // Plus the landmarks: park centre, pond, spawn, and each ring boundary.
  for (const p of [[1024, 1024], [1036, 1031], [1024, 976], [1024, 1078],
                   [1024, 1289], [1024, 1504], [1024, 1814]]) samples.push(p);

  const bad = { type: 0, h: 0, rnd: 0, lamp: 0, pal: 0, stripe: 0 };
  let first = null;

  for (const [x, y] of samples) {
    const ref = cellInfo(x, y);
    const s = w.sample(x, y);
    const fail = (k, got) => {
      bad[k]++;
      first ??= `${k} at ${x},${y}: got ${got}, want ${ref[k === 'rnd' ? 'r' : k]}`;
    };
    if (NAME[w.type[s]] !== ref.t) fail('type', NAME[w.type[s]]);
    if (!near(w.h[s], ref.h)) fail('h', w.h[s]);
    if (!near(w.rnd[s], ref.r)) fail('rnd', w.rnd[s]);
    if (!near(w.lamp[s], ref.lamp)) fail('lamp', w.lamp[s]);
    if (w.pal[s] !== ref.pal) fail('pal', w.pal[s]);
    if (!!(w.flags[s] & 1) !== ref.stripe) fail('stripe', !!(w.flags[s] & 1));
  }

  const total = Object.values(bad).reduce((a, b) => a + b, 0);
  assert.equal(total, 0,
    `${total} mismatches over ${samples.length} cells ` +
    `(${JSON.stringify(bad)}); first: ${first}`);
});
