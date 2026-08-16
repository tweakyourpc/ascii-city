/**
 * Boot the whole app under a minimal DOM and canvas shim.
 *
 * main.js and hud.js are the only modules that touch the browser, so they get
 * no coverage from the geometry tests. This catches the failures that actually
 * happen there: a renamed element id, a mis-wired listener, a HUD field that
 * throws on first paint.
 *
 * The shim is deliberately small. It is not a browser, and it does not try to
 * be: it records that the right calls were made.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/** A tiny hand-built OSM extract around 40.758N, -73.9855W. */
const SYNTHETIC_OSM = [
  {
    type: 'way', id: 1,
    tags: { building: 'yes', 'building:levels': '12' },
    geometry: [
      { lat: 40.7570, lon: -73.9865 }, { lat: 40.7570, lon: -73.9855 },
      { lat: 40.7578, lon: -73.9855 }, { lat: 40.7578, lon: -73.9865 },
      { lat: 40.7570, lon: -73.9865 },
    ],
  },
  {
    type: 'way', id: 2,
    tags: { building: 'yes', height: '180 m' },
    geometry: [
      { lat: 40.7582, lon: -73.9865 }, { lat: 40.7582, lon: -73.9850 },
      { lat: 40.7590, lon: -73.9850 }, { lat: 40.7590, lon: -73.9865 },
      { lat: 40.7582, lon: -73.9865 },
    ],
  },
  {
    type: 'way', id: 3,
    tags: { highway: 'primary', name: 'Test Avenue' },
    geometry: [
      { lat: 40.7560, lon: -73.9860 }, { lat: 40.7600, lon: -73.9860 },
    ],
  },
  {
    type: 'way', id: 4,
    tags: { highway: 'residential' },
    geometry: [
      { lat: 40.7580, lon: -73.9880 }, { lat: 40.7580, lon: -73.9835 },
    ],
  },
];

function installDom() {
  const els = new Map();
  const windowListeners = new Map();
  let fillText = 0;
  let fillRect = 0;

  class El {
    constructor(id, tag = 'div') {
      this.id = id;
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.style = {};
      this.classList = { add() {}, remove() {} };
      this.value = '';
      this.disabled = false;
      this.className = '';
      this._text = '';
      this._on = {};
    }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(k, fn) { (this._on[k] ||= []).push(fn); }
    removeEventListener() {}
    fire(k, ev = {}) {
      for (const fn of this._on[k] || []) {
        fn({ preventDefault() {}, stopPropagation() {}, ...ev });
      }
    }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { this._text = String(v); }
    get innerHTML() { return this._text; }
    getContext() { return ctx; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; }
  }

  const ctx = {
    font: '14px monospace',
    textBaseline: 'top',
    fillStyle: '#000',
    measureText: (s) => ({ width: s.length * 8 }),
    fillText: () => { fillText++; },
    fillRect: () => { fillRect++; },
    createLinearGradient: () => ({ addColorStop() {} }),
  };

  for (const id of ['c', 'warp', 'warpv', 'clock', 'phase',
                    'loc', 'attrib', 'city', 'coords', 'go']) {
    els.set(id, new El(id, id === 'c' ? 'canvas' : 'div'));
  }
  els.get('warp').value = '0';

  globalThis.HTMLInputElement = class {};
  globalThis.HTMLSelectElement = class {};
  globalThis.document = {
    getElementById: (id) => els.get(id) ?? null,
    createElement: (tag) => new El('', tag),
  };
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 720,
    panel: null,
    labels: null,
    addEventListener: (k, fn) => {
      if (!windowListeners.has(k)) windowListeners.set(k, []);
      windowListeners.get(k).push(fn);
    },
    removeEventListener: () => {},
  };
  globalThis.location = { hash: '', pathname: '/' };
  globalThis.history = {
    replaceState: (_a, _b, h) => {
      globalThis.location.hash = String(h).startsWith('#') ? h : '';
    },
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  globalThis.performance = { now: () => Date.now() };

  // No test may touch the network. The stub also lets the OSM path run
  // end-to-end: a two-building block with a street through it.
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ elements: SYNTHETIC_OSM }),
    };
  };

  let queue = [];
  globalThis.requestAnimationFrame = (fn) => queue.push(fn);

  const pump = (n = 20) => {
    for (let i = 0; i < n && queue.length; i++) {
      const q = queue;
      queue = [];
      for (const fn of q) fn(Date.now() + i * 16);
    }
  };

  return {
    el: (id) => els.get(id),
    pump,
    key: (k) => {
      for (const fn of windowListeners.get('keydown') || []) {
        fn({ key: k, target: {}, preventDefault() {} });
      }
    },
    counts: () => ({ fillText, fillRect }),
    fetchCalls: () => fetchCalls,
    mouse: (x, y) => {
      const c = els.get('c');
      c.fire('mousedown', { clientX: x, clientY: y });
      for (const fn of windowListeners.get('mouseup') || []) {
        fn({ clientX: x, clientY: y });
      }
    },
    drag: (x, y) => {
      const c = els.get('c');
      c.fire('mousedown', { clientX: x, clientY: y });
      for (const fn of windowListeners.get('mousemove') || []) {
        fn({ clientX: x + 40, clientY: y + 40 });
      }
      for (const fn of windowListeners.get('mouseup') || []) {
        fn({ clientX: x + 40, clientY: y + 40 });
      }
    },
  };
}

