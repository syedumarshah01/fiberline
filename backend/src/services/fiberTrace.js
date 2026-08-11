const db = require('../db');

/**
 * Given a starting fiber_core id, walk the chain of splices outward until it
 * dead-ends (an unspliced/terminated core = the physical end of the fiber path).
 * Returns an ordered list of "hops", each describing the cable/core segment and
 * the splice (if any) that connects it to the next.
 *
 * Splices are undirected edges between cores. Because splice chaining allows a
 * core to take part in several splices (branching), we do a deterministic
 * depth-first traversal from the start core: deterministic splice ordering
 * (splice_date, created_at, id) and every reachable splice is followed, so a
 * trace started mid-chain still documents both directions — previously only one
 * arbitrary branch was returned because the backward walk was never invoked and
 * `.first()` picked an unordered row.
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

  // All splices touching a core, ordered deterministically so repeated traces
  // always walk the same path.
  async function splicesFor(coreId) {
    return db('splices')
      .where(function () {
        this.where('core_a_id', coreId).orWhere('core_b_id', coreId);
      })
      .orderBy([
        { column: 'splice_date', order: 'asc' },
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
  }

  // Iterative DFS over the splice graph. The explicit stack keeps splice-marker
  // hops adjacent to the core they connect, matching the original output shape.
  const stack = [{ coreId: startCoreId, via: null }];
  // Safety cap so a data error (accidental splice loop) can't hang the request.
  let steps = 0;
  const MAX_STEPS = 500;

  while (stack.length && steps < MAX_STEPS) {
    const { coreId, via } = stack.pop();
    steps++;

    const core = await loadCoreWithCable(coreId);
    if (!core) continue;

    if (via) {
      segments.push({
        splice_id: via.id,
        enclosure_id: via.enclosure_id,
        splice_type: via.splice_type,
      });
    }
    segments.push(core);

    const candidates = (await splicesFor(coreId)).filter(
      (s) => !visitedSpliceIds.has(s.id),
    );
    for (const splice of candidates) {
      visitedSpliceIds.add(splice.id);
    }
    // Push in reverse so the earliest splice is explored first (stable order).
    for (const splice of [...candidates].reverse()) {
      const nextCoreId = splice.core_a_id === coreId ? splice.core_b_id : splice.core_a_id;
      stack.push({ coreId: nextCoreId, via: splice });
    }
  }

  return segments;
}

module.exports = { traceFiber };
