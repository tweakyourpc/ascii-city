/**
 * Solar system positions, checked against physics rather than against a stored
 * ephemeris.
 *
 * These invariants are not decorative: greatest elongation and sidereal period
 * between them pin down the orbital elements, the geometry of the
 * heliocentric-to-geocentric conversion, and the Kepler solver. Essentially any
 * implementation error moves at least one of them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planet, planets, moon, sunEcliptic, daysSinceEpoch,
  phaseName, moonGlyph, PLANET_NAMES,
} from '../src/planets.js';
import { julianDay, altAz, sunPos, NAMED_STARS, STARS } from '../src/astro.js';

const DAY = 86400000;
const at = (y, m, d, h = 0) => new Date(Date.UTC(y, m, d, h));

/* -------------------------------- planets -------------------------------- */

test('the inner planets never stray further from the Sun than they can', () => {
  // Mercury reaches 28 degrees, Venus 47. Exceeding these means the
  // heliocentric-to-geocentric conversion is wrong.
  const max = { Mercury: 0, Venus: 0 };
  for (let day = 0; day < 365 * 8; day++) {
    const d = daysSinceEpoch(new Date(at(2026, 0, 1).getTime() + day * DAY));
    for (const name of ['Mercury', 'Venus']) {
      max[name] = Math.max(max[name], planet(name, d).elongation);
    }
  }
  assert.ok(max.Mercury <= 28.5 && max.Mercury > 26,
    `Mercury greatest elongation ${max.Mercury.toFixed(1)}, expected about 28`);
  assert.ok(max.Venus <= 47.5 && max.Venus > 45,
    `Venus greatest elongation ${max.Venus.toFixed(1)}, expected about 47`);
});

test('the outer planets reach opposition', () => {
  const max = { Mars: 0, Jupiter: 0, Saturn: 0 };
  for (let day = 0; day < 365 * 8; day += 2) {
    const d = daysSinceEpoch(new Date(at(2026, 0, 1).getTime() + day * DAY));
    for (const name of Object.keys(max)) {
      max[name] = Math.max(max[name], planet(name, d).elongation);
    }
  }
  for (const [name, v] of Object.entries(max)) {
    assert.ok(v > 170, `${name} never got further than ${v.toFixed(0)} from the Sun`);
  }
});

test('sidereal periods match the real ones', () => {
  // Measured from HELIOCENTRIC longitude. The geocentric longitude of an
  // inner planet never leaves the Sun's neighbourhood, so it tracks the year
  // rather than the planet's own orbit.
  const truth = {
    Mercury: 0.2408, Venus: 0.6152, Mars: 1.8808,
    Jupiter: 11.862, Saturn: 29.457,
  };
  for (const [name, years] of Object.entries(truth)) {
    const span = years * 365.25 * 4;
    const step = Math.max(0.25, years * 365.25 / 60);
    let prev = null;
    let turns = 0;
    let first = null;
    let last = 0;

    for (let day = 0; day <= span; day += step) {
      const d = daysSinceEpoch(new Date(at(2026, 0, 1).getTime() + day * DAY));
      const lon = planet(name, d).helioLon;
      if (prev !== null && lon < prev - 180) {
        turns++;
        if (first === null) first = day;
        last = day;
      }
      prev = lon;
    }

    assert.ok(turns >= 3, `${name} completed only ${turns} orbits in the window`);
    // Time between the first and last wrap covers exactly turns-1 orbits.
    const period = (last - first) / (turns - 1) / 365.25;
    assert.ok(Math.abs(period - years) / years < 0.01,
      `${name} period came out ${period.toFixed(4)} yr, expected ${years}`);
  }
});

test('planets stay near the ecliptic', () => {
  let worst = 0;
  for (let day = 0; day < 365 * 6; day += 3) {
    const d = daysSinceEpoch(new Date(at(2026, 0, 1).getTime() + day * DAY));
    for (const p of planets(d)) worst = Math.max(worst, Math.abs(p.lat));
  }
  // Venus can reach about 8.5 degrees geocentric near inferior conjunction.
  assert.ok(worst < 10, `a planet reached ecliptic latitude ${worst.toFixed(1)}`);
});

