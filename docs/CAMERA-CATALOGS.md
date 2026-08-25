# World camera catalogs

`config/cctv_catalogs.json` is a declarative registry of third-party camera
catalogs. Adding a country is a JSON entry — a URL, some field paths and a
licence — not a new loader. The generic adapter
(`loadWorldCatalogSources()` in `vite.config.js`) reads it.

Catalogs are fetched in parallel and **fail independently**: one dead national
road authority never darkens the rest of the world.

## Entry shape

```jsonc
{
  "id": "ca-on",                    // short slug; prefixes every camera id
  "country": "CA",
  "countryName": "Canada (Ontario)",// shown as the camera's "city" grouping
  "provider": "Ontario 511 / MTO",  // shown in the panel
  "catalogUrl": "https://511on.ca/api/v2/get/cameras?format=json",
  "method": "GET",                  // or "POST"
  "body": null,                     // POST body (form-encoded string)
  "headers": {},                    // extra request headers
  "arrayPath": "",                  // dotted path to the camera array; "" = response IS the array
  "fields": {
    "id":        "Id",
    "name":      "Location",
    "lat":       "Latitude",        // or omit and use "wkt"
    "lon":       "Longitude",
    "wkt":       null,              // path to a WKT "POINT (lon lat)" string
    "heading":   "Direction",       // compass/travel text; parsed if present
    "elevation": null,              // metres
    "imageUrl":  "Views.0.Url"      // path to the per-camera image URL
  },
  "imageUrlTemplate": null,         // alternative: "https://host/cam/{id}.jpg"
  "imageBaseUrl": null,             // prefix for image paths that start with "/"
  "license": "...",                 // recorded on every camera; be honest here
  "anchors": [{ "lat": 43.65, "lon": -79.38, "city": "Toronto" }],
  "maxSources": 200,                // per-catalog cap
  "enabled": true
}
```

### Paths
Dotted, with array indexes: `geometry.coordinates.1`, `items.0.cameras`,
`Views.0.Url`. A missing segment yields `undefined` and the record is skipped.

### Coordinates
Either discrete `lat`/`lon` fields, **or** `wkt` pointing at a
`POINT (lon lat)` string (the US 511 DataTables family nests one at
`latLng.geography.wellKnownText`). Records at exactly `0,0` are dropped —
several catalogs use that for unplaced cameras.

### Images
`fields.imageUrl` when the record carries the URL; `imageUrlTemplate` with
`{placeholders}` when it must be constructed. Relative paths starting with `/`
are resolved against `imageBaseUrl`. Anything that isn't `http(s)` is skipped.

### Headings
`fields.heading` is parsed with the shared direction parser (travel words,
abbreviations and bare cardinals). A camera with a parsed heading gets
`headingConfidence: 'high'` and a real view cone; without one it falls back to a
deterministic fabricated heading at `'low'` confidence, which routes it to the
conservative pose prior. Note the parser reads `"NE"` but **not** a bare `"W"` —
if a catalog uses single-letter codes it needs an explicit map (see how the
DriveBC pack handles `orientation`).

### Pagination
Only needed for the 511 DataTables family, which hard-caps pages at 100 rows:

```jsonc
"pagination": { "mode": "datatables", "totalPath": "recordsTotal" }
```

The adapter rewrites `start=` in the body per page and retries each page three
times — those endpoints intermittently answer `200` with an empty body, and
without retries a few pages silently drop from every refresh.

## Environment

```bash
CCTV_WORLD_ENABLED=0             # disable the whole pack
CCTV_WORLD_CATALOGS=ca-on,fi     # only these ids/countries (default: all)
CCTV_WORLD_MAX_PER_CATALOG=150   # per-catalog cap
CCTV_WORLD_CATALOG_FILE=...      # alternative registry path
```

## Before adding an entry

1. **Fetch the catalog** and confirm it parses.
2. **Fetch one real camera image** — status, content-type, byte size. A catalog
   whose images 404 is worthless no matter how good the metadata looks.
3. **Read the licence** and write it into `license` verbatim-ish. Public
   visibility is not permission to redistribute; several sources in this project
   are personal-use-only and that is recorded on the camera itself.
4. Prefer the **operator's own endpoint** over an aggregator's copy.
