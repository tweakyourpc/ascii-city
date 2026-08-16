/**
 * Solar and stellar positions. Pure functions, no dependencies.
 *
 * Accuracy is low-precision-almanac grade: sun position to within about a
 * degree, which is far tighter than a character grid can show.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function julianDay(date) {
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  if (m <= 2) { y--; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const jd0 = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1))
            + d + B - 1524.5;
  // Without the time of day the sun never moves.
  const frac = (date.getUTCHours() + date.getUTCMinutes() / 60
              + date.getUTCSeconds() / 3600
              + date.getUTCMilliseconds() / 3600000) / 24;
  return jd0 + frac;
}

/** Apparent right ascension (degrees) and declination (degrees) of the sun. */
export function sunPos(jd) {
  const n = jd - 2451545.0;
  let L = (280.460 + 0.9856474 * n) % 360; if (L < 0) L += 360;
  let g = (357.528 + 0.9856003 * n) % 360; if (g < 0) g += 360;
  const lambda = (L + 1.915 * Math.sin(g * D2R) + 0.020 * Math.sin(2 * g * D2R)) % 360;
  const eps = 23.439 - 0.0000004 * n;
  let ra = Math.atan2(Math.cos(eps * D2R) * Math.sin(lambda * D2R),
                      Math.cos(lambda * D2R)) * R2D;
  if (ra < 0) ra += 360;
  const dec = Math.asin(Math.sin(eps * D2R) * Math.sin(lambda * D2R)) * R2D;
  return { ra, dec };
}

/** Local sidereal time in hours. */
export function lst(jd, lon) {
  const n = jd - 2451545.0;
  let gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  if (gmst < 0) gmst += 24;
  return (gmst + lon / 15 + 24) % 24;
}

/** Equatorial to horizontal coordinates. `raH` in hours, everything else degrees. */
export function altAz(raH, decD, jd, lat, lon) {
  const ra = raH * 15;
  const sid = lst(jd, lon) * 15;
  const ha = (sid - ra) * D2R;
  const decR = decD * D2R;
  const latR = lat * D2R;
  const alt = Math.asin(Math.sin(decR) * Math.sin(latR)
            + Math.cos(decR) * Math.cos(latR) * Math.cos(ha)) * R2D;
  let az = Math.atan2(-Math.sin(ha),
             Math.tan(decR) * Math.cos(latR) - Math.sin(latR) * Math.cos(ha)) * R2D;
  if (az < 0) az += 360;
  return { alt, az };
}

/**
 * [right ascension hours, declination degrees, visual magnitude].
 * The named bright stars, then a fixed procedural field so the sky isn't empty.
 */
export const STARS = [
  [18.6156, 38.78, 0.03], [2.5297, 89.26, 1.97], [5.2423, -8.20, 0.18],
  [5.9195, 7.41, 0.50], [6.7525, -16.72, -1.46], [14.2610, 19.18, 0.05],
  [6.3992, -52.70, -0.72], [19.8463, 8.87, 0.77], [7.6550, 5.22, 0.34],
  [4.5987, 16.51, 0.85], [12.4433, -63.10, 1.25], [13.4200, -11.16, 0.98],
];

(function fillSky() {
  let s = 991;
  const r = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < 700; i++) {
    STARS.push([r() * 24, Math.asin(r() * 2 - 1) * R2D, 1.6 + r() * 2.6]);
  }
})();
