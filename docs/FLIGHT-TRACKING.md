# Live flight tracking

**Status:** proposal. Nothing is implemented. Help welcome.

Plot real aircraft over the city, in real time, so you can watch them take off
and land.

This document exists because the idea is genuinely good, the data is genuinely
excellent, and there is exactly one obstacle that changes the shape of the
project. Rather than pick a side quietly, here is what was measured and what
the trade-offs are, so whoever picks this up starts from evidence.

Every measurement below was taken on 2026-08-16 and every command is included
so you can re-run it rather than take it on trust.

---

## Why it fits this engine

Unusually well, as it happens. The pieces already exist:

- A 3D camera that flies, with a working projection from world position to
  screen row.
- Depth-buffered sprite compositing, already used for cars and pedestrians.
- An identification panel that opens when you click something, already used
  for buildings, streets and stars.
- Real astronomy, so it is already a thing that renders the actual sky over
  the actual coordinates you are standing at.

And the data model lines up almost exactly. Every feed gives latitude,
longitude, altitude, heading, ground speed, vertical rate and an on-ground
flag, which is precisely what you need to place an aircraft in this world and
know what it is doing.

## Would it look like anything?

Yes, and the falloff is realistic rather than a limitation. Measured against
the engine's real constants (2.37 m per cell, 200 columns wide):

| Slant range | Altitude | Apparent size | Reads as |
| --- | --- | --- | --- |
| 0.4 km | 120 m | 15.5 columns | clearly an aircraft |
| 1 km | 300 m | 6.2 columns | clearly an aircraft |
| 2 km | 600 m | 3.1 columns | a small shape |
| 5 km | 1.5 km | 1.2 columns | a moving dot |
| 12 km | 3 km | 0.5 columns | a single light |
| 40 km | 10.5 km | 0.2 columns | a single light |

Distant aircraft genuinely are just moving lights, so the far end of that
table is correct behaviour, not a shortcoming. Approach and departure
corridors put traffic in the 1-3 km band, where it renders as a recognisable
aircraft. A city-centre box mostly sees cruise traffic, which is why airport
presets would matter (see below).

A live sample over New York, taken while writing this:

```
icao24   callsign  lon       lat      alt      state   speed  track  v/s
a7cfb7   EDV4942   -73.8383  40.7631  358 m    air     80     123    +14.0
a3689e   DAL2226   -73.867   40.7757  -        GROUND  3      301    -
a0f4a2   DAL244    -73.7844  40.635   -        GROUND  4      301    -
ac48ac   SWA2799   -73.8668  40.7756  -        GROUND  0      301    -
```

80 aircraft in the box. `EDV4942` is airborne at 358 m climbing at 14 m/s,
which is a departure in progress. The rest are taxiing at JFK and LaGuardia.
That is exactly the feature, sitting there in the data.

---

## The obstacle

**No free flight API allows a browser to call it directly.**

Measured, all with an `Origin` header, because a request without one tells you
nothing about CORS:

| Source | HTTP | Aircraft | `Access-Control-Allow-Origin` |
| --- | --- | --- | --- |
| OpenSky Network | 200 | 80 | `https://opensky-network.org`, its own origin, so blocked |
| adsb.lol | 200 | 225 | none |
| adsb.fi | 200 | 216 | none |
| adsb.one | 403 |, | none |
| airplanes.live | 403 |, | none |
| allorigins (public CORS proxy) | 500 |, | none |

Reproduce with:

```bash
ORIGIN="https://example.com"
curl -s -D - -o /dev/null -H "Origin: $ORIGIN" \
  "https://opensky-network.org/api/states/all?lamin=40.55&lomin=-74.15&lamax=40.85&lomax=-73.65"
curl -s -D - -o /dev/null -H "Origin: $ORIGIN" \
  "https://api.adsb.lol/v2/point/40.64/-73.78/25"
```

adsb.lol also answers `405` to an `OPTIONS` preflight, so it is not a matter of
asking differently.

OpenSky has a second problem on top: the response carried
`x-rate-limit-remaining: 399`, meaning 400 credits per day anonymous. That is
roughly one request every four minutes, which is not real time by any
definition. A free registered account raises it to about 4000 a day, but OAuth
credentials cannot be embedded in a public static site, and it is still
CORS-blocked regardless.

So every route needs something between the browser and the feed. That is the
entire difficulty. This project is currently a static site with no backend,
served from GitHub Pages, and adding live flight data means changing that in
one way or another.

---

## Options

Nobody has to pick one of these exclusively. They compose.

### 1. Bundled replay

Record a few minutes of real traffic over a busy airport into the repository
and loop it.

**For.** Zero infrastructure. Works on the public demo, so everybody sees the
feature. Deterministic, so it is testable. No rate limits, no keys, no
third-party uptime to depend on.

**Against.** Not live. It must be labelled as a recording, clearly and in the
UI, or it is simply a lie about what the app is doing.

### 2. Local development proxy

Around thirty lines of Node in the repository, started with something like
`npm run flights`, which fetches a feed and adds the CORS header.

