import * as Cesium from 'cesium';

/**
 * Civilian mass shootings.
 *
 * Public-record incidents — school, workplace, place-of-worship, retail and
 * public-space attacks — placed on the globe by date and location, with a
 * death-toll filter.
 *
 * DELIBERATE OMISSION: perpetrator names are never fetched, stored or shown.
 * That follows the "No Notoriety" / "Don't Name Them" guidance that criminology
 * researchers and most newsrooms now work to, on evidence that naming attackers
 * contributes to contagion. The map's subject is WHERE this happened and HOW
 * MANY people it took, which is also the only part a map can honestly render.
 * The ingest drops any perpetrator field a source carries; see
 * `/api/shootings` in vite.config.js.
 *
 * SCOPE: civilian incidents only. Armed conflict, insurgency, military
 * operations and state violence are excluded at the source level — those are a
 * different subject with different data, and merging them would misrepresent
 * both.
 *
 * COVERAGE IS UNEVEN AND THE LAYER SAYS SO. A handful of countries — the United
 * States most of all — have dedicated organisations cataloguing these events;
 * most have none. So this map is dense over North America and sparse elsewhere,
 * and that reflects WHERE RECORDS ARE KEPT, not where shootings happen. The row
 * meta line states this rather than letting the visual imply otherwise.
 */

/** Compiled dataset, served by our own endpoint rather than fetched per-source. */
const API_URL = '/api/shootings';

/**
 * Static history: there is nothing to re-poll. The manager still calls update()
 * once on enable, and this keeps it from re-fetching on a timer afterwards.
 */
const UPDATE_INTERVAL_MS = 0;

/**
 * Within this range of the camera, markers ignore the depth test so terrain
 * cannot swallow them; beyond it the globe occludes them normally.
 */
const NEAR_DEPTH_TEST_SKIP_M = 50_000;

/**
 * How deep to drill when picking. Enough to see past the tile surface and a
 * couple of other layers' primitives without walking the whole scene.
 */
const PICK_DEPTH = 8;

/** Filter floor presented on the row slider. */
export const MIN_KILLED_FLOOR = 0;
/** Filter ceiling. Above this the slider stops being useful — very few
 *  incidents reach it, and the map would go empty. */
export const MIN_KILLED_CEILING = 50;

/**
 * Marker colour by death toll.
 *
 * A restrained, single-hue ramp on purpose. This is a record of people killed;
 * a rainbow scale or anything that reads as "score" would be grotesque.
 *
 * @param {number} killed
 * @returns {Cesium.Color}
 */
export function tollColor(killed) {
  const n = Number(killed) || 0;
  if (n >= 20) return Cesium.Color.fromCssColorString('#f2545b');
  if (n >= 10) return Cesium.Color.fromCssColorString('#e07a5f');
  if (n >= 5) return Cesium.Color.fromCssColorString('#dfa06e');
  return Cesium.Color.fromCssColorString('#c8b6a6');
}

/**
 * Marker radius in pixels.
 *
 * Compressed with a cube root so a 60-death incident does not render sixty
 * times the area of a single-death one; the point is to be findable, not to
 * dramatise a body count.
 *
 * @param {number} killed
 * @returns {number}
 */
export function tollRadiusPx(killed) {
  const n = Math.max(0, Number(killed) || 0);
  return 4 + Math.cbrt(n) * 2.6;
}

/**
 * Normalise one API record, rejecting anything unplottable.
 *
 * Returns null rather than a partial entity: a marker at coordinates we guessed
 * would be a false claim about where someone died.
 *
 * @param {object} raw
 * @param {number} index
 * @returns {object|null}
 */
export function normalizeIncident(raw, index = 0) {
  if (!raw) return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const killed = Number.isFinite(Number(raw.killed)) ? Math.max(0, Number(raw.killed)) : 0;
  const injured = Number.isFinite(Number(raw.injured)) ? Math.max(0, Number(raw.injured)) : 0;

  return {
    id: String(raw.id || `incident-${index}`),
    date: typeof raw.date === 'string' ? raw.date : '',
    lat,
    lon,
    placeName: typeof raw.placeName === 'string' ? raw.placeName : '',
    country: typeof raw.country === 'string' ? raw.country : '',
    killed,
    injured,
    venueType: typeof raw.venueType === 'string' ? raw.venueType : '',
    precision: typeof raw.precision === 'string' ? raw.precision : 'exact',
    sourceName: typeof raw.sourceName === 'string' ? raw.sourceName : '',
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
  };
}

/**
 * Incidents at or above a death-toll floor.
 *
 * @param {Array<object>} incidents
 * @param {number} minKilled
 * @returns {Array<object>}
 */
