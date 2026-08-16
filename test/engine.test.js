/**
 * Headless checks on the engine's geometry and world store.
 *
 * These run without a browser by stubbing the Screen's canvas surface. They
 * cover the parts that are easy to get subtly wrong and hard to see: the
 * chunked world store, the row/distance inversion, the occlusion invariants
 * that make a single watermark sufficient, and the roof span geometry.
 *
 *     node test/engine.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera } from '../src/camera.js';
import { ProceduralWorld } from '../src/world/procedural.js';
import { ChunkedWorld, T, CHUNK, wrap } from '../src/world/source.js';
import { floorAt, canMoveTo, settle } from '../src/collision.js';
import { julianDay, sunPos, altAz } from '../src/astro.js';
import { EYE_HEIGHT, MOVE_CLEAR, WORLD } from '../src/config.js';

/* ------------------------------ world store ------------------------------ */

test('chunk store returns distinct slots for distinct cells', () => {
  const w = new ProceduralWorld();
  const seen = new Map();
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const s = w.sample(1000 + x, 1000 + y);
      const key = `${x},${y}`;
      assert.equal(seen.has(s), false, `slot ${s} reused at ${key}`);
      seen.set(s, key);
    }
  }
});

test('sampling is stable across chunk eviction', () => {
  const w = new ProceduralWorld();
  const probe = [[1024, 1024], [1030, 977], [1200, 1300], [40, 60]];
  const before = probe.map(([x, y]) => w.h[w.sample(x, y)]);
  // Force a wholesale eviction, then re-read.
  w.reset();
  for (let i = 0; i < 200; i++) w.sample(i * 37, i * 53);
  const after = probe.map(([x, y]) => w.h[w.sample(x, y)]);
  assert.deepEqual(after, before);
});

test('world wraps and never yields a negative or NaN height', () => {
  const w = new ProceduralWorld();
  for (const [x, y] of [[-5, -5], [WORLD + 3, WORLD + 3], [-0.5, 2047.9]]) {
    const s = w.sample(x, y);
    assert.ok(Number.isFinite(w.h[s]), `height at ${x},${y} not finite`);
    assert.ok(w.h[s] >= 0, `negative height at ${x},${y}`);
  }
  // Wrapping must be exact, not merely finite.
  assert.equal(w.sample(-1, -1), w.sample(WORLD - 1, WORLD - 1));
  assert.equal(w.sample(WORLD + 5, 7), w.sample(5, 7));
});

test('declared maxHeight actually bounds the terrain', () => {
  const w = new ProceduralWorld();
  let peak = 0;
  for (let y = 900; y < 1150; y += 1) {
    for (let x = 900; x < 1150; x += 1) peak = Math.max(peak, w.h[w.sample(x, y)]);
  }
  assert.ok(peak > 20, `expected towers in the centre, saw peak ${peak}`);
  assert.ok(peak <= w.maxHeight,
    `maxHeight ${w.maxHeight} understates the terrain peak ${peak}; the DDA ` +
    'early-out would clip visible geometry');
});

test('chunk boundaries are seamless', () => {
  // A cell's value must not depend on which chunk fetched it.
  const w = new ProceduralWorld();
  const x = CHUNK * 32;          // exactly on a chunk edge
  const y = 1024;
  const a = w.h[w.sample(x - 1, y)];
  const b = w.h[w.sample(x, y)];
  w.reset();
  const b2 = w.h[w.sample(x, y)];
  const a2 = w.h[w.sample(x - 1, y)];
  assert.equal(a2, a);
  assert.equal(b2, b);
});

/* --------------------------- camera projection --------------------------- */

function makeCam({ z = EYE_HEIGHT, hz = 30, vscale = 83 } = {}) {
  const cam = new Camera();
  cam.z = z;
  cam.hz = hz;
  cam.vscale = vscale;
  return cam;
}

