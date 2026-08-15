/**
 * Pure helpers for splitter naming and human-readable core notes.
 * Kept separate from the route so they're unit-testable without a database.
 */

/**
 * Default name for a splitter when the tech didn't type one. The old default
 * was `${input_core_id.slice(0, 6)}... 4-way splitter` — a raw UUID fragment
 * that meant nothing in the field. The name should say WHAT feeds it.
 *
 * source: { kind: 'core', cableCode, coreNumber }
 *       | { kind: 'port', parentName, parentSplitCount, portNumber }
 */
function defaultSplitterName(splitCount, source) {
  if (source && source.kind === 'port') {
    const parent = source.parentName || `1:${source.parentSplitCount} splitter`;
    return `Splitter 1:${splitCount} on ${parent} · port ${source.portNumber}`;
  }
  if (source && source.kind === 'core') {
    return `Splitter 1:${splitCount} on ${source.cableCode} fiber #${source.coreNumber}`;
  }
  return `Splitter 1:${splitCount}`;
}

/**
 * Note written onto a fiber core when it becomes a splitter's input.
 * Layman phrasing: this fiber's light is divided by this splitter.
 */
function splitterInputNote(splitterName, splitCount) {
  const label = splitterName || `Splitter 1:${splitCount}`;
  return `${label}: this fiber is split into ${splitCount} outputs here`;
}

/**
 * Note written onto a fiber core when it's assigned to a splitter output port.
 */
function splitterOutputNote(splitterName, splitCount, portNumber) {
  const label = splitterName || `Splitter 1:${splitCount}`;
  return `${label}: fed from output port ${portNumber} of ${splitCount}`;
}

/** Note written when a core is taken off a splitter port again. */
function splitterUnassignNote(splitterName, portNumber) {
  const label = splitterName || 'splitter';
  return `Removed from ${label} port ${portNumber}`;
}

/** A port is occupied when it feeds either a fiber core OR a child splitter. */
function portIsOccupied(port) {
  return Boolean(port && (port.output_core_id || port.output_splitter_id));
}

// Fields a splitter PATCH may change. split_count is deliberately excluded —
// the port rows are created to match it at creation time, so changing it
// would silently orphan/invent ports.
const SPLITTER_PATCH_FIELDS = ['name', 'splice_type', 'loss_db', 'technician', 'splice_date', 'notes'];

/**
 * Validate + normalize a splitter PATCH body. Mirrors the splice PATCH rules:
 * blank strings mean "clear the field" for optional text/numeric columns, and
 * enums are checked up front so Postgres never sees a value it would reject.
 *
 * Returns { updates } (may only contain keys the caller sent) or { error }.
 */
function sanitizeSplitterPatch(body) {
  const updates = {};
  for (const f of SPLITTER_PATCH_FIELDS) {
    if (body[f] !== undefined) updates[f] = body[f];
  }

  if (updates.loss_db === '') updates.loss_db = null;
  if (updates.loss_db !== undefined && updates.loss_db !== null && Number.isNaN(Number(updates.loss_db))) {
    return { error: 'loss_db must be a number' };
  }
  if (updates.splice_date === '') updates.splice_date = null;
  if (updates.technician === '') updates.technician = null;
  if (updates.name === '') updates.name = null; // clearing falls back to the auto-name
  if (updates.notes !== undefined && updates.notes !== null && typeof updates.notes !== 'string') {
    return { error: 'notes must be a string' };
  }
  if (updates.name !== undefined && updates.name !== null && typeof updates.name !== 'string') {
    return { error: 'name must be a string' };
  }
  if (updates.technician !== undefined && updates.technician !== null && typeof updates.technician !== 'string') {
    return { error: 'technician must be a string' };
  }
  if (updates.splice_type !== undefined && !['fusion', 'mechanical'].includes(updates.splice_type)) {
    return { error: "splice_type must be 'fusion' or 'mechanical'" };
  }
  if (Object.keys(updates).length === 0) {
    return { error: 'No valid fields to update' };
  }
  if (updates.loss_db !== undefined && updates.loss_db !== null) updates.loss_db = Number(updates.loss_db);
  return { updates };
}

module.exports = {
  defaultSplitterName,
  splitterInputNote,
  splitterOutputNote,
  splitterUnassignNote,
  portIsOccupied,
  sanitizeSplitterPatch,
};
