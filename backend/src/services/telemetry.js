const db = require('../db');
const { simulateFailure } = require('./impactAnalysis');
const {
  DEFAULT_STALE_AFTER_SECONDS,
  normalizeTelemetryBatch,
  presentTelemetryStatus,
  rankTelemetryFailures,
  telemetrySummary,
} = require('../utils/telemetry');

const subscribers = new Set();

function staleAfterSeconds() {
  const configured = Number(process.env.TELEMETRY_STALE_AFTER_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_AFTER_SECONDS;
}

function isMissingTelemetryTable(error) {
  return error?.code === '42P01' || /relation ["']?telemetry_status["']? does not exist/i.test(error?.message || '');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

async function findReference(table, value, codeColumn = 'code') {
  if (!value) return null;
  try {
    if (codeColumn === 'id' && !isUuid(value)) return null;
    if (isUuid(value)) {
      return await db(table).where({ id: value }).first();
    }
    return await db(table).where(codeColumn, String(value)).first();
  } catch (error) {
    // An inventory table may not exist in a partially migrated installation.
    // Telemetry remains useful as an uncorrelated device in that case.
    if (error?.code === '42P01') return null;
    throw error;
  }
}

async function resolveReferences(event) {
  const [customer, enclosure, cable] = await Promise.all([
    findReference('customers', event.customer_identifier, 'customer_code'),
    findReference('enclosures', event.enclosure_identifier, 'code'),
    findReference('cables', event.cable_identifier, 'code'),
  ]);
  let core = await findReference('fiber_cores', event.core_identifier, 'id');
  if (!core && cable && event.core_identifier != null && /^\d+$/.test(String(event.core_identifier))) {
    core = await db('fiber_cores')
      .where({ cable_id: cable.id, core_number: Number(event.core_identifier) })
      .first();
  }
  return {
    customer_id: customer?.id || null,
    enclosure_id: enclosure?.id || null,
    cable_id: cable?.id || core?.cable_id || null,
    core_id: core?.id || null,
  };
}

async function inventory() {
  const [cables, cores, customers, enclosures] = await Promise.all([
    db('cables').select('id', 'code', 'from_enclosure_id', 'to_enclosure_id', 'customer_id'),
    db('fiber_cores').select('id', 'cable_id', 'core_number'),
    db('customers').select('id', 'customer_code', 'name'),
    db('enclosures').select('id', 'code', 'name'),
  ]);
  return { cables, cores, customers, enclosures };
}

async function loadCurrentTelemetry({ now = new Date() } = {}) {
  let rows;
  try {
    rows = await db('telemetry_status').select('*').orderBy('reported_at', 'desc');
  } catch (error) {
    if (isMissingTelemetryTable(error)) {
      return {
        available: false,
        configured: false,
        source: null,
        generated_at: new Date(now).toISOString(),
        stale_after_seconds: staleAfterSeconds(),
        devices: [],
        summary: telemetrySummary([]),
        correlation: { likely_failure: null, candidates: [], impact: null },
      };
    }
    throw error;
  }

  const present = rows.map((row) => presentTelemetryStatus(row, {
    now,
    staleAfterSeconds: staleAfterSeconds(),
  }));
  let network = { cables: [], cores: [], customers: [], enclosures: [] };
  try {
    network = await inventory();
  } catch (error) {
    // Inventory can lag the telemetry migration. Keep the raw device state
    // visible even when its optional correlation tables are not ready yet.
    if (!/relation ["']?.+?["']? does not exist/i.test(error?.message || '') && error?.code !== '42P01') throw error;
  }
  const cableById = new Map(network.cables.map((cable) => [String(cable.id), cable]));
  const coreById = new Map(network.cores.map((core) => [String(core.id), core]));
  const customerById = new Map(network.customers.map((customer) => [String(customer.id), customer]));
  const enclosureById = new Map(network.enclosures.map((enclosure) => [String(enclosure.id), enclosure]));
  const decorated = present.map((device) => {
    const cable = device.cable_id ? cableById.get(String(device.cable_id)) : null;
    const core = device.core_id ? coreById.get(String(device.core_id)) : null;
    const customer = device.customer_id ? customerById.get(String(device.customer_id)) : null;
    const enclosure = device.enclosure_id ? enclosureById.get(String(device.enclosure_id)) : null;
    return {
      ...device,
      customer_code: customer?.customer_code || null,
      customer_name: customer?.name || null,
      enclosure_code: enclosure?.code || null,
      enclosure_name: enclosure?.name || null,
      cable_code: cable?.code || null,
      core_number: core?.core_number ?? null,
    };
  });
  const correlation = rankTelemetryFailures(decorated, network);
  let impact = null;
  let impactError = null;

  // The existing impact service is the only traversal authority. Telemetry can
  // select a box, but it never introduces a cable-failure traversal of its own.
  if (correlation.likely_failure?.kind === 'box') {
    try {
      const box = await findReference('enclosures', correlation.likely_failure.id, 'code');
      if (box) {
        const locations = {};
        try {
          const locationRows = await db.raw(`
            SELECT e.id,
                   COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
                   COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng
            FROM enclosures e
            LEFT JOIN poles p ON p.id = e.pole_id
          `);
          for (const location of locationRows.rows || []) {
            if (location.lat != null && location.lng != null) {
              locations[location.id] = { lat: Number(location.lat), lng: Number(location.lng) };
            }
          }
        } catch (error) {
          // Location is only for the restoration fallback, not for traversal.
          if (error?.code !== '42P01') throw error;
        }
        impact = await simulateFailure({
          kind: 'box',
          id: box.id,
          boxIds: [box.id],
          cableIds: [],
          element: { code: box.code, name: box.name ?? null, type: box.type ?? null },
          boxLocations: locations,
        });
        impact.telemetry_correlated = true;
      }
    } catch (error) {
      impactError = error.message || 'Unable to run box impact analysis';
    }
  }

  return {
    available: rows.length > 0,
    configured: rows.length > 0,
    source: [...new Set(rows.map((row) => row.source).filter(Boolean))].join(', ') || null,
    generated_at: new Date(now).toISOString(),
    stale_after_seconds: staleAfterSeconds(),
    devices: decorated,
    summary: telemetrySummary(decorated),
    correlation: {
      likely_failure: correlation.likely_failure,
      candidates: correlation.candidates,
      impact,
      impact_error: impactError,
    },
  };
}

async function ingestTelemetry(input, { source = null, now = new Date() } = {}) {
  const rawEvents = Array.isArray(input) ? input : Array.isArray(input?.events) ? input.events : [input];
  const withSource = rawEvents.map((event) => ({
    ...(event || {}),
    source: event?.source || source || event?.feed || 'external',
  }));
  const events = normalizeTelemetryBatch(withSource, { now });
  if (!events.length) {
    const error = new Error('At least one telemetry event with a device identifier is required');
    error.status = 400;
    throw error;
  }

  const stored = [];
  try {
    for (const event of events) {
      const references = await resolveReferences(event);
      const row = {
        ...event,
        ...references,
        received_at: new Date(now),
      };
      const result = await db('telemetry_status')
        .insert(row)
        .onConflict(['source', 'external_id'])
        .merge(row)
        .returning('*');
      stored.push(result?.[0] || row);
    }
  } catch (error) {
    if (isMissingTelemetryTable(error)) {
      error.status = 503;
      error.message = 'Telemetry storage is not installed; run the latest database migrations';
    }
    throw error;
  }

  const status = await loadCurrentTelemetry({ now });
  for (const subscriber of subscribers) {
    try {
      subscriber(status);
    } catch {
      // A disconnected stream must not make ingestion fail for the provider.
    }
  }
  return { accepted: stored.length, devices: stored, status };
}

function subscribeTelemetry(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

module.exports = {
  loadCurrentTelemetry,
  ingestTelemetry,
  subscribeTelemetry,
  isMissingTelemetryTable,
};
