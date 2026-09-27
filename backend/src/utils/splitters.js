/**
 * Pure helpers for splitter naming, port accounting and human-readable core
 * notes. Kept separate from the route so they're unit-testable without a
 * database — and so the box panel, the worksheet and the capacity checks all
 * count a splitter's ports the same way. Two places counting "free ports"
 * differently is how a box gets sold a port it does not have.
 */

const { splitterLossDb } = require('./lossBudget');

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

/**
 * The split ratios this build models. The database column is a plain integer, so
 * this list — not a schema constraint — is what keeps a 1:7 splitter out. It is
 * exported so the middleware, the route and the form all offer the same set: a
 * form that offers a ratio the API rejects is a bug report waiting to happen.
 * `utils/lossBudget.js` prices every one of them (a 1:64, if someone documents
 * one, still gets the 10·log10(N)+1 estimate rather than no number at all).
 */
const SUPPORTED_SPLIT_COUNTS = [2, 4, 8, 16, 32];

// --- Port accounting (the one place "free port" is defined) -------------------

/**
 * The split ratio as it is written on the tray and spoken in the field: 8 → "1:8".
 * The database stores the integer (`split_count`) because the loss table and the
 * port rows are keyed by it; the ratio is a label and is derived, never stored —
 * a stored "1:8" beside a split_count of 16 is two facts that can disagree.
 */
function ratioLabel(splitCount) {
  const n = Number(splitCount);
  return Number.isFinite(n) && n > 0 ? `1:${n}` : null;
}

/** Is this port marked damaged (unusable regardless of what is connected)? */
function portIsDamaged(port) {
  return Boolean(port && (port.status === 'damaged' || port.port_status === 'damaged'));
}

/**
 * What a single port is doing right now:
 *   'free'     — nothing on it; this is a port a new drop can take today
 *   'core'     — a fiber core is assigned (a customer drop, or a trunk core)
 *   'cascaded' — a child splitter is fed from it (occupied, but not a customer)
 *
 * The order matters: a port carrying both (a data state that should not exist)
 * counts as occupied for both kinds of work, so `free` is never reported for a
 * port that has anything on it.
 */
function portUsage(port) {
  if (!port) return 'free';
  if (port.output_core_id && port.output_splitter_id) return 'cascaded';
  if (port.output_core_id) return 'core';
  if (port.output_splitter_id) return 'cascaded';
  return 'free';
}

/**
 * The customer label printed at the box for whatever this port feeds, if any.
 *
 * It is resolved from the connected core's cable (`cables.customer_label`) —
 * NOT copied into the port row. A copy would be a second source of truth for a
 * label that is already recorded in one place, and the copy that goes stale is
 * always the one on screen: a drop reassigned to port 7 would keep wearing its
 * old port's label. Callers pass the label they joined; `output_splitter_id`
 * ports have none (a splitter is not a customer).
 */
function portCustomerLabel(port) {
  if (!port || port.output_splitter_id) return null;
  const label = port.customer_label ?? port.cable_customer_label ?? null;
  return label == null || label === '' ? null : label;
}

/**
 * Count a splitter's ports the way the field reads the tray.
 *
 * Returns totals plus the actual port numbers, because "3 free" is a number to
 * put in a headcount while "ports 5, 6, 7" is what the technician writes down.
 *
 * `free + used + cascaded` need not equal `total`: `damaged` is a condition, not
 * a connection, so a damaged port appears in `damaged_port_numbers` as well as in
 * the list for whatever is on it — and a damaged empty port appears in no other
 * list at all. Callers asking "can this port take a drop?" ask `free`.
 */
