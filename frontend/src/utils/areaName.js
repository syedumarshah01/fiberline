/**
 * Reverse-geocode a map point to a short area name ("University Town",
 * "Hayatabad", …) for the area-based code/name suggestions.
 *
 * No API key needed (OSM Nominatim). Results are cached per ~100 m grid cell
 * and lookups fail soft (null) when the service is unreachable, so the
 * suggestion dropdowns simply skip the area-based option offline.
 */

const AREA_KEYS = [
  "suburb",
  "neighbourhood",
  "quarter",
  "hamlet",
  "village",
  "town",
  "city_district",
  "city",
];

const cache = new Map();

function cacheKey(lat, lng) {
  // ~100 m resolution — suggestions don't change within a street block
  return `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
}

export async function lookupAreaName(lat, lng) {
  if (lat == null || lng == null) return null;
  const key = cacheKey(lat, lng);
  if (cache.has(key)) return cache.get(key);

  let area = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&zoom=16`,
      { headers: { Accept: "application/json" }, signal: controller.signal },
    );
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const address = data?.address || {};
      area = AREA_KEYS.map((k) => address[k]).find(Boolean) || null;
    }
  } catch {
    area = null;
  }

  cache.set(key, area);
  return area;
}
