import * as Cesium from 'cesium';
import {
  LAPSE_C_PER_M,
  buildColorTable,
  createCoarseElevation,
  createTerrainTemperatureProvider,
  sampleBilinear,
  lapseElevation,
} from './terrainTemperature.js';

/**
 * World temperature.
 *
 * A global grid of current air temperature, shaded blue through red, with a
 * five-day forecast for whatever cell you tap.
 *
 * Live data, unlike the reference layers: it refreshes on a timer, because a
 * temperature map that is six hours stale is worse than no temperature map.
 * The grid itself is built and cached SERVER-SIDE — see `temperatureData()` in
 * vite.config.js. Doing it per-browser would mean every visitor sweeping a free
 * public API, which is how a free public API stops being free.
 *
 * Source: Open-Meteo, CC BY 4.0.
 */

const GRID_URL = '/api/temperature';
const FORECAST_URL = '/api/temperature/forecast';

/**
 * NASA GIBS — free, keyless, 1 km satellite tiles.
 *
 * This is the answer to "why can't the mountain be cold and the valley warm".
 * Open-Meteo serves POINTS and caps at 600 per minute, measured; resolving
 * terrain needs roughly 0.1-degree sampling, some 6.5 million points, which no
 * amount of pacing reaches. GIBS serves PRE-RENDERED TILES from a satellite
 * instrument, so every pixel is already computed — the same class of product
 * MSN Weather and Windy draw.
 *
 * WHAT IT MEASURES IS DIFFERENT, and the layer says so rather than quietly
 * swapping one quantity for another. This is LAND SURFACE temperature — how hot
 * the ground itself is — not the air two metres above it. Desert sand can read
 * 20 C hotter than the air over it. It is real measured data and it renders
 * terrain beautifully; it is just not the number a thermometer on your porch
 * shows.
 */
const GIBS_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/'
  + '{Layer}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png';
const GIBS_LAYER = 'MODIS_Terra_Land_Surface_Temp_Day';
const GIBS_MATRIX = '1km';
/** GIBS 1km tops out here; asking beyond it returns empty tiles. */
const GIBS_MAX_LEVEL = 7;

/**
 * Refresh cadence.
 *
 * Short while the server's sweep is still filling in — a 5-degree grid takes
 * about four and a half minutes to fetch under the rate limit, and the field
 * should visibly sharpen rather than sit coarse until the next quarter hour.
 * Long once complete, because the server caches for thirty minutes and asking
 * sooner only re-reads that cache.
 */
const UPDATE_INTERVAL_MS = 60 * 1000;
const UPDATE_INTERVAL_SETTLED_MS = 15 * 60 * 1000;

/**
 * Opacity of the field.
 *
 * Low on purpose. The point is to tint the ground, not replace it — at full
 * strength this became an opaque sheet with the world hidden underneath, which
 * is worse than no layer at all.
 */
const FIELD_ALPHA = 0.42;

/**
 * Temperature colour stops, °C.
 *
 * Modelled on the ramp MSN Weather and Windy use — violet through blue, teal,
 * green, yellow, orange, red — because it is the one people already read
 * fluently. Stops cluster between 10 and 36 where most inhabited land sits, so
 * the range that matters gets most of the colour rather than being flattened
 * into one green.
 *
 * Spans a real Earth range rather than the range of the current grid: a fixed
 * scale means the same colour means the same temperature every time you look,
 * which an auto-fitted scale cannot promise.
 */
export const TEMP_STOPS = Object.freeze([
  { t: -40, color: '#8f6fc4' },
  { t: -25, color: '#7d8fd0' },
  { t: -10, color: '#5fb0c9' },
  { t: 0, color: '#3fae8f' },
  { t: 10, color: '#54b46a' },
  { t: 18, color: '#b7c94f' },
  { t: 24, color: '#e8c341' },
  { t: 30, color: '#e8913b' },
  { t: 36, color: '#dd5f33' },
  { t: 45, color: '#b8322c' },
]);