function summarizePorts(ports) {
  const list = (ports || []).filter(Boolean);
  const freePortNumbers = [];
  const usedPortNumbers = [];
  const cascadedPortNumbers = [];
  const damagedPortNumbers = [];
  const customerLabels = [];

  for (const port of list) {
    const number = Number(port.port_number);
    const usage = portUsage(port);
    const damaged = portIsDamaged(port);

    // Condition and connection are two different facts, and a port can be both:
    // a damaged port carrying a live customer is "in use" AND "damaged". Counting
    // it as only one of those loses the thing a technician has to fix.
    if (damaged) damagedPortNumbers.push(number);
    if (usage === 'cascaded') cascadedPortNumbers.push(number);
    else if (usage === 'core') usedPortNumbers.push(number);
    // A damaged empty port is not capacity, so it is never "free".
    else if (!damaged) freePortNumbers.push(number);

    const label = portCustomerLabel(port);
    if (label) customerLabels.push(label);
  }

  const ascending = (a, b) => a - b;
  return {
    total: list.length,
    free: freePortNumbers.length,
    used: usedPortNumbers.length,
    cascaded: cascadedPortNumbers.length,
    damaged: damagedPortNumbers.length,
    free_port_numbers: freePortNumbers.sort(ascending),
    used_port_numbers: usedPortNumbers.sort(ascending),
    cascaded_port_numbers: cascadedPortNumbers.sort(ascending),
    damaged_port_numbers: damagedPortNumbers.sort(ascending),
    customer_labels: [...new Set(customerLabels)],
  };
}

/**
 * A splitter as every caller wants to read it: the stored row, the ratio as it
 * is written down, its ports labelled with their usage and customer, the port
 * counts, and the insertion loss the optical budget will actually charge for it
 * (a recorded `loss_db` wins over the planning value for the ratio — the same
 * rule as `utils/lossBudget.js`, called rather than re-implemented).
 *
 * `parent` is the upstream splitter port this one is fed from, when cascaded.
 */
function enrichSplitter(splitter, { ports = [], parent = null } = {}) {
  if (!splitter) return null;
  const { loss_db: effectiveLossDb, measured } = splitterLossDb(splitter);
  const portSummary = summarizePorts(ports);
  return {
    ...splitter,
    ratio: ratioLabel(splitter.split_count),
    parent: parent || null,
    ports: ports.map((port) => ({
      ...port,
      usage: portUsage(port),
      damaged: portIsDamaged(port),
      // The one field a capacity check should read: can a new drop land here?
      // It folds together "nothing connected" and "not broken", so a caller
      // cannot accidentally plan onto a damaged port by reading `usage` alone.
      available: portUsage(port) === 'free' && !portIsDamaged(port),
      customer_label: portCustomerLabel(port),
    })),
    port_summary: portSummary,
    effective_loss_db: effectiveLossDb == null ? null : effectiveLossDb,
    loss_measured: measured,
  };
}

/**
 * Enrich a whole box's splitters from three joins the callers already do.
 * `portsBySplitterId` maps splitter id → port rows; `parentByChild` maps child
 * splitter id → the parent port feeding it (see routes/splitters.js).
 */
function enrichSplitters(splitters, portsBySplitterId = {}, parentByChild = {}) {
  const results = (splitters || []).map((splitter) =>
    enrichSplitter(splitter, {
      ports: portsBySplitterId[splitter.id] || [],
      parent: parentByChild[splitter.id] || null,
    }),
  );

  // Box-level totals, in the same words the per-splitter counts use. A box with
  // no splitters is not "full" — it is a box where this check does not apply
  // (not every box has a splitter), and callers need to tell those apart.
  const totals = results.reduce(
    (acc, splitter) => {
      acc.splitters += 1;
      acc.ports += splitter.port_summary.total;
      acc.free_ports += splitter.port_summary.free;
      acc.used_ports += splitter.port_summary.used;
      acc.cascaded_ports += splitter.port_summary.cascaded;
      acc.damaged_ports += splitter.port_summary.damaged;
      return acc;
    },
    { splitters: 0, ports: 0, free_ports: 0, used_ports: 0, cascaded_ports: 0, damaged_ports: 0 },
  );

  return { splitters: results, totals };
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
  SUPPORTED_SPLIT_COUNTS,
  defaultSplitterName,
  splitterInputNote,
  splitterOutputNote,
  splitterUnassignNote,
  portIsOccupied,
  sanitizeSplitterPatch,
  ratioLabel,
  portIsDamaged,
  portUsage,
  portCustomerLabel,
  summarizePorts,
  enrichSplitter,
  enrichSplitters,
};
