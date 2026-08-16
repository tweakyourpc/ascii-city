/**
 * Keyboard, mouse and touch, reduced to a plain state object the update loop
 * can poll. Owns no camera state.
 */
export class Input {
  constructor(canvas) {
    this.keys = Object.create(null);
    this.dragging = false;
    this.dx = 0;          // accumulated look delta, consumed by the update loop
    this.dy = 0;
    this.hourShift = 0;   // accumulated [ and ] presses

    this._lastX = 0;
    this._lastY = 0;
    this._bind(canvas);
  }

  _bind(canvas) {
    window.addEventListener('keydown', (e) => {
      // Let the browser have text input in the HUD.
      if (e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      this.keys[k] = true;
      if (k === '[') this.hourShift -= 1;
      if (k === ']') this.hourShift += 1;
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
    });

    window.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => { this.keys = Object.create(null); });

    canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.dx += e.clientX - this._lastX;
      this.dy += e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });

    canvas.addEventListener('touchstart', (e) => {
      this.dragging = true;
      this._lastX = e.touches[0].clientX;
      this._lastY = e.touches[0].clientY;
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (!this.dragging) return;
      this.dx += (e.touches[0].clientX - this._lastX) * 1.5;
      this.dy += (e.touches[0].clientY - this._lastY) * 1.5;
      this._lastX = e.touches[0].clientX;
      this._lastY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchend', () => { this.dragging = false; });
  }

  /** Read and clear the accumulated look delta. */
  takeLook() {
    const d = { x: this.dx, y: this.dy };
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  takeHourShift() {
    const h = this.hourShift;
    this.hourShift = 0;
    return h;
  }

  down(k) {
    return !!this.keys[k];
  }
}
