const express = require('express');
const db = require('../db');
const { traceFiber } = require('../services/fiberTrace');
const { buildLossBudget } = require('../services/lossBudget');
const { OLT_BUDGETS_DB } = require('../utils/lossBudget');
const { validateFiberCoreData } = require('../middleware/validation');
const router = express.Router();

// GET /api/fiber-cores/:id
router.get('/:id', async (req, res, next) => {
  try {
    const core = await db('fiber_cores').where({ id: req.params.id }).first();
    if (!core) return res.status(404).json({ error: 'Core not found' });
    res.json(core);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/fiber-cores/:id — e.g. mark 'terminated', 'damaged', 'reserved'
router.patch('/:id', validateFiberCoreData, async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const allowed = ['available', 'spliced', 'terminated', 'reserved', 'damaged'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    const updates = { updated_at: db.fn.now() };
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    await db('fiber_cores').where({ id: req.params.id }).update(updates);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/fiber-cores/:id/trace
// Requirement #6: "each main fiber completely documented of where it goes."
// Walks the splice chain from this core to its physical endpoints.
// ---------------------------------------------------------------------------
router.get('/:id/trace', async (req, res, next) => {
  try {
    const core = await db('fiber_cores').where({ id: req.params.id }).first();
    if (!core) return res.status(404).json({ error: 'Core not found' });

    const path = await traceFiber(req.params.id);
    res.json({ start_core_id: req.params.id, hops: path });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/fiber-cores/:id/loss-budget
// The trace (above) plus accumulated optical loss: fiber attenuation per
// cable crossed, every splice (measured dB or the planning default), every
// splitter crossing (incl. cascade parents), compared against the project's
// OLT budget. Optional ?olt_type=gpon|xgs_pon|p2p overrides the project
// setting for this calculation only.
// ---------------------------------------------------------------------------
router.get('/:id/loss-budget', async (req, res, next) => {
  try {
    const core = await db('fiber_cores').where({ id: req.params.id }).first();
    if (!core) return res.status(404).json({ error: 'Core not found' });

    const oltType = req.query.olt_type;
    if (oltType != null && OLT_BUDGETS_DB[oltType] === undefined) {
      return res.status(400).json({
        error: `olt_type must be one of ${Object.keys(OLT_BUDGETS_DB).join(', ')}`,
      });
    }

    const budget = await buildLossBudget(req.params.id, { olt_type: oltType });
    res.json({ start_core_id: req.params.id, ...budget });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
