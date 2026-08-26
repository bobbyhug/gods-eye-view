/**
 * Global render quality.
 *
 * One setting that governs how much the renderer is allowed to spend on image
 * quality, across the whole app rather than inside any one mode.
 *
 * Two dials do nearly all the visible work:
 *
 *   - `resolutionScale` — the app renders at CSS pixels by default, so on a
 *     Retina display every edge is drawn at half the panel's real density.
 *     Raising this is what removes the stair-stepping on wings, roads and the
 *     horizon. Cost scales with the SQUARE of the value.
 *   - the photoreal tileset's `maximumScreenSpaceError` — inverse quality:
 *     lower means Cesium tolerates less on-screen error and streams sharper
 *     tiles. This is what makes distant ground look detailed instead of
 *     smeared.
 *
 * AUTO is the default and means "let whatever is running decide": Flight Sim
 * measures its own frame times and adapts, and the map sits at Cesium's
 * defaults. Choosing an explicit level pins both dials and turns adaptation
 * off, because a setting the user chose should not be silently overridden.
 */

/** Preference key. */
const STORAGE_KEY = 'gev.renderQuality';

/**
 * The levels, in order.
 *
 * `resolution: null` on AUTO means "leave it to the caller" rather than any
 * particular number.
 */
export const QUALITY_LEVELS = Object.freeze({
  auto: { label: 'Auto', resolution: null, tileError: null },
  low: { label: 'Low', resolution: 0.75, tileError: 24 },
  medium: { label: 'Medium', resolution: 1, tileError: 16 },
  high: { label: 'High', resolution: 1.5, tileError: 12 },
  ultra: { label: 'Ultra', resolution: 2, tileError: 8 },
});

/** @type {string} */
let level = 'auto';

/**
 * Read the stored preference.
 *
 * @returns {string} A valid level id, defaulting to 'auto'.
 */
export function loadRenderQuality() {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored && stored in QUALITY_LEVELS) level = stored;
  } catch {
    // Private browsing or a blocked store is not a reason to fail startup.
  }
  return level;
}

/** @returns {string} The active level id. */
export function getRenderQuality() {
  return level;
}

/** @returns {boolean} Whether a mode may adapt quality on its own. */
export function isAutoQuality() {
  return level === 'auto';
}

/**
 * The resolution scale for a level, resolved against this display.
 *
 * ULTRA is capped by the device's own pixel ratio: asking for 2x on a 1x panel
 * renders four times the pixels and then throws three quarters of them away.
 *
 * @param {string} id - Level id.
 * @returns {number|null} Scale, or null when the level does not pin one.
 */
export function resolutionForLevel(id) {
  const entry = QUALITY_LEVELS[id];
  if (!entry || entry.resolution === null) return null;
  const dpr = globalThis.devicePixelRatio || 1;
  return Math.min(entry.resolution, Math.max(1, dpr));
}

/**
 * Apply a level to the scene.
 *
 * @param {object} options
 * @param {object} options.viewer - Cesium viewer.
 * @param {object|null} [options.tileset] - Photoreal tileset, if present.
 * @param {string} options.id - Level id.
 * @param {object|null} [options.defaults] - Values to restore for AUTO.
 * @returns {void}
 */
export function applyRenderQuality({ viewer, tileset, id, defaults = null }) {
  const entry = QUALITY_LEVELS[id];
  if (!viewer || !entry) return;

  const resolution = resolutionForLevel(id);
  if (resolution !== null) {
    viewer.resolutionScale = resolution;
  } else if (defaults && typeof defaults.resolutionScale === 'number') {
    viewer.resolutionScale = defaults.resolutionScale;
  }

  if (tileset) {
    if (entry.tileError !== null) {
      tileset.maximumScreenSpaceError = entry.tileError;
      // Dynamic error deliberately coarsens tiles far from a near-ground
      // camera. That is right for a map you are looking straight down at and
      // wrong the moment the horizon is in shot, which it always is once the
      // user has asked for a specific quality level.
      tileset.dynamicScreenSpaceError = false;
    } else if (defaults) {
      if (typeof defaults.tileError === 'number') {
        tileset.maximumScreenSpaceError = defaults.tileError;
      }
      if (typeof defaults.dynamicScreenSpaceError === 'boolean') {
        tileset.dynamicScreenSpaceError = defaults.dynamicScreenSpaceError;
      }
    }
  }

  // FXAA is cheap and helps at every level, so it follows quality rather than
  // being another thing to choose.
  const fxaa = viewer.scene?.postProcessStages?.fxaa;
  if (fxaa) fxaa.enabled = id !== 'low';
}

/**
 * Set and persist the level.
 *
 * @param {string} id - Level id.
 * @returns {string} The level actually set.
 */
export function setRenderQuality(id) {
  if (!(id in QUALITY_LEVELS)) return level;
  level = id;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // A preference that cannot be written still applies for this session.
  }
  return level;
}
