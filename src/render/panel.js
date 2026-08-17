import { col2str } from '../screen.js';
import { METERS_PER_CELL, FLOOR_H } from '../config.js';
import { GROUND_NAME, wind, bearingTo } from '../pick.js';
import { parseMetres } from '../world/osm.js';

/**
 * The identify panel, drawn in the character grid.
 *
 * Everything here comes from tags already cached locally, so the panel is
 * complete and useful offline. The Wikipedia summary is strictly additive: it
 * appears if it arrives and is silently omitted if it does not.
 */

const W = 46;
const MAX_ROWS = 22;

const TITLE = col2str(126, 231, 255);
const LABEL = col2str(58, 132, 152);
const VALUE = col2str(255, 212, 121);
const BODY = col2str(168, 196, 208);
const FRAME = col2str(40, 96, 112);
const LINK = col2str(120, 208, 255);

/** "office" -> "Office", "apartments" -> "Apartments", "yes" -> null. */
function pretty(v) {
  if (!v || v === 'yes' || v === 'true') return null;
  return String(v).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function address(tags) {
  const n = tags['addr:housenumber'];
  const s = tags['addr:street'];
  if (n && s) return `${n} ${s}`;
  return s || null;
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Greedy wrap to `w` columns, at most `max` lines. Ellipsis only if cut. */
export function wrap(text, w, max) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  let i = 0;

  for (; i < words.length; i++) {
    const word = words[i];
    if (!line.length) { line = word; continue; }
    if (line.length + 1 + word.length <= w) { line += ' ' + word; continue; }
    out.push(line);
    line = word;
    if (out.length === max) break;
  }

  const truncated = out.length === max ? i < words.length : false;
  if (out.length < max && line) out.push(line);

  if (truncated || (out.length === max && i < words.length - 1)) {
    const last = out[out.length - 1].replace(/[.,;:]+$/, '');
    out[out.length - 1] = last.length > w - 3
      ? last.slice(0, w - 3) + '...'
      : last + '...';
  }
  return out;
}

export class Panel {
  constructor() {
    this.hit = null;
    this.wiki = null;        // {state:'pending'|'ok'|'none', text}
    this._layout = null;     // set by draw(), read by rect()
  }

  select(hit) {
    this.hit = hit;
    this.wiki = null;
    this._layout = null;
  }

  close() {
    this.hit = null;
    this.wiki = null;
    this._layout = null;
  }

  get open() { return this.hit !== null; }

  /**
   * Cell rect currently covered, so clicks on the panel can be ignored.
   * Must agree exactly with draw(), or clicks land in a box that is not there.
   */
  rect(screen) {
    // Stored in output lines; returned in internal rows, because clicks are
    // mapped to internal rows and so is everything else that indexes the grid.
    const L = this._layout;
    if (!L) return null;
    const step = screen.rowStep || 1;
    return { x: L.x, y: L.y * step, w: L.w, h: L.h * step };
  }

  /** Build the panel's lines: [text, colour, indent] triples. */
  _lines(cam, world) {
    const hit = this.hit;
    const L = [];
    const inner = Math.min(W, 60) - 4;

    const kv = (k, v, url) => { if (v) L.push([k, v, url]); };

    if (hit.kind === 'building') {
      const b = hit.b;
      const t = b.tags;
      L.title = b.name || address(t) || pretty(t.building) || 'Building';

      const kind = pretty(t.amenity) || pretty(t.tourism) || pretty(t.shop)
                || pretty(t.office) || pretty(t.building) || 'Building';
      const addr = address(t);
      L.sub = b.name && addr ? `${kind} · ${addr}` : kind;

      const metres = parseMetres(t.height) ?? b.h * METERS_PER_CELL;
      const floors = t['building:levels'] || Math.round(b.h / FLOOR_H);
      kv('Height', `${Math.round(metres)} m · ${floors} floors`);
      kv('Built', t.start_date || t['construction:date']);
      kv('Operator', t.operator || t.brand);
      kv('Hours', t.opening_hours);
      const site = t.website || t['contact:website'];
      kv('Web', site ? hostOf(site) : null, site);
      kv('Distance', `${Math.round(hit.d * METERS_PER_CELL)} m · ` +
        `${wind(bearingTo(cam, hit.x, hit.y))}`);
      L.footer = b.osm;
    } else if (hit.kind === 'ground') {
      const st = hit.street;
      const poi = hit.poi;
      L.title = poi && poi.name
        ? poi.name
        : (st && st.on ? st.on : (GROUND_NAME[hit.type] || 'Ground'));
      L.sub = poi && poi.name
        ? (st && st.on ? `${pretty(poi.tags.amenity || poi.tags.shop
            || poi.tags.tourism || poi.kind) || poi.kind} · ${st.on}` : poi.kind)
        : (st && st.cross ? `near ${st.cross}` : (GROUND_NAME[hit.type] || ''));
      if (poi) {
        kv('Hours', poi.tags.opening_hours);
        kv('Operator', poi.tags.operator || poi.tags.brand);
      }
      kv('Surface', GROUND_NAME[hit.type] || '-');
      kv('Distance', `${Math.round(hit.d * METERS_PER_CELL)} m · ` +
        `${wind(bearingTo(cam, hit.x, hit.y))}`);
      L.footer = hit.poi ? hit.poi.osm : (world && world.label ? world.label : '');
    } else {
      const o = hit.object;
      L.title = o ? o.name : 'Sky';
      L.sub = o ? o.kind : 'no catalogued object here';
      if (o && o.detail) kv('', o.detail);
      if (o && Number.isFinite(o.mag)) kv('Magnitude', o.mag.toFixed(2));
      kv('Altitude', `${hit.alt.toFixed(1)}°`);
      kv('Azimuth', `${hit.az.toFixed(1)}° · ${wind(hit.az)}`);
      L.footer = '';
    }

    L.body = this.wiki && this.wiki.state === 'ok'
      ? wrap(this.wiki.text, inner, 6)
      : (this.wiki && this.wiki.state === 'pending' ? ['...'] : null);

    // Quoting an article and offering no way to read it makes the card a dead
    // end, which is the whole reason this row exists.
    if (this.wiki && this.wiki.state === 'ok' && this.wiki.url) {
      L.link = { text: 'Read on Wikipedia', url: this.wiki.url };
    }
    // The footer is the attribution line, so linking it is also the more
    // correct thing to do with it.
    L.footerUrl = /^(node|way|relation)\/\d+$/.test(String(L.footer))
      ? `https://www.openstreetmap.org/${L.footer}` : null;
    return L;
  }

  /**
   * The URL under a cell, or null. Takes internal rows, like everything else
   * that indexes the grid, and like rect() converts with rowStep.
   */
  linkAt(screen, col, row) {
    const L = this._layout;
    if (!L || !L.links) return null;
    const line = Math.floor(row / (screen.rowStep || 1));
    for (const k of L.links) {
      if (line === k.y && col >= k.x && col < k.x + k.w) return k.url;
    }
    return null;
  }

  draw(screen, cam, world) {
    if (!this.hit) return;

    const w = Math.min(W, screen.cols - 4);
    const inner = w - 4;
    const L = this._lines(cam, world);

    // [text, colour, key, url, trimmable]
    const rows = [];
    rows.push(['', FRAME]);
    rows.push([L.title.slice(0, inner).toUpperCase(), TITLE]);
    if (L.sub) rows.push([L.sub.slice(0, inner), LABEL]);
    rows.push(['', null]);
    for (const [k, v, url] of L) {
      rows.push([k ? `${k.padEnd(10)}${v}` : v, url ? LINK : (k ? VALUE : BODY), k, url]);
    }
    if (L.body) {
      rows.push(['', null, null, null, true]);
      for (const line of L.body) rows.push([line, BODY, null, null, true]);
    }
    if (L.link) rows.push([`> ${L.link.text}`, LINK, null, L.link.url]);
    rows.push(['', null]);
    rows.push([`${L.footer}`.slice(0, inner - 12), FRAME, null, L.footerUrl]);

    // The summary is the expendable part, not the link to it. Trimming body
    // lines first stops a short window from cutting off the one row that
    // exists to get you out of the card.
    const cap = Math.min(MAX_ROWS, screen.outRows - 2) - 2;
    for (let i = rows.length - 1; i >= 0 && rows.length > cap; i--) {
      if (rows[i][4]) rows.splice(i, 1);
    }

    const h = Math.min(MAX_ROWS, rows.length + 2, screen.outRows - 2);
    const x = 2;
    const y = screen.outRows - h - 1;
    const links = [];
    this._layout = { x, y, w, h, links };

    screen.scrim(x, y, w, h, 'rgba(4,10,14,0.90)');

    // Clear first. The scrim paints under the glyph layer, so without this
    // the city behind the panel blits straight over the top of it. Blanks are
    // transparent at blit time, so the scrim shows through.
    screen.clearBox(x, y, w, h);

    const bar = '-'.repeat(w - 2);
    screen.text(x, y, `+${bar}+`, FRAME);
    screen.text(x, y + h - 1, `+${bar}+`, FRAME);
    for (let r = 1; r < h - 1; r++) {
      screen.text(x, y + r, '|', FRAME);
      screen.text(x + w - 1, y + r, '|', FRAME);
    }

    // "[esc]" sits on the bottom rule so it never costs a content row.
    screen.text(x + w - 12, y + h - 1, ' [esc] close ', FRAME);

    for (let r = 0; r < rows.length && r < h - 2; r++) {
      const [text, colour, key, url] = rows[r];
      if (!text) continue;
      if (key) {
        screen.text(x + 2, y + 1 + r, key.padEnd(10), LABEL);
        screen.text(x + 12, y + 1 + r, text.slice(10, inner), colour);
        // Recorded here, from the same numbers that just painted it. Deriving
        // the bounds anywhere else is how they drift out of agreement.
        if (url) links.push({ x: x + 12, y: y + 1 + r, w: text.slice(10, inner).length, url });
      } else {
        const cut = text.slice(0, inner);
        screen.text(x + 2, y + 1 + r, cut, colour);
        if (url) links.push({ x: x + 2, y: y + 1 + r, w: cut.length, url });
      }
    }
  }
}
