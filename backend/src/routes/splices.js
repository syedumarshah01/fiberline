const express = require('express');
const db = require('../db');
const { validateSpliceData } = require('../middleware/validation');
const { canBranchFromCore } = require('../utils/branching');
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
// Joins core_a to core_b inside an enclosure. The OUT core must be available
// (or reserved); the IN core may also already be spliced when it is arriving
// from upstream, because that is a valid branching point. Both remain spliced.
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
    const coreCables = await trx('cables')
      .whereIn('id', cores.map((core) => core.cable_id))
      .select('id', 'from_enclosure_id', 'to_enclosure_id');
    const cableById = new Map(coreCables.map((cable) => [cable.id, cable]));
    const coreACable = cableById.get(coreA.cable_id);
    const existingBranch = await trx('splices')
      .where({ enclosure_id })
      .where(function () {
        this.where('core_a_id', coreA.id).orWhere('core_b_id', coreA.id);
      })
      .first();
    const existingSplitter = await trx('splitters')
      .where({ enclosure_id, input_core_id: coreA.id })
      .first();

    // An already-spliced IN fibre is a valid branch source once at this
    // enclosure. It cannot be selected again after a splice or splitter in this
    // same enclosure has already used it as a branch point.
    if (
      !canBranchFromCore(coreA, {
        cable: coreACable,
        enclosureId: enclosure_id,
        alreadyBranched: Boolean(existingBranch || existingSplitter),
      }) ||
      !['available', 'reserved'].includes(coreB.status)
    ) {
      await trx.rollback();
      return res.status(409).json({
        error: existingBranch || existingSplitter
          ? 'This IN core has already been branched in this enclosure'
          : coreA.status === 'spliced' && coreACable?.to_enclosure_id !== enclosure_id
            ? 'Only a spliced IN core coming from upstream can be used for branching'
            : 'One or both cores are not available to splice',
        cores: cores.map((c) => ({ id: c.id, status: c.status })),
      });
    }

    // Measured loss is numeric-or-null; anything else gets a clean 400 instead
    // of a Postgres error (the form submits '' for "no reading yet").
    if (loss_db !== undefined && loss_db !== null && loss_db !== '') {
      const lossValue = Number(loss_db);
      if (Number.isNaN(lossValue) || lossValue < 0) {
        await trx.rollback();
        return res.status(400).json({ error: 'loss_db must be a non-negative number' });
      }
    }

    const coresToUpdate = [core_a_id, core_b_id];

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
    // string for a numeric column (500). Normalize to null, and reject anything
    // else non-numeric (e.g. "lots") with a clean 400 instead of a 23505-style
    // crash from the database.
    if (updates.loss_db === '') updates.loss_db = null;
    if (updates.loss_db !== undefined && updates.loss_db !== null) {
      const n = Number(updates.loss_db);
      if (Number.isNaN(n) || n < 0) {
        await trx.rollback();
        return res.status(400).json({ error: 'loss_db must be a non-negative number' });
      }
    }
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
