# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Project scaffolding: README, changelog, MIT licence, `.gitignore`.

## [0.1.0] - 2026-08-16

The pre-refactor baseline, committed verbatim as `ascii-city.html` so that every
change after this point is a reviewable diff against a known-good starting state.

### Added
- ASCII raycast renderer: per-column DDA against a height field for building
  facades, floor casting for the ground plane, depth fog, and run-length batched
  text blitting to a 2D canvas.
- Infinite procedural city generated from a hash function, central park, tower
  district, houses, farmland, forest and water in concentric rings, over a
  14-cell block grid with roads, sidewalks, street trees and lamp glow.
- Astronomically correct sky: Julian day, solar right ascension and declination,
  local sidereal time and altitude/azimuth, driving the day/night light ramp, a
  sun disc, and ~700 stars that rise and set for the current latitude.
- Time warp slider and hour-scrub keys.
- Cars and pedestrians that route the street grid, turn at junctions, and render
  as depth-sorted sprites with direction-dependent headlights and tail lights.
- WASD movement with drag-look, at a fixed eye height.

[Unreleased]: https://github.com/tweakyourpc/ascii-city/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tweakyourpc/ascii-city/releases/tag/v0.1.0
