const express = require('express');
const db = require('../db');
const { validateSpliceData } = require('../middleware/validation');
const router = express.Router();

// GET /api/splices/:id
router.get('/:id', async (req, res, next) => {
  try {
    const splice = await db('splices').where({ id: req.params.id }).first();
    if (!splice) return res.status(404).json({ error: 'Splice not found' });
    res.json(splice);
  } catch (err) {
    next(err);
  }
});

/**
 * Count splices involving `coreId`, excluding `excludeSpliceId`.
 *
 * NOTE: the OR must be wrapped in a nested where — otherwise SQL operator
 * precedence turns `a = ? OR b = ? AND id != ?` into `a = ? OR (b = ? AND ... )`
 * and the splice being deleted/changed matches itself via core_a_id, making the
 * count permanently ≥ 1.
 *
 * NOTE: pg returns COUNT as a *string*, so always parseInt before comparing —
 * `count === 0` is never true against '0'.
 */
async function countOtherSplices(trx, coreId, excludeSpliceId) {
  const { count } = await trx('splices')
    .where(function () {
      this.where('core_a_id', coreId).orWhere('core_b_id', coreId);
    })
    .whereNot('id', excludeSpliceId)
    .count('id as count')
    .first();
  return parseInt(count, 10);
}

/**
 * Return a core to 'available' — but only when nothing else still references
 * it: no other splice (chained cores appear in several splices) and no splitter
 * (as input) or splitter port (as output). Releasing a core that is still wired
 * elsewhere would corrupt capacity counts and double-assign physical fiber.
 */
