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

module.exports = {
  defaultSplitterName,
  splitterInputNote,
  splitterOutputNote,
  splitterUnassignNote,
  portIsOccupied,
};