export function filterByToll(incidents, minKilled) {
  const floor = Math.max(0, Number(minKilled) || 0);
  if (floor <= 0) return incidents;
  return incidents.filter((incident) => incident.killed >= floor);
}

/**
 * Human label for the filter readout.
 *
 * @param {number} minKilled
 * @param {number} shown
 * @param {number} total
 * @returns {string}
 */
export function filterLabel(minKilled, shown, total) {
  const floor = Math.max(0, Number(minKilled) || 0);
  const counts = `${shown.toLocaleString('en-US')}/${total.toLocaleString('en-US')}`;
  return floor <= 0 ? `ALL · ${counts}` : `${floor}+ · ${counts}`;
}

/**
 * Card text for one incident.
 *
 * @param {object} incident
 * @returns {string}
 */
export function describeIncident(incident) {
  const where = [incident.placeName, incident.country].filter(Boolean).join(', ');
  const toll = [
    incident.killed ? `${incident.killed} killed` : null,
    incident.injured ? `${incident.injured} injured` : null,
  ].filter(Boolean).join(', ') || 'toll not recorded';
  return [incident.date, where, toll].filter(Boolean).join(' · ');
}

/**
 * Create the layer.
 *
 * @returns {object} Layer module.
 */
export function createShootingsLayer() {
  /** @type {Cesium.CustomDataSource|null} */
  let _dataSource = null;
  /** @type {Array<object>} */
  let _incidents = [];
  let _minKilled = MIN_KILLED_FLOOR;
  let _shown = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _loaded = false;
  let _coverageNote = '';
  let _rowControlsListener = null;
  /** entityId -> incident, so a pick resolves without searching. */
  const _byEntityId = new Map();
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;
  let _card = null;

  /** Repaint entities for the current filter. */
  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    _byEntityId.clear();
    const visible = filterByToll(_incidents, _minKilled);
    _shown = visible.length;

    let rejected = 0;
    for (const incident of visible) {
      const entityId = `shooting-${incident.id}`;
      // Guarded per record. A duplicate id makes entities.add throw, and an
      // unguarded throw here abandoned the loop partway — 378 of 654 markers
      // drawn and the rest silently missing. One malformed record should cost
      // one marker, not the map.
      try {
      _byEntityId.set(entityId, incident);
      _dataSource.entities.add({
        id: entityId,
        position: Cesium.Cartesian3.fromDegrees(incident.lon, incident.lat),
        point: {
          // Clamped to the surface. Without this the point sits at ellipsoid
          // height zero, which is BELOW ground anywhere with elevation — a
          // marker in Denver or Zurich was buried inside the terrain and could
          // not be seen or clicked.
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          pixelSize: tollRadiusPx(incident.killed),
          color: tollColor(incident.killed).withAlpha(0.85),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.55),
          outlineWidth: 1,
          // Markers stay legible at globe scale without swelling as you close
          // in on one — the size means a death toll, so it must not also mean
          // camera distance.
          scaleByDistance: new Cesium.NearFarScalar(1.0e4, 1.0, 4.0e7, 0.45),
          // FINITE, not Infinity. Infinity disables the depth test outright,
          // which meant markers on the far side of the planet drew straight
          // through it — incidents in the United States appearing over the
          // empty South Pacific and across Antarctica.
          //
          // A finite value keeps the useful half of that behaviour: within
          // this range the depth test is still skipped, so a marker is not
          // swallowed by the hill or building it sits on. Beyond it the globe
          // occludes as it should.
          disableDepthTestDistance: NEAR_DEPTH_TEST_SKIP_M,
        },
        description: describeIncident(incident),
        properties: {
          date: incident.date,
          killed: incident.killed,
          injured: incident.injured,
          venueType: incident.venueType,
          sourceName: incident.sourceName,
          sourceUrl: incident.sourceUrl,
        },
      });
      } catch (error) {
        rejected += 1;
        _byEntityId.delete(entityId);
        if (rejected === 1) console.warn('[Data:Shootings] record rejected:', error?.message || error);
      }
    }
    if (rejected > 0) {
      _shown -= rejected;
      console.warn(`[Data:Shootings] ${rejected} record(s) could not be plotted`);
    }
    _rowControlsListener?.();
  }

  /**
   * Human date: "12 June 2016" reads as a day something happened; "2016-06-12"
   * reads as a database row.
   *
   * @param {string} iso
   * @returns {string}
   */
  function formatDate(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!match) return String(iso || '');
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
  }

  /**
   * How the marker was placed, said plainly.
   *
   * A point at a city centroid is a far weaker claim than one at the building,
   * and a map that renders both identically is quietly overstating one of them.
   *
   * @param {string} precision
   * @returns {string}
   */
  function precisionNote(precision) {
    if (precision === 'venue') return 'Marker placed at the venue';
    if (precision === 'area') return 'Marker placed at the surrounding area, not the exact site';
    return 'Marker placed at the recorded location';
  }

  /** Hide the detail card. @returns {void} */
  function closeCard() {
    if (_card) _card.hidden = true;
  }

  /**
   * Show one incident's details.
   *
   * @param {object} incident
   * @returns {void}
   */
  function showCard(incident) {
    if (!_card || !incident) return;
    const set = (key, text) => {
      const node = _card.querySelector(`[data-shooting="${key}"]`);
      if (node) node.textContent = text;
    };
    set('date', formatDate(incident.date));
    set('title', incident.placeName || 'Incident');
    set('place', [incident.country].filter(Boolean).join(''));
    // An unrecorded toll shows as an em dash rather than 0 — "0 killed" would
    // be a claim, and a missing figure is not the same as a zero one.
    set('killed', incident.killed > 0 ? String(incident.killed) : '—');
    set('injured', incident.injured > 0 ? String(incident.injured) : '—');
    set('precision', precisionNote(incident.precision));
    const source = _card.querySelector('[data-shooting="source"]');
    if (source) {
      source.href = incident.sourceUrl || '#';
      source.textContent = `Source · ${incident.sourceName || 'record'}`;
      source.hidden = !incident.sourceUrl;
    }
    _card.hidden = false;
  }

  /**
   * Wire clicks on markers to the detail card.
   *
   * @param {object} viewer
   * @returns {void}
   */
  function installInteraction(viewer) {
    if (_clickHandler || !viewer?.scene?.canvas) return;
    _card = document.getElementById('shooting-detail');
    _card?.querySelector('[data-shooting="close"]')
      ?.addEventListener('click', closeCard);

    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      // drillPick, not pick. A plain pick returns the topmost primitive, which
      // over photoreal tiles is the tile surface the marker is clamped to —
      // measured returning the tileset first and the marker second, so every
      // click on a marker read as a click on empty ground.
      const hits = viewer.scene.drillPick(click.position, PICK_DEPTH);
      let incident = null;
      for (const hit of hits) {
        const id = typeof hit?.id?.id === 'string' ? hit.id.id : null;
        if (id && _byEntityId.has(id)) {
          incident = _byEntityId.get(id);
          break;
        }
      }
      // A click on empty globe dismisses the card, which is what every map
      // does and what people expect without being told.
      if (incident) showCard(incident);
      else closeCard();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: 'shootings',
    name: 'Mass Shootings',
    icon: '🕯️',
    source: 'public records',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('shootings');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _incidents = [];
      _shown = 0;
      _loaded = false;
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
      // The card belongs to the layer: leaving it up over a globe with no
      // markers on it would be a detail panel for something invisible.
      closeCard();
    },

    async update() {
      // Historical data: fetched once, then filtered locally. Re-fetching on a
      // timer would be pure waste — none of these records change.
      if (_loaded) return true;
      try {
        const response = await fetch(API_URL);
        if (!response.ok) {
          _lastError = `Shootings HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const rows = Array.isArray(payload?.incidents) ? payload.incidents : [];
        _incidents = rows
          .map((row, index) => normalizeIncident(row, index))
          .filter(Boolean)
          // Deadliest last so they draw on top of the denser small markers.
          .sort((a, b) => a.killed - b.killed);
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
     * @param {{minKilled?: number}} params
     * @returns {boolean} Whether anything was accepted.
     */
    setParams(params = {}) {
      if (!Number.isFinite(Number(params.minKilled))) return false;
      const next = Math.max(
        MIN_KILLED_FLOOR,
        Math.min(MIN_KILLED_CEILING, Math.round(Number(params.minKilled)))
      );
      if (next === _minKilled) return true;
      _minKilled = next;
      render();
      return true;
    },

    /** @param {Function} listener */
    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * The death-toll filter, plus a legend that doubles as the honest
     * statement about coverage.
     *
     * @returns {object}
     */
    getRowControls() {
      return {
        sliders: [{
          id: 'min-killed',
          paramKey: 'minKilled',
          label: 'Deaths',
          min: MIN_KILLED_FLOOR,
          max: MIN_KILLED_CEILING,
          step: 1,
          value: _minKilled,
          valueLabel: filterLabel(_minKilled, _shown, _incidents.length),
          title: 'Show only incidents at or above this number of deaths',
        }],
        legend: [],
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
  };

  return layer;
}

const shootingsLayer = createShootingsLayer();

export default shootingsLayer;
