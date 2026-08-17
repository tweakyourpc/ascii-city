import { col2str } from '../screen.js';

/**
 * Load and error states drawn into the character grid itself.
 *
 * A DOM spinner over an ASCII renderer would look borrowed. This costs almost
 * nothing and keeps the whole surface in one idiom.
 */

const BANNER = [
  ' _   ___  ___ _ _   ___ _ _ _  _ ',
  '/_\\ / __|/ __| | | | __| | | || |',
  '/ _ \\\\__ \\ (__| | | | _|| | | __ |',
  '/_/ \\_\\___/\\___|_|_| |___|_|_|_||_|',
];

const SPIN = ['.  ', '.. ', '...', ' ..', '  .', '   '];

export function drawLoading(screen, { title, detail, t }) {
  const dim = col2str(24, 88, 104);
  const bright = col2str(126, 231, 255);
  const accent = col2str(255, 212, 121);

  screen.ctx.fillStyle = '#04080c';
  screen.ctx.fillRect(0, 0, screen.width, screen.height);
  screen.clear();

  const mid = Math.floor(screen.outRows / 2);

  // A faint grid of dots, so the frame does not read as a dead canvas.
  for (let y = 0; y < screen.outRows; y += 2) {
    for (let x = (y % 4 === 0) ? 0 : 3; x < screen.cols; x += 6) {
      screen.text(x, y, '.', col2str(10, 30, 38));
    }
  }

  if (screen.cols > 40) {
    for (let i = 0; i < BANNER.length; i++) {
      const x0 = Math.floor((screen.cols - BANNER[i].length) / 2);
      screen.text(x0, mid - 5 + i, BANNER[i], dim);
    }
  }

  const dots = SPIN[Math.floor(t * 6) % SPIN.length];
  screen.centreText(mid + 1, `${title}${dots}`, bright);
  if (detail) screen.centreText(mid + 3, detail, accent);

  screen.blit();
}

export function drawError(screen, { title, detail, hint }) {
  const red = col2str(255, 138, 108);
  const dim = col2str(24, 88, 104);
  const accent = col2str(255, 212, 121);

  screen.ctx.fillStyle = '#0c0605';
  screen.ctx.fillRect(0, 0, screen.width, screen.height);
  screen.clear();

  const mid = Math.floor(screen.outRows / 2);
  const rule = '-'.repeat(Math.min(screen.cols - 4, 54));

  screen.centreText(mid - 3, rule, dim);
  screen.centreText(mid - 1, title, red);
  if (detail) screen.centreText(mid + 1, detail, accent);
  if (hint) screen.centreText(mid + 3, hint, dim);
  screen.centreText(mid + 5, rule, dim);

  screen.blit();
}
