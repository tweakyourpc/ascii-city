import { METERS_PER_CELL } from './config.js';

/** Read-only HUD readouts. City picker wiring lands with the OSM work. */
export class Hud {
  constructor() {
    this.warp = document.getElementById('warp');
    this.warpv = document.getElementById('warpv');
    this.clock = document.getElementById('clock');
    this.phase = document.getElementById('phase');
    this.loc = document.getElementById('loc');
  }

  warpFactor() {
    return Math.pow(10, Number(this.warp.value) / 25);
  }

  update({ warp, simTime, lon, sunAlt, cam, screen, fps }) {
    this.warpv.textContent = (warp < 10 ? warp.toFixed(1) : Math.round(warp)) + 'x';

    const local = new Date(simTime + lon / 15 * 3600000);
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mm = String(local.getUTCMinutes()).padStart(2, '0');
    this.clock.textContent = `${hh}:${mm}`;
    this.phase.textContent = sunAlt > 0 ? '(day)' : sunAlt > -6 ? '(twilight)' : '(night)';

    const altM = Math.round(cam.z * METERS_PER_CELL);
    this.loc.textContent =
      `x ${cam.x.toFixed(0)}  y ${cam.y.toFixed(0)}  ·  alt ${altM}m` +
      `  ·  ${screen.cols}x${screen.rows} cells  ·  ${fps.toFixed(0)} fps`;
  }
}
