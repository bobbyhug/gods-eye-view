import RBush from 'rbush';

/**
 * Viewport culling for point layers.
 *
 * THE WASTE THIS REMOVES. A layer holds every point it has ever loaded and
 * hands all of them to the renderer, whatever the camera is looking at. Flying
 * over Austin with the wildfire layer on means 9,319 fires are built, uploaded
 * and drawn so that perhaps forty of them can be seen. The cost is paid on
 * every rebuild, and it grows with each layer added rather than with what is
 * actually on screen.
 *
 * An R-tree answers "which points fall inside this rectangle" in roughly log
 * time instead of testing every point, so the working set becomes a function of
 * the VIEW rather than of the dataset. At city zoom that is a reduction of two
 * or three orders of magnitude; at globe zoom it correctly returns everything,
 * because everything genuinely is in view.
 *
 * WHY AN R-TREE AND NOT A LOOP. At ten thousand points a linear scan is honestly
 * fine — well under a millisecond. It stops being fine at a hundred thousand,
 * which is where this is going: 108,045 military installations and 304,632
 * mines are already researched and waiting. Building the index costs one pass
 * when the data loads; querying it costs almost nothing, and it is the querying
 * that happens on every camera move.
 *
 * THE ANTIMERIDIAN IS HANDLED, because it is the thing that quietly breaks
 * every naive bounding-box cull: a view spanning it has a west edge numerically
 * GREATER than its east edge, and a single rectangle query then matches nothing
 * at all. Such a view is split into two queries and the results merged.
 */

/**
 * Build an index over points.
 *
 * @param {Array<object>} points - Each needs numeric `lat` and `lon`.
 * @returns {object} Index with a `search` method.
 */
export function createViewportIndex(points) {
  const tree = new RBush();
  const items = [];
  for (const point of points || []) {
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    // Zero-area boxes: these are points, and RBush is happy to index them.
    items.push({ minX: lon, minY: lat, maxX: lon, maxY: lat, point });
  }
  // Bulk load, which builds a far better balanced tree than repeated inserts.
  tree.load(items);

  return {
    /** @returns {number} Points indexed. */
    size() { return items.length; },

    /**
     * Points inside a geographic rectangle.
     *
     * @param {{west: number, south: number, east: number, north: number}} box
     * @returns {Array<object>} The original point objects.
     */
    search(box) {
      if (!box) return items.map((entry) => entry.point);
      const { west, south, east, north } = box;
      if (![west, south, east, north].every(Number.isFinite)) {
        return items.map((entry) => entry.point);
      }
      const minY = Math.min(south, north);
      const maxY = Math.max(south, north);

      // A view crossing the antimeridian has west > east. Queried as one
      // rectangle that matches nothing, and the layer silently empties exactly
      // where the Pacific is.
      if (west > east) {
        const left = tree.search({ minX: -180, minY, maxX: east, maxY });
        const right = tree.search({ minX: west, minY, maxX: 180, maxY });
        const seen = new Set();
        const out = [];
        for (const entry of left.concat(right)) {
          if (seen.has(entry)) continue;
          seen.add(entry);
          out.push(entry.point);
        }
        return out;
      }
      return tree.search({ minX: west, minY, maxX: east, maxY })
        .map((entry) => entry.point);
    },

    /** @returns {Array<object>} Everything, unculled. */
    all() { return items.map((entry) => entry.point); },
  };
}

/**
 * The camera's view rectangle, in degrees, padded a little.
 *
 * Padding matters: culling exactly to the frustum makes markers pop in at the
 * screen edge as the camera turns, which looks worse than drawing a few
 * hundred extra points costs.
 *
 * Returns null when the view cannot be computed — looking at space, or a
 * horizon-spanning view where the rectangle is meaningless — and null means
 * "draw everything", which is the safe answer.
 *
 * @param {object} viewer - Cesium viewer.
 * @param {object} Cesium - The Cesium namespace.
 * @param {number} [padFraction]
 * @returns {{west: number, south: number, east: number, north: number}|null}
 */
export function cameraViewBox(viewer, Cesium, padFraction = 0.25) {
  const rect = viewer?.camera?.computeViewRectangle?.();
  if (!rect) return null;
  const west = Cesium.Math.toDegrees(rect.west);
  const east = Cesium.Math.toDegrees(rect.east);
  const south = Cesium.Math.toDegrees(rect.south);
  const north = Cesium.Math.toDegrees(rect.north);
  if (![west, east, south, north].every(Number.isFinite)) return null;

  const height = Math.abs(north - south);
  // A view covering most of the globe is not worth culling against — the
  // query would return nearly everything and cost more than it saves.
  if (height >= 140) return null;

  const padY = height * padFraction;
  const spanX = west > east ? (180 - west) + (east + 180) : east - west;
  const padX = spanX * padFraction;
  const wrap = (deg) => (((deg + 540) % 360) - 180);

  return {
    west: wrap(west - padX),
    east: wrap(east + padX),
    south: Math.max(-90, south - padY),
    north: Math.min(90, north + padY),
  };
}
