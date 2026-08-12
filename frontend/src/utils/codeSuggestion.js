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
 * Turn an area name into a short code slug.
 *   "University Town" -> "UT", "Hayatabad" -> "HAYA", "Phase-3" -> "PHAS"
 */
export function areaSlugFromName(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return words
    .map((w) => w[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();
}

/**
 * Next code inside an AREA family — e.g. with existing "UT-BOX-0003" and
 * slug "UT", defaultPrefix "BOX-" → "UT-BOX-0004". Starts at 0001 when the
 * area has no codes yet.
 */
export function suggestAreaCode(codes, defaultPrefix, slug) {
  if (!slug) return null;
  const familyPrefix = `${slug}-${defaultPrefix}`;
  const fam = seriesMax(codes).get(familyPrefix);
  const num = fam ? fam.num + 1 : 1;
  const width = fam ? Math.max(4, fam.width) : 4;
  return `${familyPrefix}${String(num).padStart(width, "0")}`;
}

/** "Exchange Box 12" -> "Exchange Box 13"; name without a number -> "name 2". */
export function bumpNameSeries(name) {
  const parsed = parseCode(name);
  if (parsed) {
    return `${parsed.prefix}${String(parsed.num + 1).padStart(Math.max(2, parsed.width), "0")}`;
  }
  return `${String(name).trim()} 2`;
}

/**
 * Build the two-option suggestion lists for the code/name dropdowns.
 * Option 1 is based on the NEAREST existing asset (falls back to the plain
 * series continuation); option 2 is based on the current map AREA name.
 *
 * @param {string[]} codes         Existing codes for this asset type.
 * @param {string[]} names         Existing names for this asset type.
 * @param {string}   defaultPrefix e.g. "BOX-", "CBL-".
 * @param {string}   typeLabel     Human label used in name fallbacks ("Splice Closure").
 * @param {object}   [nearest]     Nearest asset ({ code?, name? }) if known.
 * @param {string}   [area]        Area name from reverse geocoding, if known.
 */
export function buildTwoOptions({ codes, names = [], defaultPrefix, typeLabel, nearest = null, area = null }) {
  const nearbyCode = suggestCode(codes, defaultPrefix, nearest);
  const slug = area ? areaSlugFromName(area) : "";
  const areaCode = slug ? suggestAreaCode(codes, defaultPrefix, slug) : null;

  const nearbyNum = parseCode(nearbyCode)?.num ?? 1;
  const nearbyName = nearest?.name
    ? bumpNameSeries(nearest.name)
    : `${typeLabel} ${String(nearbyNum).padStart(2, "0")}`;
  const areaNum = areaCode ? parseCode(areaCode).num : 1;
  const areaName = area ? `${area} ${typeLabel} ${String(areaNum).padStart(2, "0")}` : null;

  return {
    codeOptions: [...new Set([nearbyCode, areaCode].filter(Boolean))].slice(0, 2),
    nameOptions: [...new Set([nearbyName, areaName].filter(Boolean))].slice(0, 2),
  };
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
