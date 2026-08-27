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
 * Create the layer.
 *
 * @returns {object} Layer module.
 */
export function createTemperatureLayer() {
  /** @type {Cesium.CustomDataSource|null} */
  let _dataSource = null;
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
  /** entityId -> cell, so a pick resolves without searching. */
  const _byEntityId = new Map();

  /** Paint one rectangle per grid cell. */
  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    _byEntityId.clear();
    const half = _stepDeg / 2;

    for (const cell of _cells) {
      const id = `temp-${cell.lat}-${cell.lon}`;
      _byEntityId.set(id, cell);
      try {
        _dataSource.entities.add({
          id,
          rectangle: {
            // Longitude is clamped as well as latitude. The grid starts at
            // -180, so the western edge of that column was -185 and Cesium
            // rejected it with "Expected west to be greater than or equal to
            // -3.14159…" — which is not a warning, it STOPS RENDERING and puts
            // an error dialog over the whole app. Clamping narrows the two edge
            // columns by half a cell, which at 10-degree spacing is invisible.
            coordinates: Cesium.Rectangle.fromDegrees(
              Math.max(-180, cell.lon - half), Math.max(-90, cell.lat - half),
              Math.min(180, cell.lon + half), Math.min(90, cell.lat + half)
            ),
            material: temperatureColor(cell.t),
            // Draped on terrain so the shading follows the ground rather than
            // hovering as a flat sheet over mountains.
            classificationType: Cesium.ClassificationType.TERRAIN,
          },
          description: `${cell.t}°C at ${cell.lat}, ${cell.lon}`,
        });
      } catch {
        // One bad cell must not abandon the rest of the grid.
      }
    }
    _rowControlsListener?.();
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
      if (!_enabled) return;
      // drillPick, not pick: the cells are draped on the tile surface, so a
      // plain pick returns the terrain in front of them.
      const hits = viewer.scene.drillPick(click.position, 8);
      for (const hit of hits) {
        const id = typeof hit?.id?.id === 'string' ? hit.id.id : null;
        if (id && _byEntityId.has(id)) {
          void showForecast(_byEntityId.get(id));
          return;
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: 'temperature',
    name: 'Temperature',
    icon: '🌡️',
    source: 'Open-Meteo',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('temperature');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _cells = [];
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      installInteraction(viewer);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
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
      return {
        legend: [-20, 0, 10, 20, 30].map((t) => ({
          label: `${t}°`,
          color: temperatureColor(t, 1).toCssColorString(),
          count: null,
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
