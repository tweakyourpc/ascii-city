/**
 * Which way round the world is.
 *
 * The engine's conventions: world +x is east, +y is north, angles are measured
 * counter-clockwise from +x as usual, and screen columns increase to the right.
 * Those four facts together fix the handedness of everything that turns a
 * horizontal angle into a screen column, and there are six such places.
 *
 * This file exists because the ray fan was mirrored for the whole life of the
 * project. A procedural city is statistically symmetric, so nothing looked
 * wrong until real OpenStreetMap data arrived and the buildings on one side of
 * a street rendered on the other.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera, normAngle } from '../src/camera.js';
import { ChunkedWorld, T } from '../src/world/source.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { project } from '../src/render/sky.js';
import { unproject, bearingTo, wind } from '../src/pick.js';
import { FOV, HORIZON_FRAC } from '../src/config.js';

const CX = 100;
const CY = 100;

/** Two markers due north of the camera: a tall one east, a short one west. */
class Markers extends ChunkedWorld {
  constructor() {
    super({ size: 0 });
    this.maxHeight = 30;
    this.hasStreets = false;
  }

  fillChunk(ox, oy, base) {
    for (let ly = 0; ly < 32; ly++) {
      for (let lx = 0; lx < 32; lx++) {
        const x = ox + lx;
        const y = oy + ly;
        const s = base + (ly << 5) + lx;
        let h = 0;
        if (y >= CY + 28 && y < CY + 32) {
          if (x >= CX + 14 && x < CX + 20) h = 30;      // EAST, tall
          if (x >= CX - 20 && x < CX - 14) h = 6;       // WEST, short
        }
        this.h[s] = h;
        this.type[s] = h ? T.TOWER : T.FIELD;
        this.rnd[s] = 0.5;
        this.lamp[s] = 0;
        this.pal[s] = 0;
        this.flags[s] = 0;
      }
    }
  }
}

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
    covWords: ((rows + 31) >> 5),
    cov: new Uint32Array((rows + 31) >> 5),
    hasHoles: new Uint8Array(cols),
    holeMask: new Uint32Array(cols * ((rows + 31) >> 5)),
    set(x, y, g, c) {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return;
      this.glyph[y * cols + x] = g;
      this.colour[y * cols + x] = c;
    },
    setDepth(x, y, g, c, d) {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return;
      const i = y * cols + x;
      this.glyph[i] = g; this.colour[i] = c; this.depth[i] = d;
    },
    fillRow(y, g, c, d) { for (let x = 0; x < cols; x++) this.setDepth(x, y, g, c, d); },
  };
  s.glyph.fill(undefined);
  s.depth.fill(1e9);
  return s;
}

/* ------------------------------- the ray fan ------------------------------ */

test('the ray fan puts east on the right when facing north', () => {
  const screen = makeScreen(80, 24);
  const cam = new Camera();
  cam.angle = Math.PI / 2;               // north
  cam.buildRays(screen);

  const angAt = (i) => Math.atan2(cam.rs[i], cam.rc[i]) * 180 / Math.PI;
  const left = angAt(0);
  const right = angAt(screen.cols - 1);

  // Facing north (90 deg), the right of the screen looks east-of-north, which
  // is a SMALLER angle; the left looks west-of-north, a LARGER one.
  assert.ok(right < 90 && right > 40,
    `right edge should look east-of-north, got ${right.toFixed(1)} deg`);
  assert.ok(left > 90 && left < 140,
    `left edge should look west-of-north, got ${left.toFixed(1)} deg`);
  assert.ok(left > right, 'the fan runs the wrong way round');
});

test('a building due east renders on the right half of the screen', () => {
  const world = new Markers();
  const screen = makeScreen(80, 24);
  const cam = new Camera();
  cam.x = CX + 0.5;
  cam.y = CY + 0.5;
  cam.z = 2;
  cam.pitch = 0;
  cam.angle = Math.PI / 2;               // north
  cam.hz = screen.horizon;
  cam.buildRays(screen);
  const L = new Lighting();
  L.update(40);
  renderScene(screen, cam, world, L, 0);

  // Column height above the horizon separates the tall marker from the short.
  const topOf = (col) => {
    for (let y = 0; y < screen.rows; y++) {
      const i = y * screen.cols + col;
      if (screen.glyph[i] !== undefined && screen.depth[i] < 200) return y;
    }
    return screen.rows;
  };

  const tall = [];
  const short = [];
  for (let col = 0; col < screen.cols; col++) {
    const t = topOf(col);
    if (t < screen.horizon - 6) tall.push(col);
    else if (t < screen.horizon) short.push(col);
  }

  assert.ok(tall.length > 0, 'the tall marker did not render');
  assert.ok(short.length > 0, 'the short marker did not render');

  const mid = screen.cols / 2;
  const avg = (a) => a.reduce((p, c) => p + c, 0) / a.length;
  assert.ok(avg(tall) > mid,
    `the EAST building rendered on the left (columns around ${avg(tall).toFixed(0)} of ${screen.cols})`);
  assert.ok(avg(short) < mid,
    `the WEST building rendered on the right (columns around ${avg(short).toFixed(0)} of ${screen.cols})`);
});

