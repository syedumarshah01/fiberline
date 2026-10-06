const { haversineMeters } = require('../services/streetRoute');

const DEFAULT_SPLICE_LOSS_DB = 0.1;
const DEFAULT_CONNECTOR_LOSS_DB = 0.3;
const DEFAULT_FIBER_ATTENUATION_DB_PER_KM = 0.35;
const SPLITTER_INSERTION_LOSS_DB = Object.freeze({
  2: 3.5,
  4: 7.2,
  8: 10.5,
  16: 13.5,
  32: 17.3,
});
const SAFETY_MARGIN_DB = 3;
const MAX_SEARCH_HOPS = positiveInteger(process.env.SERVICEABILITY_MAX_SEARCH_HOPS, 10);
const MAX_SEARCH_DISTANCE_M = positiveNumber(process.env.SERVICEABILITY_MAX_SEARCH_DISTANCE_M, 2000);

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function numeric(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * A core is considered for automatic use only when its explicit status and all
 * known relationships agree. A stale `spare` label cannot override a splice,
 * customer termination, or splitter connection.
 */
function isSpareCore(core) {
  if (!core || core.status !== 'spare') return false;
  if (core.status === 'reserved' || core.status === 'damaged' || core.status === 'faulty') return false;
  const counts = [core.splice_count, core.termination_count, core.splitter_use_count].map((value) => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) && Number.isInteger(number) && number >= 0 ? number : null;
  });
  return counts.every((count) => count === 0);
}

/** A port is free only with a known-false disabled flag and no child splitter. */
function isFreePort(port) {
  if (!port || port.disabled !== false) return false;
  if (port.status !== 'active') return false;
  return (port.connected_core_id ?? port.output_core_id ?? null) == null &&
    (port.output_splitter_id ?? null) == null;
}

function fiberLoss(segment) {
  const lengthKm = numeric(segment.length_km) ?? (
    numeric(segment.length_m) == null ? null : numeric(segment.length_m) / 1000
  );
  const attenuation = numeric(segment.attenuation_db_per_km) ?? DEFAULT_FIBER_ATTENUATION_DB_PER_KM;
  if (lengthKm == null || lengthKm < 0 || attenuation < 0) return null;
  return { loss_db: lengthKm * attenuation, attenuation_db_per_km: attenuation, length_km: lengthKm };
}

function splitterLoss(splitter) {
  const recorded = numeric(splitter.insertion_loss_db) ?? numeric(splitter.loss_db);
  if (recorded != null) {
    return { loss_db: recorded, measured: true };
  }
  const ratio = numeric(splitter.split_count);
  const loss = ratio == null ? null : SPLITTER_INSERTION_LOSS_DB[ratio];
  return loss == null ? null : { loss_db: loss, measured: false };
}

/**
 * Additive dB loss calculation for the complete documented path. All values
 * remain in dB/dBm; no linear-power conversion is performed.
 */
function calculateLossBudget({
  fiber_segments = [],
  splices = [],
  splitters = [],
  connector_count,
  budget_db,
  safety_margin_db = SAFETY_MARGIN_DB,
} = {}) {
  const budget = numeric(budget_db);
  if (budget == null) {
    return { known: false, reason: 'UNKNOWN_BUDGET', total_loss_db: null, margin_db: null, breakdown: [] };
  }

  const connectors = numeric(connector_count);
  if (connectors == null) {
    return {
      known: false,
      reason: 'UNKNOWN_TOPOLOGY',
      detail: connector_count === null || connector_count === undefined
        ? 'CONNECTOR_COUNT_UNAVAILABLE'
        : 'INVALID_CONNECTOR_COUNT',
      missing: ['connector_count'],
      total_loss_db: null,
      margin_db: null,
      breakdown: [],
    };
  }
  if (connectors < 0 || !Number.isInteger(connectors)) {
    return { known: false, reason: 'UNKNOWN_TOPOLOGY', detail: 'INVALID_CONNECTOR_COUNT', total_loss_db: null, margin_db: null, breakdown: [] };
  }

  const breakdown = [];
  let total = 0;
  const push = (entry) => {
    total += entry.loss_db;
    breakdown.push({ ...entry, running_loss_db: round2(total) });
  };

  for (const segment of fiber_segments) {
    const loss = fiberLoss(segment);
    if (!loss) {
      return { known: false, reason: 'UNKNOWN_TOPOLOGY', detail: 'fiber segment length is missing or invalid', total_loss_db: null, margin_db: null, breakdown };
    }
    push({
      type: 'fiber',
      cable_id: segment.cable_id ?? null,
      length_km: round2(loss.length_km),
      attenuation_db_per_km: loss.attenuation_db_per_km,
      loss_db: loss.loss_db,
      measured_attenuation: numeric(segment.attenuation_db_per_km) != null,
    });
  }

  for (const splice of splices) {
    const measured = numeric(splice.loss_db);
    push({
      type: 'splice',
      splice_id: splice.splice_id ?? splice.id ?? null,
      loss_db: measured ?? DEFAULT_SPLICE_LOSS_DB,
      measured: measured != null,
    });
  }

  for (const splitter of splitters) {
    const loss = splitterLoss(splitter);
    if (!loss) {
      return {
        known: false,
        reason: 'UNKNOWN_TOPOLOGY',
        detail: `splitter ${splitter.id ?? ''} has no supported ratio or recorded insertion loss`.trim(),
        total_loss_db: null,
        margin_db: null,
        breakdown,
      };
    }
    push({
      type: 'splitter',
      splitter_id: splitter.id ?? null,
      split_count: numeric(splitter.split_count),
      loss_db: loss.loss_db,
      measured: loss.measured,
    });
  }

  if (connectors > 0) {
    push({
      type: 'connector',
      count: connectors,
      loss_db: connectors * DEFAULT_CONNECTOR_LOSS_DB,
      loss_per_connector_db: DEFAULT_CONNECTOR_LOSS_DB,
      measured: false,
    });
  }

  const safetyMargin = numeric(safety_margin_db) ?? SAFETY_MARGIN_DB;
  const totalLoss = round2(total);
  const margin = round2(budget - totalLoss);
  const severity = margin < 0 ? 'FAIL' : margin < safetyMargin ? 'MARGINAL' : 'OK';
  return {
    known: true,
    budget_db: budget,
    total_loss_db: totalLoss,
    margin_db: margin,
    safety_margin_db: safetyMargin,
    low_power: margin < safetyMargin,
    severity,
    connector_count: connectors,
    breakdown,
  };
}

function dropSegment(from, to, { cableId = null } = {}) {
  if (!from || !to) return null;
  const distanceM = haversineMeters(from, to);
  if (!Number.isFinite(distanceM) || distanceM < 0) return null;
  return {
    cable_id: cableId,
    length_m: distanceM,
    attenuation_db_per_km: DEFAULT_FIBER_ATTENUATION_DB_PER_KM,
    estimated: true,
    basis: 'straight_line_customer_drop',
  };
}

module.exports = {
  DEFAULT_SPLICE_LOSS_DB,
  DEFAULT_CONNECTOR_LOSS_DB,
  DEFAULT_FIBER_ATTENUATION_DB_PER_KM,
  SPLITTER_INSERTION_LOSS_DB,
  SAFETY_MARGIN_DB,
  MAX_SEARCH_HOPS,
  MAX_SEARCH_DISTANCE_M,
  positiveNumber,
  positiveInteger,
  numeric,
  round2,
  isSpareCore,
  isFreePort,
  fiberLoss,
  splitterLoss,
  calculateLossBudget,
  dropSegment,
};
