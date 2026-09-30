const db = require('../db');
const { getAvailableCoreCounts } = require('./capacityGraph');
const { simulateFailure } = require('./impactAnalysis');
const { resolveAddress } = require('./addressLookup');
const { loadBoxDocumentation } = require('./boxDocumentation');
const { traceFiber } = require('./fiberTrace');
const { buildLossBudget } = require('./lossBudget');
const { runReadOnlyQuery } = require('./readOnlyQuery');
const { prepareAgentAction } = require('./agentActions');
const MAX_LIMIT = 50;

function limitValue(value, fallback = 20) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(MAX_LIMIT, Math.max(1, Math.round(number))) : fallback;
}

function textValue(value) {
  return String(value ?? '').trim();
}

function like(value) {
  // The value is still passed as a parameter; escaping wildcards prevents a
  // model-supplied `%` from turning a targeted search into a full scan.
  return `%${textValue(value).replace(/[\\%_]/g, '\\$&')}%`;
}

function coordinates(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

async function searchNetwork({ text, kind = 'all', limit = 20 } = {}) {
  const query = textValue(text);
  if (!query) return { error: 'text is required' };
  const capped = limitValue(limit);
  const pattern = like(query);
  const normalizedKind = ['all', 'pole', 'enclosure', 'cable', 'customer', 'headend'].includes(kind) ? kind : 'all';
  const queries = {
    pole: [
      `SELECT id, code, name, status, pole_type, 'pole' AS kind,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM poles WHERE code ILIKE ? OR name ILIKE ? ESCAPE '\\' ORDER BY code LIMIT ?`,
      [pattern, pattern, capped],
    ],
    enclosure: [
      `SELECT e.id, e.code, e.name, e.type, e.pole_id, 'enclosure' AS kind,
              COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
              COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng
       FROM enclosures e LEFT JOIN poles p ON p.id = e.pole_id
       WHERE e.code ILIKE ? OR e.name ILIKE ? OR e.type ILIKE ? ESCAPE '\\'
       ORDER BY e.code LIMIT ?`,
      [pattern, pattern, pattern, capped],
    ],
    cable: [
      `SELECT id, code, name, cable_type, status, from_enclosure_id, to_enclosure_id, 'cable' AS kind
       FROM cables WHERE code ILIKE ? OR name ILIKE ? ESCAPE '\\' ORDER BY code LIMIT ?`,
      [pattern, pattern, capped],
    ],
    customer: [
      `SELECT id, customer_code, name, phone, email, address, status, 'customer' AS kind,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM customers
       WHERE customer_code ILIKE ? OR name ILIKE ? OR address ILIKE ? ESCAPE '\\'
       ORDER BY customer_code LIMIT ?`,
      [pattern, pattern, pattern, capped],
    ],
    headend: [
      `SELECT id, code, name, site_type, root_enclosure_id, 'headend' AS kind
       FROM headends WHERE code ILIKE ? OR name ILIKE ? ESCAPE '\\' ORDER BY code LIMIT ?`,
      [pattern, pattern, capped],
    ],
  };

  const kinds = normalizedKind === 'all' ? Object.keys(queries) : [normalizedKind];
  const results = await Promise.all(kinds.map(async (assetKind) => {
    const [sql, params] = queries[assetKind];
    const result = await db.raw(sql, params);
    return result.rows;
  }));
  return { query, results: results.flat().slice(0, capped), count: results.flat().length };
}

async function networkSummary() {
  const [poles, enclosures, cables, customers, cores, capacity] = await Promise.all([
    db('poles').count('* as count').first(),
    db('enclosures').count('* as count').first(),
    db('cables').count('* as count').first(),
    db('customers').count('* as count').first(),
    db('fiber_cores').select('status').count('* as count').groupBy('status'),
    getAvailableCoreCounts(),
  ]);
  const coreStatus = Object.fromEntries(cores.map((row) => [row.status, Number(row.count)]));
  const boxesWithSpare = Object.values(capacity).filter((count) => count > 0).length;
  return {
    poles: Number(poles?.count || 0),
    enclosures: Number(enclosures?.count || 0),
    cables: Number(cables?.count || 0),
    customers: Number(customers?.count || 0),
    fiber_cores: coreStatus,
    boxes_with_spare_capacity: boxesWithSpare,
  };
}

async function nearbyBoxes({ lat, lng, address, radius_m = 500, spare_only = false, limit = 50 } = {}) {
  let point = coordinates({ lat, lng });
  let resolved = null;
  if (!point && textValue(address)) {
    resolved = await resolveAddress(address, { limit: 5 });
    if (resolved.resolved) {
      point = { lat: Number(resolved.resolved.lat), lng: Number(resolved.resolved.lng) };
    }
  }
  if (!point) return { error: 'Provide valid lat/lng coordinates or an address that can be resolved.', candidates: resolved?.candidates || [] };
  const radius = Math.min(10000, Math.max(1, Number(radius_m) || 500));
  const capped = limitValue(limit, 50);
  const result = await db.raw(`
    SELECT e.id, e.code, e.name, e.type,
           COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
           COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng,
           ST_Distance(COALESCE(e.location, p.location), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_m
    FROM enclosures e LEFT JOIN poles p ON p.id = e.pole_id
    WHERE COALESCE(e.location, p.location) IS NOT NULL
      AND ST_DWithin(COALESCE(e.location, p.location), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)
    ORDER BY distance_m ASC LIMIT ?
  `, [point.lng, point.lat, point.lng, point.lat, radius, capped]);
  const capacity = await getAvailableCoreCounts();
  const boxes = result.rows.map((row) => ({
    ...row,
    distance_m: Math.round(Number(row.distance_m)),
    available_cores: Number(capacity[row.id] || 0),
  }));
  return {
    center: point,
    location: resolved?.resolved ? {
      label: resolved.resolved.label,
      source: resolved.resolved.source,
      confidence: resolved.resolved.confidence,
    } : null,
    radius_m: radius,
    boxes: spare_only ? boxes.filter((box) => box.available_cores > 0) : boxes,
    total_in_radius: boxes.length,
  };
}

async function loadBox(identifier) {
  const token = textValue(identifier);
  const result = await db.raw(`
    SELECT e.id, e.code, e.name, e.type, e.pole_id,
           COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
           COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng
    FROM enclosures e LEFT JOIN poles p ON p.id = e.pole_id
    WHERE e.id::text = ? OR lower(e.code) = lower(?) OR lower(e.name) = lower(?)
    LIMIT 2
  `, [token, token, token]);
  if (result.rows.length !== 1) return { box: null, candidates: result.rows };
  return { box: result.rows[0], candidates: result.rows };
}

async function analyzeOutage({ kind = 'pole', identifier } = {}) {
  const token = textValue(identifier);
  if (!token) return { error: 'identifier is required' };
  if (kind === 'pole') {
    const { findPole } = require('./naturalLanguageQuery');
    // Reuse the same pole resolution and graph executor used by the natural
    // language path without exposing arbitrary database identifiers.
    const { pole, candidates } = await findPole(token);
    if (!pole) return { status: candidates.length ? 'ambiguous' : 'not_found', candidates };
    const boxes = await db('enclosures').where({ pole_id: pole.id }).select('id', 'code', 'name', 'type');
    const simulations = [];
    for (const box of boxes) {
      simulations.push(await simulateFailure({
        kind: 'box', id: box.id, boxIds: [box.id], cableIds: [],
        element: { code: box.code, name: box.name, type: box.type },
      }));
    }
    const customers = new Map();
    for (const simulation of simulations) {
      for (const customer of simulation.affected?.customers || []) {
        const key = customer.customer_id || customer.customer_label || customer.key;
        if (key && !customers.has(key)) customers.set(key, customer);
      }
    }
    return {
      status: 'ok', pole,
      mounted_boxes: boxes,
      affected_customers: [...customers.values()],
      affected_count: customers.size,
      simulation_summaries: simulations.map((simulation) => simulation.summary),
      warnings: [...new Set(simulations.flatMap((simulation) => simulation.warnings || []))],
    };
  }
  if (!['enclosure', 'box'].includes(kind)) return { error: 'kind must be pole or enclosure' };
  const { box, candidates } = await loadBox(token);
  if (!box) return { status: candidates.length ? 'ambiguous' : 'not_found', candidates };
  const simulation = await simulateFailure({
    kind: 'box', id: box.id, boxIds: [box.id], cableIds: [],
    element: { code: box.code, name: box.name, type: box.type },
  });
  return { status: 'ok', box, ...simulation };
}

async function boxDocumentation({ identifier } = {}) {
  const token = textValue(identifier);
  if (!token) return { error: 'identifier is required' };
  const { box, candidates } = await loadBox(token);
  if (!box) return { status: candidates.length ? 'ambiguous' : 'not_found', candidates };
  const documentation = await loadBoxDocumentation({ enclosureId: box.id });
  return {
    status: 'ok',
    enclosure: documentation.enclosure,
    summary: documentation.summary,
    cables_landing_here: documentation.cables_landing_here,
    splitters: documentation.splitters,
    splices: documentation.splices,
    qc_flags: documentation.qc_flags,
  };
}

async function assetDetails({ kind, identifier } = {}) {
  const token = textValue(identifier);
  if (!token) return { error: 'identifier is required' };
  const result = await searchNetwork({ text: token, kind, limit: 5 });
  if (result.error) return result;
  return { ...result, exact_or_matching_assets: result.results };
}

async function traceCore({ core_id } = {}) {
  const coreId = textValue(core_id);
  if (!coreId) return { error: 'core_id is required' };
  const core = await db('fiber_cores').where({ id: coreId }).first();
  if (!core) return { status: 'not_found', error: 'Fiber core not found' };
  return { status: 'ok', core, trace: await traceFiber(coreId) };
}

async function lossBudget({ core_id, olt_type } = {}) {
  const coreId = textValue(core_id);
  if (!coreId) return { error: 'core_id is required' };
  const core = await db('fiber_cores').where({ id: coreId }).first();
  if (!core) return { status: 'not_found', error: 'Fiber core not found' };
  return { status: 'ok', core, budget: await buildLossBudget(coreId, { olt_type }) };
}

async function queryDatabase({ sql } = {}) {
  return runReadOnlyQuery(sql);
}

async function requestAgentAction(args, context) {
  return prepareAgentAction(args, context);
}

async function approvals({ status = 'pending', limit = 20 } = {}) {
  const capped = limitValue(limit);
  const rows = await db('as_built_approvals as a')
    .leftJoin('users as u', 'u.id', 'a.submitted_by')
    .where('a.status', status)
    .select(
      'a.id', 'a.enclosure_id', 'a.change_type', 'a.status', 'a.submitted_by',
      'a.submitted_by_username', 'a.submitted_role', 'a.created_at',
      'u.username as current_submitter_username',
    )
    .orderBy('a.created_at', 'desc')
    .limit(capped);
  return { status, approvals: rows };
}

const TOOL_HANDLERS = {
  search_network: searchNetwork,
  get_network_summary: networkSummary,
  find_nearby_boxes: nearbyBoxes,
  analyze_outage: analyzeOutage,
  get_asset_details: assetDetails,
  get_box_documentation: boxDocumentation,
  trace_fiber_core: traceCore,
  get_loss_budget: lossBudget,
  query_network_database: queryDatabase,
  request_agent_action: requestAgentAction,
  list_approvals: approvals,
};

async function executeNetworkTool(name, args = {}, context = {}) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return { error: `Tool ${name} is not available.` };
  try {
    return await handler(args, context);
  } catch (error) {
    // Tool failures become model-visible data, not stack traces or a way to
    // make the model retry arbitrary SQL.
    return { error: error.message || 'Network tool failed.' };
  }
}

module.exports = {
  TOOL_HANDLERS,
  searchNetwork,
  networkSummary,
  nearbyBoxes,
  analyzeOutage,
  assetDetails,
  boxDocumentation,
  traceCore,
  lossBudget,
  queryDatabase,
  requestAgentAction,
  approvals,
  executeNetworkTool,
};
