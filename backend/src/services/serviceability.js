/**
 * The database side of "can we serve this address?".
 *
 * Three reads and (at most) one network call, in the order the answer needs them:
 *
 *   1. where the address is        — services/addressLookup.js (or the caller's
 *                                    own lat/lng, when the CSR clicked the map);
 *   2. what is near it             — every box within the search radius with its
 *                                    free splitter ports and spare fibres, which
 *                                    is what decides *which* box serves it;
 *   3. how long the run is         — the street route from that box to the door
 *                                    (OSRM, 2.5 s budget), or straight-line ×
 *                                    1.25 when there is no route to be had.
 *
 * Then utils/serviceability.js — pure, testable — turns those into the verdict,
 * the price and the next steps. Nothing here decides anything: it fetches.
 */

const db = require('../db');
const { getAvailableCoreCounts, findNearestSource } = require('./capacityGraph');
const { fetchStreetRoute } = require('./streetRoute');
const { resolveAddress } = require('./addressLookup');
const { getProjectSettings } = require('./lossBudget');
const {
  assessServiceability,
  rankBoxes,
} = require('../utils/serviceability');
const { resolveCostModel } = require('../utils/dropCost');

const DEFAULT_RADIUS_M = 500;
const MAX_RADIUS_M = 5000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ROUTE_TIMEOUT_MS = 2500;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, { min, max, fallback }) {
  const n = num(value);
  if (n == null) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));

/** Parse + range-check the query once, so every layer downstream trusts it. */
function parseQuery(query = {}) {
  const lat = num(query.lat);
  const lng = num(query.lng);
  const address = typeof query.address === 'string' && query.address.trim() ? query.address.trim() : null;

  if (address == null && (lat == null || lng == null)) {
    return { error: 'address or lat/lng is required' };
  }
  if (lat != null && (lat < -90 || lat > 90)) return { error: 'lat must be between -90 and 90' };
  if (lng != null && (lng < -180 || lng > 180)) return { error: 'lng must be between -180 and 180' };
  if ((lat == null) !== (lng == null)) return { error: 'lat and lng must be given together' };

  return {
    address,
    point: lat != null ? { lat, lng } : null,
    radius_m: clamp(query.radius_m, { min: 25, max: MAX_RADIUS_M, fallback: DEFAULT_RADIUS_M }),
    limit: clamp(query.limit, { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT }),
    want_route: !['0', 'false', 'no', 'off'].includes(String(query.route ?? '').toLowerCase()),
  };
}

/**
 * Every box within `radius_m`, with what it can actually take.
 *
 *   distance_m       straight line to the box (its own point, or its pole's)
 *   free_ports       ports with neither an output core nor a child splitter
 *   free_port_numbers  up to 8 of them, so the answer can name the one to assign
 *   splitter_count / ports_total   what is installed
 *   available_cores  spare fibres on the non-drop cables landing there
 *
 * Customer boxes (type 'terminal', no pole, their own location) are found too —
 * they are boxes on the map, and a neighbouring install is decent evidence that
 * the street is already built.
 */
