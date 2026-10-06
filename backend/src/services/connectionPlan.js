const db = require('../db');
const { loadCandidates, routeTo } = require('./customerLookup');
const { findNearestSource } = require('./capacityGraph');
const { haversineMeters } = require('./streetRoute');
const { resolveAddress } = require('./addressLookup');
const { getProjectSettings, buildLossBudget } = require('./lossBudget');
const { buildConnectionPlan } = require('../utils/connectionPlan');

const DEFAULT_RADIUS_M = 500;
const MAX_RADIUS_M = 5000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ROUTE_TIMEOUT_MS = 2500;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max, fallback) {
  const number = num(value);
  return number == null ? fallback : Math.min(max, Math.max(min, Math.round(number)));
}

function parsePlanQuery(query = {}) {
  const lat = num(query.lat);
  const lng = num(query.lng);
  const address = typeof query.address === 'string' && query.address.trim() ? query.address.trim() : null;
  if (!address && (lat == null || lng == null)) return { error: 'address or lat/lng is required' };
  if (lat != null && (lat < -90 || lat > 90)) return { error: 'lat must be between -90 and 90' };
  if (lng != null && (lng < -180 || lng > 180)) return { error: 'lng must be between -180 and 180' };
  if ((lat == null) !== (lng == null)) return { error: 'lat and lng must be given together' };
  return {
    address,
    point: lat == null ? null : { lat, lng },
    radius_m: clamp(query.radius_m, 25, MAX_RADIUS_M, DEFAULT_RADIUS_M),
    limit: clamp(query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT),
    want_route: !['0', 'false', 'no', 'off'].includes(String(query.route ?? '').toLowerCase()),
  };
}

async function routeToNearest(point, enclosure, { wantRoute = true, route = routeTo } = {}) {
  if (!wantRoute) return null;
  try {
    return await route(point, enclosure, { timeoutMs: ROUTE_TIMEOUT_MS });
  } catch {
    // The pure planner creates the direct haversine fallback. Never turn this
    // failure into a route-shaped response.
    return null;
  }
}

async function loadSourceDetails(source, targetId) {
  if (!source?.found || !source.source_enclosure_id) return null;
  const ids = [
    targetId,
    source.source_enclosure_id,
    ...(source.path || []).flatMap((edge) => [edge.from_enclosure_id, edge.to_enclosure_id]),
  ].filter(Boolean);
  const boxes = await db('enclosures as e')
    .leftJoin('poles as p', 'p.id', 'e.pole_id')
    .whereIn('e.id', [...new Set(ids)])
    .select('e.id', 'e.code', 'e.name', 'e.type');
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const path = (source.path || []).slice().reverse().map((edge) => {
    const from = byId.get(edge.to_enclosure_id);
    const to = byId.get(edge.from_enclosure_id);
    return {
      cable_id: edge.cable_id,
      cable_code: edge.cable_code,
      cable_type: edge.cable_type || 'distribution',
      length_m: edge.length_m == null ? null : Number(edge.length_m),
      attenuation_db_per_km: edge.attenuation_db_per_km == null ? null : Number(edge.attenuation_db_per_km),
      from_enclosure_id: edge.to_enclosure_id,
      from_code: from?.code || edge.to_enclosure_id,
      to_enclosure_id: edge.from_enclosure_id,
      to_code: to?.code || edge.from_enclosure_id,
    };
  });
  return {
    ...source,
    source_enclosure: byId.get(source.source_enclosure_id) || { id: source.source_enclosure_id },
    path,
  };
}

async function tracedBaseBudget(connection, settings) {
  // Existing port input and an existing core are the two places where the
  // current trace engine can provide the OLT-to-box portion. A brought-in path
  // is kept as an explicit path estimate instead of double-counting the source
  // cable in a trace and in the BFS path.
  const coreId =
    connection.type === 'bring_capacity'
      ? null
      : connection.port?.input_core_id || connection.core?.id || null;
  if (!coreId) return null;
  try {
    return await buildLossBudget(coreId, { olt_type: settings?.olt_type });
  } catch {
    return null;
  }
}

async function createConnectionPlan(params = {}, deps = {}) {
  const {
    resolve = resolveAddress,
    loadBoxes = loadCandidates,
    route = routeToNearest,
    sourceFinder = findNearestSource,
    loadSettings = getProjectSettings,
    buildBudget = tracedBaseBudget,
    loadSource = loadSourceDetails,
  } = deps;
  const parsed = parsePlanQuery(params);
  if (parsed.error) return { error: parsed.error, status: 400 };

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
        hint: 'Pass lat/lng (the map click gives you both), or configure a geocoder for free-text addresses.',
      };
    }
    point = { lat: resolution.resolved.lat, lng: resolution.resolved.lng };
  }

  const candidates = await loadBoxes({ point, radius_m: parsed.radius_m, limit: parsed.limit });
  const nearest = candidates?.[0] || null;
  if (!nearest) {
    return {
      error: 'No enclosure is available to design a connection from.',
      status: 404,
      point,
      warnings: ['Add or locate an enclosure before creating a customer connection plan.'],
    };
  }

  const streetRoute = await route(point, nearest, { wantRoute: parsed.want_route, timeoutMs: ROUTE_TIMEOUT_MS });
  let source = null;
  if (!(nearest.splitter_ports || []).length && !(nearest.available_core_options || []).length) {
    source = await sourceFinder(nearest.id).catch(() => null);
    source = await loadSource(source, nearest.id).catch(() => source);
  }

  const settings = await loadSettings();
  const connection = {
    type: nearest.splitter_ports?.length
      ? 'splitter_port'
      : nearest.available_core_options?.length
        ? 'install_splitter_on_core'
        : 'bring_capacity',
    port: nearest.splitter_ports?.[0] || null,
    core: nearest.available_core_options?.[0] || null,
  };
  const baseBudget = await buildBudget(
    // This object is intentionally the same shape chosen by buildConnectionPlan.
    // The pure planner makes the final choice again and remains the source of
    // ordered-step behavior.
    {
      type: connection.type,
      port: connection.port,
      core: connection.core,
    },
    settings,
  );

  const result = buildConnectionPlan({
    point,
    enclosure: nearest,
    streetRoute,
    haversine: haversineMeters,
    splitterPorts: nearest.splitter_ports,
    availableCores: nearest.available_core_options,
    source,
    settings,
    baseBudget,
  });

  if (result.error) return { ...result, status: 409 };
  return {
    ...result,
    nearest_enclosure: result.enclosure,
    alternatives: candidates.slice(1).map((candidate) => ({
      id: candidate.id,
      code: candidate.code,
      name: candidate.name ?? null,
      distance_m: candidate.distance_m,
      free_ports: candidate.free_ports,
      available_cores: candidate.available_cores,
    })),
    query: {
      input: parsed.address,
      address: resolution?.resolved?.matched?.address || parsed.address,
      label: resolution?.resolved?.label || null,
      source: resolution?.resolved?.source || (parsed.point ? 'coordinates' : 'unknown'),
      confidence: resolution?.resolved?.confidence || (parsed.point ? 'high' : null),
      matched: resolution?.resolved?.matched || null,
      radius_m: parsed.radius_m,
    },
  };
}

module.exports = {
  createConnectionPlan,
  parsePlanQuery,
  routeToNearest,
  loadSourceDetails,
  DEFAULT_RADIUS_M,
  MAX_RADIUS_M,
  ROUTE_TIMEOUT_MS,
};
