const DEFAULT_STALE_AFTER_SECONDS = 300;
const DEFAULT_SIGNAL_THRESHOLD_DBM = -27;

const LINK_DOWN_VALUES = new Set([
  'down', 'link_down', 'link-down', 'offline', 'unreachable', 'lost', 'loss',
  'disconnected', 'not_reachable', 'not-reachable', 'alarm', 'los', 'loss_of_signal', 'loss-of-signal',
]);
const LOW_SIGNAL_VALUES = new Set([
  'low_signal', 'low-signal', 'signal_low', 'signal-low', 'weak_signal', 'weak-signal', 'degraded',
  'optical_low', 'rx_low', 'low_rx', 'warning',
]);
const HEALTHY_VALUES = new Set([
  'up', 'online', 'ok', 'healthy', 'normal', 'active', 'connected', 'ready',
]);

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateOrNow(value, now = new Date()) {
  const date = value ? new Date(value) : now;
  return Number.isNaN(date.getTime()) ? now : date;
}

function stringOrNull(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

/** Convert vendor spellings into the three statuses the map understands. */
function normalizeTelemetryStatus(value) {
  const status = String(value || 'unknown').trim().toLowerCase().replace(/\s+/g, '_');
  if (LINK_DOWN_VALUES.has(status)) return 'link_down';
  if (LOW_SIGNAL_VALUES.has(status)) return 'low_signal';
  if (HEALTHY_VALUES.has(status)) return 'healthy';
  return 'unknown';
}

/**
 * Normalize one OLT/ONT event without touching the database. Vendors can send
 * `device_id`, `ont_id`, or `serial`, and either `rx_power_dbm` or
 * `signal_dbm`; the API stores one predictable shape.
 */
function normalizeTelemetryEvent(event = {}, { now = new Date(), defaultThresholdDbm = DEFAULT_SIGNAL_THRESHOLD_DBM } = {}) {
  const externalId = first(
    event.external_id,
    event.device_id,
    event.ont_id,
    event.olt_id,
    event.serial,
    event.serial_number,
    event.name,
    event.id,
  );
  if (!externalId) return null;

  const reportedAt = dateOrNow(first(event.reported_at, event.timestamp, event.event_time, event.occurred_at), now);
  const signalDbm = numberOrNull(first(event.signal_dbm, event.rx_power_dbm, event.rx_power, event.optical_power));
  const thresholdDbm = numberOrNull(first(
    event.signal_threshold_dbm,
    event.rx_threshold_dbm,
    event.low_signal_threshold_dbm,
    defaultThresholdDbm,
  ));
  let status = normalizeTelemetryStatus(first(event.status, event.state, event.alarm, event.event_type));
  // A numeric reading is enough to classify a feed that does not provide a
  // friendly alarm string. Do not turn an explicit link-down into low-signal.
  if (status === 'healthy' && signalDbm !== null && thresholdDbm !== null && signalDbm <= thresholdDbm) {
    status = 'low_signal';
  }
  if (status === 'unknown' && signalDbm !== null && thresholdDbm !== null && signalDbm <= thresholdDbm) {
    status = 'low_signal';
  }

  const location = event.location || {};
  return {
    source: String(first(event.source, event.feed, event.vendor, 'external')),
    external_id: String(externalId),
    device_type: String(first(event.device_type, event.kind, event.type, 'ont')).toLowerCase(),
    status,
    signal_dbm: signalDbm,
    signal_threshold_dbm: thresholdDbm,
    reported_at: reportedAt.toISOString(),
    customer_identifier: stringOrNull(first(event.customer_id, event.customer_code, event.customer_identifier, event.customer)),
    enclosure_identifier: stringOrNull(first(event.enclosure_id, event.box_id, event.box_code, event.enclosure_code, event.enclosure_identifier)),
    cable_identifier: stringOrNull(first(event.cable_id, event.cable_code, event.cable_identifier)),
    core_identifier: stringOrNull(first(event.core_id, event.core_identifier, event.fiber_core_id, event.core_number)),
    lat: numberOrNull(first(event.lat, event.latitude, location.lat, location.latitude)),
    lng: numberOrNull(first(event.lng, event.lon, event.longitude, location.lng, location.lon)),
    payload: event,
  };
}

function normalizeTelemetryBatch(input, options = {}) {
  const events = Array.isArray(input) ? input : Array.isArray(input?.events) ? input.events : [input];
  return events.map((event) => normalizeTelemetryEvent(event, options)).filter(Boolean);
}

function telemetryFreshness(reportedAt, { now = new Date(), staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS } = {}) {
  const timestamp = new Date(reportedAt);
  const ageSeconds = Number.isNaN(timestamp.getTime())
    ? Infinity
    : Math.max(0, (new Date(now).getTime() - timestamp.getTime()) / 1000);
  return {
    age_seconds: Number.isFinite(ageSeconds) ? Math.round(ageSeconds) : null,
    stale: !Number.isFinite(ageSeconds) || ageSeconds > staleAfterSeconds,
  };
}

/** Add the map-facing state while retaining the raw status for diagnostics. */
function presentTelemetryStatus(row, options = {}) {
  const freshness = telemetryFreshness(row.reported_at, options);
  const status = normalizeTelemetryStatus(row.status);
  const state = freshness.stale
    ? 'stale'
    : status === 'link_down'
      ? 'link_down'
      : status === 'low_signal'
        ? 'low_signal'
        : status === 'healthy'
          ? 'healthy'
          : 'unknown';
  return {
    ...row,
    status,
    state,
    stale: freshness.stale,
    age_seconds: freshness.age_seconds,
    active: !freshness.stale && (status === 'link_down' || status === 'low_signal'),
  };
}

function addCandidate(map, kind, id, score, device, reason, label = null) {
  if (!id) return;
  const key = `${kind}:${id}`;
  const current = map.get(key) || {
    kind,
    id,
    label,
    score: 0,
    evidence_count: 0,
    link_down_count: 0,
    low_signal_count: 0,
    device_ids: [],
    reasons: [],
  };
  current.score += score;
  current.evidence_count += 1;
  const status = device.status || device.state;
  if (status === 'link_down') current.link_down_count += 1;
  if (status === 'low_signal') current.low_signal_count += 1;
  if (!current.device_ids.includes(device.external_id)) current.device_ids.push(device.external_id);
  if (!current.reasons.includes(reason)) current.reasons.push(reason);
  if (!current.label && label) current.label = label;
  map.set(key, current);
}

/**
 * Rank active telemetry evidence against inventory references. This is pure so
 * a vendor adapter and the API can be tested without a database. Direct box
 * evidence wins over a cable endpoint guess; a cable is still returned when
 * no box/core relationship is known.
 */
function rankTelemetryFailures(devices = [], { cables = [], cores = [], customers = [] } = {}) {
  const candidates = new Map();
  const cableById = new Map(cables.map((cable) => [String(cable.id), cable]));
  const cableByCode = new Map(cables.filter((cable) => cable.code).map((cable) => [String(cable.code), cable]));
  const coreById = new Map(cores.map((core) => [String(core.id), core]));
  const customerById = new Map(customers.map((customer) => [String(customer.id), customer]));
  const customerByCode = new Map(customers.filter((customer) => customer.customer_code).map((customer) => [String(customer.customer_code), customer]));

  for (const device of devices) {
    if (!device.active || device.stale) continue;
    const badWeight = (device.status || device.state) === 'link_down' ? 10 : 7;
    const customer = device.customer_id
      ? customerById.get(String(device.customer_id))
      : customerByCode.get(String(device.customer_identifier));
    const enclosureId = device.enclosure_id || device.serving_enclosure_id || customer?.enclosure_id || null;
    if (enclosureId) addCandidate(candidates, 'box', enclosureId, badWeight + 8, device, 'device is tagged to this box', device.enclosure_code);

    let cable = device.cable_id
      ? cableById.get(String(device.cable_id))
      : cableByCode.get(String(device.cable_identifier));
    if (!cable && customer) {
      cable = cables.find((candidate) => String(candidate.customer_id || '') === String(customer.id));
    }
    if (cable) {
      addCandidate(candidates, 'cable', cable.id, badWeight, device, 'device is tagged to this cable', cable.code);
      if (!enclosureId && customer && String(cable.customer_id || '') === String(customer.id)) {
        addCandidate(candidates, 'box', cable.from_enclosure_id, badWeight + 2, device, 'customer drop cable lands at this box');
      }
      // Core/cable evidence can point to the two possible box endpoints, but
      // it is deliberately weaker than an explicit enclosure reference.
      if (!enclosureId && device.device_type !== 'olt') {
        for (const endpoint of [cable.from_enclosure_id, cable.to_enclosure_id]) {
          addCandidate(candidates, 'box', endpoint, badWeight * 0.35, device, 'endpoint of the tagged cable');
        }
      }
    }

    const core = device.core_id ? coreById.get(String(device.core_id)) : null;
    if (core) {
      const coreCable = cableById.get(String(core.cable_id));
      if (coreCable) addCandidate(candidates, 'cable', coreCable.id, badWeight * 0.8, device, 'device is tagged to a core on this cable', coreCable.code);
    }
  }

  const ranked = [...candidates.values()].sort((a, b) =>
    b.score - a.score || b.link_down_count - a.link_down_count || b.evidence_count - a.evidence_count || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );
  return {
    candidates: ranked,
    likely_failure: ranked[0] || null,
    active_devices: devices.filter((device) => device.active && !device.stale),
  };
}

function correlateTelemetry(devices = [], relationships = {}) {
  return rankTelemetryFailures(devices, relationships);
}

function telemetrySummary(devices = []) {
  const summary = { total: devices.length, healthy: 0, link_down: 0, low_signal: 0, stale: 0, unknown: 0, active: 0 };
  for (const device of devices) {
    if (device.stale || device.state === 'stale') summary.stale += 1;
    else if (device.state === 'link_down') summary.link_down += 1;
    else if (device.state === 'low_signal') summary.low_signal += 1;
    else if (device.state === 'healthy') summary.healthy += 1;
    else summary.unknown += 1;
    if (device.active) summary.active += 1;
  }
  return summary;
}

module.exports = {
  DEFAULT_STALE_AFTER_SECONDS,
  DEFAULT_SIGNAL_THRESHOLD_DBM,
  normalizeTelemetryStatus,
  normalizeTelemetryEvent,
  normalizeTelemetryBatch,
  telemetryFreshness,
  presentTelemetryStatus,
  rankTelemetryFailures,
  correlateTelemetry,
  telemetrySummary,
};
