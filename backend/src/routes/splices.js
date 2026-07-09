const express = require('express');
const db = require('../db');
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
router.post('/', async (req, res, next) => {
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
    const busy = cores.filter((c) => !['available', 'reserved'].includes(c.status));
    if (busy.length) {
      await trx.rollback();
      return res.status(409).json({
        error: 'One or both cores are not available to splice',
        cores: busy.map((c) => ({ id: c.id, status: c.status })),
      });
    }

    const [splice] = await trx('splices')
      .insert({
        enclosure_id, core_a_id, core_b_id, splice_type: splice_type || 'fusion',
        tray_number, tray_position, loss_db, technician,
        splice_date: splice_date || new Date(), notes,
      })
      .returning('*');

    await trx('fiber_cores').whereIn('id', [core_a_id, core_b_id]).update({ status: 'spliced', updated_at: trx.fn.now() });

    await trx.commit();
    res.status(201).json(splice);
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// DELETE /api/splices/:id — un-splice, returning both cores to 'available'
router.delete('/:id', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const splice = await trx('splices').where({ id: req.params.id }).first();
    if (!splice) {
      await trx.rollback();
      return res.status(404).json({ error: 'Splice not found' });
    }
    await trx('fiber_cores')
      .whereIn('id', [splice.core_a_id, splice.core_b_id])
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
