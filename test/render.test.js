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
import { makeScreen } from './support/screen.js';

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

/**
 * Flat ground, one tree, and optionally an opaque slab behind or in front of
 * it. Vegetation is the only transparent material, so this is what exercises
 * the coverage bitmask.
 */
class TreeWorld extends ChunkedWorld {
  constructor({ treeH = 7, tx = 25, ty = 40,
                slabH = 0, slabY = 70, slabAhead = true } = {}) {
    super({ size: 0 });
    this.o = { treeH, tx, ty, slabH, slabY, slabAhead };
    this.maxHeight = Math.max(treeH, slabH);
    this.hasStreets = false;
    this.hasVegetation = true;
  }

  fillChunk(ox, oy, base) {
    const { treeH, tx, ty, slabH, slabY } = this.o;
    for (let ly = 0; ly < 32; ly++) {
      for (let lx = 0; lx < 32; lx++) {
        const x = ox + lx;
        const y = oy + ly;
        const s = base + (ly << 5) + lx;
        let h = 0;
        let t = T.FIELD;
        if (x === tx && y === ty) { h = treeH; t = T.TREE; }
        else if (slabH && y >= slabY && y < slabY + 2) { h = slabH; t = T.TOWER; }
        this.h[s] = h;
        this.type[s] = t;
        this.rnd[s] = 0.5;
        this.lamp[s] = 0;
        this.pal[s] = 0;
        this.flags[s] = 0;
      }
    }
  }
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


/* ------------------------- transparent vegetation ------------------------- */

/** Render looking north from just south of the tree. */
function treeView(world, over = {}) {
  return renderAt(world, {
    z: 2.5, pitch: -2, cols: 90, rows: 30, x: 25.5, y: 22, ...over,
  });
}

const LEAF = '@%&*+.';

test('a canopy has holes in it', () => {
  // A green brick has none. Between the first and last leaf row of a column
  // crossing the tree there must be at least one row the canopy did not fill.
  const world = new TreeWorld({ treeH: 8 });
  const { screen } = treeView(world);
  const { cols, rows, depth, glyph } = screen;

  let holes = 0;
  let leafCols = 0;
  for (let col = 0; col < cols; col++) {
    const leafRows = [];
    for (let y = 0; y < rows; y++) {
      const i = y * cols + col;
      if (depth[i] < 50 && glyph[i] && LEAF.includes(glyph[i])) leafRows.push(y);
    }
    if (leafRows.length < 3) continue;
    leafCols++;
    const span = leafRows[leafRows.length - 1] - leafRows[0] + 1;
    if (span > leafRows.length) holes++;
  }
  assert.ok(leafCols > 0, 'no canopy was drawn at all');
  assert.ok(holes > 0, 'the canopy is solid: every column is a filled run');
});

test('a building behind a tree is visible through the gaps', () => {
  // The headline feature. Without transparency the tree hides the slab
  // entirely in the columns it covers.
  const bare = new TreeWorld({ treeH: 8, slabH: 16, slabY: 70 });
  const { screen } = treeView(bare);
  const { cols, rows, depth, glyph } = screen;

  // Columns where the tree drew something.
  let through = 0;
  let treeCols = 0;
  for (let col = 0; col < cols; col++) {
    let hasLeaf = false;
    let hasFar = false;
    for (let y = 0; y < rows; y++) {
      const i = y * cols + col;
      if (!glyph[i]) continue;
      if (depth[i] < 40 && LEAF.includes(glyph[i])) hasLeaf = true;
      if (depth[i] > 40 && depth[i] < 1e8) hasFar = true;
    }
    if (hasLeaf) { treeCols++; if (hasFar) through++; }
  }
  assert.ok(treeCols > 0, 'the tree drew nothing');
  assert.ok(through > 0,
    'no distant geometry showed through the canopy in any column');
});

test('an opaque building still occludes completely', () => {
  // Guards the mark-iff-opaque rule: a slab in FRONT must hide the tree.
  const world = new TreeWorld({ treeH: 8, tx: 25, ty: 80, slabH: 20, slabY: 40 });
  const { screen } = treeView(world);
  const { cols, rows, depth, glyph } = screen;

  let behindSlab = 0;
  for (let col = 0; col < cols; col++) {
    for (let y = 0; y < rows; y++) {
      const i = y * cols + col;
      if (glyph[i] && depth[i] > 45 && depth[i] < 1e8) behindSlab++;
    }
  }
  assert.equal(behindSlab, 0,
    `${behindSlab} cells were drawn behind an opaque wall`);
});

test('the canopy is round, not square', () => {
  // Leaf-row count per column must rise and fall across the crown. A box
  // gives a flat profile.
  const world = new TreeWorld({ treeH: 9 });
  const { screen } = treeView(world, { cols: 200, rows: 44, z: 2.5, pitch: -3 });
  const { cols, rows, depth, glyph } = screen;

  const profile = [];
  for (let col = 0; col < cols; col++) {
    let n = 0;
    for (let y = 0; y < rows; y++) {
      const i = y * cols + col;
      if (depth[i] < 50 && glyph[i] && LEAF.includes(glyph[i])) n++;
    }
    profile.push(n);
  }
  const first = profile.findIndex((v) => v > 0);
  const last = profile.length - 1 - [...profile].reverse().findIndex((v) => v > 0);
  assert.ok(first >= 0 && last > first,
    'canopy is too narrow to have a profile; widen the fixture');

  const peak = Math.max(...profile);
  const edges = Math.max(profile[first], profile[last]);
  assert.ok(peak > edges,
    `profile ${profile.slice(first, last + 1)} does not bulge in the middle`);
});

test('vegetation does not shimmer with time', () => {
  const world = new TreeWorld({ treeH: 8 });
  const a = renderAt(world, { z: 2.5, pitch: -2, cols: 90, rows: 30, x: 25.5, y: 22 });
  const screenB = makeScreen(90, 30);
  const cam = new Camera();
  cam.x = 25.5; cam.y = 22; cam.z = 2.5; cam.pitch = -2; cam.angle = Math.PI / 2;
  cam.hz = screenB.horizon + 2;
  cam.buildRays(screenB);
  const light = new Lighting();
  light.update(40);
  renderScene(screenB, cam, world, light, 12345);   // a very different time

  let diff = 0;
  for (let i = 0; i < a.screen.glyph.length; i++) {
    if (a.screen.glyph[i] !== screenB.glyph[i]) diff++;
  }
  assert.equal(diff, 0, `${diff} cells changed with time alone`);
});

test('the leaf pattern is anchored in the world, not to the screen', () => {
  // Keyed on the ray instead of on the world, the gaps crawl like static as
  // the camera moves. Nudging half a cell must not reshuffle the whole crown.
  const world = new TreeWorld({ treeH: 8 });
  const a = treeView(world, { x: 25.5 });
  const b = treeView(world, { x: 25.5 + 0.02 });

  const count = (s) => s.screen.glyph.filter(
    (g, i) => g && LEAF.includes(g) && s.screen.depth[i] < 50).length;
  const na = count(a);
  const nb = count(b);
  assert.ok(na > 0 && nb > 0);
  assert.ok(Math.abs(na - nb) <= Math.max(3, na * 0.25),
    `leaf count jumped from ${na} to ${nb} for a 0.02 cell move`);
});

test('the early-out is still exact when the column has holes in it', () => {
  // The executable form of the termination proof. Disabling the cut by
  // overstating the world height must change nothing.
  const world = new TreeWorld({ treeH: 8, slabH: 16, slabY: 70 });
  const honest = treeView(world);
  world.maxHeight = 1e6;
  const uncut = treeView(world);

  let diff = 0;
  for (let i = 0; i < honest.screen.glyph.length; i++) {
    if (honest.screen.glyph[i] !== uncut.screen.glyph[i]) diff++;
  }
  assert.equal(diff, 0, `${diff} cells differ with the early-out enabled`);
});

test('a column with holes reports them so the sky can be filled behind', () => {
  const world = new TreeWorld({ treeH: 14 });
  const { screen } = treeView(world, { pitch: -6 });
  let flagged = 0;
  for (let col = 0; col < screen.cols; col++) if (screen.hasHoles[col]) flagged++;
  assert.ok(flagged > 0,
    'no column was flagged as having gaps; drawSky would paint over the canopy');
});

test('an all-opaque world never touches the coverage mask', () => {
  // The fast path is what keeps buildings costing exactly what they did.
  const world = new BlockWorld({ height: 10 });
  const { screen } = renderAt(world, { z: 30, pitch: 14 });
  let flagged = 0;
  for (let col = 0; col < screen.cols; col++) if (screen.hasHoles[col]) flagged++;
  assert.equal(flagged, 0, 'an opaque world promoted to the masked path');
});
