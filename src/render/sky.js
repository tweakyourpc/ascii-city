import { col2str } from '../screen.js';
import { normAngle } from '../camera.js';
import { altAz, STARS } from '../astro.js';
import { FOV } from '../config.js';

/**
 * Project a horizontal coordinate (azimuth, altitude in degrees) to a grid cell.
 * Objects at infinity, so nothing here depends on the camera's height.
 */
export function project(screen, cam, azDeg, altDeg) {
  const theta = (90 - azDeg) * Math.PI / 180;
  const da = normAngle(theta - cam.angle);
  if (Math.abs(da) > FOV * 0.7) return null;

  const x = Math.round(screen.cols / 2 + Math.tan(da) * screen.proj);
  const y = Math.round(cam.hz - Math.tan(Math.min(85, altDeg) * Math.PI / 180) * screen.vscale);
  if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows) return null;
  return { x, y };
}

/**
 * Paint the sky gradient onto the canvas directly, up to each column's sky
 * limit, then overlay stars and the sun as glyphs.
 */
export function drawSky(screen, cam, L, site, jd, sun, sunAlt, dayK) {
  const { ctx, cols, cw, ch, skyEnd } = screen;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, screen.width, screen.height);

  const gh = Math.max(2, cam.hz * ch);
  const grad = ctx.createLinearGradient(0, 0, 0, gh);
  grad.addColorStop(0, col2str(...L.skyTop));
  grad.addColorStop(1, col2str(...L.skyBottom));
  ctx.fillStyle = grad;

  // One rect per run of columns sharing a sky height, rather than one per column.
  let run = 0;
  for (let x = 0; x <= cols; x++) {
    if (x === cols || skyEnd[x] !== skyEnd[run]) {
      if (skyEnd[run] > 0) ctx.fillRect(run * cw, 0, (x - run) * cw + 1, skyEnd[run] * ch);
      run = x;
    }
  }

  if (dayK < 0.62) {
    const starDim = 1 - dayK / 0.62;
    for (let i = 0; i < STARS.length; i++) {
      const st = STARS[i];
      const q = altAz(st[0], st[1], jd, site.lat, site.lon);
      if (q.alt <= 1) continue;
      const p = project(screen, cam, q.az, q.alt);
      if (!p || p.y >= skyEnd[p.x]) continue;
      const m = st[2];
      const bright = Math.max(0, Math.min(1, (4.7 - m) / 4.6)) * starDim;
      if (bright < 0.06) continue;
      screen.set(p.x, p.y, m < 0.6 ? '*' : m < 2 ? '+' : '.',
                 col2str(250 * bright, 220 * bright, 255 * bright));
    }
  }

  if (sunAlt > -2) {
    const p = project(screen, cam, sun.az, sunAlt);
    if (p) {
      const warm = sunAlt < 8;
      const sc = warm ? col2str(255, 168, 90) : col2str(255, 244, 200);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          const sx = p.x + ox;
          const sy = p.y + oy;
          if (sx < 0 || sx >= cols || sy < 0 || sy >= skyEnd[sx]) continue;
          if (Math.abs(ox) + Math.abs(oy) * 2 > 3) continue;
          screen.set(sx, sy, '@', sc);
        }
      }
    }
  }
}