**For.** Genuinely live. No accounts, no third parties, and small enough to
audit at a glance. Costs nothing and depends on nothing.

**Against.** Only works when you are running the project locally. The public
demo shows nothing.

### 3. Serverless proxy

A Cloudflare Worker, or equivalent, on a free tier.

**For.** Live data on the public demo. Server-side caching means many viewers
share one upstream poll, which is also the polite thing to do to a free
volunteer-run feed. Around fifteen lines.

**Against.** Needs an account somebody owns. Adds a deployed dependency, and
the project stops being purely static, which is currently one of its nicer
properties.

### 4. Self-hosted proxy

Same idea, on hardware you own.

**For.** Full control over caching, source and retention.

**Against.** Has to be publicly reachable, which usually means a tunnel or
port forwarding, and the demo then depends on somebody's home server staying
up.

### 5. Public CORS proxy

**For.** No setup at all.

**Against.** The one tried here returned HTTP 500 on the first attempt.
Unreliable, rate-limited, and routes all traffic through an unrelated third
party. Not recommended.

### A reasonable starting point

**1 + 2.** Replay by default so the demo works for everyone, live data locally
for anyone running it themselves, and a single configuration line away from 3
for anyone who wants to deploy a proxy. That gets the feature in front of
people without imposing infrastructure on anybody.

---

## The add-on interface

The part that makes this tractable for a contributor, and the reason this can
be added later without disturbing anything.

Do not let the renderer know which feed it is talking to. Define a normalised
aircraft record and have every source adapt to it:

```js
{
  id,               // ICAO 24-bit address, stable across updates
  callsign,         // "DAL2226", may be null
  lat, lon,         // degrees
  altM,             // metres, barometric or geometric
  headingDeg,       // true track
  groundSpeedMs,
  verticalRateMs,   // positive is climbing
  onGround,         // boolean
  seenAt,           // epoch seconds of this fix
}
```

A source is then a URL plus a function mapping one feed's response onto that
shape. OpenSky, adsb.lol, a private receiver, a recorded file and a paid
commercial feed all become interchangeable, and adding one touches no
rendering code.

This is the same trick the project already uses for worlds: `WorldSource` in
`src/world/source.js` means the raycaster genuinely cannot tell a procedural
city from Manhattan. It works well there and it would work well here.

Configuration would then be a single entry naming the source and, where
relevant, a proxy URL, so the public build ships with the replay source and
anyone can point it at their own.

---

## Implementation notes worth having up front

**Aircraft need their own draw distance.** The terrain fog limit is
`FOG_FULL = 320` cells, which is only 0.76 km. Aircraft stay visible for tens
of kilometres and must be exempt from it, with their own falloff.

**Dead reckoning between polls is not optional.** Feeds update every 5 to 30
seconds and the renderer runs at 60 fps. Advance each aircraft along its track
by ground speed, and its altitude by vertical rate, between fixes, or they
will teleport once every poll. This is also what makes a 400-credit-a-day feed
watchable at all.

**Departure and arrival are derivable**, and this is what makes the feature
read as "taking off and landing" rather than "dots moving": the `onGround`
flag, plus altitude below roughly 1500 m with a vertical rate beyond about
±2.5 m/s, cleanly separates climb-out from approach.

**Sub-pixel aircraft should be drawn as a single light**, not skipped. At
range that is all you can see of a real aircraft anyway, and the anti-collision
strobe is often the only thing visible at night.

**Airport presets would be needed** for the feature to show itself. JFK,
Heathrow and Schiphol would do. Their runways, taxiways and terminals are
already in OpenStreetMap, so the ground would render properly too. A viewpoint
preset beside the approach lights, looking down the glideslope, would be the
most direct demonstration.

**Licensing differs by source.** adsb.lol and adsb.fi are ODbL, the same
licence family as the OpenStreetMap data this project already uses and
attributes, which makes them the easier fit. OpenSky has its own terms
oriented toward research use. Any bundled recording needs its source
attributed in the repository and in the UI.

**Aircraft and the depth buffer.** They are almost always beyond the terrain
draw distance, so they will rarely be occluded by anything except nearby
buildings. Worth deciding deliberately whether they write depth at all rather
than discovering it by accident.

---

## Open questions

- Interpolate between fixes, or extrapolate ahead of the last one? The first
  is smoother and always lags; the second is current and occasionally wrong.
- How should a busy airport avoid filling the sky with callsign labels? The
  existing label declutterer in `src/render/labels.js` already solves the same
  problem for streets and could probably be reused.
- Should a recorded replay be time-shifted onto the simulated clock, so that
  scrubbing to midnight shows the night traffic pattern rather than the
  afternoon one?
- Is there any free feed with permissive CORS that was missed here? That
  single fact would remove the entire obstacle, and this document should be
  corrected if so.

## If you want to pick this up

Open an issue or a draft PR. The most useful first contribution is not code:
it is either a feed with permissive CORS that was missed, or a decision on the
proxy question, because everything else follows from that.
