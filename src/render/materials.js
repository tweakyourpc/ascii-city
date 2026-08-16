import { col2str } from '../screen.js';
import { T, F, hash } from '../world/source.js';
import { FOG_K, GLYPH_RAMP, LIT, FACADE } from '../config.js';

export { GLYPH_RAMP, LIT, FACADE };

export function fogOf(d) {
  return Math.exp(-d * FOG_K);
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Current lighting, recomputed once per frame from the sun's altitude and
 * shared by every material function.
 */
export class Lighting {
  constructor() {
    this.dayAmt = 1;     // 0 night .. 1 day
    this.amb = 1;        // ambient multiplier
    this.litProb = 0.4;  // chance a given window is lit
    this.haze = [0, 0, 0];
    this.skyTop = [0, 0, 0];
    this.skyBottom = [0, 0, 0];
  }

  update(sunAlt) {
    const k = Math.max(0, Math.min(1, (sunAlt + 6) / 12));
    const dusk = Math.max(0, 1 - Math.abs(sunAlt) / 9);

    this.dayAmt = k;
    this.amb = 0.2 + 0.8 * k;
    this.litProb = 0.58 - 0.38 * k;

    let top = mix([3, 4, 12], [24, 58, 122], k);
    let bot = mix([9, 11, 28], [132, 172, 212], k);
    top = mix(top, [34, 22, 62], dusk * 0.8);
    bot = mix(bot, [224, 112, 58], dusk * 0.85);

    this.skyTop = top;
    this.skyBottom = bot;
    this.haze = [bot[0] * 0.30, bot[1] * 0.30, bot[2] * 0.32];
    return k;
  }

  /** Blend a colour toward the haze by fog factor `f` (1 = near, 0 = far). */
  depth(r, g, b, f) {
    const h = this.haze;
    return col2str(r * f + h[0] * (1 - f),
                   g * f + h[1] * (1 - f),
                   b * f + h[2] * (1 - f));
  }

  hazeColour() {
    const h = this.haze;
    return col2str(h[0], h[1], h[2]);
  }
}

/* ------------------------------ ground ------------------------------ */

export function groundGlyph(world, s, wx, wy, t) {
  const r = hash(Math.floor(wx * 2), Math.floor(wy * 2), 0);
  switch (world.type[s]) {
    case T.ROAD:
      if (world.flags[s] & F.STRIPE) return '|';
      return r < 0.08 ? ':' : r < 0.3 ? ',' : '.';
    case T.PATH: return r < 0.2 ? ',' : '.';
    case T.SIDEWALK: return r < 0.5 ? ':' : ';';
    case T.PLAZA: return r < 0.25 ? '+' : '.';
    case T.YARD:
    case T.FIELD: return r < 0.45 ? '"' : ',';
    case T.FARM: return r < 0.5 ? '=' : '-';
    case T.WATER:
      return (Math.sin(wx * 0.7 + t * 1.4) + Math.cos(wy * 0.9 - t * 1.1)) > 0.2 ? '~' : '-';
    default: return '.';
  }
}

export function groundColour(world, s, f, L) {
  let r, g, b;
  const stripe = (world.flags[s] & F.STRIPE) !== 0;

  switch (world.type[s]) {
    case T.ROAD:
      if (stripe) { r = 190; g = 160; b = 60; }
      else { r = 62; g = 64; b = 74; }
      break;
    case T.PATH: r = 96; g = 84; b = 62; break;
    case T.SIDEWALK: r = 96; g = 98; b = 104; break;
    case T.PLAZA: r = 88; g = 84; b = 76; break;
    case T.YARD:
    case T.FIELD: r = 60; g = 118; b = 52; break;
    case T.FARM: r = 122; g = 108; b = 48; break;
    case T.WATER: r = 26; g = 74; b = 128; break;
    default: r = 70; g = 70; b = 70;
  }

  const a = stripe ? Math.max(0.35, L.amb) : L.amb;
  const lamp = world.lamp[s] * (1 - L.dayAmt) * 0.6;
  return L.depth(r * a + 255 * lamp, g * a + 176 * lamp, b * a + 96 * lamp, f);
}

/* ------------------------------- roofs -------------------------------
 * Roofs need their own table, or from above the city reads as pavement with
 * boxes on it. Three cues do the work: a bright parapet along the building's
 * outline, gravel and plant noise inside, and red beacons on the tall towers
 * at night.
 *
 * These take plain values rather than a world slot, because the caller has to
 * sample neighbouring cells to find the outline and that would invalidate the
 * slot (see the validity rule in world/source.js).
 */

/** Bits set by the caller when the neighbour on that side is lower. */
export const OPEN = { W: 1, E: 2, N: 4, S: 8 };

const PARAPET_W = 0.13;

/**
 * Distance to the nearest edge whose neighbour is lower, or 1 if this cell is
 * in the interior of a larger building. That distinction is the whole point:
 * testing the cell edge alone outlines every cell and roofs read as graph paper.
 */
function parapetDist(wx, wy, mx, my, open) {
  const u = wx - mx;
  const v = wy - my;
  let d = 1;
  if ((open & OPEN.W) && u < d) d = u;
  if ((open & OPEN.E) && 1 - u < d) d = 1 - u;
  if ((open & OPEN.N) && v < d) d = v;
  if ((open & OPEN.S) && 1 - v < d) d = 1 - v;
  return d;
}

export function roofGlyph(type, rnd, flags, open, wx, wy, mx, my, t) {
  if (type === T.TREE || type === T.FOREST) {
    const r = hash(mx * 31, my * 17, 0);
    return r < 0.3 ? '&' : r < 0.7 ? '%' : '*';
  }

  if (parapetDist(wx, wy, mx, my, open) < PARAPET_W) return '=';

  // Blink, so it reads as an aircraft warning light rather than a stain.
  if ((flags & F.BEACON) && Math.sin(t * 2.2 + rnd * 6.3) > 0.4) {
    const u = wx - mx;
    const v = wy - my;
    if (u > 0.38 && u < 0.62 && v > 0.38 && v < 0.62) return '*';
  }

  const r = hash(mx * 29 + ((wx * 3) | 0), my * 23 + ((wy * 3) | 0), 0);
  return r < 0.42 ? '.' : r < 0.72 ? ':' : r < 0.92 ? '+' : '#';
}

export function roofColour(type, rnd, palIdx, flags, open, wx, wy, mx, my, f, t, L) {
  if (type === T.TREE || type === T.FOREST) {
    const r = hash(mx * 31, my * 17, 0);
    return L.depth((40 + r * 30) * L.amb, (110 + r * 70) * L.amb,
                   (44 + r * 30) * L.amb, f);
  }

  if ((flags & F.BEACON) && Math.sin(t * 2.2 + rnd * 6.3) > 0.4) {
    const u = wx - mx;
    const v = wy - my;
    if (u > 0.38 && u < 0.62 && v > 0.38 && v < 0.62) return col2str(255, 60, 48);
  }

  const pal = FACADE[palIdx];
  // Roofs face the sky, so they take flat light with no side dimming.
  const a = L.amb * 1.15;
  const lift = parapetDist(wx, wy, mx, my, open) < PARAPET_W ? 1.9 : 1.0;
  return L.depth((pal[0] + 22 * rnd) * a * lift,
                 (pal[1] + 22 * rnd) * a * lift,
                 (pal[2] + 26 * rnd) * a * lift, f);
}
