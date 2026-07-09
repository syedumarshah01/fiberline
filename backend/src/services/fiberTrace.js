const db = require('../db');

/**
 * Given a starting fiber_core id, walk the chain of splices outward in both
 * directions until it dead-ends (an unspliced/terminated core = the physical
 * end of the fiber path). Returns an ordered list of "hops", each describing
 * the cable/core segment and the splice (if any) that connects it to the next.
 *
 * A core can appear in at most one splice (enforced at the application level
 * by the 'available'/'reserved' check before splicing), so the chain is a
 * simple linked list, not a branching tree.
 */
async function traceFiber(startCoreId) {
  const visitedSpliceIds = new Set();
  const segments = [];

  async function loadCoreWithCable(coreId) {
    return db('fiber_cores as fc')
      .join('cables as c', 'c.id', 'fc.cable_id')
      .where('fc.id', coreId)
      .select(
        'fc.id as core_id', 'fc.core_number', 'fc.status as core_status',
        'c.id as cable_id', 'c.code as cable_code', 'c.name as cable_name',
        'c.cable_type', 'c.from_enclosure_id', 'c.to_enclosure_id', 'c.customer_id', 'c.customer_label'
      )
      .first();
  }

  async function walk(coreId, direction) {
    const chain = [];
    let currentCoreId = coreId;

    // Safety cap so a data error (accidental splice loop) can't hang the request
    for (let i = 0; i < 200; i++) {
      const core = await loadCoreWithCable(currentCoreId);
      if (!core) break;
      chain.push(core);

      const splice = await db('splices')
        .where('core_a_id', currentCoreId)
        .orWhere('core_b_id', currentCoreId)
        .first();

      if (!splice || visitedSpliceIds.has(splice.id)) break;
      visitedSpliceIds.add(splice.id);

      const nextCoreId = splice.core_a_id === currentCoreId ? splice.core_b_id : splice.core_a_id;
      chain.push({ splice_id: splice.id, enclosure_id: splice.enclosure_id, splice_type: splice.splice_type });
      currentCoreId = nextCoreId;
    }
    return direction === 'backward' ? chain.reverse() : chain;
  }

  const forwardChain = await walk(startCoreId, 'forward');
  segments.push(...forwardChain);

  return segments;
}

module.exports = { traceFiber };
