/**
 * Half-block rendering mode.
 *
 * The grid runs at double vertical resolution and the scene is painted as
 * solid colour instead of glyphs. Everything here drives the real `Screen`,
 * because the whole point of this file is to cover the class that the glyph
 * tests used to stub out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera } from '../src/camera.js';
import { ChunkedWorld, T } from '../src/world/source.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { Panel } from '../src/render/panel.js';
import { drawLoading } from '../src/render/loading.js';
import { makeScreen, MODE } from './support/screen.js';

/** Flat ground with one block, so there is a silhouette to look at. */
class BlockWorld extends ChunkedWorld {
  constructor({ height = 12 } = {}) {
    super({ size: 0 });
    this.height_ = height;
    this.maxHeight = height;
    this.hasStreets = false;
  }

  fillChunk(ox, oy, base) {
    for (let ly = 0; ly < 32; ly++) {
      for (let lx = 0; lx < 32; lx++) {
        const x = ox + lx;
        const y = oy + ly;
        const s = base + (ly << 5) + lx;
        const solid = x >= 20 && x < 34 && y >= 60 && y < 100;
        this.h[s] = solid ? this.height_ : 0;
        this.type[s] = solid ? T.TOWER : T.FIELD;
        this.rnd[s] = 0.5;
        this.lamp[s] = 0;
        this.pal[s] = 0;
        this.flags[s] = 0;
      }
    }
  }
}

function render(screen) {
  const cam = new Camera();
  cam.x = 26.5;
  cam.y = 20;
  cam.z = 3;
  cam.pitch = 0;
  cam.angle = Math.PI / 2;
  cam.hz = screen.horizon;
  cam.buildRays(screen);
  const L = new Lighting();
  L.update(40);
  screen.clear();
  renderScene(screen, cam, new BlockWorld(), L, 0);
  return cam;
}

/* ------------------------------ the grid ------------------------------- */

test('block mode runs the grid at double vertical resolution', () => {
  const glyph = makeScreen(80, 30, MODE.GLYPH);
  const block = makeScreen(80, 30, MODE.BLOCK);

  assert.equal(glyph.rowStep, 1);
  assert.equal(block.rowStep, 2);
  assert.equal(glyph.rows, glyph.outRows, 'glyph mode has one row per line');
  assert.equal(block.rows, block.outRows * 2, 'block mode has two rows per line');
  assert.ok(block.rows > glyph.rows,
    `block mode should have more internal rows (${block.rows} vs ${glyph.rows})`);
  // A text line is the same height in both, so text stays the same size.
  assert.equal(block.ch * block.rowStep, block.lineH);
  assert.equal(glyph.ch, glyph.lineH);
});

test('a text line is an even number of internal rows in block mode', () => {
  const block = makeScreen(80, 30, MODE.BLOCK);
  assert.equal(block.lineH % 2, 0, 'half blocks cannot split an odd line height');
  assert.equal(block.rows % 2, 0);
});

test('switching mode reallocates without losing the contract', () => {
  const screen = makeScreen(80, 30, MODE.GLYPH);
  const before = screen.rows;
  screen.setMode(MODE.BLOCK);
  assert.equal(screen.mode, MODE.BLOCK);
  assert.ok(screen.rows > before);
  assert.equal(screen.glyph.length, screen.cols * screen.rows);
  assert.equal(screen.kind.length, screen.cols * screen.rows);
  assert.equal(screen.depth.length, screen.cols * screen.rows);
  assert.equal(screen.holeMask.length, screen.cols * screen.covWords);

  screen.setMode(MODE.GLYPH);
  assert.equal(screen.rows, before, 'switching back should restore the shape');
});

/* ------------------------------ the blit -------------------------------- */

test('the scene is painted as rectangles, the text as text', () => {
  const screen = makeScreen(80, 30, MODE.BLOCK);
  render(screen);
  screen._calls.fillRect = 0;
  screen._calls.fillText = 0;
  screen.blit();
  assert.ok(screen._calls.fillRect > 0, 'no blocks were painted');
  assert.equal(screen._calls.fillText, 0, 'the scene should need no text at all');
});

test('glyph mode still paints the scene as text', () => {
  const screen = makeScreen(80, 30, MODE.GLYPH);
  render(screen);
  screen._calls.fillRect = 0;
  screen._calls.fillText = 0;
  screen.blit();
  assert.ok(screen._calls.fillText > 0, 'nothing was drawn');
  assert.equal(screen._calls.fillRect, 0, 'glyph mode should paint no blocks');
});

