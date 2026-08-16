import { T, F, hash } from './source.js';
import { METERS_PER_CELL, STOREY_METERS, FLOOR_H } from '../config.js';

/**
 * An OpenStreetMap extract, rasterized into the engine's height field.
 *
 * Implements the WorldSource contract from source.js, but with flat arrays
 * rather than chunks: an OSM extract is bounded and fully known at load time,
 * so there is nothing to generate lazily.
 *
 * Orientation matters and is not arbitrary. The engine's sky code treats world
 * +y as north (a camera angle of pi/2 looks at azimuth 0), so cell y must
 * increase with latitude. Get this backwards and the sun rises in the west.
 */

/* ------------------------------ projection ------------------------------ */

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

/** Equirectangular about the box centre. Sub-cell accurate at city scale. */
export function makeProjection([s, w, n, e]) {
  const lat0 = (s + n) / 2;
  const lon0 = (w + e) / 2;
  const mPerLon = M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180);

  const halfW = Math.abs(e - w) / 2 * mPerLon / METERS_PER_CELL;
  const halfH = Math.abs(n - s) / 2 * M_PER_DEG_LAT / METERS_PER_CELL;

  const width = Math.max(16, Math.ceil(halfW * 2));
  const height = Math.max(16, Math.ceil(halfH * 2));

  return {
    lat0,
    lon0,
    width,
    height,
    x: (lon) => (lon - lon0) * mPerLon / METERS_PER_CELL + width / 2,
    // +y is north
    y: (lat) => (lat - lat0) * M_PER_DEG_LAT / METERS_PER_CELL + height / 2,
  };
}

/* -------------------------------- tags --------------------------------- */

/**
 * Building height in cells.
 * `height` in metres wins, then `building:levels`, then a 3-level default as
 * specified. Roof height is added when it is given separately.
 */
export function heightOfCells(tags = {}) {
  const metres = parseMetres(tags.height ?? tags['building:height']);
  if (metres !== null && metres > 0) return metres / METERS_PER_CELL;

  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    const roof = parseFloat(tags['roof:levels']);
    const total = levels + (Number.isFinite(roof) ? roof : 0);
    // Storeys map onto the facade texture's floor pitch exactly.
    return total * FLOOR_H;
  }

  return 3 * FLOOR_H;   // default: 3 levels
}

/** Parse an OSM distance: "25", "25 m", "82'", "82 ft". Returns metres. */
export function parseMetres(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  const m = /^(-?[\d.]+)\s*(.*)$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith("'") || unit.startsWith('ft') || unit.startsWith('feet')) {
    return n * 0.3048;
  }
  return n;
}

/** Road width in metres, by highway class. */
const ROAD_W = {
  motorway: 20, trunk: 18, primary: 16, secondary: 13, tertiary: 11,
  residential: 9, unclassified: 9, living_street: 8, service: 5,
  pedestrian: 6, footway: 3, path: 3, cycleway: 3, steps: 3, track: 4,
};

const FOOT_LIKE = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway']);

const WATERWAY_W = { river: 26, canal: 14, stream: 5 };

/* ------------------------------ the world ------------------------------- */

export class OsmWorld {
  /**
   * @param {number[]} bbox [south, west, north, east]
   * @param {Array} elements Overpass elements with inline geometry
   */
  constructor(bbox, elements, label = 'OpenStreetMap') {
    this.bbox = bbox;
    this.label = label;
    this.name = label;

    const proj = makeProjection(bbox);
    this.proj = proj;
    this.width = proj.width;
    this.height = proj.height;
    this.lat = proj.lat0;
    this.lon = proj.lon0;

    this.size = 0;                 // bounded: the camera does not wrap
    this.maxHeight = 0;

    // One extra slot past the grid, returned for anything out of bounds.
    const n = this.width * this.height;
    this.voidSlot = n;
    this.h = new Float32Array(n + 1);
    this.type = new Uint8Array(n + 1);
    this.rnd = new Float32Array(n + 1);
    this.lamp = new Float32Array(n + 1);
    this.pal = new Uint8Array(n + 1);
    this.flags = new Uint8Array(n + 1);

    this.roadCells = [];
    this.stats = { buildings: 0, roads: 0, water: 0, green: 0, skipped: 0 };

    this._rasterize(elements);
  }

  /* --- WorldSource contract --- */

  sample(cx, cy) {
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return this.voidSlot;
    return y * this.width + x;
  }

  ready() { return Promise.resolve(this); }

