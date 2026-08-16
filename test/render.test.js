/**
 * Rendering checks against a synthetic world with known geometry.
 *
 * The engine draws characters, so its output can be asserted on directly. These
 * cover the drone camera's failure modes: missing roofs, gaps between a roof
 * and the geometry behind it, and the black band that a naive draw-distance
 * clip leaves below the horizon at altitude.
 *
 *     node --test test/render.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera } from '../src/camera.js';
import { ChunkedWorld, T } from '../src/world/source.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { FOV, HORIZON_FRAC } from '../src/config.js';

/* --------------------------- synthetic fixtures --------------------------- */

/** Flat ground with one solid rectangular block of a known height. */
class BlockWorld extends ChunkedWorld {
  constructor({ height = 10, x0 = 20, x1 = 30, y0 = 100, y1 = 140 } = {}) {
    super({ size: 0 });
    this.box = { height, x0, x1, y0, y1 };
    this.maxHeight = height;
    this.hasStreets = false;
  }

  fillChunk(ox, oy, base) {
    const { height, x0, x1, y0, y1 } = this.box;
    for (let ly = 0; ly < 32; ly++) {
      for (let lx = 0; lx < 32; lx++) {
        const x = ox + lx;
        const y = oy + ly;
        const s = base + (ly << 5) + lx;
        const solid = x >= x0 && x < x1 && y >= y0 && y < y1;
        this.h[s] = solid ? height : 0;
        this.type[s] = solid ? T.TOWER : T.FIELD;
        this.rnd[s] = 0.5;
        this.lamp[s] = 0;
        this.pal[s] = 0;
        this.flags[s] = 0;
      }
    }
  }
}

/** Minimal Screen stand-in: same buffers and contract, no canvas. */
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

function renderAt(world, { z, pitch, cols = 90, rows = 40, x = 25.5, y = 5.5 }) {
  const screen = makeScreen(cols, rows);
  const cam = new Camera();
  cam.x = x;
  cam.y = y;
  cam.z = z;
  cam.angle = Math.PI / 2;      // looking along +y
  cam.pitch = pitch;
  cam.hz = screen.horizon - pitch;
  cam.buildRays(screen);

  const light = new Lighting();
  light.update(40);             // daylight

  renderScene(screen, cam, world, light, 0);
  return { screen, cam };
}

const columnGlyphs = (screen, col) => {
  const out = [];
  for (let y = 0; y < screen.rows; y++) out.push(screen.glyph[y * screen.cols + col]);
  return out;
};

/* --------------------------------- tests --------------------------------- */

test('below the rooftops, a building blocks everything behind it', () => {
  const world = new BlockWorld({ height: 10 });
  const { screen } = renderAt(world, { z: 2, pitch: 0 });
  const col = Math.floor(screen.cols / 2);
  const glyphs = columnGlyphs(screen, col);
  const drawn = glyphs.filter((g) => g !== undefined).length;
  assert.ok(drawn > 0, 'nothing was drawn at street level');
  // Above the horizon there should be a wall, not sky, in the centre column.
  assert.notEqual(screen.skyEnd[col], screen.horizon,
    'the building should cut into the sky');
});

test('above the rooftops, roofs are drawn', () => {
  // A wide block seen from well above, so the roof occupies enough rows for
  // its outline to be sampled at all.
  const world = new BlockWorld({ height: 10, x0: 0, x1: 60, y0: 100, y1: 160 });
  const high = renderAt(world, { z: 40, pitch: 15 });
  const low = renderAt(world, { z: 2, pitch: 0 });

  const col = Math.floor(high.screen.cols / 2);
  assert.ok(columnGlyphs(high.screen, col).some((g) => g !== undefined),
    'the drone view drew nothing');
  assert.ok(columnGlyphs(low.screen, col).some((g) => g !== undefined));

  // The parapet glyph only comes from the roof material, so its presence is
  // direct evidence that the roof pass ran rather than facades alone.
  const all = high.screen.glyph.filter((g) => g !== undefined).join('');
  assert.ok(all.includes('='), 'no roof parapet anywhere in the drone view');
});

