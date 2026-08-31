import * as Cesium from 'cesium';

/**
 * Airports.
 *
 * 11,444 airports worldwide with their runways: length, surface, lighting and
 * TRUE heading. Compiled by scripts/compile-airports.mjs from OurAirports,
 * which is public domain — no key, no attribution requirement, no
 * redistribution restriction.
 *
 * WHY THE RUNWAY DATA IS HERE and not just a dot. The flight simulator had
 * nowhere to aim: photorealistic tiles are photographs, so they can show a
 * runway but cannot say which way it points, how long it is, or whether it is
 * paved. A pilot needs all three before committing to an approach, and so does
 * anyone flying the sim.
 *
 * WHAT IS NOT HERE. Heliports, seaplane bases and closed fields are excluded at
 * compile time. A closed airport drawn on a map is a lie about where you can
 * land, and 13,482 of them would have been drawn.
 */

const API_URL = '/api/airports';

/** Static reference data. Runways do not move. */
const UPDATE_INTERVAL_MS = 0;

/** How deep to drill for a marker under the cursor. */
const PICK_DEPTH = 8;

/**
 * Marker styling by airport size.
 *
 * Deliberately not a continuous scale on runway length: three sizes read as
 * three categories at a glance, whereas a smooth ramp reads as noise. Colour
 * carries the same information as size so the distinction survives for anyone
 * who cannot easily compare small dots.
 */
export const AIRPORT_TIERS = Object.freeze({
  large: { label: 'Large', color: '#4fd8e8', pixelSize: 11, minZoomM: Infinity },
  medium: { label: 'Medium', color: '#7fd4a0', pixelSize: 8, minZoomM: 900_000 },
  small: { label: 'Small', color: '#9aa8b4', pixelSize: 5, minZoomM: 260_000 },
});

const TIER_ORDER = Object.freeze(['large', 'medium', 'small']);

/**
 * Format a runway for display.
 *
 * @param {object} runway
 * @returns {string}
 */
export function runwayLine(runway) {
  if (!runway) return '';
  const parts = [];
  if (runway.ident) parts.push(runway.ident);
  if (Number.isFinite(runway.lengthFt)) {
    parts.push(`${runway.lengthFt.toLocaleString()} ft`);
  }
  if (runway.surface) parts.push(runway.surface.toUpperCase());
  if (runway.lit) parts.push('LIT');
  if (Number.isFinite(runway.headingDeg)) {
    parts.push(`${Math.round(runway.headingDeg).toString().padStart(3, '0')}°T`);
  }
  return parts.join(' · ');
}

/**
 * Whether an aircraft of a given class can use this airport.
 *
 * Used by the flight simulator to answer "can I land here". A 747 needs roughly
 * 8,000 ft of hard runway at typical landing weight; light aircraft need far
 * less. Deliberately conservative: telling someone they can land somewhere they
 * cannot is worse than the reverse.
 *
 * @param {object} airport
 * @param {number} requiredFt
 * @returns {boolean}
 */
export function canAccept(airport, requiredFt = 8000) {
  if (!airport) return false;
  return (airport.runways || []).some(
    (runway) => runway.hard && Number(runway.lengthFt) >= requiredFt
  );
}

/**
 * The nearest airport to a point that can take the aircraft.
 *
 * @param {Array<object>} airports
 * @param {number} lat
 * @param {number} lon
 * @param {number} [requiredFt]
 * @returns {object|null}
 */
export function nearestUsable(airports, lat, lon, requiredFt = 8000) {
  let best = null;
  let bestScore = Infinity;
  for (const airport of airports || []) {
    if (!canAccept(airport, requiredFt)) continue;
    // Squared degrees is not a distance, but it orders correctly over the
    // ranges that matter here and costs no trigonometry per candidate.
    const dLat = airport.lat - lat;
    const dLon = (airport.lon - lon) * Math.cos((lat * Math.PI) / 180);
    const score = (dLat * dLat) + (dLon * dLon);
    if (score < bestScore) { bestScore = score; best = airport; }
  }
  return best;
}

/**
 * Create the layer.
 *
 * @returns {object} Layer module.
 */
