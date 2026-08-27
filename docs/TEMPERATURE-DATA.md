# Temperature layer — how it works

Shows real air temperature worldwide. Hover for a readout, click for local
conditions and a five-day forecast.

## The problem: a few hundred points, one planet

Free weather APIs bill per **location**, not per request. Open-Meteo's free tier
allows 10,000 a day. A global grid is therefore small — 648 points at 10-degree
spacing — and a 10-degree cell is roughly 1,100 km across at the equator.

Painting those 648 values directly is what made earlier versions look like flat
blocks. One cell swallows an entire mountain range, so Denver and the summit of
Mount Elbert came out the same colour despite a 2,800 m height difference and a
real 11 °C gap.

Buying more points was never the answer. A 5-degree grid was tried: 2,520 points
per sweep exhausted the entire daily budget in an afternoon, and it was *still*
too coarse to resolve a valley.

## The fix: separate weather from altitude

A surface temperature is two things added together — the large-scale weather
pattern, which genuinely is smooth over hundreds of kilometres, and the local
effect of altitude, which is not smooth at all but follows a known physical law
and costs nothing to compute.

So the layer splits them:

1. **Reduce every observation to sea level** — add back the warmth its own
   altitude took away, at 6.5 °C/km.
2. **Interpolate that field.** Sea-level temperature really is smooth, so
   interpolating it is honest rather than an artefact-generating guess.
3. **Subtract altitude again per pixel**, at full elevation resolution.

The output has the detail of the elevation data while every value still agrees
with the measurement it came from. This is standard meteorological downscaling.

### Measured against ground truth

Sampled field versus the provider's own reading for the same point:

| Place | Elevation | Flat field | Downscaled | Truth |
| --- | --- | --- | --- | --- |
| Leadville, CO | 3,105 m | 19.3 °C | **8.9 °C** | 8.3 °C |
| Denver, CO | 1,601 m | 19.4 °C | **17.8 °C** | 17.5 °C |
| Geneva, CH | 380 m | 23.5 °C | 21.4 °C | 22.5 °C |

An 11 °C error at Leadville becomes 0.6 °C. Geneva is near sea level and barely
moves, which is the expected result — where there is no altitude there is
nothing to correct.

## Elevation source

**AWS Terrain Tiles** ("terrarium"), public domain, on the AWS Open Data
registry. Keyless, CORS-open, no quota. Elevation is packed into the colour
channels of an ordinary PNG.

Fetched to zoom 9 — about 300 m per pixel, finer than any temperature signal
this layer can honestly claim.

Bathymetry is **clamped to zero**. Terrarium encodes sea-floor depth, so an
uncorrected lapse would "warm" the oceans by several degrees as the floor drops
away and the Mariana Trench would glow. Genuine below-sea-level land loses a
fraction of a degree it should have kept — a far smaller error than heating
every ocean on Earth.

## The readout never disagrees with the colour

The cursor readout and the painted pixel read the **same** cached elevation
sample, so they cannot drift apart. Using the picked surface height would have
been easier and wrong: the pick lands on Google's photogrammetry, so clicking a
skyscraper roof would report the temperature 400 m up while the ground beside it
stayed the colour of the valley floor.

## Two sources, one grid

| Source | Role | Licence |
| --- | --- | --- |
| Open-Meteo | Primary — answers 100 coordinates per request | CC BY 4.0 |
| MET Norway | Fallback — one request per point, but no daily ceiling | CC BY 4.0 |

Open-Meteo is cheap in requests but capped daily. MET Norway has no daily cap
but needs a request per point, so it is paced at five per second — a quarter of
what they permit — and identifies itself in the User-Agent, both conditions of
their free access.

The two are **never mixed into one grid**. They are different forecast models,
and stitching half of each together would put a seam across the map.

Attribution on the layer row follows whichever source actually produced the
numbers on screen.

## Sweeping without leaving half the world blank

Points are fetched in **interlaced order** — four coarse-to-fine passes over
offset sub-lattices, so any prefix covers the whole globe and later batches
refine between earlier samples. The first 100 points already span -85 to +75.

This was a real bug, not a refinement. Row-major order meant a sweep that died
partway had fetched a contiguous band from the south pole northward, so a failed
run left the entire northern hemisphere empty.

The sampler also **refuses to answer beyond the latitudes actually measured**.
Clamping unconditionally meant a southern-hemisphere-only grid answered a query
for Berlin with a value measured near Antarctica. Blank is the honest answer for
somewhere that has not been measured.

## Caching

Three-hour grid lifetime, persisted to `data/temperature-cache.json`. Without
that, every server restart began a fresh sweep — which is what actually
exhausted the daily budget during development — and a quota-spent day showed a
blank globe instead of the last good field.

A failed sweep sets a ten-minute cooldown so a spent quota is not rediscovered
on every request.

## Surface mode

A second mode paints **NASA MODIS land-surface temperature** (GIBS, keyless, 1 km).
That is what the ground radiates, not what the air is doing — on a sunny day
asphalt reads far hotter than the air above it — so it is a separate, labelled
mode rather than the default.