/**
 * Interpolated colour for a temperature.
 *
 * @param {number} celsius
 * @param {number} [alpha]
 * @returns {Cesium.Color}
 */
export function temperatureColor(celsius, alpha = 0.5) {
  const t = Number(celsius);
  if (!Number.isFinite(t)) return Cesium.Color.GRAY.withAlpha(alpha);
  if (t <= TEMP_STOPS[0].t) return Cesium.Color.fromCssColorString(TEMP_STOPS[0].color).withAlpha(alpha);
  const last = TEMP_STOPS[TEMP_STOPS.length - 1];
  if (t >= last.t) return Cesium.Color.fromCssColorString(last.color).withAlpha(alpha);

  for (let i = 0; i < TEMP_STOPS.length - 1; i += 1) {
    const lo = TEMP_STOPS[i];
    const hi = TEMP_STOPS[i + 1];
    if (t >= lo.t && t <= hi.t) {
      const ratio = (t - lo.t) / (hi.t - lo.t);
      return Cesium.Color.lerp(
        Cesium.Color.fromCssColorString(lo.color),
        Cesium.Color.fromCssColorString(hi.color),
        ratio,
        new Cesium.Color()
      ).withAlpha(alpha);
    }
  }
  return Cesium.Color.GRAY.withAlpha(alpha);
}

/** WMO weather codes, condensed. Open-Meteo reports these with the forecast. */
const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
};

/**
 * @param {number} code
 * @returns {string}
 */
export function weatherText(code) {
  return WMO[Number(code)] || '—';
}

/**
 * Short weekday for an ISO date, or TODAY.
 *
 * @param {string} iso
 * @param {number} index
 * @returns {string}
 */
export function dayLabel(iso, index) {
  if (index === 0) return 'TODAY';
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
}

/**
 * Find the photorealistic tileset in a scene.
 *
 * @param {object} viewer
 * @returns {object|null}
 */
function findPhotorealTileset(viewer) {
  const prims = viewer?.scene?.primitives;
  if (!prims) return null;
  for (let i = 0; i < prims.length; i += 1) {
    const p = prims.get(i);
    if (p && p.imageryLayers && typeof p.maximumScreenSpaceError === 'number') return p;
  }
  return null;
}

/**
 * Create the layer.
 *
 * @returns {object} Layer module.
 */
