import { METERS_PER_CELL } from './config.js';
import { PRESETS, parseLocation } from './world/overpass.js';

/** HUD readouts, the city picker, and the URL hash that makes a view shareable. */
export class Hud {
  constructor({ onLoad }) {
    this.warp = document.getElementById('warp');
    this.warpv = document.getElementById('warpv');
    this.clock = document.getElementById('clock');
    this.phase = document.getElementById('phase');
    this.loc = document.getElementById('loc');
    this.where = document.getElementById('where');
    this.attrib = document.getElementById('attrib');
    this.city = document.getElementById('city');
    this.coords = document.getElementById('coords');
    this.go = document.getElementById('go');
    this.onLoad = onLoad;

    for (const [key, preset] of Object.entries(PRESETS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = preset.label;
      this.city.appendChild(opt);
    }

    this.city.addEventListener('change', () => {
      const key = this.city.value;
      this.onLoad({ preset: key, bbox: PRESETS[key].bbox, label: PRESETS[key].label });
    });

    this.go.addEventListener('click', () => this._submitCoords());
    this.coords.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._submitCoords();
      e.stopPropagation();
    });
  }

  _submitCoords() {
    const bbox = parseLocation(this.coords.value);
    if (!bbox) {
      this.setError('Could not read that. Try "40.75,-73.98" or "s,w,n,e".');
      return;
    }
    this.city.value = '';
    this.onLoad({ preset: null, bbox, label: 'Custom area' });
  }

  /**
   * Reflect the current view in the URL, so any moment can be shared or
   * reloaded exactly. Written with replaceState, so it adds no history
   * entries, and throttled so it is not touched every frame.
   */
  syncHash({ preset, bbox }, cam = null, hour = null) {
    const parts = [];
    if (preset) parts.push(`city=${preset}`);
    else if (bbox) parts.push(`bbox=${bbox.map((v) => v.toFixed(5)).join(',')}`);

    if (cam) {
      parts.push(`x=${cam.x.toFixed(1)}`, `y=${cam.y.toFixed(1)}`,
                 `z=${cam.z.toFixed(1)}`, `a=${cam.angle.toFixed(3)}`,
                 `p=${cam.pitch.toFixed(1)}`);
    }
    if (hour !== null) parts.push(`h=${hour.toFixed(2)}`);

    const hash = parts.length ? '#' + parts.join('&') : '';
    if (location.hash !== hash) {
      history.replaceState(null, '', hash || location.pathname);
    }
  }

  /**
   * Read the initial view from the URL.
   * Accepts `city=` or `bbox=`, plus optional camera placement (x, y, z, a,
   * p) and hour of day (h). Camera keys are how the screenshots in docs/ are
   * reproduced.
   */
  static initialView() {
    const q = new URLSearchParams(location.hash.slice(1));
    const num = (k) => (q.has(k) ? Number(q.get(k)) : undefined);
    const finite = (v) => (Number.isFinite(v) ? v : undefined);

    const camera = {
      x: finite(num('x')), y: finite(num('y')), z: finite(num('z')),
      angle: finite(num('a')), pitch: finite(num('p')),
    };
    const hour = finite(num('h'));

    const city = q.get('city');
    if (city && PRESETS[city]) {
      return { preset: city, bbox: PRESETS[city].bbox,
               label: PRESETS[city].label, camera, hour };
    }
    const bbox = q.get('bbox');
    if (bbox) {
      const parsed = parseLocation(bbox);
      if (parsed) return { preset: null, bbox: parsed, label: 'Custom area', camera, hour };
    }
    return { preset: 'procedural', bbox: null,
             label: PRESETS.procedural.label, camera, hour };
  }

  select(preset) {
    if (preset) this.city.value = preset;
  }

  setBusy(busy) {
    this.go.disabled = busy;
    this.city.disabled = busy;
  }

  setError(msg) {
    this.attrib.className = 'err';
    this.attrib.textContent = msg;
  }

  /**
   * OpenStreetMap's licence requires attribution wherever its data is shown.
   */
  setAttribution(world) {
    this.attrib.className = 'dim';
    if (!world.bbox) {
      this.attrib.textContent = 'Procedural world. No map data.';
      return;
    }
    const km = (world.width * METERS_PER_CELL / 1000).toFixed(2);
    this.attrib.innerHTML =
      `${world.label} &middot; ${world.stats.buildings} buildings, ` +
      `${world.stats.roads} ways &middot; ${km} km across &middot; ` +
      'map data &copy; <a href="https://www.openstreetmap.org/copyright" ' +
      'target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  }

  warpFactor() {
    return Math.pow(10, Number(this.warp.value) / 25);
  }

  update({ warp, simTime, lon, sunAlt, cam, screen, fps, where,
           labelMode, trafficMode }) {
    this.warpv.textContent = (warp < 10 ? warp.toFixed(1) : Math.round(warp)) + 'x';

    const local = new Date(simTime + lon / 15 * 3600000);
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mm = String(local.getUTCMinutes()).padStart(2, '0');
    this.clock.textContent = `${hh}:${mm}`;
    this.phase.textContent = sunAlt > 0 ? '(day)' : sunAlt > -6 ? '(twilight)' : '(night)';

    // The cheapest possible answer to "where am I", and the least intrusive.
    if (this.where) {
      if (where && where.on) {
        const cross = where.cross && where.crossDist < 26
          ? ` · near ${where.cross}` : '';
        this.where.textContent = where.on.toUpperCase() + cross.toUpperCase();
      } else {
        this.where.textContent = '';
      }
    }

    const altM = Math.round(cam.z * METERS_PER_CELL);
    this.loc.textContent =
      `x ${cam.x.toFixed(0)}  y ${cam.y.toFixed(0)}  ·  alt ${altM} m` +
      `  ·  ${screen.cols}x${screen.rows} cells  ·  ${fps.toFixed(0)} fps` +
      (labelMode === 0 ? '  ·  labels off' : '') +
      (trafficMode === 0 ? '  ·  traffic off' : '');
  }
}
