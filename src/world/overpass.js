/**
 * Overpass API client.
 *
 * Overpass is a free, volunteer-run service. Everything here is shaped by that:
 * a small bounding-box cap so a stray query cannot ask for a country, a cache
 * so panning back to a city costs nothing, endpoint fallback, and a hard
 * timeout instead of an indefinite hang.
 *
 * Overpass sends Access-Control-Allow-Origin: *, so this works from a browser
 * with no proxy.
 */

/**
 * Public instances are individually unreliable, and which one is healthy
 * varies by the minute: in testing, one endpoint timed out on a query another
 * answered in four seconds. The order is shuffled per call, or a degraded
 * first entry would fail every load.
 *
 * Only worldwide instances belong here. Regional mirrors such as
 * overpass.osm.ch answer 200 with zero elements for anywhere outside their
 * coverage, which is indistinguishable from genuinely empty map data.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const TIMEOUT_MS = 45000;

// Some instances rate-limit requests that arrive without a meaningful
// User-Agent. Browsers set their own and silently ignore this header; it is
// here so the engine is a good citizen when driven from Node, in tests and
// from tools/.
const UA = 'ascii-city/0.3 (+https://github.com/tweakyourpc/ascii-city)';
const CACHE_PREFIX = 'ascii-city:osm:';
const CACHE_VERSION = 1;

/** Largest bbox we will ask for, in square degrees. About 2km x 2km at 40N. */
export const MAX_BBOX_DEG2 = 0.0006;

/**
 * Preset cities. Boxes are around 1.2km a side: big enough to fly across,
 * small enough that Overpass answers in a few seconds.
 */
export const PRESETS = {
  procedural: { label: 'Procedural City', bbox: null },
  manhattan: {
    label: 'Manhattan (Midtown)',
    bbox: [40.7466, -73.9900, 40.7576, -73.9750],
  },
  tokyo: {
    label: 'Tokyo (Shinjuku)',
    bbox: [35.6870, 139.6970, 35.6980, 139.7120],
  },
  london: {
    label: 'London (The City)',
    bbox: [51.5100, -0.0920, 51.5210, -0.0760],
  },
  paris: {
    label: 'Paris (Louvre)',
    bbox: [48.8580, 2.3300, 48.8690, 2.3460],
  },
};

/**
 * The query is split in two.
 *
 * Buildings and streets are what make a city recognisable, so they are fetched
 * as one required request. Water and green space are a separate best-effort
 * request: they improve the scene but a slow or failing instance must not stop
 * the city from loading.
 *
 * `out geom` inlines coordinates on ways and on relation members, so there is
 * no second pass to resolve node ids.
 */
export function buildQuery([s, w, n, e], layer = 'core') {
  const bbox = `${s},${w},${n},${e}`;
  if (layer === 'core') {
    return `[out:json][timeout:60];
(
  nwr["building"](${bbox});
  way["highway"](${bbox});
);
out geom;`;
  }
  return `[out:json][timeout:60];
(
  way["waterway"~"^(river|canal|stream)$"](${bbox});
  nwr["natural"="water"](${bbox});
  nwr["leisure"~"^(park|garden|pitch)$"](${bbox});
  nwr["landuse"~"^(grass|forest|meadow|farmland|cemetery)$"](${bbox});
);
out geom;`;
}

export function bboxArea([s, w, n, e]) {
  return Math.abs(n - s) * Math.abs(e - w);
}

/**
 * Parse a user-supplied location string.
 * Accepts "s,w,n,e", a bare "lat,lon" (a box is built around it), or an
 * openstreetmap.org URL with a #map=zoom/lat/lon fragment.
 */
export function parseLocation(text, { spanDeg = 0.011 } = {}) {
  const raw = String(text).trim();
  if (!raw) return null;

  const osm = /#map=[\d.]+\/(-?[\d.]+)\/(-?[\d.]+)/.exec(raw);
  if (osm) return boxAround(Number(osm[1]), Number(osm[2]), spanDeg);

  const nums = raw.split(/[\s,]+/).map(Number).filter((v) => !Number.isNaN(v));

  if (nums.length === 4) {
    const [a, b, c, d] = nums;
    // Accept either corner ordering.
    const box = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    return validBox(box) ? box : null;
  }
  if (nums.length === 2) {
    const [lat, lon] = nums;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return boxAround(lat, lon, spanDeg);
  }
  return null;
}

