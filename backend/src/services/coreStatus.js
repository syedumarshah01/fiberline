const PROTECTED_STATUSES = new Set(['reserved', 'damaged', 'unknown']);

async function referenceCounts(executor, coreId, { excludeSpliceId = null } = {}) {
  const spliceQuery = executor('splices').where(function () {
    this.where('core_a_id', coreId).orWhere('core_b_id', coreId);
  });
  if (excludeSpliceId) spliceQuery.whereNot('id', excludeSpliceId);
  const [splices, terminations, splitterInputs, splitterPorts] = await Promise.all([
    spliceQuery.count('id as count').first(),
    executor('terminations').where({ core_id: coreId }).count('id as count').first(),
    executor('splitters').where({ input_core_id: coreId }).count('id as count').first(),
    executor('splitter_ports').where({ output_core_id: coreId }).count('id as count').first(),
  ]);
  return {
    splices: Number(splices?.count || 0),
    terminations: Number(terminations?.count || 0),
    splitter_inputs: Number(splitterInputs?.count || 0),
    splitter_ports: Number(splitterPorts?.count || 0),
  };
}

/**
 * Reconcile a core after a splice/port/splitter is removed. Protected states
 * are never silently unreserved, repaired, or promoted; connected ordinary
 * cores remain in_use and truly unreferenced ones become spare.
 */
async function isSpareCoreEligible(executor, core) {
  if (!core || core.status !== 'spare') return false;
  const refs = await referenceCounts(executor, core.id);
  return Object.values(refs).every((count) => count === 0);
}

async function refreshCoreStatus(executor, coreId, { excludeSpliceId = null } = {}) {
  const core = await executor('fiber_cores').where({ id: coreId }).first();
  if (!core) return null;
  if (PROTECTED_STATUSES.has(core.status)) return core.status;
  const refs = await referenceCounts(executor, coreId, { excludeSpliceId });
  const hasConnections = Object.values(refs).some((count) => count > 0);
  const status = hasConnections ? 'in_use' : 'spare';
  await executor('fiber_cores').where({ id: coreId }).update({
    status,
    updated_at: executor.fn.now(),
  });
  return status;
}

module.exports = { PROTECTED_STATUSES, referenceCounts, isSpareCoreEligible, refreshCoreStatus };