const dom = installDom();
await import('../src/main.js');
dom.pump();

test('the app boots and paints', () => {
  const { fillText, fillRect } = dom.counts();
  assert.ok(fillText > 100, `only ${fillText} fillText calls; nothing was drawn`);
  assert.ok(fillRect > 0, 'the sky was never painted');
});

test('the HUD reports position, altitude and time', () => {
  assert.match(dom.el('loc').textContent, /x \d+\s+y \d+/);
  assert.match(dom.el('loc').textContent, /alt \d+ m/);
  assert.match(dom.el('loc').textContent, /\d+x\d+ cells/);
  assert.match(dom.el('clock').textContent, /^\d{2}:\d{2}$/);
  assert.match(dom.el('phase').textContent, /^\((day|twilight|night)\)$/);
});

test('the city picker is populated from the presets', () => {
  const opts = dom.el('city').children.map((c) => c.value);
  assert.ok(opts.includes('procedural'));
  assert.ok(opts.includes('manhattan'));
  assert.ok(opts.includes('tokyo'));
  assert.ok(opts.includes('london'));
});

test('the procedural world attributes itself honestly', () => {
  // Nothing may claim OpenStreetMap data when none has been loaded.
  assert.doesNotMatch(dom.el('attrib').textContent, /OpenStreetMap/);
  assert.match(dom.el('attrib').textContent, /Procedural/);
});

test('malformed numbers give an immediate, readable error', () => {
  // Still synchronous: something that is clearly meant to be coordinates but
  // is not must not cost a network round trip.
  dom.el('coords').value = '12, 34, 56';
  dom.el('go').fire('click');
  assert.equal(dom.el('attrib').className, 'err');
  assert.match(dom.el('attrib').textContent, /Could not read those numbers/);
});

test('a place name that cannot be found says so', async () => {
  // The stubbed fetch returns OSM elements, not a geocoder response, so the
  // lookup fails the way an unknown place would.
  dom.el('coords').value = 'zzzz not a real place zzzz';
  dom.el('go').fire('click');
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setImmediate(r));
    dom.pump(3);
  }
  assert.equal(dom.el('attrib').className, 'err');
  assert.match(dom.el('attrib').textContent, /Could not find/);
});

test('valid coordinates load a city and become a shareable URL hash', async () => {
  dom.el('coords').value = '40.7580,-73.9855';
  dom.el('go').fire('click');

  assert.match(globalThis.location.hash,
    /^#bbox=-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/);

  // The load is async and yields a frame between fetch and rasterize.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setImmediate(r));
    dom.pump(3);
  }

  assert.ok(dom.fetchCalls() > 0, 'no Overpass request was made');
  assert.match(dom.el('attrib').textContent, /OpenStreetMap/,
    `attribution missing after load: "${dom.el('attrib').textContent}"`);
  assert.equal(dom.el('attrib').className, 'dim', 'load reported an error');
});

test('a click opens the identify panel, a drag does not', () => {
  const panel = globalThis.window.panel;
  assert.ok(panel, 'main.js did not expose the panel');
  assert.equal(panel.open, false);

  // A drag must never be read as a click.
  dom.drag(400, 300);
  dom.pump(2);
  assert.equal(panel.open, false, 'a drag opened the panel');

  // A click on the scene should identify something.
  dom.mouse(400, 300);
  dom.pump(2);
  assert.equal(panel.open, true, 'a click did not open the panel');
  assert.ok(['building', 'ground', 'sky'].includes(panel.hit.kind));

  // Escape closes it.
  dom.key('escape');
  dom.pump(2);
  assert.equal(panel.open, false, 'escape did not close the panel');
});

test('N cycles the label layer', () => {
  const labels = globalThis.window.labels;
  assert.ok(labels, 'main.js did not expose the label layer');
  const before = labels.mode;
  dom.key('n');
  dom.pump(2);
  assert.notEqual(labels.mode, before, 'N did not change the label mode');
});

test('the loaded world renders without throwing', () => {
  const before = dom.counts().fillText;
  dom.pump(5);
  assert.ok(dom.counts().fillText > before, 'nothing drawn after the city loaded');
});
