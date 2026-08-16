import {
  FONT_PX, FONT_STACK, LINE_RATIO, FOV, HORIZON_FRAC,
} from './config.js';

/** Quantised rgb() string cache. 5 bits per channel is plenty for text. */
const colCache = new Map();

export function col2str(r, g, b) {
  r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  let s = colCache.get(key);
  if (s === undefined) {
    s = `rgb(${(r >> 3) << 3},${(g >> 3) << 3},${(b >> 3) << 3})`;
    colCache.set(key, s);
  }
  return s;
}

/**
 * The character grid and its canvas backing.
 *
 * Holds three parallel buffers: glyphs, colours, and a per-cell depth buffer.
 * The depth buffer replaces the original's per-column `wallDist` heuristic and
 * lets sprites composite correctly against roofs seen from above.
 */
export class Screen {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const ctx = this.ctx;
    ctx.textBaseline = 'top';
    ctx.font = `${FONT_PX}px ${FONT_STACK}`;
    // Measure rather than assume: monospace metrics differ across platforms.
    this.cw = ctx.measureText('MMMMMMMMMM').width / 10 || 8;
    this.ch = Math.round(FONT_PX * LINE_RATIO);

    this.cols = Math.max(24, Math.floor(w / this.cw));
    this.rows = Math.max(12, Math.floor(h / this.ch));
    this.horizon = Math.floor(this.rows * HORIZON_FRAC);

    this.proj = (this.cols / 2) / Math.tan(FOV / 2);
    // Vertical units are rows, not columns, so the projection scale differs.
    this.vscale = this.proj * this.cw / this.ch;

    const n = this.cols * this.rows;
    this.glyph = new Array(n);
    this.colour = new Array(n);
    this.depth = new Float32Array(n);
    this.skyEnd = new Int32Array(this.cols);
  }

  clear() {
    this.glyph.fill(undefined);
    this.depth.fill(1e9);
  }

  set(x, y, ch, colour) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = y * this.cols + x;
    this.glyph[i] = ch;
    this.colour[i] = colour;
  }

  /** Set a cell and record its depth, for later sprite compositing. */
  setDepth(x, y, ch, colour, d) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = y * this.cols + x;
    this.glyph[i] = ch;
    this.colour[i] = colour;
    this.depth[i] = d;
  }

  fillRow(y, ch, colour, d) {
    if (y < 0 || y >= this.rows) return;
    const base = y * this.cols;
    for (let x = 0; x < this.cols; x++) {
      this.glyph[base + x] = ch;
      this.colour[base + x] = colour;
      this.depth[base + x] = d;
    }
  }

  /** Centre a line of text on a given row. Used for load and error states. */
  centreText(y, text, colour) {
    const x0 = Math.floor((this.cols - text.length) / 2);
    for (let i = 0; i < text.length; i++) this.set(x0 + i, y, text[i], colour);
  }

  /**
   * Blit the grid to canvas, batching runs of same-coloured glyphs into single
   * fillText calls. A full screen costs a few hundred draws, not tens of
   * thousands.
   */
  blit() {
    const { ctx, cols, rows, cw, ch, glyph, colour } = this;
    ctx.font = `${FONT_PX}px ${FONT_STACK}`;

    for (let y = 0; y < rows; y++) {
      const base = y * cols;
      let run = '';
      let runCol = null;
      let runStart = 0;

      for (let x = 0; x < cols; x++) {
        const g = glyph[base + x];
        if (g === undefined || g === ' ') {
          if (run) {
            ctx.fillStyle = runCol;
            ctx.fillText(run, runStart * cw, y * ch);
            run = '';
          }
          continue;
        }
        const c = colour[base + x];
        if (run && c !== runCol) {
          ctx.fillStyle = runCol;
          ctx.fillText(run, runStart * cw, y * ch);
          run = '';
        }
        if (!run) { runStart = x; runCol = c; }
        run += g;
      }
      if (run) {
        ctx.fillStyle = runCol;
        ctx.fillText(run, runStart * cw, y * ch);
      }
    }
  }
}
