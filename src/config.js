/**
 * Every tunable in one place. Values that were magic numbers scattered through
 * the original single-file engine live here with a note on what they control.
 */

/* ------------------------------- display ------------------------------- */

/**
 * 0 = glyph (one character per cell), 1 = half-block (double vertical
 * resolution, solid colour). See MODE in screen.js. Toggled at runtime with B.
 */
export const RENDER_MODE = 0;

export const FONT_PX = 14;
export const FONT_STACK = 'ui-monospace, Menlo, Consolas, monospace';
export const LINE_RATIO = 1.05;        // cell height as a multiple of font size
export const FOV = 1.15;               // radians, horizontal
export const HORIZON_FRAC = 0.52;      // horizon as a fraction of screen rows

/* ------------------------------- distance ------------------------------ */

export const MAXD = 175;               // DDA draw distance, cells
export const FOG_K = 0.0125;           // exp(-d * FOG_K)
export const FOG_FULL = 320;           // past here everything is pure haze;
                                       // fogOf(320) is about 0.018

/* -------------------------------- scale --------------------------------
 * FLOOR_H is primary: it is the facade texture's window-row pitch, inherited
 * from the original engine. The metric scale is derived from it, so that one
 * real storey occupies exactly one rendered floor and OSM `building:levels`
 * lines up with the window rows for free.
 *
 * Calibration constants. Check them on screen after changing either.
 */

export const FLOOR_H = 1.35;                                   // cells per storey
export const STOREY_METERS = 3.2;
export const METERS_PER_CELL = STOREY_METERS / FLOOR_H;        // about 2.37 m

/* -------------------------------- camera -------------------------------- */

export const EYE_HEIGHT = 1.65;        // standing eye height, cells
export const MIN_CAM_Z = 0.05;         // below this the floor cast degenerates
export const MAX_CAM_Z = 400;          // soft ceiling
export const Z_ACCEL = 26;             // cells/s^2 on Q/E
export const Z_DAMP = 0.02;            // velocity retained per second
export const WALK_SPEED = 5.6;
export const RUN_MULT = 4.0;
/**
 * Travel speed scales with altitude, the way every map and flight view does:
 * you move at a rate proportional to how much you can see. At eye level this
 * is a walk; at 200 m it crosses a city in seconds, without making street
 * level uncontrollable.
 */
export const SPEED_PER_CELL_UP = 0.035;
// Capped so the fastest case still crosses a loaded extract in a few seconds
// rather than in one. Uncapped, altitude alone reached Mach 2.
export const MAX_SPEED_MULT = 6;
export const BODY_R = 0.28;            // collision half-width, cells
export const MOVE_CLEAR = 0.35;        // vertical clearance needed to fly over
export const WADE_Z = 2.0;             // above this you fly over water

/* ------------------------------ procedural ------------------------------ */

export const WORLD = 2048;             // wrap period, cells
export const BLOCK = 14;               // city block pitch, cells
export const SEED = 1337;

/* ------------------------------- palettes ------------------------------- */

export const GLYPH_RAMP = ' .:-=+*#%@';
export const LIT = [[255, 198, 120], [130, 226, 255], [255, 130, 216], [176, 255, 190]];
export const FACADE = [[42, 46, 60], [50, 42, 54], [36, 50, 56], [54, 48, 42]];

/* -------------------------------- traffic ------------------------------- */

export const MAX_CARS = 26;
export const MAX_PEDS = 30;
export const AGENT_CULL_D2 = 8100;     // squared cells

/* ------------------------------- defaults ------------------------------- */

export const DEFAULT_LAT = 40.71;
export const DEFAULT_LON = -74.00;
