import { T } from './world/source.js';

/**
 * What is at a given screen cell.
 *
 * This is a depth-buffer readback, not a fresh ray cast. The renderer already
 * computed the exact distance of whatever it drew at every cell, so the answer
 * is already in memory: O(1), and pixel-exact by construction. A recast ray can
 * disagree with what was actually drawn by half a cell, which is precisely the
 * kind of disagreement a user notices when they click a building and get the
 * one behind it.
 */

const SKY_D = 1e8;

export function pick(screen, cam, world, col, row, skyMarks) {
  if (col < 0 || col >= screen.cols || row < 0 || row >= screen.rows) return null;
  const i = row * screen.cols + col;
  const d = screen.depth[i];

  // Nothing wrote depth there, so it is sky.
  if (d >= SKY_D) {
    const aim = unproject(screen, cam, col, row);
    const hit = skyMarks ? skyMarks.nearest(col, row) : null;
    return hit ? { kind: 'sky', object: hit, ...aim } : { kind: 'sky', object: null, ...aim };
  }

  // Facades record the cell's ENTRY distance, so the reconstructed point lands
  // exactly on a cell boundary. Nudge forward to land inside the cell.
  const dw = d * cam.rinv[col];
  const wx = cam.x + cam.rc[col] * (dw + 0.05);
  const wy = cam.y + cam.rs[col] * (dw + 0.05);

  const s = world.sample(wx, wy);
  const id = world.bid ? world.bid[s] : 0;

  if (world.h[s] > 0 && id && world.buildings && world.buildings[id]) {
    return {
      kind: 'building',
      id,
      b: world.buildings[id],
      x: wx, y: wy, d,
      part: row < cam.rowOf(world.h[s], d) + 0.5 ? 'roof' : 'facade',
    };
  }

  return {
    kind: 'ground',
    x: wx, y: wy, d,
    type: world.type[s],
    street: world.nearestStreet ? world.nearestStreet(wx, wy) : null,
    poi: world.nearestPoi ? world.nearestPoi(wx, wy) : null,
  };
}

/**
 * Screen cell back to a horizon direction. The inverse of sky.js's project(),
 * so a click on empty sky still yields a real altitude and azimuth rather than
 * "nothing here".
 */
export function unproject(screen, cam, x, y) {
  const da = Math.atan2(x + 0.5 - screen.cols / 2, screen.proj);
  const az = ((90 - (cam.angle + da) * 180 / Math.PI) % 360 + 360) % 360;
  const alt = Math.atan2(cam.hz - y, screen.vscale) * 180 / Math.PI;
  return { az, alt };
}

const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
               'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass point for a bearing in degrees. */
export function wind(deg) {
  return WINDS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Bearing from the camera to a world point. World +y is north. */
export function bearingTo(cam, x, y) {
  const deg = Math.atan2(y - cam.y, x - cam.x) * 180 / Math.PI;
  return ((90 - deg) % 360 + 360) % 360;
}

export const GROUND_NAME = {
  [T.ROAD]: 'Road', [T.PATH]: 'Path', [T.SIDEWALK]: 'Footway',
  [T.PLAZA]: 'Paving', [T.YARD]: 'Yard', [T.FIELD]: 'Open ground',
  [T.FARM]: 'Farmland', [T.WATER]: 'Water', [T.TREE]: 'Tree',
  [T.FOREST]: 'Woodland', [T.VOID]: 'Beyond the map',
};

/**
 * Records which named sky object was drawn where, so the sky can be picked.
 * Reused across frames; nothing allocates per frame.
 */
export class SkyMarks {
  constructor() {
    this.n = 0;
    this.x = [];
    this.y = [];
    this.obj = [];
  }

  reset() { this.n = 0; }

  add(x, y, object) {
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.obj[this.n] = object;
    this.n++;
  }

  /** Nearest recorded object within `r` cells of a click. */
  nearest(col, row, r = 3) {
    let best = null;
    let bd = (r + 1) * (r + 1);
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i] - col;
      const dy = this.y[i] - row;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = this.obj[i]; }
    }
    return best;
  }
}