  maxHeightAt() { return this.maxHeight; }

  dispose() { this.roadCells.length = 0; }

  /** Traffic needs somewhere to put a car; OSM streets are not on a grid. */
  get hasStreets() { return this.roadCells.length > 0; }

  randomRoadCell() {
    if (this.roadCells.length === 0) return null;
    const p = this.roadCells[(Math.random() * this.roadCells.length) | 0];
    return { x: (p % this.width) + 0.5, y: Math.floor(p / this.width) + 0.5 };
  }

  /** Nearest road cell to the middle of the extract. */
  spawn() {
    const cx = this.width / 2;
    const cy = this.height / 2;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.roadCells.length; i++) {
      const p = this.roadCells[i];
      const x = p % this.width;
      const y = (p / this.width) | 0;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bestD) { bestD = d; best = { x: x + 0.5, y: y + 0.5 }; }
    }
    return best
      ? { ...best, angle: Math.PI / 2 }
      : { x: cx, y: cy, angle: Math.PI / 2 };
  }

  /* ------------------------------ raster ------------------------------ */

  _set(x, y, type, h, palSeed, flagBits = 0) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const s = y * this.width + x;
    this.type[s] = type;
    this.h[s] = h;
    this.rnd[s] = hash(x, y, 0x5eed);
    this.pal[s] = palSeed & 3;
    this.flags[s] = flagBits;
    if (h > this.maxHeight) this.maxHeight = h;
  }

  _rasterize(elements) {
    // Ground first, then water, then roads, then buildings: later layers win.
    const green = [];
    const water = [];
    const roads = [];
    const waterways = [];
    const buildings = [];

    for (const el of elements) {
      const tags = el.tags || {};
      if (tags.building || tags['building:part']) buildings.push(el);
      else if (tags.highway) roads.push(el);
      else if (tags.waterway) waterways.push(el);
      else if (tags.natural === 'water') water.push(el);
      else if (tags.leisure || tags.landuse) green.push(el);
      else this.stats.skipped++;
    }

    // Default ground. Plaza reads as neutral paving between the named layers.
    this.type.fill(T.PLAZA);
    for (let i = 0; i < this.width * this.height; i++) {
      this.rnd[i] = hash(i % this.width, (i / this.width) | 0, 0x5eed);
    }
    // Beyond the extract there is simply no data. Render it as neutral,
    // hazy ground rather than inventing countryside: at altitude the view
    // reaches well past a 1 km box, and a green field out there would be a
    // claim about the world that OpenStreetMap never made.
    this.type[this.voidSlot] = T.VOID;

    for (const el of green) this._fillArea(el);
    for (const el of water) this._fillWater(el);
    for (const el of waterways) this._strokeWaterway(el);

    const lamps = [];
    for (const el of roads) this._strokeRoad(el, lamps);
    this._splatLamps(lamps);

    for (const el of buildings) this._fillBuilding(el);

    // Collect road cells after buildings, so none of them are inside a wall.
    for (let s = 0; s < this.width * this.height; s++) {
      if (this.h[s] === 0 &&
          (this.type[s] === T.ROAD || this.type[s] === T.SIDEWALK)) {
        this.roadCells.push(s);
      }
    }
  }

  /** All closed rings of an element, projected to cell coordinates. */
  _ringsOf(el) {
    const rings = [];
    const toCells = (geom) => geom.map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);

    if (el.geometry && el.geometry.length > 2) {
      rings.push(toCells(el.geometry));
    } else if (el.members) {
      for (const m of el.members) {
        if (m.geometry && m.geometry.length > 2) rings.push(toCells(m.geometry));
      }
    }
    return rings;
  }

  _fillBuilding(el) {
    const rings = this._ringsOf(el);
    if (rings.length === 0) return;

    const h = heightOfCells(el.tags);
    const type = h > 8 ? T.TOWER : T.HOUSE;
    const pal = (el.id ?? 0) & 3;
    let touched = 0;

    scanFill(rings, this.width, this.height, (x, y) => {
      this._set(x, y, type, h, pal);
      touched++;
    });
    if (touched) this.stats.buildings++;
  }

  _fillArea(el) {
    const tags = el.tags || {};
    const rings = this._ringsOf(el);
    if (rings.length === 0) return;

    const forest = tags.landuse === 'forest' || tags.natural === 'wood';
    let touched = 0;

    scanFill(rings, this.width, this.height, (x, y) => {
      if (forest) {
        // Scatter canopy rather than a solid block of tree.
        const r = hash(x, y, 0xf0f0);
        if (r < 0.34) this._set(x, y, T.FOREST, 3 + r * 8, 0);
        else this._set(x, y, T.FIELD, 0, 0);
      } else {
        this._set(x, y, T.FIELD, 0, 0);
      }
      touched++;
    });
    if (touched) this.stats.green++;
  }

  _fillWater(el) {
    const rings = this._ringsOf(el);
    if (rings.length === 0) return;
    let touched = 0;
    scanFill(rings, this.width, this.height, (x, y) => {
      this._set(x, y, T.WATER, 0, 0);
      touched++;
    });
    if (touched) this.stats.water++;
  }

  _strokeWaterway(el) {
    if (!el.geometry || el.geometry.length < 2) return;
    const w = (WATERWAY_W[el.tags?.waterway] ?? 6) / METERS_PER_CELL;
    const pts = el.geometry.map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);
    strokePath(pts, w, this.width, this.height, (x, y) => {
      this._set(x, y, T.WATER, 0, 0);
    });
    this.stats.water++;
  }

  _strokeRoad(el, lamps) {
    if (!el.geometry || el.geometry.length < 2) return;
    const kind = el.tags?.highway;
    const metres = ROAD_W[kind] ?? 8;
    const w = metres / METERS_PER_CELL;
    const foot = FOOT_LIKE.has(kind);
    const type = foot ? T.SIDEWALK : T.ROAD;
    const pts = el.geometry.map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);

    strokePath(pts, w, this.width, this.height, (x, y, distToCentre, along) => {
      // A dashed centre line on the wider carriageways only.
      const stripe = !foot && metres >= 9 && distToCentre < 0.6 &&
                     (Math.floor(along) % 5) < 2;
      this._set(x, y, type, 0, 0, stripe ? F.STRIPE : 0);
    });

    if (!foot) {
      // Street lamps every ~11 cells along the kerb.
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        for (let d = -acc; d < len; d += 11) {
          if (d < 0) continue;
          const t = d / len;
          const side = ((lamps.length & 1) ? 1 : -1) * (w / 2 + 0.5);
          lamps.push([ax + (bx - ax) * t + nx * side, ay + (by - ay) * t + ny * side]);
        }
        acc = (acc + len) % 11;
      }
    }
    this.stats.roads++;
  }

  /** Glow falloff around each lamp, matching the procedural world's look. */
  _splatLamps(lamps) {
    const R = 5;
    for (const [lx, ly] of lamps) {
      const x0 = Math.max(0, Math.floor(lx - R));
      const x1 = Math.min(this.width - 1, Math.ceil(lx + R));
      const y0 = Math.max(0, Math.floor(ly - R));
      const y1 = Math.min(this.height - 1, Math.ceil(ly + R));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - lx;
          const dy = y + 0.5 - ly;
          const g = Math.exp(-(dx * dx + dy * dy) / 7.5);
          const s = y * this.width + x;
          if (g > this.lamp[s]) this.lamp[s] = g;
        }
      }
    }
  }
}