test('no gaps open between a rooftop and the geometry behind it', () => {
  // The failure this guards against is a renderer that draws facades only: a
  // hairline slit of distant ground appears along the near edge of every roof.
  // Every column must be a single contiguous run of drawn cells from its first
  // drawn row to the bottom of the screen.
  const world = new BlockWorld({ height: 10 });
  for (const [z, pitch] of [[30, 14], [60, 16], [120, 18]]) {
    const { screen } = renderAt(world, { z, pitch });
    for (let col = 0; col < screen.cols; col++) {
      const glyphs = columnGlyphs(screen, col);
      const first = glyphs.findIndex((g) => g !== undefined);
      if (first === -1) continue;
      for (let y = first; y < screen.rows; y++) {
        assert.notEqual(glyphs[y], undefined,
          `gap at column ${col} row ${y} (z=${z}, pitch=${pitch})`);
      }
    }
  }
});

test('no black band below the horizon at altitude', () => {
  // A plain draw-distance clip on the floor cast leaves tens of undrawn rows
  // below the horizon once the camera is high. The fog cutoff must fill them.
  const world = new BlockWorld({ height: 10 });
  const { screen, cam } = renderAt(world, { z: 300, pitch: 6 });
  const firstBelow = Math.max(0, Math.ceil(cam.hz));
  let undrawn = 0;
  for (let y = firstBelow; y < screen.rows; y++) {
    for (let col = 0; col < screen.cols; col++) {
      if (screen.glyph[y * screen.cols + col] === undefined) undrawn++;
    }
  }
  assert.equal(undrawn, 0, `${undrawn} undrawn cells below the horizon at z=300`);
});

test('the depth buffer is finite everywhere something was drawn', () => {
  const world = new BlockWorld({ height: 10 });
  for (const [z, pitch] of [[2, 0], [30, 14], [300, 6]]) {
    const { screen } = renderAt(world, { z, pitch });
    for (let i = 0; i < screen.glyph.length; i++) {
      if (screen.glyph[i] === undefined) continue;
      assert.ok(Number.isFinite(screen.depth[i]),
        `non-finite depth at index ${i} (z=${z})`);
      assert.ok(screen.depth[i] > 0, `non-positive depth at index ${i} (z=${z})`);
    }
  }
});

test('parapets mark the building outline, not every cell', () => {
  // Testing the cell edge alone outlines all 400 cells of the block and the
  // roof reads as graph paper. Only the perimeter should carry a parapet.
  const world = new BlockWorld({ height: 10, x0: 0, x1: 60, y0: 100, y1: 160 });
  const { screen } = renderAt(world, { z: 40, pitch: 15, cols: 90, rows: 40 });

  let parapet = 0;
  let roofInterior = 0;
  for (let i = 0; i < screen.glyph.length; i++) {
    const g = screen.glyph[i];
    if (g === '=') parapet++;
    else if (g === '.' || g === ':' || g === '+' || g === '#') roofInterior++;
  }
  assert.ok(roofInterior > 0, 'no roof interior drawn');
  assert.ok(parapet / (parapet + roofInterior) < 0.35,
    `parapets are ${(parapet / (parapet + roofInterior) * 100).toFixed(0)}% of ` +
    'the roof surface; the outline test is matching cell edges, not the building');
});

test('the altitude early-out does not clip visible geometry', () => {
  // dCut must never remove something that would have been drawn. Compare a
  // render against one with the cutoff effectively disabled by overstating the
  // world's maximum height.
  const world = new BlockWorld({ height: 10 });
  const honest = renderAt(world, { z: 80, pitch: 16 });

  world.maxHeight = 1e6;        // forces dCut to Infinity
  const uncut = renderAt(world, { z: 80, pitch: 16 });

  let diffs = 0;
  for (let i = 0; i < honest.screen.glyph.length; i++) {
    if (honest.screen.glyph[i] !== uncut.screen.glyph[i]) diffs++;
  }
  assert.equal(diffs, 0, `${diffs} cells differ with the early-out enabled`);
});