export function createAirportsLayer() {
  /** @type {Cesium.CustomDataSource|null} */
  let _dataSource = null;
  /** @type {Array<object>} */
  let _airports = [];
  let _shown = 0;
  let _loaded = false;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _coverageNote = '';
  /** Which size tiers are drawn. */
  let _tiers = new Set(['large', 'medium']);
  let _rowControlsListener = null;
  let _clickHandler = null;
  let _card = null;

  /** @returns {Array<object>} */
  function visible() {
    return _airports.filter((airport) => _tiers.has(airport.type));
  }

  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    const rows = visible();
    _shown = 0;

    for (const airport of rows) {
      const tier = AIRPORT_TIERS[airport.type] || AIRPORT_TIERS.small;
      try {
        _dataSource.entities.add({
          id: `airport-${airport.id}`,
          position: Cesium.Cartesian3.fromDegrees(airport.lon, airport.lat),
          point: {
            pixelSize: tier.pixelSize,
            color: Cesium.Color.fromCssColorString(tier.color).withAlpha(0.92),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.55),
            outlineWidth: 1,
            // Clamped, or the marker floats at ellipsoid height and sinks into
            // the terrain wherever the ground is above it.
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            // Finite, not Infinity: an infinite value draws the marker through
            // the planet, so airports on the far side show through the globe.
            disableDepthTestDistance: 50_000,
            // Small fields only appear once the camera is close enough for them
            // to be distinguishable; drawn at global zoom they are a grey haze
            // over every populated continent.
            distanceDisplayCondition: Number.isFinite(tier.minZoomM)
              ? new Cesium.DistanceDisplayCondition(0, tier.minZoomM)
              : undefined,
          },
          properties: { airport },
        });
        _shown += 1;
      } catch {
        // One bad row must not abandon the rest of the world.
      }
    }
    _rowControlsListener?.();
  }

  /**
   * Show the detail card for an airport.
   *
   * @param {object} airport
   * @returns {void}
   */
  function showCard(airport) {
    _card = document.getElementById('airport-card');
    if (!_card) return;
    const code = [airport.icao, airport.iata].filter(Boolean).join(' / ');
    const runways = (airport.runways || []).map(
      (runway) => `<li>${runwayLine(runway)}</li>`
    ).join('');
    _card.innerHTML = `
      <button class="airport-card-close" data-airport="close" aria-label="Close">×</button>
      <div class="airport-card-type">${(AIRPORT_TIERS[airport.type] || {}).label || ''} airport</div>
      <h3 class="airport-card-name">${airport.name}</h3>
      <div class="airport-card-code">${code}</div>
      <div class="airport-card-meta">
        ${airport.municipality ? `${airport.municipality} · ` : ''}${airport.country}
        ${Number.isFinite(airport.elevationFt) ? ` · ${airport.elevationFt.toLocaleString()} ft elev` : ''}
      </div>
      ${runways ? `<div class="airport-card-runways"><div class="airport-card-label">RUNWAYS</div><ul>${runways}</ul></div>` : ''}
    `;
    _card.hidden = false;
    _card.querySelector('[data-airport="close"]')?.addEventListener('click', closeCard);
  }

  function closeCard() {
    if (_card) _card.hidden = true;
  }

  /** @param {object} viewer */
  function installInteraction(viewer) {
    if (_clickHandler || !viewer?.scene?.canvas) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      // drillPick, not pick: a plain pick returns the topmost primitive, which
      // over Google's photorealistic tiles is the tile surface itself, so every
      // click on a marker reads as empty ground.
      const hits = viewer.scene.drillPick(click.position, PICK_DEPTH) || [];
      for (const hit of hits) {
        const airport = hit?.id?.properties?.airport?.getValue?.();
        if (airport) { showCard(airport); return; }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: 'airports',
    name: 'Airports',
    icon: '🛬',
    source: 'OurAirports',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('airports');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _airports = [];
      _shown = 0;
      _loaded = false;
      _enabled = false;
      _lastUpdate = null;
      _lastError = null;
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      installInteraction(viewer);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      closeCard();
    },

    async update() {
      // Static reference data: fetched once. Re-fetching on a timer would be
      // pure waste, since none of these records change between deploys.
      if (_loaded) return true;
      try {
        const response = await fetch(API_URL);
        if (!response.ok) {
          _lastError = `Airports HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const rows = Array.isArray(payload?.airports) ? payload.airports : [];
        _airports = rows.filter(
          (row) => row && Number.isFinite(row.lat) && Number.isFinite(row.lon)
        );
        _coverageNote = typeof payload?.coverageNote === 'string' ? payload.coverageNote : '';
        _loaded = true;
        _lastUpdate = Date.now();
        _lastError = null;
        render();
        return true;
      } catch (error) {
        _lastError = String(error?.message || error);
        return false;
      }
    },

    /**
     * @param {{tiers?: Array<string>}} params
     * @returns {boolean}
     */
    setParams(params = {}) {
      if (!Array.isArray(params.tiers)) return false;
      const next = new Set(params.tiers.filter((tier) => tier in AIRPORT_TIERS));
      // An empty selection would silently blank the layer while it still reads
      // as enabled; keep the largest tier rather than showing nothing.
      if (!next.size) next.add('large');
      _tiers = next;
      render();
      return true;
    },

    /** @param {Function} listener */
    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const counts = _airports.reduce((acc, airport) => {
        acc[airport.type] = (acc[airport.type] || 0) + 1;
        return acc;
      }, {});
      return {
        chips: TIER_ORDER.map((tier) => {
          const selected = new Set(_tiers);
          if (selected.has(tier)) selected.delete(tier);
          else selected.add(tier);
          return {
            id: tier,
            label: `${AIRPORT_TIERS[tier].label.toUpperCase()} ${counts[tier] || 0}`,
            active: _tiers.has(tier),
            params: { tiers: [...selected] },
          };
        }),
        legend: TIER_ORDER.map((tier) => ({
          label: AIRPORT_TIERS[tier].label,
          color: AIRPORT_TIERS[tier].color,
          count: counts[tier] || 0,
          blurb: 'Runway length, surface and true heading on every airport.',
        })),
      };
    },

    getStats() {
      return {
        count: _shown,
        lastUpdate: _lastUpdate,
        error: _lastError,
        note: _coverageNote,
      };
    },

    /** @returns {Array<object>} For the flight simulator. */
    all() { return _airports; },
  };

  return layer;
}

const airportsLayer = createAirportsLayer();

export default airportsLayer;
