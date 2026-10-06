const crypto = require('crypto');
const db = require('../db');

/**
 * Optimistic concurrency token for a box's documentation. A documentation
 * panel sends this token back with every edit. The token includes all records
 * that can be edited from that panel, so a second technician cannot silently
 * overwrite a splice, splitter, port assignment, or box metadata change.
 *
 * The caller may provide a transaction executor. Routes lock the enclosure row
 * before calling this function, which makes the compare-and-update check
 * atomic when two edits arrive at the same time.
 */
async function getBoxRevision(enclosureId, executor = db) {
  const enclosure = await executor('enclosures')
    .where({ id: enclosureId })
    .select('id', 'code', 'name', 'type', 'capacity', 'status', 'mounting', 'notes', 'connector_count_in', 'connector_count_out', 'updated_at')
    .first();
  if (!enclosure) return null;

  const cables = await executor('cables')
    .where({ from_enclosure_id: enclosureId })
    .orWhere({ to_enclosure_id: enclosureId })
    .select('id', 'updated_at');
  const cableIds = cables.map((cable) => cable.id);
  const cores = cableIds.length
    ? await executor('fiber_cores').whereIn('cable_id', cableIds).select('id', 'cable_id', 'core_number', 'status', 'updated_at')
    : [];
  const splices = await executor('splices')
    .where({ enclosure_id: enclosureId })
    .select('id', 'core_a_id', 'core_b_id', 'splice_type', 'tray_number', 'tray_position', 'loss_db', 'technician', 'splice_date', 'notes', 'updated_at');
  const splitters = await executor('splitters')
    .where({ enclosure_id: enclosureId })
    .select('id', 'name', 'split_count', 'splice_type', 'input_core_id', 'loss_db', 'technician', 'splice_date', 'notes', 'updated_at');
  const splitterIds = splitters.map((splitter) => splitter.id);
  const ports = splitterIds.length
    ? await executor('splitter_ports')
        .whereIn('splitter_id', splitterIds)
        .select('id', 'splitter_id', 'output_core_id', 'output_splitter_id', 'port_number', 'status', 'disabled', 'notes', 'updated_at')
    : [];

  const parts = { enclosure, cables, cores, splices, splitters, ports };
  const revision = makeBoxRevision(parts);
  const timestamps = [
    enclosure.updated_at,
    ...cables.map((row) => row.updated_at),
    ...cores.map((row) => row.updated_at),
    ...splices.map((row) => row.updated_at),
    ...splitters.map((row) => row.updated_at),
    ...ports.map((row) => row.updated_at),
  ].filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);

  return {
    revision,
    changed_at: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    parts,
  };
}

function makeBoxRevision({ enclosure, cables = [], cores = [], splices = [], splitters = [], ports = [] }) {
  const compact = {
    enclosure: compactRows([enclosure], ['id', 'connector_count_in', 'connector_count_out', 'updated_at']),
    cables: compactRows(cables, ['id', 'updated_at']),
    cores: compactRows(cores, ['id', 'cable_id', 'core_number', 'status', 'updated_at']),
    splices: compactRows(splices, ['id', 'core_a_id', 'core_b_id', 'updated_at']),
    splitters: compactRows(splitters, ['id', 'input_core_id', 'disabled', 'insertion_loss_db', 'updated_at']),
    ports: compactRows(ports, ['id', 'splitter_id', 'output_core_id', 'output_splitter_id', 'port_number', 'status', 'disabled', 'updated_at']),
  };
  return crypto.createHash('sha256').update(stableStringify(compact)).digest('hex');
}

function compactRows(rows, fields) {
  return (rows || [])
    .map((row) => Object.fromEntries(fields.map((field) => [field, row?.[field] ?? null])))
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function stableStringify(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function expectedRevision(req) {
  const header = req.get?.('if-match') || req.headers?.['if-match'];
  const body = req.body || {};
  return String(header || body._box_revision || '').replace(/^W\//, '').replace(/^"|"$/g, '') || null;
}

/** Throw a structured 409 only when the caller opted into concurrency checks. */
async function assertBoxRevision({ req, enclosureId, executor = db }) {
  const expected = expectedRevision(req);
  if (!expected) return null;
  const current = await getBoxRevision(enclosureId, executor);
  if (!current) {
    const error = new Error('Enclosure not found');
    error.status = 404;
    throw error;
  }
  if (expected !== current.revision) {
    const error = new Error('This box changed while you were editing it. Review the latest documentation before saving again.');
    error.status = 409;
    error.code = 'BOX_EDIT_CONFLICT';
    error.conflict = {
      enclosure_id: enclosureId,
      expected_revision: expected,
      current_revision: current.revision,
      changed_at: current.changed_at,
      // The current parts let an interactive client render a diff without
      // guessing which technician's values should win.
      current: current.parts,
    };
    throw error;
  }
  return current;
}

module.exports = {
  getBoxRevision,
  assertBoxRevision,
  expectedRevision,
  stableStringify,
  makeBoxRevision,
};