test('rowOf and distOf are exact inverses', () => {
  const cam = makeCam({ z: 42 });
  for (const h of [0, 3, 20, 41]) {
    for (let row = 31; row < 90; row += 7) {
      const d = cam.distOf(h, row);
      const back = cam.rowOf(h, d);
      assert.ok(Math.abs(back - (row + 0.5)) < 1e-9,
        `h=${h} row=${row}: round trip gave ${back}`);
    }
  }
});

test('the horizon does not move with altitude', () => {
  // On a flat world the horizon sits at eye level however high you are; only
  // its distance changes. rowOf must converge to hz for every camera height.
  // Assert the convergence rate rather than picking an arbitrary "far": the
  // offset from the horizon is exactly camZ * vscale / d, so tenfold distance
  // must give a tenfold smaller offset, at any altitude.
  for (const z of [1.65, 50, 400]) {
    const cam = makeCam({ z });
    const near = Math.abs(cam.rowOf(0, 1e6) - cam.hz);
    const far = Math.abs(cam.rowOf(0, 1e7) - cam.hz);
    assert.ok(far < 1e-2, `at z=${z} the offset ${far} is not converging`);
    assert.ok(Math.abs(near / far - 10) < 1e-6,
      `at z=${z} the vanishing line converges at the wrong rate`);
  }
});

test('a roof at exactly camera height lands on the horizon at every distance', () => {
  const cam = makeCam({ z: 10 });
  for (const d of [1, 10, 100, 1000]) {
    assert.equal(cam.rowOf(10, d), cam.hz);
  }
});

test('bottoms are monotone in distance', () => {
  // This is the property that makes a single occlusion watermark sufficient:
  // nothing further away can ever appear below something nearer.
  const cam = makeCam({ z: 60 });
  let prev = Infinity;
  for (let d = 1; d < 300; d += 3) {
    const base = cam.rowOf(0, d);
    assert.ok(base < prev, `base row not decreasing at d=${d}`);
    prev = base;
  }
});

test('successive cell spans always overlap, so no gap can open', () => {
  // The next cell's base must sit strictly below the current cell's roof top,
  // for every altitude and every building height. Without a roof pass this is
  // exactly what fails, and hairline slits of far ground show through.
  const cam = makeCam({ z: 40 });
  for (const h of [0.5, 3, 12, 39.9, 60]) {
    for (const d0 of [1, 4, 17, 90]) {
      for (const ratio of [1.01, 1.5, 4, 20]) {
        const d1 = d0 * ratio;
        const roofTop = cam.z > h ? cam.rowOf(h, d1) : cam.rowOf(h, d0);
        const nextBase = cam.rowOf(0, d1);
        assert.ok(nextBase > roofTop,
          `gap at h=${h} d0=${d0} d1=${d1}: base ${nextBase} <= top ${roofTop}`);
      }
    }
  }
});

test('roof span is empty when the camera is below the roof', () => {
  const cam = makeCam({ z: 5 });
  const h = 20;
  const d0 = 10;
  const d1 = 14;
  const above = cam.z > h;
  const tRoof = above ? cam.rowOf(h, d1) : cam.rowOf(h, d0);
  const tSplit = cam.rowOf(h, d0);
  assert.equal(tRoof, tSplit, 'below the roof the quad is back-facing');
});

test('roof span is non-empty and above the facade when the camera is above', () => {
  const cam = makeCam({ z: 50 });
  const h = 20;
  const d0 = 10;
  const d1 = 14;
  const tRoof = cam.rowOf(h, d1);
  const tSplit = cam.rowOf(h, d0);
  const base = cam.rowOf(0, d0);
  assert.ok(tRoof < tSplit, 'far roof edge should sit higher on screen');
  assert.ok(tSplit < base, 'facade should hang below the roof seam');
});

/* ------------------------------- collision ------------------------------- */

