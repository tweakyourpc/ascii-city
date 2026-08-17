# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-08-16

### Added
- **Type a city name.** The location box accepts "Kyoto" as well as
  coordinates and map links, resolved through Nominatim with Photon as a
  fallback. The resolved name is displayed, because "Springfield" is
  ambiguous. Coordinates still resolve synchronously with no network call.
- [docs/FLIGHT-TRACKING.md](docs/FLIGHT-TRACKING.md): a written-up proposal for
  plotting live aircraft, with the CORS obstacle measured across six sources
  and a provider interface sketched so a feed can be added later.

- **Street and landmark labels.** Named streets label themselves whenever in
  view; notable buildings name themselves on approach. `N` cycles the layer
  off / streets / streets and landmarks. The HUD always names the street you
  are on and the nearest crossing.
- **Click to identify.** Any building, street or sky object. Buildings show
  name, type, real height and floors, address, year built, operator, hours,
  distance and bearing, plus a Wikipedia summary where OpenStreetMap carries a
  wikidata or wikipedia tag.
- **The Moon and the five naked-eye planets**, with correct phase, distance
  and varying magnitude, plus 36 named stars with Bayer designations and
  constellations.
- **See-through foliage.** Round canopies with gaps you can see buildings and
  sky through.
- **Points of interest.** Named amenities, shops, tourism nodes and subway
  entrances, as a third best-effort Overpass layer.
- Sprite detail levels for cars and pedestrians, plus head-on and rear car
  templates chosen by heading. `T` cycles traffic off / cars / cars and
  people, with pedestrians off by default.

### Changed

- Occlusion is a per-column bitmask rather than a single watermark, which the
  transparency required. An all-opaque frame takes a fast path and is
  bit-identical to before.
- The DDA's termination test generalises both previous breaks: it asks whether
  the row window all remaining geometry must project into is already painted.
- Sprites write depth, so labels cannot draw over a car in front of them.

### Fixed

- **The view was horizontally mirrored**, and had been since the original
  single-file engine. The ray fan ran backwards, so facing north the left of
  the screen looked east-of-north. Looking along an east-west street this put
  the buildings from one side of the road on the other. It went unnoticed
  because a procedural city is statistically symmetric, so a mirror of it
  looks like itself; real map data made it visible. Six places that map a
  horizontal angle to a screen column had to move together, including the
  drag-look and strafe directions, which were compensating for it.
- `slim()` dropped every element without geometry or members, so POI nodes,
  which carry lat/lon directly, would have been discarded silently.
- Lunar phase is measured against the Sun's true longitude, not its mean. The
  mean put the synodic month 29 minutes out per lunation.
- A landmark label is depth-tested against its building's near face. At the
  centroid distance a building always occluded its own name.
- Labels are all-or-nothing. Skipping individually occluded characters left
  city texture between the letters, so WEST 42ND STREET read as WEST
  42N=+STREET.

## [1.0.0] - 2026-08-16

### Added

- **Real cities from OpenStreetMap.** Building footprints, street networks,
  rivers and green space are fetched from the Overpass API and rasterized into
  the engine's height field. Presets for Manhattan, Tokyo, London and Paris,
  plus any coordinates: a point, an explicit bounding box, or a pasted
  openstreetmap.org link.
- **Drone camera.** `E` and `Q` fly up and down. Rooftops render as horizontal
  surfaces, so the view stays correct above the skyline, and you can land on a
  roof and walk around on it.
- **Roof materials.** Parapets along building outlines, gravel texture, and
  blinking red aircraft beacons on anything over 60 m.
- **Load and error states drawn into the character grid**, rather than as a DOM
  overlay.
- **Shareable URLs.** The hash tracks city, position, altitude, heading, pitch
  and hour, so any view can be linked. `#hud=0` hides the overlay.
- **ES module architecture.** The single 717-line file became `src/`, behind a
  world interface that returns integer slots into chunked struct-of-arrays, so
  procedural and OpenStreetMap worlds are interchangeable and nothing allocates
  in the hot path.
- `tools/render-frame.js`, which renders a frame to stdout as text, and
  `tools/map-preview.js`, which prints a rasterized world top-down.
- 56 tests covering projection inversion, occlusion invariants, roof spans,
  collision, OSM tag parsing and rasterization, and a full app boot under a DOM
  shim. No test touches the network.

### Changed

- Building heights come from the `height` tag, then `building:levels`, then a
  3-level default. The metric scale is derived from the facade texture's floor
  pitch rather than chosen separately, so one real storey occupies exactly one
  rendered floor.
- Sprite occlusion uses a per-cell depth buffer instead of one distance per
  column. The old heuristic could not handle a rooftop seen from above
  partially hiding the street behind it.
- The floor cast fog-clips rather than distance-clips. A plain draw-distance
  test left tens of undrawn rows below the horizon at altitude.
- Collision is a clearance test rather than a solid/not-solid test, so you fly
  over buildings rather than into them, and water only blocks while you are low
  enough to be wading.
- Aircraft beacons are one per building. Testing per cell scattered a red light
  over every cell of a tower's roof.
- The HUD has a backdrop. Over a wall of lit windows, a text shadow alone was
  not enough.

### Fixed

- The altitude early-out was unsound as designed. Above the skyline
  `rowOf(maxHeight, d)` falls toward the horizon, so distant geometry appears
  *higher* on screen and being hidden at one distance implies nothing about
  twice that distance; applying the cut there deleted visible rooftops. It is
  now restricted to the camera-below-geometry case, where the monotonicity it
  relies on actually holds.
- Roof parapets tested the cell edge without checking whether the neighbouring
  cell was lower, which outlined all 400 cells of a block and made roofs read
  as graph paper. They now trace the building outline.
- `overpass.osm.ch` was dropped from the endpoint list. It is a Switzerland-only
  mirror that answers HTTP 200 with zero elements for anywhere else, which is
  indistinguishable from genuinely empty map data. An empty response from one
  instance now falls through to the next.
- Overpass endpoint order is shuffled per call. Instance health varies by the
  minute: one endpoint timed out on a query another answered in four seconds.
- The map query is split into a required core request (buildings and streets)
  and a best-effort one (water and parks). The combined query timed out where
  buildings and streets alone took three seconds.
- Cached responses are stripped of the `nodes` and `bounds` fields the
  rasterizer never reads, cutting them by about a third. `localStorage` allows
  roughly 5 MB and a dense square kilometre can arrive as 3 MB.

## [0.1.0] - 2026-08-16

The pre-refactor baseline, committed verbatim as `ascii-city.html` so that every
change after this point is a reviewable diff against a known-good starting state.

### Added
- ASCII raycast renderer: per-column DDA against a height field for building
  facades, floor casting for the ground plane, depth fog, and run-length batched
  text blitting to a 2D canvas.
- Infinite procedural city generated from a hash function: central park, tower
  district, houses, farmland, forest and water in concentric rings, over a
  14-cell block grid with roads, sidewalks, street trees and lamp glow.
- Astronomically correct sky: Julian day, solar right ascension and declination,
  local sidereal time and altitude/azimuth, driving the day/night light ramp, a
  sun disc, and ~700 stars that rise and set for the current latitude.
- Time warp slider and hour-scrub keys.
- Cars and pedestrians that route the street grid, turn at junctions, and render
  as depth-sorted sprites with direction-dependent headlights and tail lights.
- WASD movement with drag-look, at a fixed eye height.

[Unreleased]: https://github.com/tweakyourpc/ascii-city/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/tweakyourpc/ascii-city/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tweakyourpc/ascii-city/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/tweakyourpc/ascii-city/releases/tag/v0.1.0