async function loadCandidates({ point, radius_m, limit }) {
  const nearby = await db.raw(
    `
    SELECT e.id, e.code, e.name, e.type,
           COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
           COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng,
           ST_Distance(COALESCE(e.location, p.location), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_m
    FROM enclosures e LEFT JOIN poles p ON p.id = e.pole_id
    WHERE ST_DWithin(COALESCE(e.location, p.location), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)
    ORDER BY distance_m ASC
    LIMIT ?
    `,
    [point.lng, point.lat, point.lng, point.lat, radius_m, limit],
  );

  let rows = nearby.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name ?? null,
    type: row.type ?? null,
    lat: num(row.lat),
    lng: num(row.lng),
    distance_m: Math.round(num(row.distance_m) ?? 0),
  }));

  // Nothing inside the search radius does not mean nothing on the map: asking
  // "can we serve this?" deserves "the nearest box is 1.2 km away", not "no box
  // found". One extra query, only when there is nothing else to report.
  if (!rows.length) {
    const nearest = await db.raw(
      `
      SELECT e.id, e.code, e.name, e.type,
             COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
             COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng,
             ST_Distance(COALESCE(e.location, p.location), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_m
      FROM enclosures e LEFT JOIN poles p ON p.id = e.pole_id
      WHERE COALESCE(e.location, p.location) IS NOT NULL
      ORDER BY distance_m ASC
      LIMIT 1
      `,
      [point.lng, point.lat],
    );
    rows = nearest.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name ?? null,
      type: row.type ?? null,
      lat: num(row.lat),
      lng: num(row.lng),
      distance_m: Math.round(num(row.distance_m) ?? 0),
      outside_search_radius: true,
    }));
  }

  const ids = rows.map((row) => row.id);
  const [portCounts, freePorts, capacity] = await Promise.all([
    db('splitters')
      .whereIn('enclosure_id', ids)
      .select('enclosure_id')
      .count({ splitter_count: 'id' })
      .groupBy('enclosure_id')
      .then((result) => new Map(result.map((row) => [row.enclosure_id, Number(row.splitter_count) || 0])))
      .catch(() => new Map()),
    db('splitter_ports as sp')
      .join('splitters as s', 's.id', 'sp.splitter_id')
      .whereIn('s.enclosure_id', ids)
      .whereNull('sp.output_core_id')
      .whereNull('sp.output_splitter_id')
      .select('s.enclosure_id', 'sp.port_number', 's.name as splitter_name')
      .orderBy('sp.port_number')
      .catch(() => []),
    getAvailableCoreCounts().catch(() => ({})),
  ]);

  const portsByBox = new Map();
  for (const row of freePorts) {
    const entry = portsByBox.get(row.enclosure_id) || { numbers: [], names: new Set() };
    if (entry.numbers.length < 8) entry.numbers.push(Number(row.port_number));
    if (row.splitter_name) entry.names.add(row.splitter_name);
    portsByBox.set(row.enclosure_id, entry);
  }

  // All of a splitter's ports, so "the splitter is full" can say so with a count.
  const totals = await db('splitter_ports as sp')
    .join('splitters as s', 's.id', 'sp.splitter_id')
    .whereIn('s.enclosure_id', ids)
    .select('s.enclosure_id')
    .count({ ports_total: 'sp.id' })
    .groupBy('s.enclosure_id')
    .catch(() => []);

  const totalsByBox = new Map(totals.map((row) => [row.enclosure_id, Number(row.ports_total) || 0]));

  return rows.map((row) => {
    const ports = portsByBox.get(row.id) || { numbers: [], names: new Set() };
    return {
      ...row,
      free_ports: ports.numbers.length,
      free_port_numbers: ports.numbers,
      splitter_name: [...ports.names][0] || null,
      splitter_count: portCounts.get(row.id) || 0,
      ports_total: totalsByBox.get(row.id) || 0,
      available_cores: capacity[row.id] || 0,
    };
  });
}

/** Is there a network root at all? Absent table = unknown, not "no". */
async function headendConfigured() {
  try {
    const row = await db('headends').count({ n: 'id' }).first();
    return Number(row?.n) > 0;
  } catch {
    return null;
  }
}

/**
 * The street route from a point to a box, or null when there is none to be had
 * (no OSRM, no route, a timeout). The caller falls back to the straight line and
 * says so — a quoting endpoint must answer even with the internet down.
 */
async function routeTo(point, box, { timeoutMs = ROUTE_TIMEOUT_MS } = {}) {
  if (box?.lat == null || box?.lng == null) return null;
  try {
    const route = await fetchStreetRoute(
      [
        { lat: point.lat, lng: point.lng },
        { lat: box.lat, lng: box.lng },
      ],
      { timeoutMs },
    );
    if (!Number.isFinite(route?.distance_m)) return null;
    return {
      length_m: Math.round(route.distance_m),
      coordinates: route.coordinates,
      source: 'street_route',
    };
  } catch {
    return null;
  }
}