/* ---------------------------- raster helpers ---------------------------- */

/**
 * Even-odd scanline fill over a set of rings. Passing outer and inner rings
 * together punches holes for free, which is what multipolygon relations need.
 */
export function scanFill(rings, width, height, plot) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings) {
    for (const [, y] of r) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minY)) return;

  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  const xs = [];

  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;

    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        // Half-open in y, so a vertex on the scanline counts once.
        if ((yi > sy) === (yj > sy)) continue;
        xs.push(xi + (sy - yi) / (yj - yi) * (xj - xi));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) plot(x, y);
    }
  }
}

/**
 * Stamp a polyline of a given width. `plot` receives the perpendicular
 * distance to the centre line and the distance travelled along it, so callers
 * can draw kerbs and centre markings.
 */
export function strokePath(pts, width, gridW, gridH, plot) {
  const r = Math.max(0.5, width / 2);
  let along = 0;

  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const len = Math.sqrt(len2);
    if (len < 1e-9) continue;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
    const x1 = Math.min(gridW - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const y1 = Math.min(gridH - 1, Math.ceil(Math.max(ay, by) + r));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        let t = (px * vx + py * vy) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = px - vx * t;
        const dy = py - vy * t;
        const d = Math.hypot(dx, dy);
        if (d <= r) plot(x, y, d, along + t * len);
      }
    }
    along += len;
  }
}
