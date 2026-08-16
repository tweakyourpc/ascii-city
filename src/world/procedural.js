import { ChunkedWorld, T, F, CHUNK, hash } from './source.js';
import { WORLD, BLOCK, SEED } from '../config.js';

const CENTER = WORLD / 2;      // 1024, where the park sits

/**
 * The original engine's procedural city, behind the WorldSource interface.
 *
 * Terrain is a pure function of coordinates: a park at the centre so the
 * skyline has an open foreground, then concentric rings of towers, houses,
 * farmland, forest and water, over a block grid with roads, sidewalks, street
 * trees and lamp-glow falloff.
 */
export class ProceduralWorld extends ChunkedWorld {
  constructor({ seed = SEED } = {}) {
    super({ size: WORLD, maxChunks: 4096 });
    this.seed = seed;
    // A bound, not an observation: the tallest term below is 10 + 10 + 21.
    this.maxHeight = 42;
    this.name = 'Procedural City';
  }

  fillChunk(ox, oy, base) {
    const seed = this.seed;

    for (let ly = 0; ly < CHUNK; ly++) {
      const ay = oy + ly;
      const my = ay % BLOCK;
      const by = (ay / BLOCK) | 0;
      const ddy = ay - CENTER;
      const pdy = ay - (CENTER + 7);

      for (let lx = 0; lx < CHUNK; lx++) {
        const ax = ox + lx;
        const mx = ax % BLOCK;
        const bx = (ax / BLOCK) | 0;
        const ddx = ax - CENTER;
        const pdx = ax - (CENTER + 12);

        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const rb = hash(bx, by, seed);
        const rb2 = hash(bx + 911, by + 733, seed);
        const rc = hash(ax, ay, seed);

        let type = T.FIELD;
        let h = 0;
        let stripe = false;

        if (dist < 54) {
          // the park: an open foreground so the skyline has somewhere to stand
          const pondD = Math.sqrt(pdx * pdx + pdy * pdy);
          if (pondD < 9.5) {
            type = T.WATER;
          } else if (Math.abs(ddx) < 1.5 || Math.abs(ddy) < 1.5 ||
                     (dist > 28.5 && dist < 30.5)) {
            type = T.PLAZA;
          } else if (rc < 0.018 && Math.abs(ddx) > 7 && Math.abs(ddy) > 7) {
            type = T.TREE; h = 3.4 + rc * 90;
          } else {
            type = T.FIELD;
          }
        } else if (mx < 3 || my < 3) {
          type = dist < 780 ? T.ROAD : T.PATH;
          if (mx === 1 && my >= 3 && (ay % 4) < 2) stripe = true;
          if (my === 1 && mx >= 3 && (ax % 4) < 2) stripe = true;
        } else if (mx === 3 || mx === 13 || my === 3 || my === 13) {
          type = T.SIDEWALK;
          if (dist < 560 && rc < 0.05) { type = T.TREE; h = 3.2 + rc * 20; }
        } else if (dist < 265) {
          if (rb < 0.07) {
            type = T.PLAZA;
          } else {
            type = T.TOWER;
            const lf = Math.max(0, 1 - dist / 320);
            // a skyline needs low-rise too, or every street is a slot canyon
            h = rb < 0.46 ? 4 + rb2 * 6 : 10 + rb2 * 10 + lf * rc * 21;
          }
        } else if (dist < 480) {
          if (rb < 0.74) { type = T.HOUSE; h = 2.4 + rb2 * 2.2; }
          else type = T.YARD;
        } else if (dist < 790) {
          if (rb < 0.35) type = T.FIELD;
          else { type = T.FARM; h = rc < 0.5 ? 1.1 : 0; }
        } else if (rb < 0.55) {
          if (rc < 0.55) { type = T.FOREST; h = 3 + rc * 5; }
          else type = T.FIELD;
        } else {
          type = T.WATER;
        }

        let lamp = 0;
        if (type === T.ROAD || type === T.SIDEWALK ||
            type === T.PLAZA || type === T.PATH) {
          const kx = Math.min(
            Math.abs(ax - (bx * BLOCK - 1)), Math.abs(ax - (bx * BLOCK + 3)),
            Math.abs(ax - (bx * BLOCK + 13)), Math.abs(ax - (bx * BLOCK + BLOCK + 3)));
          const ky = Math.min(
            Math.abs(ay - (by * BLOCK - 1)), Math.abs(ay - (by * BLOCK + 3)),
            Math.abs(ay - (by * BLOCK + 13)), Math.abs(ay - (by * BLOCK + BLOCK + 3)));
          const sx = Math.abs(ax - Math.round(ax / 7) * 7);
          const sy = Math.abs(ay - Math.round(ay / 7) * 7);
          lamp = Math.exp(-Math.min(kx * kx + sy * sy, ky * ky + sx * sx) / 7.5);
        }

        let flags = stripe ? F.STRIPE : 0;
        if (h > 25 && hash(ax, ay, seed ^ 0x9e37) < 0.25) flags |= F.BEACON;

        const s = base + (ly << 5) + lx;
        this.h[s] = h;
        this.type[s] = type;
        this.rnd[s] = rc;
        this.lamp[s] = lamp;
        this.pal[s] = (hash(bx + 5, by + 9, seed) * 4) | 0;
        this.flags[s] = flags;
      }
    }
  }

  /** A sensible place to drop the camera: a street near the park's edge. */
  spawn() {
    let x = CENTER + 0.5;
    let y = CENTER - 47.5;   // 976.5, matching the original start position
    for (let n = 0; n < 24; n++) {
      const t = this.type[this.sample(x, y)];
      const l = this.type[this.sample(x - 1, y)];
      const r = this.type[this.sample(x + 1, y)];
      if (t !== T.TREE && t !== T.WATER && l !== T.TREE && r !== T.TREE) break;
      y += 1;
    }
    return { x, y, angle: Math.PI / 2 };
  }
}
