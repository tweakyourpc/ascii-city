import { T, hash } from '../world/source.js';
import { MAXD, FOG_FULL, FOV, FLOOR_H } from '../config.js';
import {
  fogOf, groundGlyph, groundColour, roofGlyph, roofColour,
  GLYPH_RAMP, LIT, FACADE, OPEN,
} from './materials.js';

const FAR = Math.min(MAXD, FOG_FULL);

// The real termination is the distance break below; this only catches a
// degenerate ray direction. Cells crossed to reach Euclidean distance t is at
// most about 1.42t, and t is at most FAR / cos(FOV/2).
const GUARD_MAX = ((FAR * 1.5 / Math.cos(FOV / 2)) | 0) + 32;

/**
 * Floor cast: every row below the horizon is a distance, and every column in
 * that row is a point on the ground plane at that distance.
 *
 * Runs first and unconditionally. At altitude it paints the ground between and
 * beyond rooftops, which is most of the frame. The DDA then overpaints exactly
 * the rows that buildings occlude, which is correct without extra work because
 * a height field seen from outside always covers a bottom-anchored span of each
 * column (see the occlusion note in castWorld).
 */
function castFloor(screen, cam, world, L, t) {
  const { cols, rows, vscale } = screen;
  const hz = cam.hz;
  const camZ = cam.z;
  const hazeCol = L.hazeColour();

  const y0 = Math.max(0, Math.ceil(hz));

  for (let y = y0; y < rows; y++) {
    const rowOff = y + 0.5 - hz;
    if (rowOff <= 0.001) continue;

    const dPerp = camZ * vscale / rowOff;

    // Fog-clip rather than distance-clip. At camZ = 100 a plain MAXD test
    // leaves ~48 rows of black below the horizon; past FOG_FULL everything is
    // pure haze anyway, so fill and skip sampling entirely. This is faster
    // than sampling, and it bounds the chunk working set at altitude.
    if (dPerp > FOG_FULL) {
      screen.fillRow(y, '.', hazeCol, dPerp);
      continue;
    }

    const f = fogOf(dPerp);
    for (let x = 0; x < cols; x++) {
      const dw = dPerp * cam.rinv[x];
      const wx = cam.x + cam.rc[x] * dw;
      const wy = cam.y + cam.rs[x] * dw;
      const s = world.sample(wx, wy);
      screen.setDepth(x, y,
        groundGlyph(world, s, wx, wy, t),
        groundColour(world, s, f, L),
        dPerp);
    }
  }
}

/**
 * Per-column DDA over the height field, front to back.
 *
 * Each cell contributes at most two spans:
 *
 *   roof   rows [yA, yS)   a horizontal plane at height h
 *   facade rows [yS, yB)   the vertical wall down to the ground
 *
 * A roof at height h is simply a floor cast at elevation h, so the same
 * row-to-distance inversion serves both. When the camera is below h the roof
 * quad is back-facing, yA equals yS, and the roof loop is empty: one code path
 * covers standing in the street and hovering above the rooftops.
 *
 * OCCLUSION. A single `yTop` watermark is sufficient, and the reason is worth
 * recording. Bottoms are monotone (rowOf(0, d0) strictly decreases with
 * distance) so nothing behind can appear below something in front; and DDA
 * cells are contiguous, so successive spans always overlap. The covered set is
 * therefore always the bottom-anchored interval [yTop, rows), and
 * yTop = min(yTop, yA) is the complete update.
 *
 * That second property is exactly what fails without roofs: a gap opens
 * whenever d1/d0 exceeds camZ/(camZ-h), which shows up as hairline slits of
 * distant ground through the near edge of every rooftop. Drawing the roof
 * closes it analytically. A min/max pair or a per-column bitmask only becomes
 * necessary with overhangs, bridges or arches.
 */
