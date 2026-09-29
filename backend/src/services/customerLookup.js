/**
 * Database reads shared by customer connection planning.
 *
 * This module only loads physical enclosure capacity and asks the street router
 * for geometry. Decisions, installation steps, and optical calculations live in
 * connectionPlan.js / utils/connectionPlan.js.
 */
const db = require('../db');
const { getAvailableCoreCounts, getAvailableCoreOptions } = require('./capacityGraph');
const { fetchStreetRoute } = require('./streetRoute');

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
  const [portCounts, freePorts, capacity, coreOptions] = await Promise.all([
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
      .where('sp.status', 'active')
      .whereNull('sp.output_core_id')
      .whereNull('sp.output_splitter_id')
      .select(
        'sp.id',
        's.id as splitter_id',
        's.enclosure_id',
        'sp.port_number',
        's.name as splitter_name',
        's.split_count',
        's.loss_db',
        's.input_core_id',
      )
      .orderBy('s.id')
      .orderBy('sp.port_number')
      .catch(() => []),
    getAvailableCoreCounts().catch(() => ({})),
    getAvailableCoreOptions(ids).catch(() => ({})),
  ]);

  const portsByBox = new Map();
  for (const row of freePorts) {
    const entry = portsByBox.get(row.enclosure_id) || { numbers: [], names: new Set(), options: [] };
    if (entry.numbers.length < 8) entry.numbers.push(Number(row.port_number));
    if (row.splitter_name) entry.names.add(row.splitter_name);
    if (entry.options.length < 8) {
      entry.options.push({
        id: row.id,
        splitter_id: row.splitter_id,
        splitter_name: row.splitter_name,
        port_number: Number(row.port_number),
        split_count: row.split_count == null ? null : Number(row.split_count),
        loss_db: row.loss_db == null ? null : Number(row.loss_db),
        input_core_id: row.input_core_id,
      });
    }
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
    const ports = portsByBox.get(row.id) || { numbers: [], names: new Set(), options: [] };
    return {
      ...row,
      free_ports: ports.numbers.length,
      free_port_numbers: ports.numbers,
      splitter_name: [...ports.names][0] || null,
      splitter_ports: ports.options,
      splitter_count: portCounts.get(row.id) || 0,
      ports_total: totalsByBox.get(row.id) || 0,
      available_cores: capacity[row.id] || 0,
      available_core_options: coreOptions[row.id] || [],
    };
  });
}

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


module.exports = {
  loadCandidates,
  routeTo,
  DEFAULT_RADIUS_M,
  MAX_RADIUS_M,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ROUTE_TIMEOUT_MS,
};
