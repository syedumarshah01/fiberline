/**
 * Turning what the caller typed into a point on the map.
 *
 * There is no geocoder in this app, and for the question being asked there does
 * not have to be one: a CSR asking "can we serve House 12-B, Street 4?" is
 * almost always asking about a street the network is already on, so the address
 * is already in the database — an existing customer a few doors down, or the box
 * the last install hung off. That lookup is local, instant and offline.
 *
 *   GET /api/serviceability/check?address=...
 *
 * Resolution order (utils/addressMatch.js does the scoring, this file gets the
 * rows and makes the call):
 *
 *   1. an asset code or name — "NAP-14", "POLE-0007", "green cabinet" — exact,
 *      so it wins outright;
 *   2. an existing customer's address, scored by token overlap (the house number
 *      has to agree, or it is a different home);
 *   3. an external geocoder, if the deployment configured one
 *      (GEOCODE_BASE_URL, Nominatim-compatible: `GET {base}/search?q=...`).
 *
 * Anything that scores below the threshold is returned as a *suggestion*, never
 * silently used: quoting a price for the wrong house is worse than asking the
 * CSR to click the map, and the caller has `lat`/`lng` for exactly that case.
 */

const db = require('../db');
const { matchAddresses, matchAssetCode, DEFAULT_THRESHOLD } = require('../utils/addressMatch');

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_ASSETS = 2000; // a network bigger than this needs a geocoder, not ILIKE

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Enclosures with a usable point: their own, or their pole's. */
async function loadEnclosureAssets() {
  const rows = await db.raw(
    `
    SELECT e.id, e.code, e.name, e.type,
           COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
           COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng
    FROM enclosures e LEFT JOIN poles p ON p.id = e.pole_id
    LIMIT ?
    `,
    [MAX_ASSETS],
  );
  return rows.rows.map((row) => ({ ...row, kind: 'enclosure' }));
}

/** Poles, so "POLE-0007" resolves to the pole itself. Pole coordinates live in
 *  the `location` column, not in lat/lng columns — read them the same way the
 *  poles route does. */
async function loadPoleAssets() {
  const rows = await db.raw(
    `
    SELECT id, code, name,
           ST_Y(location::geometry) AS lat,
           ST_X(location::geometry) AS lng
    FROM poles
    LIMIT ?
    `,
    [MAX_ASSETS],
  );
  return rows.rows.map((row) => ({ ...row, kind: 'pole', type: 'pole' }));
}

/** Customers who have both an address and a point: the local gazetteer. */
async function loadCustomerAddresses() {
  const rows = await db.raw(
    `
    SELECT id, customer_code AS code, name, address, status,
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
    FROM customers
    WHERE address IS NOT NULL AND address <> '' AND location IS NOT NULL
    LIMIT ?
    `,
    [MAX_ASSETS],
  );
  return rows.rows;
}

/** Customers with an address but no point: suggestable, not placeable. */
async function loadUnplacedAddresses() {
  const rows = await db('customers')
    .whereNotNull('address')
    .whereNot('address', '')
    .whereNull('location')
    .select('id', 'customer_code as code', 'name', 'address')
    .limit(MAX_ASSETS);
  return rows;
}

function assetLabel(asset) {
  return [asset.code, asset.name].filter(Boolean).join(' — ');
}

/**
 * Ask an external geocoder, if one is configured. Nominatim-compatible on
 * purpose (the open-source default): `GET {base}/search?format=json&limit=1&q=`.
 * Any failure is swallowed into "no result" — a geocoder being down must not
 * turn a serviceability check into a 500.
 */