export function createTemperatureLayer() {
  /** The photoreal tileset, which hosts the imagery layer. */
  let _tileset = null;
  /** @type {object|null} */
  let _imageryLayer = null;
  let _provider = null;
  const _coarseElevation = createCoarseElevation();
  /** Built once; the ramp never changes. */
  let _colorTable = null;
  /** Bilinear sampling index, built from the cells. */
  let _lookup = null;
  /** @type {Array<object>} */
  let _cells = [];
  let _stepDeg = 10;
  let _generated = '';
  let _complete = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _rowControlsListener = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;
  let _panel = null;
  let _hover = null;
  /** 'air' (Open-Meteo field) or 'surface' (NASA 1 km tiles). */
  let _mode = 'air';
  /** @type {object|null} */
  let _gibsLayer = null;
  let _gibsDate = '';


  /**
   * Sample the grid at any lat/lon, bilinearly.
   *
   * The grid is 10 degrees apart, which as discrete rectangles looked like
   * exactly what it is: giant coloured squares stamped over the map. Real
   * temperature is a smooth field, so it should be drawn as one. Interpolating
   * between the four surrounding samples turns the same data into a continuous
   * gradient with no visible cell edges.
   *
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null} Celsius, or null outside the grid.
   */
  function sampleAt(lat, lon) {
    return sampleBilinear(_lookup, lat, lon);
  }

  /**
   * Temperature at the actual ground, which is what the map paints.
   *
   * {@link sampleAt} returns the sea-level field; this puts the altitude back.
   * The elevation comes from the provider's own tile cache, so the number
   * reported here is computed from the very same sample as the colour beneath
   * the cursor and the two cannot drift apart.
   *
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function surfaceAt(lat, lon) {
    const seaLevel = sampleAt(lat, lon);
    if (seaLevel === null) return null;
    const metres = _provider?.elevationAt(lat, lon);
    const height = Number.isFinite(metres) ? metres : _coarseElevation.at(lat, lon);
    return seaLevel - (LAPSE_C_PER_M * lapseElevation(height));
  }

  /** Build the lat/lon lookup the sampler reads. */
  function indexGrid() {
    if (!_cells.length) { _lookup = null; return; }
    const lats = [...new Set(_cells.map((c) => c.lat))].sort((a, b) => a - b);
    const lons = [...new Set(_cells.map((c) => c.lon))].sort((a, b) => a - b);
    const step = _stepDeg;
    const cols = lons.length;
    const rows = lats.length;
    const values = new Float32Array(cols * rows).fill(NaN);
    const lonIndex = new Map(lons.map((v, i) => [v, i]));
    const latIndex = new Map(lats.map((v, i) => [v, i]));
    for (const cell of _cells) {
      const i = lonIndex.get(cell.lon);
      const j = latIndex.get(cell.lat);
      if (i === undefined || j === undefined) continue;
      // Store SEA-LEVEL temperature, not the observed value. Each reading is
      // credited back the warmth its own altitude took away, which is what
      // makes the field smooth enough to interpolate honestly: a station on a
      // plateau and one in the valley below it disagree by degrees purely
      // because of height, and interpolating between them as-is smears that
      // height difference sideways across the map. The altitude is subtracted
      // again per-pixel at full elevation resolution when the tile is drawn.
      values[j * cols + i] = cell.t + (LAPSE_C_PER_M * lapseElevation(_coarseElevation.at(cell.lat, cell.lon)));
    }
    _lookup = { minLat: lats[0], minLon: lons[0], step, cols, rows, values };
  }

  /**
   * Put the field on the map as an imagery layer over the 3D tiles.
   *
   * This is what "mixed in with the ground" means technically: the tileset
   * composites the image into its own surface shading, so terrain and cities
   * still read through it. The previous approach — classified rectangles —
   * could only ever be a sheet laid on top.
   *
   * @returns {void}
   */
  function render() {
    indexGrid();
    removeImagery();
    if (!_lookup || !_tileset?.imageryLayers) return;
    try {
      if (!_colorTable) _colorTable = buildColorTable(temperatureColor);
      // A TILED provider, not one global image. The previous version painted
      // the whole planet into a single 720x360 canvas, which is half a degree
      // per pixel — about 55 km — so every mountain range on Earth landed
      // inside one pixel and the map could not show terrain even in principle.
      // Tiles let the detail scale with the zoom, and each one downscales the
      // field by its own elevation as it is drawn.
      _provider = createTerrainTemperatureProvider({
        sampleSeaLevel: sampleAt,
        colorTable: _colorTable,
        alpha: FIELD_ALPHA,
      });
      _imageryLayer = _tileset.imageryLayers.addImageryProvider(_provider);
      _imageryLayer.show = _enabled && _mode === 'air';
    } catch (error) {
      _lastError = `Imagery layer failed: ${error?.message || error}`;
    }
    _rowControlsListener?.();
  }

  /**
   * Most recent date GIBS actually has a tile for.
   *
   * Satellite products publish on a lag that varies by day, so today is often
   * empty. Probing one known tile per candidate date costs three small requests
   * at worst and avoids showing a blank globe.
   *
   * @returns {Promise<string>}
   */
  async function resolveGibsDate() {
    for (let back = 1; back <= 5; back += 1) {
      const d = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
      const probe = GIBS_URL
        .replace('{Layer}', GIBS_LAYER).replace('{Time}', d)
        .replace('{TileMatrixSet}', GIBS_MATRIX)
        .replace('{TileMatrix}', '3').replace('{TileRow}', '2').replace('{TileCol}', '4');
      try {
        const response = await fetch(probe, { method: 'HEAD' });
        if (response.ok) return d;
      } catch { /* try the next day */ }
    }
    return new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  }

  /**
   * Attach the NASA 1 km surface-temperature tiles.
   *
   * @returns {Promise<void>}
   */
  async function addGibs() {
    if (!_tileset?.imageryLayers || _gibsLayer) return;
    try {
      _gibsDate = await resolveGibsDate();
      const provider = new Cesium.WebMapTileServiceImageryProvider({
        url: GIBS_URL,
        layer: GIBS_LAYER,
        style: 'default',
        format: 'image/png',
        tileMatrixSetID: GIBS_MATRIX,
        maximumLevel: GIBS_MAX_LEVEL,
        tilingScheme: new Cesium.GeographicTilingScheme(),
        dimensions: { Time: _gibsDate },
        credit: new Cesium.Credit('NASA EOSDIS GIBS · MODIS', true),
      });
      _gibsLayer = _tileset.imageryLayers.addImageryProvider(provider);
      _gibsLayer.alpha = FIELD_ALPHA;
      _gibsLayer.show = _enabled && _mode === 'surface';
    } catch (error) {
      _lastError = `NASA tiles failed: ${error?.message || error}`;
    }
  }

  /** @returns {void} */
  function removeGibs() {
    if (_gibsLayer && _tileset?.imageryLayers) {
      try { _tileset.imageryLayers.remove(_gibsLayer, true); } catch { /* already gone */ }
    }
    _gibsLayer = null;
  }

  /** Show whichever source is selected. */
  function applyMode() {
    if (_imageryLayer) _imageryLayer.show = _enabled && _mode === 'air';
    if (_gibsLayer) _gibsLayer.show = _enabled && _mode === 'surface';
    if (_mode === 'surface' && !_gibsLayer) void addGibs();
    _rowControlsListener?.();
  }

  /** @returns {void} */
  function removeImagery() {
    if (_imageryLayer && _tileset?.imageryLayers) {
      try { _tileset.imageryLayers.remove(_imageryLayer, true); } catch { /* already gone */ }
    }
    _imageryLayer = null;
    _provider = null;
  }

  /**
   * Fetch and show the forecast for a cell.
   *
   * @param {object} cell
   * @returns {Promise<void>}
   */
  async function showForecast(cell) {
    if (!_panel) return;
    const set = (key, text) => {
      const node = _panel.querySelector(`[data-temp="${key}"]`);
      if (node) node.textContent = text;
    };
    _panel.hidden = false;
    set('place', `${cell.lat.toFixed(1)}°, ${cell.lon.toFixed(1)}°`);
    set('now', `${cell.t}°C`);
    set('cond', 'Loading…');
    const days = _panel.querySelector('[data-temp="days"]');
    if (days) days.innerHTML = '';

    try {
      const response = await fetch(`${FORECAST_URL}?lat=${cell.lat}&lon=${cell.lon}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      const current = data?.current || {};
      set('now', `${Math.round(Number(current.temperature_2m))}°C`);
      const feels = Number(current.apparent_temperature);
      set('cond', [
        weatherText(current.weather_code),
        Number.isFinite(feels) ? `feels ${Math.round(feels)}°` : null,
        Number.isFinite(Number(current.relative_humidity_2m)) ? `${Math.round(Number(current.relative_humidity_2m))}% humidity` : null,
        Number.isFinite(Number(current.wind_speed_10m)) ? `${Math.round(Number(current.wind_speed_10m))} km/h wind` : null,
      ].filter(Boolean).join(' · '));

      const daily = data?.daily;
      if (days && daily?.time) {
        for (let i = 0; i < daily.time.length; i += 1) {
          const row = document.createElement('div');
          row.className = 'temp-day';
          row.innerHTML = `
            <span class="temp-day-name">${dayLabel(daily.time[i], i)}</span>
            <span class="temp-day-cond">${weatherText(daily.weather_code?.[i])}</span>
            <span class="temp-day-range">
              <span class="temp-day-max">${Math.round(Number(daily.temperature_2m_max?.[i]))}°</span>
              <span class="temp-day-min">${Math.round(Number(daily.temperature_2m_min?.[i]))}°</span>
            </span>`;
          days.appendChild(row);
        }
      }
    } catch (error) {
      set('cond', `Forecast unavailable (${error?.message || error})`);
    }
  }

  /** @returns {void} */
  function closePanel() {
    if (_panel) _panel.hidden = true;
  }

  /**
   * Show the cursor readout at a screen position.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} celsius
   * @returns {void}
   */
  function showHover(x, y, celsius) {
    if (!_hover) return;
    const when = new Date().toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).replace(',', '');
    _hover.innerHTML = `${Math.round(celsius)} °C<span class="temp-hover-when">${when}</span>`;
    // Offset up and right of the pointer, and flipped when near an edge so the
    // pill never runs off screen or sits under the cursor.
    const rect = _hover.getBoundingClientRect();
    const flipX = x + 18 + rect.width > window.innerWidth;
    const flipY = y - 14 - rect.height < 0;
    _hover.style.left = `${flipX ? x - 18 - rect.width : x + 18}px`;
    _hover.style.top = `${flipY ? y + 18 : y - 14 - rect.height}px`;
    _hover.hidden = false;
  }

  /** @returns {void} */
  function hideHover() {
    if (_hover) _hover.hidden = true;
  }

  /**
   * @param {object} viewer
   * @returns {void}
   */
  function installInteraction(viewer) {
    if (_clickHandler || !viewer?.scene?.canvas) return;
    _panel = document.getElementById('temp-panel');
    _hover = document.getElementById('temp-hover');
    _panel?.querySelector('[data-temp="close"]')?.addEventListener('click', closePanel);

    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled || !_lookup) return;
      // There are no entities to pick any more — the field is one image. So
      // resolve the ground point under the cursor and sample the field there,
      // which also means the forecast is for the exact spot clicked rather
      // than for the centre of a 10-degree cell.
      const cartesian = viewer.scene.pickPosition(click.position)
        || viewer.camera.pickEllipsoid(click.position, Cesium.Ellipsoid.WGS84);
      if (!cartesian) return;
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const t = surfaceAt(lat, lon);
      if (t === null) return;
      void showForecast({ lat: Number(lat.toFixed(3)), lon: Number(lon.toFixed(3)), t: Number(t.toFixed(1)) });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Cursor readout. Reads the interpolated field rather than calling the API:
    // a request per mouse move would exhaust the free tier in seconds, and the
    // field is already in memory so this costs nothing and never lags.
    _clickHandler.setInputAction((movement) => {
      if (!_enabled || !_lookup) { hideHover(); return; }
      const position = movement.endPosition;
      const cartesian = viewer.scene.pickPosition(position)
        || viewer.camera.pickEllipsoid(position, Cesium.Ellipsoid.WGS84);
      if (!cartesian) { hideHover(); return; }
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      const t = surfaceAt(
        Cesium.Math.toDegrees(carto.latitude),
        Cesium.Math.toDegrees(carto.longitude)
      );
      if (t === null) { hideHover(); return; }
      showHover(position.x, position.y, t);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }

  const layer = {
    id: 'temperature',
    name: 'Temperature',
    icon: '🌡️',
    // Overwritten from the payload once a grid arrives. Attribution is a
    // licence condition for both sources, so it has to name the one that
    // actually produced the numbers on screen, not a hardcoded guess.
    source: 'Open-Meteo',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      // The tileset is looked up rather than injected so the layer's signature
      // matches every other module the manager registers.
      _tileset = findPhotorealTileset(viewer);
      _cells = [];
      _lookup = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
    },

    enable(viewer) {
      _enabled = true;
      if (!_tileset) _tileset = findPhotorealTileset(viewer);
      installInteraction(viewer);
      applyMode();
    },

    disable() {
      _enabled = false;
      if (_imageryLayer) _imageryLayer.show = false;
      if (_gibsLayer) _gibsLayer.show = false;
      closePanel();
      hideHover();
    },

    async update() {
      try {
        const response = await fetch(GRID_URL);
        if (!response.ok) {
          _lastError = `Temperature HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const cells = Array.isArray(payload?.cells) ? payload.cells : [];
        if (!cells.length) {
          _lastError = 'No temperature cells returned';
          return false;
        }
        _cells = cells;
        _stepDeg = Number(payload.stepDeg) || 10;
        _generated = String(payload.generated || '');
        // While the sweep is partial, keep polling so the map sharpens; once
        // complete, back off to the server's cache lifetime.
        _complete = payload.complete === true;
        const sourceName = payload?.source?.name;
        if (typeof sourceName === 'string' && sourceName) layer.source = sourceName;
        layer.updateInterval = _complete ? UPDATE_INTERVAL_SETTLED_MS : UPDATE_INTERVAL_MS;
        _lastUpdate = Date.now();
        _lastError = null;
        // The sea-level reduction needs elevation for every observation, so the
        // coarse mosaic has to be in hand before the grid is indexed. Sixteen
        // tiles, fetched once, then cached for the life of the session.
        await _coarseElevation.ready();
        render();
        return true;
      } catch (error) {
        _lastError = String(error?.message || error);
        return false;
      }
    },

    /** @param {Function} listener */
    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * @param {{mode?: string}} params
     * @returns {boolean}
     */
    setParams(params = {}) {
      if (params.mode !== 'air' && params.mode !== 'surface') return false;
      if (params.mode === _mode) return true;
      _mode = params.mode;
      applyMode();
      return true;
    },

    /** @returns {object} */
    getRowControls() {
      // A handful of stops rather than every one: the row is narrow, and the
      // point is to say which end is hot.
      // Counts are per band, not null: the row renders whatever `count` holds,
      // so null printed the literal text "null" beside every swatch.
      const bands = [
        { label: '≤ -20°', t: -20, test: (v) => v <= -20 },
        { label: '0°', t: 0, test: (v) => v > -20 && v <= 0 },
        { label: '10°', t: 10, test: (v) => v > 0 && v <= 10 },
        { label: '20°', t: 20, test: (v) => v > 10 && v <= 20 },
        { label: '30°+', t: 30, test: (v) => v > 20 },
      ];
      return {
        chips: [
          {
            id: 'temp-air', label: 'AIR', active: _mode === 'air',
            params: { mode: 'air' },
            title: 'Air temperature 2 m above ground, Open-Meteo. Smooth but 10-degree resolution.',
          },
          {
            id: 'temp-surface', label: 'SURFACE 1KM', active: _mode === 'surface',
            params: { mode: 'surface' },
            title: 'Land surface temperature from NASA MODIS at 1 km — shows terrain, but measures the ground, not the air.',
          },
        ],
        legend: bands.map((band) => ({
          label: band.label,
          color: temperatureColor(band.t, 1).toCssColorString(),
          count: _cells.filter((cell) => band.test(cell.t)).length,
          blurb: 'Current air temperature at 2 m. Tap a cell for a five-day forecast.',
        })),
      };
    },

    getStats() {
      return {
        count: _cells.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Say plainly when the field is still filling in, rather than showing a
        // coarse map with no explanation for why it looks blocky.
        note: _generated
          ? `${_stepDeg}° grid, elevation-corrected${_complete ? '' : ' — still filling in'}, ${_generated.slice(11, 16)} UTC`
          : '',
      };
    },
  };

  return layer;
}

const temperatureLayer = createTemperatureLayer();

export default temperatureLayer;
