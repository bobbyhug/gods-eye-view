import * as Cesium from 'cesium';

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

/** Server caches for 30 minutes; asking more often just re-reads that cache. */
const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

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
 * Spans a real Earth range rather than the range of the current grid: a fixed
 * scale means the same colour means the same temperature every time you look,
 * which an auto-fitted scale cannot promise.
 */
export const TEMP_STOPS = Object.freeze([
  { t: -40, color: '#3b2f7a' },
  { t: -20, color: '#3f6fd0' },
  { t: 0, color: '#57b6e0' },
  { t: 10, color: '#8fd0a8' },
  { t: 20, color: '#e2d066' },
  { t: 30, color: '#e08a48' },
  { t: 45, color: '#c2392f' },
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
  /** Bilinear sampling index, built from the cells. */
  let _lookup = null;
  /** @type {Array<object>} */
  let _cells = [];
  let _stepDeg = 10;
  let _generated = '';
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _rowControlsListener = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;
  let _panel = null;


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
    if (!_lookup) return null;
    const { minLat, minLon, step, cols, rows, values } = _lookup;
    const x = (lon - minLon) / step;
    const y = (lat - minLat) / step;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;

    // Longitude wraps; latitude clamps at the poles.
    const col = (i) => ((i % cols) + cols) % cols;
    const row = (j) => Math.min(rows - 1, Math.max(0, j));
    const at = (j, i) => values[row(j) * cols + col(i)];

    const v00 = at(y0, x0);
    const v10 = at(y0, x0 + 1);
    const v01 = at(y0 + 1, x0);
    const v11 = at(y0 + 1, x0 + 1);
    if (![v00, v10, v01, v11].every(Number.isFinite)) return null;

    const top = v00 * (1 - fx) + v10 * fx;
    const bottom = v01 * (1 - fx) + v11 * fx;
    return top * (1 - fy) + bottom * fy;
  }

  /**
   * Draw the whole field into one canvas.
   *
   * One image rather than 648 primitives: it is smooth, it is a single draw,
   * and it can be handed to the tileset as an imagery layer so the colour sits
   * IN the ground texture instead of floating over it as a sheet.
   *
   * @returns {HTMLCanvasElement}
   */
  function paintCanvas() {
    const canvas = document.createElement('canvas');
    // Half a degree per pixel. Finer than this cannot add information — the
    // source grid is 10 degrees — but it keeps the gradient free of stair-steps.
    canvas.width = 720;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(canvas.width, canvas.height);
    const data = image.data;

    for (let py = 0; py < canvas.height; py += 1) {
      // Canvas y runs top-down, latitude runs bottom-up.
      const lat = 90 - (py + 0.5) * (180 / canvas.height);
      for (let px = 0; px < canvas.width; px += 1) {
        const lon = -180 + (px + 0.5) * (360 / canvas.width);
        const t = sampleAt(lat, lon);
        const i = (py * canvas.width + px) * 4;
        if (t === null) {
          data[i + 3] = 0;
          continue;
        }
        const colour = temperatureColor(t, 1);
        data[i] = Math.round(colour.red * 255);
        data[i + 1] = Math.round(colour.green * 255);
        data[i + 2] = Math.round(colour.blue * 255);
        // Alpha lives here rather than on the layer so the tint stays even
        // across the whole field.
        data[i + 3] = Math.round(FIELD_ALPHA * 255);
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
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
      values[j * cols + i] = cell.t;
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
      // A data URL, not an `image` option: Cesium 1.138's
      // SingleTileImageryProvider requires `url` and rejects an image with
      // "options.url is required". The canvas is small enough (720x360) that
      // encoding it costs nothing worth measuring.
      const provider = new Cesium.SingleTileImageryProvider({
        url: paintCanvas().toDataURL('image/png'),
        rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
        tileWidth: 720,
        tileHeight: 360,
      });
      _imageryLayer = _tileset.imageryLayers.addImageryProvider(provider);
      _imageryLayer.show = _enabled;
    } catch (error) {
      _lastError = `Imagery layer failed: ${error?.message || error}`;
    }
    _rowControlsListener?.();
  }

  /** @returns {void} */
  function removeImagery() {
    if (_imageryLayer && _tileset?.imageryLayers) {
      try { _tileset.imageryLayers.remove(_imageryLayer, true); } catch { /* already gone */ }
    }
    _imageryLayer = null;
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
   * @param {object} viewer
   * @returns {void}
   */
  function installInteraction(viewer) {
    if (_clickHandler || !viewer?.scene?.canvas) return;
    _panel = document.getElementById('temp-panel');
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
      const t = sampleAt(lat, lon);
      if (t === null) return;
      void showForecast({ lat: Number(lat.toFixed(3)), lon: Number(lon.toFixed(3)), t: Number(t.toFixed(1)) });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: 'temperature',
    name: 'Temperature',
    icon: '🌡️',
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
      if (_imageryLayer) _imageryLayer.show = true;
      installInteraction(viewer);
    },

    disable() {
      _enabled = false;
      if (_imageryLayer) _imageryLayer.show = false;
      closePanel();
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
        _lastUpdate = Date.now();
        _lastError = null;
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
        note: _generated ? `Grid generated ${_generated.slice(0, 16).replace('T', ' ')} UTC` : '',
      };
    },
  };

  return layer;
}

const temperatureLayer = createTemperatureLayer();

export default temperatureLayer;
