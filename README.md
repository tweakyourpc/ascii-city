<!-- hero image lands here in Phase 5 -->

# ASCII City

A 3D city renderer that draws to text. No WebGL, no shaders, no dependencies, 
just a raycaster writing coloured characters into a grid, blitted to a 2D canvas.

The sky is not decoration. Sun position and star positions are computed from real
astronomy, Julian day, solar right ascension and declination, local sidereal
time, so day and night arrive when they actually would, for the latitude and
longitude you are standing at.

> **Status:** early. The engine works; the OpenStreetMap integration and the
> drone camera are in progress. See [CHANGELOG.md](CHANGELOG.md) and the
> [roadmap](#roadmap).

## What it does

**Renderer.** A per-column DDA raycast against a height field draws building
facades, and a floor-casting pass fills every row below the horizon with ground.
Output is a character grid with a parallel colour grid, blitted with run-length
batched `fillText` calls so a full screen of text costs a few hundred draw calls
rather than tens of thousands. Depth fog, per-material glyph ramps, and a
single-watermark occlusion scheme that exploits the fact that a height field seen
from outside always covers a bottom-anchored span of each column.

**World.** An infinite procedural city generated from a hash function, no
storage, no seed file, just coordinates in and terrain out. A park at the centre
gives the skyline something to stand behind, then concentric rings of towers,
houses, farmland, forest and water, laid over a block grid with roads,
sidewalks, street trees and lamp-glow falloff.

**Sky.** Julian day to solar position to altitude/azimuth, driving the ambient
light level, the sky gradient, a sun disc that sets in the right place, and
around 700 stars that rise and set correctly. There is a time-warp slider and
hour-scrub keys, so you can watch a day pass in ten seconds.

**Traffic.** Cars and pedestrians route the street grid, pick new headings at
junctions, hug the correct side of the road, and are drawn as depth-sorted ASCII
sprites, headlights white when coming toward you, tail lights red going away.

## Running it

```bash
git clone https://github.com/tweakyourpc/ascii-city.git
cd ascii-city
python3 -m http.server 8000   # or: npx serve .
```

Then open <http://localhost:8000>.

A static server is required, the engine is built from ES modules, and browsers
refuse to load modules over `file://`. The pre-refactor single-file version in
`legacy/ascii-city.html` has no such requirement and can be opened directly.

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Arrow keys | Move / turn |
| Drag mouse | Look around |
| `Shift` | Run |
| `[` `]` | Scrub back / forward one hour |
| Time warp slider | Speed up the clock, 1x to 10000x |

## Roadmap

- [x] Procedural city, raycast renderer, real astronomy, traffic
- [ ] ES module refactor
- [ ] Drone camera: free flight on the Z axis, with rooftops
- [ ] Real cities from OpenStreetMap via the Overpass API
- [ ] City picker with presets and custom bounding boxes

## Architecture

Documented once the module refactor lands.

## Licence

[MIT](LICENSE) © Christopher Davis