/**
 * Run one serviceability check.
 *
 * Returns the pure assessment (utils/serviceability.js) plus a `query` block
 * describing what was asked and how the address was resolved — the frontend and
 * the text sheet both print it, because "which address did it actually price?"
 * is the first question anyone asks about a quote.
 */
async function checkServiceability(params = {}, deps = {}) {
  const {
    resolve = resolveAddress,
    loadSettings = getProjectSettings,
    loadBoxes = loadCandidates,
    route = routeTo,
    nearestSource = findNearestSource,
    hasHeadend = headendConfigured,
  } = deps;

  const parsed = parseQuery(params);
  if (parsed.error) return { error: parsed.error, status: 400 };

  const settings = await loadSettings();
  const model = resolveCostModel(settings);

  // --- 1. where is the address? ---------------------------------------------
  let point = parsed.point;
  let resolution = null;
  if (!point) {
    resolution = await resolve(parsed.address, { limit: 5 });
    if (!resolution.resolved) {
      return {
        error: 'Address could not be matched to a location',
        status: 404,
        address: parsed.address,
        candidates: resolution.candidates || [],
        warnings: resolution.warnings || [],
        hint:
          'Pass lat/lng (the map click gives you both), or set GEOCODE_BASE_URL to a ' +
          'Nominatim-compatible geocoder on the backend to resolve free-text addresses.',
      };
    }
    point = { lat: resolution.resolved.lat, lng: resolution.resolved.lng };
  }

  // --- 2. what is near it? ---------------------------------------------------
  // The search radius defaults to the tool's own "we will not price beyond this"
  // limit: nothing outside it could change the verdict, only the cost of saying no.
  const radius_m = Math.min(MAX_RADIUS_M, Math.max(parsed.radius_m, model.max_extension_m));
  const candidates = await loadBoxes({ point, radius_m, limit: parsed.limit });
  const settingsForCost = { ...model, ...settings };

  // --- 3. how long is the run? ----------------------------------------------
  // Rank first (pure), then measure the one run that matters: from the box the
  // connection is actually built from, or — when nothing qualifies — from the
  // nearest box, which is the one an extension would start at.
  const ranked = rankBoxes(candidates, model);
  const target = ranked.recommended || ranked.nearest;
  let routeInfo = null;
  if (parsed.want_route && target) {
    routeInfo = await route(point, target);
  }

  // --- 4. capacity to bring in, when the box is full -------------------------
  let suggestedSource = null;
  if (target && !ranked.recommended) {
    suggestedSource = await nearestSource(target.id).catch(() => null);
  }

  const result = assessServiceability({
    point,
    candidates,
    settings: settingsForCost,
    route: routeInfo,
    extras: {
      radius_m,
      headend_configured: await hasHeadend(),
      suggested_source: suggestedSource && suggestedSource.found !== false ? suggestedSource : null,
    },
  });

  return {
    ...result,
    query: {
      input: parsed.address,
      address: resolution?.resolved?.matched?.address || parsed.address,
      label: resolution?.resolved?.label || null,
      source: resolution?.resolved?.source || (parsed.point ? 'coordinates' : 'unknown'),
      confidence: resolution?.resolved?.confidence || (parsed.point ? 'high' : null),
      matched: resolution?.resolved?.matched || null,
      candidates: resolution?.candidates || [],
      resolution_warnings: resolution?.warnings || [],
      radius_m,
      rates: {
        currency: model.currency,
        drop_cable_cost_per_m: model.drop_cable_cost_per_m,
        labour_cost_per_drop: model.labour_cost_per_drop,
        splice_cost: model.splice_cost,
        splitter_cost: model.splitter_cost,
        extension_cost_per_m: model.extension_cost_per_m,
        slack_pct: model.slack_pct,
        max_drop_m: model.max_drop_m,
        max_extension_m: model.max_extension_m,
        overridden: model.overridden,
      },
    },
  };
}

module.exports = {
  checkServiceability,
  parseQuery,
  loadCandidates,
  routeTo,
  headendConfigured,
  DEFAULT_RADIUS_M,
  MAX_RADIUS_M,
  ROUTE_TIMEOUT_MS,
  isUuid,
};