function castWorld(screen, cam, world, L, t) {
  const { cols, rows, vscale } = screen;
  const hz = cam.hz;
  const camZ = cam.z;
  const hMax = world.maxHeight;

  for (let col = 0; col < cols; col++) {
    const rdx = cam.rc[col];
    const rdy = cam.rs[col];
    const cosC = 1 / cam.rinv[col];

    let mapX = Math.floor(cam.x);
    let mapY = Math.floor(cam.y);
    const ddX = Math.abs(1 / rdx);
    const ddY = Math.abs(1 / rdy);

    let stepX, stepY, sX, sY;
    if (rdx < 0) { stepX = -1; sX = (cam.x - mapX) * ddX; }
    else { stepX = 1; sX = (mapX + 1 - cam.x) * ddX; }
    if (rdy < 0) { stepY = -1; sY = (cam.y - mapY) * ddY; }
    else { stepY = 1; sY = (mapY + 1 - cam.y) * ddY; }

    let yTop = rows;
    let prev = 0;
    let side = 0;
    let dCut = Infinity;

    for (let guard = 0; guard < GUARD_MAX; guard++) {
      const next = sX < sY ? sX : sY;
      const s = world.sample(mapX, mapY);
      const h = world.h[s];

      if (h > 0) {
        // Copy everything this cell contributes before any further sampling:
        // finding the roof outline below samples neighbours, which invalidates
        // the slot.
        const type = world.type[s];
        const rnd = world.rnd[s];
        const palIdx = world.pal[s];
        const flags = world.flags[s];

        const d0 = prev * cosC;
        const d1 = next * cosC;
        const above = camZ > h;

        // Clamp rows, never distances: clamping d0 here would put the nearest
        // building's base row on screen instead of far below it.
        const tRoof = above ? cam.rowOf(h, d1)
                    : (d0 > 1e-6 ? cam.rowOf(h, d0) : -1e9);

        let yA = Math.ceil(tRoof - 0.5);
        if (yA < 0) yA = 0;

        let yS, yB;
        if (d0 > 1e-6) {
          yS = Math.ceil(cam.rowOf(h, d0) - 0.5);
          yB = Math.ceil(cam.rowOf(0, d0) - 0.5);
        } else {
          // The camera's own cell: its base is infinitely far below the screen.
          yS = rows;
          yB = rows;
        }
        if (yB > yTop) yB = yTop;
        if (yB > rows) yB = rows;
        if (yS > yB) yS = yB;
        if (yS < yA) yS = yA;

        /* ---- roof: horizontal plane, distance re-solved per row ---- */
        if (yA < yS) {
          // Which sides of this cell are building outline rather than
          // interior. Computed once per cell, not per row.
          let open = 0;
          if (world.h[world.sample(mapX - 1, mapY)] < h) open |= OPEN.W;
          if (world.h[world.sample(mapX + 1, mapY)] < h) open |= OPEN.E;
          if (world.h[world.sample(mapX, mapY - 1)] < h) open |= OPEN.N;
          if (world.h[world.sample(mapX, mapY + 1)] < h) open |= OPEN.S;

          const dz = camZ - h;
          for (let yy = yA; yy < yS; yy++) {
            const dR = dz * vscale / (yy + 0.5 - hz);
            const dw = dR * cam.rinv[col];
            // wx,wy are for texture only; the material values are already in
            // locals, so no re-sampling and no seam-row cell flipping.
            const wx = cam.x + rdx * dw;
            const wy = cam.y + rdy * dw;
            screen.setDepth(col, yy,
              roofGlyph(type, rnd, flags, open, wx, wy, mapX, mapY, t),
              roofColour(type, rnd, palIdx, flags, open, wx, wy, mapX, mapY,
                         fogOf(dR), t, L),
              dR);
          }
        }

        /* ---- facade: vertical wall, one distance for the whole span ---- */
        if (yS < yB) {
          const dn = Math.max(0.25, d0);
          const hitx = cam.x + rdx * prev;
          const hity = cam.y + rdy * prev;
          const u = side === 0 ? hity - Math.floor(hity) : hitx - Math.floor(hitx);
          const uu = Math.floor(u * 4);
          const pillar = u < 0.09 || u > 0.91;
          const f2 = fogOf(dn);
          const sideDim = side === 1 ? 0.68 : 1;
          const rowsPerFloor = FLOOR_H * vscale / dn;
          const pal = FACADE[palIdx];
          const lit = LIT[palIdx];
          const isVeg = type === T.TREE || type === T.FOREST;

          for (let yy = yS; yy < yB; yy++) {
            const z = camZ - (yy + 0.5 - hz) * dn / vscale;
            let ch, cc;

            if (isVeg) {
              const r = hash(mapX * 31 + ((z * 2) | 0), mapY * 17 + uu, 0);
              if (z < 1.4) {
                ch = '|';
                cc = L.depth(74 * L.amb, 54 * L.amb, 34 * L.amb, f2);
              } else {
                ch = r < 0.3 ? '&' : r < 0.7 ? '%' : '*';
                cc = L.depth((40 + r * 30) * L.amb, (110 + r * 70) * L.amb,
                             (44 + r * 30) * L.amb, f2);
              }
            } else if (rowsPerFloor < 1.25) {
              // Too far to resolve individual floors: fall back to a
              // brightness ramp with the occasional lit block.
              const lv = hash(mapX * 7 + ((z * 1.4) | 0), mapY * 13 + uu, 0);
              if (lv < L.litProb * 0.55) {
                ch = lv < L.litProb * 0.2 ? '#' : '8';
                cc = L.depth(lit[0] * 0.9, lit[1] * 0.9, lit[2] * 0.9,
                             Math.max(f2, 0.22));
              } else {
                const br = Math.max(0, Math.min(1, f2 * (0.35 + 0.65 * L.amb) * 2.4));
                ch = GLYPH_RAMP[Math.max(1, Math.round(br * (GLYPH_RAMP.length - 1)))];
                cc = L.depth(70 * L.amb * sideDim, 78 * L.amb * sideDim,
                             96 * L.amb * sideDim, f2);
              }
            } else {
              const fl = Math.floor(z / FLOOR_H);
              const frac = z / FLOOR_H - fl;
              if (frac < 0.2 || pillar) {
                ch = pillar ? '|' : '-';
                cc = L.depth(pal[0] * L.amb * sideDim * 1.5,
                             pal[1] * L.amb * sideDim * 1.5,
                             pal[2] * L.amb * sideDim * 1.5, f2);
              } else if (hash(mapX * 13 + uu, mapY * 7 + fl * 31, 0) < L.litProb) {
                // One window, textured across its own height so it does not
                // read as a flat bar.
                const sub = Math.floor((frac - 0.2) * 5);
                const v = hash(mapX * 3 + uu * 17 + sub, mapY * 5 + fl * 23, 0);
                ch = v < 0.45 ? '#' : v < 0.8 ? '8' : '%';
                const glow = 0.72 + v * 0.35;
                cc = L.depth(lit[0] * glow, lit[1] * glow, lit[2] * glow,
                             Math.max(f2, 0.2));
              } else {
                ch = ((z / FLOOR_H - fl) * 5 | 0) % 2 ? ':' : '.';
                cc = L.depth(pal[0] * L.amb * sideDim, pal[1] * L.amb * sideDim,
                             pal[2] * L.amb * sideDim, f2);
              }
            }
            screen.setDepth(col, yy, ch, cc, dn);
          }
        }

        if (yA < yTop) {
          yTop = yA;
          // Exact early-out, valid only while the camera is below the tallest
          // geometry. In that regime rowOf(hMax, d) rises monotonically toward
          // the horizon, so once the tallest possible thing at distance d
          // projects below the watermark, everything beyond d does too.
          //
          // It genuinely does not apply when flying above the skyline: there
          // rowOf(hMax, d) falls toward the horizon, so distant geometry
          // appears HIGHER on screen and being hidden at d says nothing about
          // 2d. Cutting there silently deletes visible rooftops. From above
          // you really can see to the fog limit, and the cost is bounded by
          // FAR instead.
          dCut = (camZ < hMax && yTop < hz + 0.5)
            ? (hMax - camZ) * vscale / (hz + 0.5 - yTop)
            : Infinity;
        }
      }

      if (yTop <= 0 || next > FAR || next * cosC > dCut) break;

      if (sX < sY) { sX += ddX; mapX += stepX; side = 0; }
      else { sY += ddY; mapY += stepY; side = 1; }
      prev = next;
    }

    screen.skyEnd[col] = Math.min(yTop, Math.max(0, Math.ceil(hz)));
  }
}

export function renderScene(screen, cam, world, L, t) {
  castFloor(screen, cam, world, L, t);
  castWorld(screen, cam, world, L, t);
}
