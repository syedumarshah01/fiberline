/**
 * Helpers for drawing cable name labels on the map.
 *
 * Cables carry a `code` (primary identifier, e.g. "CBL-0007") and an optional
 * free-text `name`. The on-map label shows the code, and appends the name in
 * parentheses when it adds information.
 */

/** Minimum zoom at which cable labels are shown. Below this the map would be
 *  a wall of overlapping text; at zoom ≥ 15 a neighbourhood is in view. */
export const CABLE_LABEL_MIN_ZOOM = 15;

/** Text to show on the map for a cable. */
export function cableLabel(cable) {
  if (!cable || typeof cable !== "object") return "";
  const code = typeof cable.code === "string" ? cable.code.trim() : "";
  const name = typeof cable.name === "string" ? cable.name.trim() : "";
  if (code && name && name !== code) return `${code} · ${name}`;
  return code || name;
}

/**
 * Midpoint of a route, measured along its length (not just the middle vertex —
 * a route drawn as a long straight run plus many tight bends would otherwise
 * put the label near the bends).
 *
 * Route points are [lng, lat] pairs (as stored in cables.route).
 * Returns the midpoint as [lng, lat], or null for routes with < 2 points.
 */
export function routeMidpointLngLat(route) {
  if (!Array.isArray(route) || route.length < 2) return null;

  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const [x1, y1] = route[i - 1];
    const [x2, y2] = route[i];
    if ([x1, y1, x2, y2].some((v) => v == null)) return null;
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  if (total === 0) return null;

  let walked = 0;
  for (let i = 1; i < route.length; i++) {
    const [x1, y1] = route[i - 1];
    const [x2, y2] = route[i];
    const seg = Math.hypot(x2 - x1, y2 - y1);
    if (walked + seg >= total / 2) {
      const t = seg === 0 ? 0 : (total / 2 - walked) / seg;
      return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    walked += seg;
  }
  return route[route.length - 1];
}
