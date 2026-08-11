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

    if (!enclosure_id || !core_a_id || !core_b_id) {
      await trx.rollback();
      return res.status(400).json({ error: 'enclosure_id, core_a_id, core_b_id are required' });
    }
    if (core_a_id === core_b_id) {
      await trx.rollback();
      return res.status(400).json({ error: 'A core cannot be spliced to itself' });
    }

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
        tray_number, tray_position, loss_db, technician,
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

    // If changing cores, validate and update
    let newCoreAId = splice.core_a_id;
    let newCoreBId = splice.core_b_id;

    if (req.body.core_a_id && req.body.core_a_id !== splice.core_a_id) {
      const newCoreA = await trx('fiber_cores').where({ id: req.body.core_a_id }).forUpdate().first();
      if (!newCoreA) {
        await trx.rollback();
        return res.status(404).json({ error: 'New core_a not found' });
      }
      if (!['available', 'reserved'].includes(newCoreA.status)) {
        await trx.rollback();
        return res.status(409).json({ error: 'New core_a is not available', status: newCoreA.status });
      }
      newCoreAId = req.body.core_a_id;
    }

    if (req.body.core_b_id && req.body.core_b_id !== splice.core_b_id) {
      const newCoreB = await trx('fiber_cores').where({ id: req.body.core_b_id }).forUpdate().first();
      if (!newCoreB) {
        await trx.rollback();
        return res.status(404).json({ error: 'New core_b not found' });
      }
      if (!['available', 'reserved'].includes(newCoreB.status)) {
        await trx.rollback();
        return res.status(409).json({ error: 'New core_b is not available', status: newCoreB.status });
      }
      newCoreBId = req.body.core_b_id;
    }

    // If cores changed, update statuses
    if (newCoreAId !== splice.core_a_id || newCoreBId !== splice.core_b_id) {
      // Return old cores to available
      await trx('fiber_cores').whereIn('id', [splice.core_a_id, splice.core_b_id]).update({
        status: 'available',
        updated_at: trx.fn.now(),
      });

      // Mark new cores as spliced
      await trx('fiber_cores').whereIn('id', [newCoreAId, newCoreBId]).update({
        status: 'spliced',
        updated_at: trx.fn.now(),
      });

      updates.core_a_id = newCoreAId;
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
// Find and delete the splice involving this core, returning only the OUT core to available
// For chaining: the IN core may still be spliced to another core
// ---------------------------------------------------------------------------
router.delete('/by-core/:coreId', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const splice = await trx('splices')
      .where('core_a_id', req.params.coreId)
      .orWhere('core_b_id', req.params.coreId)
      .first();
    
    if (!splice) {
      await trx.rollback();
      return res.status(404).json({ error: 'No splice found for this core' });
    }

    // Check if core_a (IN) has other splices
    const otherSplicesForCoreA = await trx('splices')
      .where('core_a_id', splice.core_a_id)
      .orWhere('core_b_id', splice.core_a_id)
      .whereNot('id', splice.id)
      .count('id as count')
      .first();
    
    // Only return core_a to available if it has no other splices
    if (otherSplicesForCoreA.count === 0) {
      await trx('fiber_cores')
        .where({ id: splice.core_a_id })
        .update({ status: 'available', updated_at: trx.fn.now() });
    }
    
    // Always return core_b (OUT) to available
    await trx('fiber_cores')
      .where({ id: splice.core_b_id })
      .update({ status: 'available', updated_at: trx.fn.now() });
    
    await trx('splices').where({ id: splice.id }).del();
    await trx.commit();
    
    res.json({ message: 'Splice removed', splice_id: splice.id });
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// DELETE /api/splices/:id — un-splice, returning only the OUT core to 'available'
// For chaining: the IN core may still be spliced to another core, so we only
// return the OUT core to available. We check if the IN core has other splices.
router.delete('/:id', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const splice = await trx('splices').where({ id: req.params.id }).first();
    if (!splice) {
      await trx.rollback();
      return res.status(404).json({ error: 'Splice not found' });
    }
    
    // Check if core_a (IN) has other splices
    const otherSplicesForCoreA = await trx('splices')
      .where('core_a_id', splice.core_a_id)
      .orWhere('core_b_id', splice.core_a_id)
      .whereNot('id', splice.id)
      .count('id as count')
      .first();
    
    // Only return core_a to available if it has no other splices
    if (otherSplicesForCoreA.count === 0) {
      await trx('fiber_cores')
        .where({ id: splice.core_a_id })
        .update({ status: 'available', updated_at: trx.fn.now() });
    }
    
    // Always return core_b (OUT) to available
    await trx('fiber_cores')
      .where({ id: splice.core_b_id })
      .update({ status: 'available', updated_at: trx.fn.now() });
    
    await trx('splices').where({ id: req.params.id }).del();
    await trx.commit();
    res.status(204).send();
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

module.exports = router;