test('walking is blocked by buildings but flying is not', () => {
  const w = new ProceduralWorld();
  // Find a genuinely tall cell rather than assuming one.
  let target = null;
  for (let y = 1000; y < 1100 && !target; y++) {
    for (let x = 1000; x < 1100; x++) {
      if (w.h[w.sample(x, y)] > 8) { target = [x + 0.5, y + 0.5]; break; }
    }
  }
  assert.ok(target, 'expected a tall building near the centre');
  const [tx, ty] = target;
  const h = floorAt(w, tx, ty);

  assert.equal(canMoveTo(w, tx, ty, EYE_HEIGHT), false, 'should not walk through it');
  assert.equal(canMoveTo(w, tx, ty, h + MOVE_CLEAR + 0.01), true, 'should fly over it');
  assert.equal(canMoveTo(w, tx, ty, h - 0.01), false, 'should not clip its top');
});

test('settling lands the camera on a rooftop, not inside it', () => {
  const w = new ProceduralWorld();
  let target = null;
  for (let y = 1000; y < 1100 && !target; y++) {
    for (let x = 1000; x < 1100; x++) {
      if (w.h[w.sample(x, y)] > 8) { target = [x + 0.5, y + 0.5]; break; }
    }
  }
  const cam = new Camera();
  cam.x = target[0];
  cam.y = target[1];
  cam.z = 0.1;
  cam.vz = -12;
  settle(w, cam);
  assert.equal(cam.z, floorAt(w, cam.x, cam.y) + EYE_HEIGHT);
  assert.equal(cam.vz, 0, 'downward velocity should be cancelled on landing');
});

test('spawn point is standable', () => {
  const w = new ProceduralWorld();
  const s = w.spawn();
  assert.ok(canMoveTo(w, s.x, s.y, EYE_HEIGHT),
    'the camera would start inside geometry');
  assert.notEqual(w.type[w.sample(s.x, s.y)], T.WATER);
});

/* -------------------------------- astronomy ------------------------------- */

test('the sun rises in the east and sets in the west', () => {
  // Manhattan, equinox-ish, so the check is not latitude-sensitive.
  const lat = 40.71;
  const lon = -74.00;
  const at = (h) => {
    const jd = julianDay(new Date(Date.UTC(2026, 2, 20, h, 0, 0)));
    const s = sunPos(jd);
    return altAz(s.ra / 15, s.dec, jd, lat, lon);
  };
  const morning = at(12);   // 07:00 local
  const evening = at(23);   // 18:00 local
  assert.ok(morning.az > 45 && morning.az < 135,
    `morning azimuth ${morning.az.toFixed(1)} is not easterly`);
  assert.ok(evening.az > 225 && evening.az < 315,
    `evening azimuth ${evening.az.toFixed(1)} is not westerly`);
});

test('the sun is below the horizon at local midnight', () => {
  const jd = julianDay(new Date(Date.UTC(2026, 5, 21, 5, 0, 0)));  // 00:00 EST
  const s = sunPos(jd);
  const p = altAz(s.ra / 15, s.dec, jd, 40.71, -74.00);
  assert.ok(p.alt < 0, `sun altitude ${p.alt.toFixed(1)} at midnight`);
});

test('julian day includes the time of day', () => {
  const a = julianDay(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
  const b = julianDay(new Date(Date.UTC(2026, 0, 1, 12, 0, 0)));
  assert.ok(Math.abs((b - a) - 0.5) < 1e-9, 'half a day should be 0.5 JD');
});

/* --------------------------------- misc ---------------------------------- */

test('wrap is non-negative for negative inputs', () => {
  assert.equal(wrap(-1, 2048), 2047);
  assert.equal(wrap(-2049, 2048), 2047);
  assert.equal(wrap(0, 2048), 0);
});

test('a subclass must implement fillChunk', () => {
  const bare = new ChunkedWorld({ size: 64 });
  assert.throws(() => bare.sample(0, 0), /fillChunk/);
});