function boxAround(lat, lon, spanDeg) {
  // Keep the box roughly square on the ground, not in degrees.
  const half = spanDeg / 2;
  const lonHalf = half / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const box = [lat - half, lon - lonHalf, lat + half, lon + lonHalf];
  return validBox(box) ? box : null;
}

function validBox([s, w, n, e]) {
  return Math.abs(s) <= 90 && Math.abs(n) <= 90
      && Math.abs(w) <= 180 && Math.abs(e) <= 180
      && n > s && e > w;
}

const cacheKey = (bbox) =>
  CACHE_PREFIX + CACHE_VERSION + ':' + bbox.map((v) => v.toFixed(5)).join(',');

function readCache(bbox) {
  try {
    const hit = localStorage.getItem(cacheKey(bbox));
    return hit ? JSON.parse(hit) : null;
  } catch {
    return null;
  }
}

function writeCache(bbox, data) {
  try {
    localStorage.setItem(cacheKey(bbox), JSON.stringify(data));
  } catch {
    // Quota exceeded, or storage disabled. Drop our own old entries and retry
    // once; a cache miss is not worth failing a load over.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(cacheKey(bbox), JSON.stringify(data));
    } catch { /* give up silently */ }
  }
}

const shuffled = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * Run one query, trying instances until one answers.
 * @param {boolean} expectData treat an empty 200 as a failed instance and move
 *   on, rather than as an answer. Guards against a mirror that is up but does
 *   not hold data for the requested area.
 */
async function runQuery(query, { onProgress, signal, label, expectData = false }) {
  const urls = shuffled(ENDPOINTS);
  let lastErr = null;

  for (let i = 0; i < urls.length; i++) {
    onProgress(i === 0 ? `Querying ${label}` : `Retrying ${label} (${i + 1}/${urls.length})`);

    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), TIMEOUT_MS);
    const relay = () => timer.abort();
    if (signal) signal.addEventListener('abort', relay, { once: true });

    try {
      const res = await fetch(urls[i], {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        signal: timer.signal,
      });

      if (res.status === 429 || res.status === 504 || res.status === 503) {
        lastErr = new Error('That Overpass instance is busy');
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`Overpass returned ${res.status}`);
        continue;
      }
      const json = await res.json();
      const elements = json.elements || [];
      if (expectData && elements.length === 0) {
        // Up, but holds nothing here. Ask somebody else before concluding the
        // area is empty.
        lastErr = new Error('That instance has no data for this area');
        continue;
      }
      return elements;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err.name === 'AbortError' ? new Error('Overpass timed out') : err;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', relay);
    }
  }
  throw lastErr || new Error('Could not reach Overpass');
}

/**
 * Fetch OSM elements for a bounding box.
 * @param {number[]} bbox [south, west, north, east]
 * @param {{ onProgress?: (msg: string) => void, signal?: AbortSignal }} opts
 * @returns {Promise<Array>} OSM elements with inline geometry
 */
export async function fetchOsm(bbox, { onProgress = () => {}, signal } = {}) {
  if (!validBox(bbox)) throw new Error('Invalid bounding box');

  const area = bboxArea(bbox);
  if (area > MAX_BBOX_DEG2) {
    const times = (area / MAX_BBOX_DEG2).toFixed(1);
    throw new Error(
      `Area is ${times}x the limit. Try a smaller box (about 2km a side).`);
  }

  const cached = readCache(bbox);
  if (cached) {
    onProgress('Loaded from cache');
    return cached;
  }

  const core = await runQuery(buildQuery(bbox, 'core'),
    { onProgress, signal, label: 'buildings and streets', expectData: true });

  // Best effort. A missing river is worth far less than a failed load.
  let extra = [];
  try {
    extra = await runQuery(buildQuery(bbox, 'detail'),
      { onProgress, signal, label: 'water and parks' });
  } catch (err) {
    if (signal?.aborted) throw err;
    onProgress('Skipped water and parks');
  }

  const elements = core.concat(extra);
  writeCache(bbox, elements);
  return elements;
}
