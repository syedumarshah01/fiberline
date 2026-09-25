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
 *
 * A mid-span closure is not a splice record: inserting one splits a cable into
 * two rows and links them with `cables.continues_cable_id`, so the fiber plainly
 * continues across the box — core #n of the upstream half runs into core #n of
 * the downstream half. The walk follows that link too (both ways), which is what
 * keeps a trace from dead-ending inside an inserted closure.
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
        'c.cable_type', 'c.from_enclosure_id', 'c.to_enclosure_id', 'c.customer_id', 'c.customer_label',
        // Mid-span splits: the downstream half of this cable, if any.
        'c.continues_cable_id',
        // Loss-budget inputs: the cable's length and per-km attenuation (NULL
        // attenuation → project default at calculation time).
        'c.length_m', 'c.attenuation_db_per_km'
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

  /** The downstream half of a cable, if a closure was inserted mid-span. */
  async function childCableOf(cableId) {
    return db('cables').where({ continues_cable_id: cableId }).first();
  }

  /** The core with this number on that cable — how the two halves pair up. */
  async function coreOnCable(cableId, coreNumber) {
    return db('fiber_cores').where({ cable_id: cableId, core_number: coreNumber }).first();
  }

  /** Only a lit (spliced) or terminated strand carries the path onward. */
  const inService = (core) => !!core && ['spliced', 'terminated'].includes(core.core_status ?? core.status);

  /**
   * The core the fiber continues into across a mid-span closure, in either
   * direction, with the hop that describes the step. Returns null when there is
   * no split, when the paired core is not in service, or when this step would
   * bounce straight back to the core we arrived from.
   */
  async function continuationStep(core, cameFromCoreId, taken) {
    if (!core.cable_id || !inService(core)) return null;
    const candidates = [];

    const child = await childCableOf(core.cable_id); // downstream half
    if (child) {
      candidates.push({
        cableId: child.id,
        cableCode: child.code,
        boxId: child.from_enclosure_id,
      });
    }
    if (core.continues_cable_id) {
      // upstream half — the closure is at the start of *this* cable
      candidates.push({
        cableId: core.continues_cable_id,
        cableCode: null,
        boxId: core.from_enclosure_id,
      });
    }

    for (const candidate of candidates) {
      const next = await coreOnCable(candidate.cableId, core.core_number);
      if (!next || !inService(next)) continue;
      const nextCoreId = next.core_id ?? next.id ?? null;
      if (!nextCoreId || nextCoreId === cameFromCoreId || nextCoreId === core.core_id) continue;
      const stepKey = `${core.core_id}->${nextCoreId}`;
      if (taken.has(stepKey)) continue;
      taken.add(stepKey);
      return {
        nextCoreId,
        cableId: candidate.cableId,
        cableCode: candidate.cableCode,
        boxId: candidate.boxId,
      };
    }
    return null;
  }

  // Iterative DFS over the splice graph. The explicit stack keeps splice-marker
  // hops adjacent to the core they connect to, matching the original output
  // shape.
  const stack = [{ coreId: startCoreId, via: null, from: null }];
  const takenContinuations = new Set();
  // Safety cap so a data error (accidental splice loop) can't hang the request.
  let steps = 0;
  const MAX_STEPS = 500;

  while (stack.length && steps < MAX_STEPS) {
    const { coreId, via, from } = stack.pop();
    steps++;

    const core = await loadCoreWithCable(coreId);
    if (!core) continue;

    if (via) {
      const isContinuation = via.splice_type === 'continuation';
      segments.push({
        splice_id: via.id ?? via.splice_id ?? null,
        enclosure_id: via.enclosure_id,
        splice_type: via.splice_type,
        // Measured splice loss (OTDR/power meter), if recorded — the loss
        // budget falls back to a planning default when this is null.
        loss_db: via.loss_db,
        // `type: 'splice'` is what the budget keys off; a continuation has no
        // splice row but is still a joint the light crosses (a fusion splice
        // inside the inserted closure), so it must not vanish from the budget.
        ...(isContinuation
          ? {
              type: 'splice',
              continues_from_cable_id: via.continues_from_cable_id ?? null,
              continues_to_cable_id: via.continues_to_cable_id ?? null,
              continues_to_cable_code: via.continues_to_cable_code ?? null,
            }
          : {}),
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
      stack.push({ coreId: nextCoreId, via: splice, from: coreId });
    }

    // …and the mid-span continuation, which is a step along the same fiber
    // rather than a splice in the joint table.
    const continuation = await continuationStep(core, from, takenContinuations);
    if (continuation) {
      stack.push({
        coreId: continuation.nextCoreId,
        from: coreId,
        via: {
          splice_id: null,
          enclosure_id: continuation.boxId ?? null,
          splice_type: 'continuation',
          loss_db: null,
          continues_from_cable_id: core.cable_id,
          continues_to_cable_id: continuation.cableId ?? null,
          continues_to_cable_code: continuation.cableCode ?? null,
        },
      });
    }
  }

  return segments;
}

module.exports = { traceFiber };