async function geocode(query, { baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!baseUrl) return null;
  const url = `${String(baseUrl).replace(/\/+$/, '')}/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'fiberline-serviceability/1.0' },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const first = Array.isArray(payload) ? payload[0] : null;
    const lat = num(first?.lat);
    const lng = num(first?.lon);
    if (lat == null || lng == null) return null;
    return { lat, lng, label: first.display_name || query, raw: first };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a free-text address (or asset code) to a point.
 *
 * Returns { resolved, candidates, reason, warnings }:
 *   resolved    { lat, lng, source, matched, label, confidence } | null
 *   candidates  scored suggestions (asset matches first, then addresses)
 *   reason      'asset_code' | 'customer_address' | 'geocoder' | 'no_match'
 */
async function resolveAddress(input, options = {}) {
  const {
    limit = 5,
    threshold = DEFAULT_THRESHOLD,
    geocoderBaseUrl = process.env.GEOCODE_BASE_URL,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const query = String(input ?? '').trim();
  const warnings = [];
  const candidates = [];
  if (!query) {
    return { resolved: null, candidates, reason: 'no_match', warnings: ['no address was given'] };
  }

  // 1. Asset codes and names — exact, so they settle the question.
  let assets = [];
  try {
    const [enclosures, poles] = await Promise.all([loadEnclosureAssets(), loadPoleAssets()]);
    assets = [...enclosures, ...poles];
  } catch (err) {
    warnings.push(`asset codes could not be searched (${err.message})`);
  }
  const assetMatches = matchAssetCode(query, assets);
  for (const match of assetMatches.slice(0, limit)) {
    candidates.push({
      kind: match.kind,
      id: match.id,
      code: match.code,
      name: match.name ?? null,
      address: null,
      label: assetLabel(match) || match.code,
      lat: num(match.lat),
      lng: num(match.lng),
      score: match.score,
      matched_by: match.how,
      placeable: num(match.lat) != null && num(match.lng) != null,
    });
  }
  const bestAsset = candidates.find((c) => c.placeable && c.score >= 0.9);
  if (bestAsset) {
    return {
      resolved: {
        lat: bestAsset.lat,
        lng: bestAsset.lng,
        source: 'asset_code',
        matched: { kind: bestAsset.kind, id: bestAsset.id, code: bestAsset.code, name: bestAsset.name },
        label: bestAsset.label,
        confidence: 'high',
      },
      candidates,
      reason: 'asset_code',
      warnings,
    };
  }

  // 2. Addresses the network already knows.
  let placeable = [];
  try {
    const [withPoint, withoutPoint] = await Promise.all([loadCustomerAddresses(), loadUnplacedAddresses()]);
    placeable = matchAddresses(
      query,
      withPoint.map((row, index) => ({
        kind: 'customer',
        id: row.id,
        code: row.code,
        name: row.name ?? null,
        address: row.address,
        label: [row.code, row.name].filter(Boolean).join(' — '),
        lat: num(row.lat),
        lng: num(row.lng),
        rank: index,
        placeable: num(row.lat) != null && num(row.lng) != null,
      })),
      { limit, threshold },
    );
    const unplaced = matchAddresses(
      query,
      withoutPoint.map((row, index) => ({
        kind: 'customer',
        id: row.id,
        code: row.code,
        name: row.name ?? null,
        address: row.address,
        label: [row.code, row.name].filter(Boolean).join(' — '),
        lat: null,
        lng: null,
        rank: index + placeable.length,
        placeable: false,
      })),
      { limit, threshold },
    );
    candidates.push(...placeable, ...unplaced);
  } catch (err) {
    warnings.push(`customer addresses could not be searched (${err.message})`);
  }

  // `confident`, not `score`: one shared token in a long address is a suggestion
  // to show the CSR, never a point to price a customer from.
  const bestAddress = candidates.find((c) => c.kind === 'customer' && c.placeable && c.confident);
  if (bestAddress) {
    return {
      resolved: {
        lat: bestAddress.lat,
        lng: bestAddress.lng,
        source: 'customer_address',
        matched: {
          kind: 'customer',
          id: bestAddress.id,
          code: bestAddress.code,
          name: bestAddress.name,
          address: bestAddress.address,
          score: bestAddress.score,
        },
        label: `${bestAddress.address} (${bestAddress.code})`,
        confidence: bestAddress.score >= 0.8 ? 'high' : 'medium',
      },
      candidates: candidates.slice(0, limit),
      reason: 'customer_address',
      warnings,
    };
  }

  // 3. An external geocoder, when this deployment has one.
  const geocoded = await geocode(query, { baseUrl: geocoderBaseUrl, fetchImpl, timeoutMs });
  if (geocoded) {
    return {
      resolved: {
        lat: geocoded.lat,
        lng: geocoded.lng,
        source: 'geocoder',
        matched: { label: geocoded.label },
        label: geocoded.label,
        confidence: 'medium',
      },
      candidates: candidates.slice(0, limit),
      reason: 'geocoder',
      warnings,
    };
  }

  if (!geocoderBaseUrl) {
    warnings.push(
      'the address matched nothing in the network and no geocoder is configured ' +
        '(set GEOCODE_BASE_URL to a Nominatim-compatible service) — pass lat/lng, or click the map',
    );
  }

  return {
    resolved: null,
    candidates: candidates.slice(0, limit),
    reason: 'no_match',
    warnings,
  };
}

module.exports = { resolveAddress, geocode, DEFAULT_TIMEOUT_MS };