async function releaseCoreIfOrphaned(trx, coreId, excludeSpliceId) {
  const others = await countOtherSplices(trx, coreId, excludeSpliceId);
  if (others > 0) return false;

  const [splitterUse] = await trx('splitters').where({ input_core_id: coreId }).count('id as count');
  if (parseInt(splitterUse.count, 10) > 0) return false;

  const [portUse] = await trx('splitter_ports').where({ output_core_id: coreId }).count('id as count');
  if (parseInt(portUse.count, 10) > 0) return false;

  await trx('fiber_cores')
    .where({ id: coreId })
    .update({ status: 'available', updated_at: trx.fn.now() });
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/splices
// Joins core_a to core_b inside an enclosure. Both cores must currently be
// 'available' (or 'reserved'). On success both flip to 'spliced'.
// ---------------------------------------------------------------------------
router.post('/', validateSpliceData, async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const {
      enclosure_id, core_a_id, core_b_id,
      splice_type, tray_number, tray_position,
      loss_db, technician, splice_date, notes,
    } = req.body;

    const cores = await trx('fiber_cores').whereIn('id', [core_a_id, core_b_id]).forUpdate();
    if (cores.length !== 2) {
      await trx.rollback();
      return res.status(404).json({ error: 'One or both cores not found' });
    }

    // For chaining: allow spliced core to be spliced to available core
    // This enables further branching of fibers
    const coreA = cores.find((c) => c.id === core_a_id);
    const coreB = cores.find((c) => c.id === core_b_id);

    // Validate: coreA (IN) can be available, reserved, or spliced; coreB (OUT) must be available or reserved
    const canSplice = (coreA.status === 'available' || coreA.status === 'reserved' || coreA.status === 'spliced') &&
                     (coreB.status === 'available' || coreB.status === 'reserved');

    if (!canSplice) {
      await trx.rollback();
      return res.status(409).json({
        error: 'One or both cores are not available to splice',
        cores: cores.map((c) => ({ id: c.id, status: c.status })),
      });
    }

    // If coreA is spliced, we allow chaining - the original splice remains intact
    // This allows branching: one fiber can be spliced to multiple downstream fibers
    // The spliced core stays spliced, and we create a new splice record for the branch

    // Only update coreB to spliced (coreA is already spliced if it was spliced)
    const coresToUpdate = coreA.status === 'spliced' ? [core_b_id] : [core_a_id, core_b_id];

    const [splice] = await trx('splices')
      .insert({
        enclosure_id, core_a_id, core_b_id, splice_type: splice_type || 'fusion',
        tray_number, tray_position, loss_db: loss_db === '' ? null : loss_db, technician,
        splice_date: splice_date || new Date(), notes,
      })
      .returning('*');

    await trx('fiber_cores').whereIn('id', coresToUpdate).update({ status: 'spliced', updated_at: trx.fn.now() });

    await trx.commit();
    res.status(201).json(splice);
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/splices/:id — edit splice details or re-splice with different cores
// Can update metadata (loss_db, splice_type, notes) AND/OR change core_a_id/core_b_id
// to splice with different available fibers.
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const splice = await trx('splices').where({ id: req.params.id }).forUpdate().first();
    if (!splice) {
      await trx.rollback();
      return res.status(404).json({ error: 'Splice not found' });
    }

    const allowed = ['splice_type', 'tray_number', 'tray_position', 'loss_db', 'technician', 'splice_date', 'notes'];
    const updates = { updated_at: trx.fn.now() };
    for (const f of allowed) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    // The edit form submits loss_db as '' when blank — Postgres rejects an empty
    // string for a numeric column (500). Normalize to null.
    if (updates.loss_db === '') updates.loss_db = null;
    if (updates.notes !== undefined && updates.notes !== null && typeof updates.notes !== 'string') {
      await trx.rollback();
      return res.status(400).json({ error: "notes must be a string" });
    }
    if (updates.splice_date === '') updates.splice_date = null;
    if (updates.tray_number === '') updates.tray_number = null;
    if (updates.tray_position === '') updates.tray_position = null;
    if (updates.technician === '') updates.technician = null;
    if (updates.splice_type !== undefined && !['fusion', 'mechanical'].includes(updates.splice_type)) {
      await trx.rollback();
      return res.status(400).json({ error: "splice_type must be 'fusion' or 'mechanical'" });
    }

    const coreAChanged = req.body.core_a_id !== undefined && req.body.core_a_id !== splice.core_a_id;
    const coreBChanged = req.body.core_b_id !== undefined && req.body.core_b_id !== splice.core_b_id;

    // If changing cores, validate and update
    let newCoreAId = splice.core_a_id;
    let newCoreBId = splice.core_b_id;

    if (coreAChanged) {
      const newCoreA = await trx('fiber_cores').where({ id: req.body.core_a_id }).forUpdate().first();
      if (!newCoreA) {
        await trx.rollback();
        return res.status(404).json({ error: 'New core_a not found' });
      }
      if (req.body.core_a_id === newCoreBId) {
        await trx.rollback();
        return res.status(400).json({ error: 'A core cannot be spliced to itself' });
      }
      if (!['available', 'reserved'].includes(newCoreA.status)) {
        await trx.rollback();
        return res.status(409).json({ error: 'New core_a is not available', status: newCoreA.status });
      }
      newCoreAId = req.body.core_a_id;
    }

    if (coreBChanged) {
      const newCoreB = await trx('fiber_cores').where({ id: req.body.core_b_id }).forUpdate().first();
      if (!newCoreB) {
        await trx.rollback();
        return res.status(404).json({ error: 'New core_b not found' });
      }
      if (req.body.core_b_id === newCoreAId) {
        await trx.rollback();
        return res.status(400).json({ error: 'A core cannot be spliced to itself' });
      }
      if (!['available', 'reserved'].includes(newCoreB.status)) {
        await trx.rollback();
        return res.status(409).json({ error: 'New core_b is not available', status: newCoreB.status });
      }
      newCoreBId = req.body.core_b_id;
    }

    // Only touch the sides that actually changed. Freeing an unchanged core and
    // re-marking it 'spliced' is a no-op; but freeing a CHANGED core must be
    // conditional — it may be chained into other splices.
    if (coreAChanged) {
      await releaseCoreIfOrphaned(trx, splice.core_a_id, splice.id);
      await trx('fiber_cores').where({ id: newCoreAId }).update({ status: 'spliced', updated_at: trx.fn.now() });
      updates.core_a_id = newCoreAId;
    }
    if (coreBChanged) {
      await releaseCoreIfOrphaned(trx, splice.core_b_id, splice.id);
      await trx('fiber_cores').where({ id: newCoreBId }).update({ status: 'spliced', updated_at: trx.fn.now() });
      updates.core_b_id = newCoreBId;
    }

    if (Object.keys(updates).length <= 1) {
      await trx.rollback();
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const [updated] = await trx('splices').where({ id: req.params.id }).update(updates).returning('*');
    await trx.commit();
    res.json(updated);
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/splices/by-core/:coreId
// Find and delete the splice involving this core. Cores are only returned to
// 'available' when no other splice still references them (chains survive).
// ---------------------------------------------------------------------------
router.delete('/by-core/:coreId', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const splice = await trx('splices')
      .where(function () {
        this.where('core_a_id', req.params.coreId).orWhere('core_b_id', req.params.coreId);
      })
      .orderBy([{ column: 'splice_date' }, { column: 'created_at' }])
      .first();

    if (!splice) {
      await trx.rollback();
      return res.status(404).json({ error: 'No splice found for this core' });
    }

    await releaseCoreIfOrphaned(trx, splice.core_a_id, splice.id);
    await releaseCoreIfOrphaned(trx, splice.core_b_id, splice.id);
    await trx('splices').where({ id: splice.id }).del();
    await trx.commit();

    res.json({ message: 'Splice removed', splice_id: splice.id });
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// DELETE /api/splices/:id — un-splice. Cores are only returned to
// 'available' when no other splice still references them (chains survive).
router.delete('/:id', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const splice = await trx('splices').where({ id: req.params.id }).first();
    if (!splice) {
      await trx.rollback();
      return res.status(404).json({ error: 'Splice not found' });
    }

    await releaseCoreIfOrphaned(trx, splice.core_a_id, splice.id);
    await releaseCoreIfOrphaned(trx, splice.core_b_id, splice.id);
    await trx('splices').where({ id: req.params.id }).del();
    await trx.commit();
    res.status(204).send();
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

module.exports = router;
