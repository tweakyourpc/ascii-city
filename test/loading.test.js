/**
 * The loading screen's banner.
 *
 * It used to be drawn by centring each row on its own length. The rows were
 * 33, 33, 34 and 35 columns wide, so every row sat at a slightly different
 * offset and the letterforms sheared apart. These tests pin both halves of the
 * fix: the rows are one width, and the block is placed once.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { drawLoading, drawError, BANNER } from '../src/render/loading.js';
import { makeScreen, MODE } from './support/screen.js';

const W = BANNER[0].length;

/** The grid as lines of text, with undefined cells read as blanks. */
function lines(screen) {
  const out = [];
  for (let y = 0; y < screen.rows; y++) {
    let l = '';
    for (let x = 0; x < screen.cols; x++) {
      const g = screen.glyph[y * screen.cols + x];
      l += g === undefined ? ' ' : g;
    }
    out.push(l);
  }
  return out;
}

function loaded(cols = 151, rows = 48, mode = MODE.GLYPH) {
  const screen = makeScreen(cols, rows, mode);
  screen.clear();
  drawLoading(screen, { title: 'LOADING MAP DATA', detail: 'Querying', t: 0.2 });
  return screen;
}

/* ------------------------------ the artwork ------------------------------ */

test('every banner row is the same width', () => {
  const widths = new Set(BANNER.map((l) => l.length));
  assert.equal(widths.size, 1,
    `rows differ in width (${[...widths].join(', ')}), which shears the letters`);
});

test('the banner still says what it should', () => {
  // Row three carries the underscores of every letter's baseline, so it is the
  // cheapest proof the glyphs did not get transcribed into nonsense.
  assert.match(BANNER[3], /^\/_\/ \\_\\___\/\\___\|___\|___\|/);
  assert.equal(BANNER.length, 4);
});

/* ----------------------------- the placement ----------------------------- */

test('all four rows are drawn at one offset, not centred individually', () => {
  const screen = loaded();
  const grid = lines(screen);
  const x0 = Math.floor((screen.cols - W) / 2);

  // Compare only the inked cells: the faint dot grid is painted underneath and
  // shows through wherever the banner has a blank.
  let checked = 0;
  for (let i = 0; i < BANNER.length; i++) {
    const row = grid[bannerRow(screen) + i];
    for (let c = 0; c < W; c++) {
      const want = BANNER[i][c];
      if (want === ' ') continue;
      assert.equal(row[x0 + c], want,
        `row ${i} column ${c} is misplaced: the block is not aligned`);
      checked++;
    }
  }
  assert.ok(checked > 80, `only ${checked} cells verified, the banner is missing`);
});

/** Where drawLoading puts the top of the banner. */
function bannerRow(screen) {
  return Math.floor(screen.outRows / 2) - 5;
}

test('the banner fits inside the screen at every width that shows it', () => {
  for (const cols of [W + 4, W + 5, 80, 100, 151, 200]) {
    const screen = loaded(cols, 48);
    const x0 = Math.floor((cols - W) / 2);
    assert.ok(x0 >= 0, `banner starts off-screen at ${cols} cols`);
    assert.ok(x0 + W <= cols, `banner overflows the right edge at ${cols} cols`);

    const grid = lines(screen);
    for (let i = 0; i < BANNER.length; i++) {
      assert.equal(grid[bannerRow(screen) + i].length, cols);
    }
  }
});

test('a narrow screen drops the banner rather than clipping it', () => {
  const screen = loaded(W, 30);
  const grid = lines(screen);
  for (let i = 0; i < BANNER.length; i++) {
    const row = grid[bannerRow(screen) + i] || '';
    // Only the dot grid may remain on those rows.
    assert.equal(row.replace(/[.\s]/g, ''), '',
      `the banner was drawn clipped at ${W} cols`);
  }
  // The words still have to be there, or the screen says nothing at all.
  assert.ok(grid.some((l) => l.includes('LOADING MAP DATA')));
});

/* ------------------------------ still works ------------------------------ */

test('both screens draw in both render modes without throwing', () => {
  for (const mode of [MODE.GLYPH, MODE.BLOCK]) {
    const a = loaded(151, 48, mode);
    assert.ok(lines(a).some((l) => l.includes('LOADING MAP DATA')), `mode ${mode}`);

    const b = makeScreen(151, 48, mode);
    b.clear();
    assert.doesNotThrow(() => drawError(b, {
      title: 'COULD NOT LOAD THAT AREA', detail: 'All 4 mirrors are busy.', hint: 'Press R.',
    }));
    assert.ok(lines(b).some((l) => l.includes('COULD NOT LOAD')), `error, mode ${mode}`);
  }
});