test('planet magnitudes are in the right range and vary', () => {
  const seen = {};
  for (let day = 0; day < 365 * 4; day += 5) {
    const d = daysSinceEpoch(new Date(at(2026, 0, 1).getTime() + day * DAY));
    for (const p of planets(d)) {
      const s = seen[p.name] || (seen[p.name] = { lo: 99, hi: -99 });
      s.lo = Math.min(s.lo, p.mag);
      s.hi = Math.max(s.hi, p.mag);
    }
  }
  assert.ok(seen.Venus.lo < -3.5, `Venus never got brighter than ${seen.Venus.lo}`);
  assert.ok(seen.Jupiter.lo < -1.5, `Jupiter never got brighter than ${seen.Jupiter.lo}`);
  assert.ok(seen.Mars.hi - seen.Mars.lo > 2,
    'Mars magnitude should swing widely between conjunction and opposition');
  for (const [name, s] of Object.entries(seen)) {
    assert.ok(Number.isFinite(s.lo) && Number.isFinite(s.hi), `${name} magnitude is NaN`);
  }
});

test('every planet returns finite coordinates', () => {
  for (const name of PLANET_NAMES) {
    const p = planet(name, daysSinceEpoch(at(2026, 5, 15)));
    assert.ok(Number.isFinite(p.ra) && p.ra >= 0 && p.ra < 24, `${name} ra`);
    assert.ok(Number.isFinite(p.dec) && Math.abs(p.dec) <= 90, `${name} dec`);
    assert.ok(p.dist > 0, `${name} distance`);
  }
});

/* --------------------------------- Moon ---------------------------------- */

test('the Moon stays at a plausible distance', () => {
  let lo = 1e9;
  let hi = 0;
  for (let h = 0; h < 24 * 365 * 3; h += 6) {
    const d = daysSinceEpoch(new Date(at(2026, 0, 1).getTime() + h * 3600000));
    const km = moon(d).distKm;
    lo = Math.min(lo, km);
    hi = Math.max(hi, km);
  }
  // True range is 356,500 to 406,700 km.
  assert.ok(lo > 352000 && lo < 360000, `perigee came out ${Math.round(lo)} km`);
  assert.ok(hi > 402000 && hi < 410000, `apogee came out ${Math.round(hi)} km`);
});

test('the Moon stays within about five degrees of the ecliptic', () => {
  let worst = 0;
  for (let h = 0; h < 24 * 365 * 2; h += 6) {
    const d = daysSinceEpoch(new Date(at(2026, 0, 1).getTime() + h * 3600000));
    worst = Math.max(worst, Math.abs(moon(d).lat));
  }
  assert.ok(worst > 4.5 && worst < 6,
    `lunar ecliptic latitude reached ${worst.toFixed(2)}, expected about 5.3`);
});

