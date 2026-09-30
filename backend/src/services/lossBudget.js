const db = require('../db');
const { traceFiber } = require('./fiberTrace');
const {
  calculateLossBudget,
  OLT_BUDGETS_DB,
} = require('../utils/lossBudget');

/**
 * Single-row project settings (which OLT type this network runs, plus
 * optional budget / safety-margin overrides). The row is created lazily so
 * existing databases pick up loss budgets without a seed step.
 */
async function getProjectSettings() {
  let row = await db('project_settings').orderBy('created_at').first();
  if (!row) {
    [row] = await db('project_settings').insert({}).returning('*');
  }
  return row;
}

/**
 * Every splitter the traced path crosses, keyed by the traced core it
 * attaches to:
 *   - input side:  splitters.input_core_id is one of the traced cores
 *   - output side: one of the traced cores is assigned to a splitter port
 *   - cascade parents: if a crossed splitter is itself fed from another
 *     splitter's port (cascaded distribution), that parent is in the optical
 *     path too — walk up the chain and attach it to the same traced core.
 *
 * The trace walks splices only, so it cannot hop through a splitter; this
 * enrichment is what makes the budget cover the splitter leg of a PON path.
 */
async function splitterCrossingsByCoreId(coreIds) {
  const byCoreId = {};
  if (!coreIds.length) return byCoreId;

  const add = (coreId, splitter) => {
    if (!coreId || !splitter) return;
    (byCoreId[coreId] = byCoreId[coreId] || []).push(splitter);
  };

  // Input side: a traced core feeding a splitter.
  const inputSide = await db('splitters').whereIn('input_core_id', coreIds);
  for (const splitter of inputSide) add(splitter.input_core_id, splitter);

  // Output side: a traced core coming out of a splitter port.
  const portSide = await db('splitter_ports as sp')
    .join('splitters as s', 's.id', 'sp.splitter_id')
    .whereIn('sp.output_core_id', coreIds)
    .select('s.*', 'sp.port_number', 'sp.output_core_id');
  for (const row of portSide) add(row.output_core_id, row);

  // Cascade parents: child splitters fed from a parent's port.
  const known = new Set([...inputSide, ...portSide].map((s) => s.id));
  let frontier = [...known];
  let guard = 0;
  while (frontier.length && guard++ < 10) {
    const links = await db('splitter_ports as sp')
      .join('splitters as parent', 'parent.id', 'sp.splitter_id')
      .whereIn('sp.output_splitter_id', frontier)
      .select('parent.*', 'sp.output_splitter_id as child_id');
    const next = [];
    for (const parent of links) {
      if (known.has(parent.id)) continue;
      known.add(parent.id);
      next.push(parent.id);
      // The parent is crossed by every traced core behind the child.
      for (const [coreId, splitters] of Object.entries(byCoreId)) {
        if (splitters.some((s) => s.id === parent.child_id)) add(coreId, parent);
      }
    }
    frontier = next;
  }

  return byCoreId;
}

/**
 * Build the full loss budget for the fiber path starting at `startCoreId`:
 * trace the splice chain, merge in each cable's length + attenuation, find
 * the splitter crossings, then run the pure calculation against the project
 * budget. `olt_type` (optional) overrides the project's configured type for
 * this calculation only.
 */
async function buildLossBudget(startCoreId, { olt_type } = {}) {
  const hops = await traceFiber(startCoreId);

  // Merge cable loss data into the core hops.
  const cableIds = [...new Set(hops.filter((h) => h.cable_id).map((h) => h.cable_id))];
  const cables = cableIds.length
    ? await db('cables').whereIn('id', cableIds).select('id', 'length_m', 'attenuation_db_per_km')
    : [];
  const cableById = Object.fromEntries(cables.map((c) => [c.id, c]));
  const enrichedHops = hops.map((hop) =>
    hop.core_id
      ? {
          ...hop,
          length_m: cableById[hop.cable_id] ? cableById[hop.cable_id].length_m : null,
          attenuation_db_per_km: cableById[hop.cable_id]
            ? cableById[hop.cable_id].attenuation_db_per_km
            : null,
        }
      : hop,
  );

  // Splitter crossings + project budget settings.
  const coreIds = hops.filter((h) => h.core_id).map((h) => h.core_id);
  const splittersByCoreId = await splitterCrossingsByCoreId(coreIds);
  const settings = await getProjectSettings();
  const typeRequested =
    olt_type != null && OLT_BUDGETS_DB[olt_type] !== undefined ? olt_type : null;

  return calculateLossBudget(enrichedHops, {
    olt_type: typeRequested || settings.olt_type,
    budget_db: settings.budget_db,
    safety_margin_db: settings.safety_margin_db,
    splittersByCoreId,
  });
}

module.exports = { getProjectSettings, splitterCrossingsByCoreId, buildLossBudget };