test('runs are batched: a flat row is not one rect per cell', () => {
  // Each half-row batches on its own colour. Requiring a matching colour PAIR
  // before continuing roughly squares the chance of a break, which collapses
  // runs to about one cell.
  const screen = makeScreen(80, 30, MODE.BLOCK);
  screen.clear();
  const c = 'rgb(8,8,8)';
  for (let y = 0; y < screen.rows; y++) {
    for (let x = 0; x < screen.cols; x++) screen.setDepth(x, y, ' ', c, 10);
  }
  screen._calls.fillRect = 0;
  screen.blit();
  // A uniform screen is one merged full-height rect per output line.
  assert.ok(screen._calls.fillRect <= screen.outRows,
    `${screen._calls.fillRect} rects for a uniform screen of ${screen.outRows} lines`);
});

test('the two halves merge into one rect where they agree', () => {
  const screen = makeScreen(40, 10, MODE.BLOCK);
  screen.clear();
  const c = 'rgb(16,16,16)';
  for (let x = 0; x < screen.cols; x++) {
    screen.setDepth(x, 0, ' ', c, 10);
    screen.setDepth(x, 1, ' ', c, 10);
  }
  screen._calls.fillRect = 0;
  screen._calls.rects.length = 0;
  screen.blit();
  assert.equal(screen._calls.fillRect, 1, 'a matching pair should be one rect');
  assert.equal(screen._calls.rects[0][3], screen.lineH, 'and it should be full height');
});

test('a text cell claims its whole line, so no half block shows through', () => {
  const screen = makeScreen(40, 10, MODE.BLOCK);
  screen.clear();
  const c = 'rgb(24,24,24)';
  for (let x = 0; x < screen.cols; x++) {
    screen.setDepth(x, 0, ' ', c, 10);
    screen.setDepth(x, 1, ' ', c, 10);
  }
  screen.text(5, 0, 'HI', 'rgb(255,255,255)');
  screen._calls.rects.length = 0;
  screen._calls.texts.length = 0;
  screen.blit();

  assert.ok(screen._calls.texts.some(([t]) => t.includes('HI')), 'text not drawn');
  // No rectangle may cover the columns the text occupies on that line.
  for (const [rx, ry, rw] of screen._calls.rects) {
    if (ry !== 0) continue;
    const c0 = rx / screen.cw;
    const c1 = c0 + rw / screen.cw;
    assert.ok(c1 <= 5 || c0 >= 7,
      `a block spans columns ${c0}..${c1}, overlapping the text at 5..6`);
  }
});

/* --------------------------- consumers still work ------------------------ */

test('the panel lays out and clears correctly in both modes', () => {
  for (const mode of [MODE.GLYPH, MODE.BLOCK]) {
    const screen = makeScreen(90, 30, mode);
    render(screen);
    const p = new Panel();
    p.select({
      kind: 'ground', x: 26, y: 40, d: 20, type: T.FIELD, street: null, poi: null,
    });
    p.draw(screen, { x: 26, y: 20 }, { label: 'Test' });

    const box = p.rect(screen);
    assert.ok(box, `no panel rect in mode ${mode}`);
    assert.ok(box.y >= 0 && box.y + box.h <= screen.rows,
      `panel box ${box.y}..${box.y + box.h} outside ${screen.rows} rows in mode ${mode}`);

    // Everything inside must be panel content or blank, never city texture.
    let leaked = 0;
    for (let r = box.y + 2; r < box.y + box.h - 2; r++) {
      for (let cx = box.x + 1; cx < box.x + box.w - 1; cx++) {
        if (screen.kind[r * screen.cols + cx] !== 2) leaked++;
      }
    }
    assert.equal(leaked, 0, `${leaked} non-text cells inside the panel in mode ${mode}`);
  }
});

test('the loading screen centres itself in both modes', () => {
  for (const mode of [MODE.GLYPH, MODE.BLOCK]) {
    const screen = makeScreen(90, 30, mode);
    assert.doesNotThrow(() => drawLoading(screen, {
      title: 'LOADING MAP DATA', detail: 'Querying', t: 0,
    }), `loading screen threw in mode ${mode}`);
    const drawn = screen.glyph.filter((g) => g !== undefined && g !== ' ').length;
    assert.ok(drawn > 20, `loading screen drew almost nothing in mode ${mode}`);
  }
});

test('picking still maps a click to an internal row in both modes', () => {
  // main.js divides the mouse position by screen.ch, which is the internal row
  // height. That is what lets the click path work unchanged in both modes.
  for (const mode of [MODE.GLYPH, MODE.BLOCK]) {
    const screen = makeScreen(90, 30, mode);
    const row = Math.floor((10 * screen.lineH + 2) / screen.ch);
    assert.ok(row >= 0 && row < screen.rows);
    // Ten text lines down should be ten lines down, whatever the mode.
    assert.equal(Math.floor(row / screen.rowStep), 10);
  }
});