test('the synodic month is right, and varies the way it really does', () => {
  // Phase is measured against the Sun's TRUE longitude. Using the mean
  // longitude instead puts this 29 minutes per lunation out.
  const el = (d) => {
    const e = (moon(d).elongation + 360) % 360;
    return e > 180 ? e - 360 : e;
  };
  const start = at(2026, 0, 1).getTime();
  const events = [];
  let prev = el(daysSinceEpoch(new Date(start)));

  for (let h = 1; h < 24 * 365 * 8; h++) {
    const d = daysSinceEpoch(new Date(start + h * 3600000));
    const e = el(d);
    if (prev < 0 && e >= 0) {
      let lo = d - 1 / 24;
      let hi = d;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (el(mid) < 0) lo = mid; else hi = mid;
      }
      events.push((lo + hi) / 2);
    }
    prev = e;
  }

  assert.ok(events.length > 90, `only found ${events.length} new moons in 8 years`);
  const gaps = events.slice(1).map((v, i) => v - events[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  // 0.006 d is the residual of a twelve-term lunar theory, about 8 minutes.
  assert.ok(Math.abs(mean - 29.53059) < 0.006,
    `mean synodic month ${mean.toFixed(5)} d, expected 29.53059`);
  assert.ok(Math.min(...gaps) > 29.2 && Math.max(...gaps) < 29.9,
    'the synodic month should vary between about 29.27 and 29.83 days');
});

test('phase names and glyphs follow the elongation', () => {
  assert.equal(phaseName(0), 'new');
  assert.equal(phaseName(90), 'first quarter');
  assert.equal(phaseName(180), 'full');
  assert.equal(phaseName(270), 'last quarter');
  assert.equal(phaseName(359), 'new');
  assert.notEqual(moonGlyph(1), moonGlyph(0));
});

test('a full moon is opposite the Sun in the sky', () => {
  // Find a full moon, then check it rises as the Sun sets.
  const start = at(2026, 0, 1).getTime();
  let full = null;
  for (let h = 0; h < 24 * 40 && !full; h++) {
    const when = new Date(start + h * 3600000);
    const m = moon(daysSinceEpoch(when));
    if (Math.abs(m.elongation - 180) < 0.3) full = when;
  }
  assert.ok(full, 'no full moon found in 40 days');

  const jd = julianDay(full);
  const m = moon(daysSinceEpoch(full));
  const s = sunPos(jd);
  const lat = 40.71;
  const lon = -74.0;
  const ms = altAz(m.ra, m.dec, jd, lat, lon);
  const ss = altAz(s.ra / 15, s.dec, jd, lat, lon);
  // Opposite in the sky means one is up when the other is down.
  assert.ok(Math.sign(ms.alt) !== Math.sign(ss.alt) || Math.abs(ms.alt) < 6,
    `full moon altitude ${ms.alt.toFixed(1)} with Sun at ${ss.alt.toFixed(1)}`);
});

/* --------------------------------- stars --------------------------------- */

test('the named star catalogue lines up with the coordinate table', () => {
  assert.ok(NAMED_STARS.length > 12);
  assert.ok(STARS.length > NAMED_STARS.length);
  for (let i = 0; i < NAMED_STARS.length; i++) {
    assert.ok(NAMED_STARS[i].name, `entry ${i} has no name`);
    const [ra, dec, mag] = STARS[i];
    assert.ok(ra >= 0 && ra < 24, `${NAMED_STARS[i].name} ra out of range`);
    assert.ok(Math.abs(dec) <= 90, `${NAMED_STARS[i].name} dec out of range`);
    assert.ok(mag < 3.5, `${NAMED_STARS[i].name} is too faint to be a named star`);
  }
});

test('the named stars are where they should be', () => {
  // Spot-check against catalogue positions, to a tenth of a degree.
  const want = {
    Sirius: [6.7525, -16.72], Vega: [18.6156, 38.78],
    Polaris: [2.5297, 89.26], Betelgeuse: [5.9195, 7.41],
    Rigel: [5.2423, -8.20], Capella: [5.2782, 45.998],
    Antares: [16.4901, -26.43], Deneb: [20.6905, 45.28],
  };
  for (const [name, [ra, dec]] of Object.entries(want)) {
    const i = NAMED_STARS.findIndex((s) => s.name === name);
    assert.ok(i >= 0, `${name} missing from the catalogue`);
    assert.ok(Math.abs(STARS[i][0] - ra) < 0.01, `${name} ra`);
    assert.ok(Math.abs(STARS[i][1] - dec) < 0.1, `${name} dec`);
  }
});

test('Polaris sits near the pole all night', () => {
  const i = NAMED_STARS.findIndex((s) => s.name === 'Polaris');
  const lat = 40.71;
  let lo = 99;
  let hi = -99;
  for (let h = 0; h < 24; h++) {
    const when = at(2026, 2, 20, h);
    const q = altAz(STARS[i][0], STARS[i][1], julianDay(when), lat, -74);
    lo = Math.min(lo, q.alt);
    hi = Math.max(hi, q.alt);
  }
  // Its altitude equals the observer's latitude, within a degree.
  assert.ok(Math.abs(lo - lat) < 1.5 && Math.abs(hi - lat) < 1.5,
    `Polaris altitude ranged ${lo.toFixed(1)} to ${hi.toFixed(1)} at latitude ${lat}`);
});

/* -------------------------------- the Sun -------------------------------- */

test('the shared solar longitude agrees with the existing sun model', () => {
  // planets.js recomputes the Sun to get Earth's position. If it drifted from
  // astro.js the planets would be systematically offset.
  for (const when of [at(2026, 0, 15), at(2026, 5, 21), at(2026, 9, 3)]) {
    const a = sunEcliptic(daysSinceEpoch(when));
    const b = sunPos(julianDay(when));
    // Convert the shared ecliptic longitude to RA for comparison.
    const eps = 23.4393 * Math.PI / 180;
    const lo = a.lon * Math.PI / 180;
    let ra = Math.atan2(Math.cos(eps) * Math.sin(lo), Math.cos(lo)) * 180 / Math.PI;
    if (ra < 0) ra += 360;
    const diff = Math.abs(((ra - b.ra + 540) % 360) - 180);
    assert.ok(diff < 0.5,
      `solar RA differs by ${diff.toFixed(2)} degrees between the two models`);
  }
});
