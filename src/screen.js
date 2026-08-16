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
    this.scrims = [];
  }

  clear() {
    this.glyph.fill(undefined);
    this.depth.fill(1e9);
    this.scrims.length = 0;
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

  /**
   * Left-aligned text, clipped to the grid. Spaces are left transparent so a
   * label does not punch a hole in whatever it sits on.
   * @returns {number} glyphs actually written
   */
  text(x, y, str, colour) {
    if (y < 0 || y >= this.rows) return 0;
    const base = y * this.cols;
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const cx = x + i;
      if (cx < 0) continue;
      if (cx >= this.cols) break;
      if (str[i] === ' ') continue;
      this.glyph[base + cx] = str[i];
      this.colour[base + cx] = colour;
      n++;
    }
    return n;
  }

  /**
   * As text(), but writes only the cells the caller's depth `d` is in front of,
   * so world-anchored labels are occluded by geometry.
   */
  textDepth(x, y, str, colour, d) {
    if (y < 0 || y >= this.rows) return 0;
    const base = y * this.cols;
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const cx = x + i;
      if (cx < 0) continue;
      if (cx >= this.cols) break;
      if (str[i] === ' ') continue;
      if (d > this.depth[base + cx]) continue;
      this.glyph[base + cx] = str[i];
      this.colour[base + cx] = colour;
      n++;
    }
    return n;
  }

  /** Centre a line of text on a given row. Used for load and error states. */
  centreText(y, text, colour) {
    return this.text(Math.floor((this.cols - text.length) / 2), y, text, colour);
  }

  /**
   * Queue a translucent rectangle, in cell coordinates, painted at the start of
   * the next blit. The glyph grid has no per-cell background, and the sky is
   * painted straight to the canvas, so a panel backdrop has to go here.
   */
  scrim(x, y, w, h, style) {
    this.scrims.push([x, y, w, h, style]);
  }

  /**
   * Blit the grid to canvas, batching runs of same-coloured glyphs into single
   * fillText calls. A full screen costs a few hundred draws, not tens of
   * thousands.
   */
  blit() {
    const { ctx, cols, rows, cw, ch, glyph, colour } = this;

    // Backdrops first, under the glyphs.
    for (let i = 0; i < this.scrims.length; i++) {
      const [sx, sy, sw, sh, style] = this.scrims[i];
      ctx.fillStyle = style;
      ctx.fillRect(sx * cw, sy * ch, sw * cw, sh * ch);
    }
    this.scrims.length = 0;

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