test('looking along a street, the north side stays on the left', () => {
  // The exact symptom that surfaced this: buildings from one side of a road
  // rendering on the other. Facing east, north is on your left.
  class Street extends ChunkedWorld {
    constructor() { super({ size: 0 }); this.maxHeight = 30; this.hasStreets = false; }
    fillChunk(ox, oy, base) {
      for (let ly = 0; ly < 32; ly++) {
        for (let lx = 0; lx < 32; lx++) {
          const x = ox + lx;
          const y = oy + ly;
          const s = base + (ly << 5) + lx;
          let h = 0;
          // A street runs east-west along y = CY. Tall terrace on the north
          // side, low terrace on the south side.
          if (x > CX + 6 && x < CX + 60) {
            if (y >= CY + 4 && y < CY + 10) h = 30;     // NORTH side, tall
            if (y > CY - 10 && y <= CY - 4) h = 5;      // SOUTH side, low
          }
          this.h[s] = h;
          this.type[s] = h ? T.TOWER : T.FIELD;
          this.rnd[s] = 0.5; this.lamp[s] = 0; this.pal[s] = 0; this.flags[s] = 0;
        }
      }
    }
  }

  const screen = makeScreen(80, 24);
  const cam = new Camera();
  cam.x = CX + 0.5;
  cam.y = CY + 0.5;
  cam.z = 2;
  cam.pitch = 0;
  cam.angle = 0;                        // facing EAST, along the street
  cam.hz = screen.horizon;
  cam.buildRays(screen);
  const L = new Lighting();
  L.update(40);
  renderScene(screen, cam, new Street(), L, 0);

  const topOf = (col) => {
    for (let y = 0; y < screen.rows; y++) {
      const i = y * screen.cols + col;
      if (screen.glyph[i] !== undefined && screen.depth[i] < 200) return y;
    }
    return screen.rows;
  };

  let tallSum = 0;
  let tallN = 0;
  let lowSum = 0;
  let lowN = 0;
  for (let col = 0; col < screen.cols; col++) {
    const t = topOf(col);
    if (t < screen.horizon - 5) { tallSum += col; tallN++; }
    else if (t < screen.horizon) { lowSum += col; lowN++; }
  }
  assert.ok(tallN > 0 && lowN > 0, 'both terraces should be visible');

  const mid = screen.cols / 2;
  assert.ok(tallSum / tallN < mid,
    'the NORTH terrace rendered on the right; the view is mirrored');
  assert.ok(lowSum / lowN > mid,
    'the SOUTH terrace rendered on the left; the view is mirrored');
});

/* --------------------------------- the sky -------------------------------- */

test('the rising sun appears on the right when facing north', () => {
  const screen = makeScreen(80, 24);
  const cam = new Camera();
  cam.angle = Math.PI / 2;               // north
  cam.hz = 12;
  cam.buildRays(screen);
  // Azimuth is measured from north, and the visible half-field is about 46
  // degrees, so these have to be close to 0 to be on screen at all.
  const p = project(screen, cam, 25, 10);    // 25 degrees east of north
  assert.ok(p, 'azimuth 25 should be inside the field of view');
  assert.ok(p.x > screen.cols / 2,
    `an object east of north rendered at column ${p.x} of ${screen.cols}`);

  const q = project(screen, cam, 335, 10);   // 25 degrees west of north
  assert.ok(q, 'azimuth 335 should be inside the field of view');
  assert.ok(q.x < screen.cols / 2,
    `an object west of north rendered at column ${q.x} of ${screen.cols}`);
});

test('project and unproject agree away from the centre', () => {
  const screen = makeScreen(80, 24);
  const cam = new Camera();
  cam.angle = Math.PI / 2;
  cam.hz = 12;
  cam.buildRays(screen);

  for (const az of [340, 350, 10, 20]) {
    const p = project(screen, cam, az, 0);
    assert.ok(p, `azimuth ${az} not projected`);
    const back = unproject(screen, cam, p.x, cam.hz);
    const diff = Math.abs(((back.az - az + 540) % 360) - 180);
    assert.ok(diff < 3,
      `azimuth ${az} round-tripped to ${back.az.toFixed(1)}`);
  }
});

/* -------------------------- movement and turning -------------------------- */

test('turning right decreases the heading angle', () => {
  // Screen columns increase to the right and angles increase counter-clockwise,
  // so turning right must run the angle down. Get this backwards and the mouse
  // feels inverted.
  const cam = new Camera();
  cam.angle = Math.PI / 2;
  const before = cam.angle;
  // The same arithmetic main.js applies for a rightward drag.
  cam.angle -= 40 * 0.004;
  assert.ok(cam.angle < before);

  // Facing north and turning right should head toward east (angle 0).
  assert.ok(cam.angle < Math.PI / 2 && cam.angle > 0);
});

test('strafing left moves west when facing north', () => {
  const angle = Math.PI / 2;             // north
  const fx = Math.cos(angle);
  const fy = Math.sin(angle);
  // The vector main.js uses for the 'a' key.
  const mx = -fy;
  const my = fx;
  assert.ok(mx < -0.5, `strafe left moved x by ${mx.toFixed(2)}, expected west`);
  assert.ok(Math.abs(my) < 1e-9, 'strafe left should not move north or south');
});

/* ------------------------- the compass still holds ------------------------ */

test('bearings are unchanged by any of this', () => {
  const cam = { x: 0, y: 0 };
  assert.equal(wind(bearingTo(cam, 0, 10)), 'N');
  assert.equal(wind(bearingTo(cam, 10, 0)), 'E');
  assert.equal(wind(bearingTo(cam, 0, -10)), 'S');
  assert.equal(wind(bearingTo(cam, -10, 0)), 'W');
});

test('normAngle still wraps to a half turn either side', () => {
  assert.ok(Math.abs(normAngle(Math.PI * 3)) - Math.PI < 1e-9);
  assert.ok(normAngle(-Math.PI * 1.5) > 0);
});
