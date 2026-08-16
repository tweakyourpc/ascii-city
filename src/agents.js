import { T, wrap } from './world/source.js';
import { normAngle } from './camera.js';
import { BLOCK, FOV, MAXD, MAX_CARS, MAX_PEDS, AGENT_CULL_D2 } from './config.js';
import { fogOf } from './render/materials.js';
import { col2str } from './screen.js';

const CAR = [
  ' .------. ',
  ' |##||##| ',
  '-[o]--[o]-',
];
const PED = [' o ', '/|\\', '/ \\'];

/**
 * Cars and pedestrians routing the street grid.
 *
 * Only meaningful on a world that has a block-aligned road grid; worlds without
 * one report `hasStreets = false` and traffic is skipped.
 */
export class Traffic {
  constructor(world) {
    this.world = world;
    this.agents = [];
  }

  setWorld(world) {
    this.world = world;
    this.agents.length = 0;
  }

  _spawn(kind, cam) {
    const world = this.world;
    const ang = Math.random() * Math.PI * 2;
    const rad = 16 + Math.random() * 58;
    const sx = cam.x + Math.cos(ang) * rad;
    const sy = cam.y + Math.sin(ang) * rad;
    const bx = Math.floor(sx / BLOCK) * BLOCK;
    const by = Math.floor(sy / BLOCK) * BLOCK;

    const a = {
      kind,
      axis: Math.random() < 0.5 ? 'x' : 'y',
      dir: Math.random() < 0.5 ? 1 : -1,
      side: Math.random() < 0.5,
      x: sx, y: sy, inX: false,
      spd: kind === 'car' ? 3 + Math.random() * 5 : 0.9 + Math.random() * 0.7,
      pal: (Math.random() * 4) | 0,
    };

    if (kind === 'car') {
      if (a.axis === 'y') a.x = bx + (a.dir > 0 ? 0.6 : 2.4);
      else a.y = by + (a.dir > 0 ? 0.6 : 2.4);
    } else if (a.axis === 'y') {
      a.x = bx + (a.side ? 3.5 : 13.5);
    } else {
      a.y = by + (a.side ? 3.5 : 13.5);
    }

    const t = world.type[world.sample(a.x, a.y)];
    if (kind === 'car' ? t !== T.ROAD : t !== T.SIDEWALK) return false;
    this.agents.push(a);
    return true;
  }

  update(dt, cam) {
    const world = this.world;
    if (world.hasStreets === false) { this.agents.length = 0; return; }
    const agents = this.agents;

    for (let i = agents.length - 1; i >= 0; i--) {
      const a = agents[i];
      const dx = a.x - cam.x;
      const dy = a.y - cam.y;
      if (dx * dx + dy * dy > AGENT_CULL_D2) { agents.splice(i, 1); continue; }

      if (a.axis === 'x') a.x += a.dir * a.spd * dt;
      else a.y += a.dir * a.spd * dt;

      const mx = wrap(a.x, BLOCK);
      const my = wrap(a.y, BLOCK);
      const atCross = mx < 3 && my < 3;

      if (atCross && !a.inX) {
        a.inX = true;
        if (Math.random() < (a.kind === 'car' ? 0.35 : 0.5)) {
          a.axis = a.axis === 'x' ? 'y' : 'x';
          a.dir = Math.random() < 0.5 ? 1 : -1;
          const bx = Math.floor(a.x / BLOCK) * BLOCK;
          const by = Math.floor(a.y / BLOCK) * BLOCK;
          if (a.kind === 'car') {
            if (a.axis === 'y') a.x = bx + (a.dir > 0 ? 0.6 : 2.4);
            else a.y = by + (a.dir > 0 ? 0.6 : 2.4);
          }
        }
      } else if (!atCross) {
        a.inX = false;
      }

      // Pedestrians hug the kerb; if they wander off it, turn them around.
      if (a.kind === 'ped' && world.type[world.sample(a.x, a.y)] !== T.SIDEWALK) {
        a.dir = -a.dir;
      }
    }

    let cars = 0;
    let peds = 0;
    for (let i = 0; i < agents.length; i++) {
      if (agents[i].kind === 'car') cars++; else peds++;
    }
    for (let i = 0; i < 3; i++) if (cars < MAX_CARS && this._spawn('car', cam)) cars++;
    for (let i = 0; i < 3; i++) if (peds < MAX_PEDS && this._spawn('ped', cam)) peds++;
  }

  /**
   * Draw sprites, back to front, depth-tested per cell against the scene depth
   * buffer. The original tested one distance per column, which cannot handle a
   * rooftop seen from above partially hiding the street behind it.
   */
  draw(screen, cam, L) {
    const agents = this.agents;
    if (agents.length === 0) return;

    const vis = [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const rx = a.x - cam.x;
      const ry = a.y - cam.y;
      const d = Math.sqrt(rx * rx + ry * ry);
      if (d < 0.5 || d > MAXD) continue;
      const da = normAngle(Math.atan2(ry, rx) - cam.angle);
      if (Math.abs(da) > FOV * 0.72) continue;
      vis.push({ a, d, ang: da });
    }
    vis.sort((p, q) => q.d - p.d);

    const { cols, rows, depth } = screen;

    for (let i = 0; i < vis.length; i++) {
      const { a, d, ang } = vis[i];
      const dp = d * Math.cos(ang);
      if (dp < 0.3) continue;

      const tpl = a.kind === 'car' ? CAR : PED;
      const wWorld = a.kind === 'car' ? 2.4 : 0.85;
      const hWorld = a.kind === 'car' ? 1.5 : 1.8;

      const cx = cols / 2 + Math.tan(ang) * cam.proj;
      const wcols = Math.max(1, wWorld * cam.proj / dp);
      const baseR = cam.rowOf(0, dp);
      const topR = cam.rowOf(hWorld, dp);
      const y0 = Math.floor(topR);
      const y1 = Math.max(y0 + 1, Math.ceil(baseR));
      const span = Math.max(0.001, baseR - topR);
      const x0 = cx - wcols / 2;
      const f = Math.max(0.12, fogOf(dp));

      const toward = (a.axis === 'x' ? a.dir * (a.x - cam.x) : a.dir * (a.y - cam.y)) < 0;
      const lampCol = toward ? col2str(255, 250, 220) : col2str(255, 70, 50);
      const bodyCol = L.depth(64 + a.pal * 18, 68, 82, f);
      const pedCol = L.depth(150 * L.amb + 46, 152 * L.amb + 44, 168 * L.amb + 50, f);

      const yA = Math.max(0, y0);
      const yB = Math.min(rows, y1);
      const xA = Math.max(0, Math.floor(x0));
      const xB = Math.min(cols, Math.ceil(x0 + wcols));

      for (let y = yA; y < yB; y++) {
        let tr = Math.floor((y + 0.5 - topR) / span * tpl.length);
        if (tr < 0) tr = 0;
        if (tr >= tpl.length) tr = tpl.length - 1;
        const row = tpl[tr];

        for (let x = xA; x < xB; x++) {
          if (dp >= depth[y * cols + x]) continue;
          let tc = Math.floor((x + 0.5 - x0) / wcols * row.length);
          if (tc < 0) tc = 0;
          if (tc >= row.length) tc = row.length - 1;
          const g = row[tc];
          if (g === ' ') continue;
          screen.set(x, y, g,
            a.kind === 'car' ? (g === 'o' ? lampCol : bodyCol) : pedCol);
        }
      }
    }
  }
}
