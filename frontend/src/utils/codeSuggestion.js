/**
 * Auto-suggest the next inventory code (POLE-0007, BOX-0012, CBL-0003, …)
 * from the codes that already exist — optionally biased toward the numbering
 * family of the nearest existing asset, so a new pole next to "POLE-0041"
 * suggests "POLE-0042".
 */

/** Split "BOX-0012" into { prefix: "BOX-", num: 12, width: 4 }. */
export function parseCode(code) {
  const match = /^([^\d]*?)(\d+)$/.exec(String(code || "").trim());
  if (!match) return null;
  return { prefix: match[1], num: parseInt(match[2], 10), width: match[2].length };
}

function haversineMeters(a, b) {
  const R = 6371000;
  const rad = (v) => (v * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Find the nearest asset with a geolocation to a point (e.g. map click). */
export function nearestWithCode(items, point) {
  if (!point || point.lat == null || point.lng == null) return null;
  let best = null;
  let bestDist = Infinity;
  for (const item of items || []) {
    if (item.lat == null || item.lng == null || !item.code) continue;
    const d = haversineMeters(point, item);
    if (d < bestDist) {
      bestDist = d;
      best = item;
    }
  }
  return best;
}

/** Highest used number per code-prefix family. */
function seriesMax(codes) {
  const byPrefix = new Map();
  for (const code of codes || []) {
    const parsed = parseCode(code);
    if (!parsed) continue;
    const current = byPrefix.get(parsed.prefix);
    if (!current || parsed.num > current.num) {
      byPrefix.set(parsed.prefix, {
        num: parsed.num,
        width: Math.max(parsed.width, current?.width || 0),
      });
    }
  }
  return byPrefix;
}

/**
 * Suggest the next code.
 *
 * @param {string[]} codes          Existing codes for this asset type.
 * @param {string}   defaultPrefix  Used when nothing exists yet ("POLE-").
 * @param {object}   [nearItem]     Optional nearby asset — its code's family
 *                                  wins, mirroring "based on nearby assets".
 */
export function suggestCode(codes, defaultPrefix, nearItem = null) {
  const byPrefix = seriesMax(codes);

  // Prefer the numbering family of the nearest existing asset, if it has one.
  const nearParsed = nearItem && parseCode(nearItem.code);
  if (nearParsed && byPrefix.has(nearParsed.prefix)) {
    const fam = byPrefix.get(nearParsed.prefix);
    return `${nearParsed.prefix}${String(fam.num + 1).padStart(Math.max(4, fam.width), "0")}`;
  }

  if (byPrefix.size) {
    // Otherwise continue the family with the highest number in use.
    const [prefix, fam] = [...byPrefix.entries()].sort((a, b) => b[1].num - a[1].num)[0];
    return `${prefix}${String(fam.num + 1).padStart(Math.max(4, fam.width), "0")}`;
  }

  return `${defaultPrefix}0001`;
}
