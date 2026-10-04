const express = require('express');
const db = require('../db');
const { traceFiber } = require('../services/fiberTrace');
const { buildLossBudget } = require('../services/lossBudget');
const { OLT_BUDGETS_DB } = require('../utils/lossBudget');
const { validateFiberCoreData } = require('../middleware/validation');
const {
  assertBoxRevision,
  expectedRevision,
  getBoxRevision,
} = require('../services/boxRevision');
const { snapshotBox, recordAsBuiltChange } = require('../services/asBuiltApproval');
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
  const revision = expectedRevision(req);
  const trx = await db.transaction();
  try {
    const { status, notes } = req.body;
    const allowed = ['available', 'spliced', 'terminated', 'reserved', 'damaged'];
    if (status && !allowed.includes(status)) {
      await trx.rollback();
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }

    // Read first to discover the cable endpoints, then acquire locks in the
    // same enclosure-first order used by splice/splitter mutations. This avoids
    // a deadlock between a direct core edit and a box edit.
    const core = await trx('fiber_cores').where({ id: req.params.id }).first();
    if (!core) {
      await trx.rollback();
      return res.status(404).json({ error: 'Core not found' });
    }
    const cable = await trx('cables')
      .where({ id: core.cable_id })
      .select('from_enclosure_id', 'to_enclosure_id')
      .first();
    const enclosureIds = [...new Set([
      cable?.from_enclosure_id,
      cable?.to_enclosure_id,
    ].filter(Boolean))].sort();
    const requestedEnclosure = req.body.enclosure_id || req.query.enclosure_id || req.get('x-box-id');
    let targetEnclosure = requestedEnclosure;

    if (targetEnclosure && !enclosureIds.includes(targetEnclosure)) {
      await trx.rollback();
      return res.status(400).json({ error: 'enclosure_id must be an endpoint of the core cable' });
    }
    if (enclosureIds.length) {
      await trx('enclosures').whereIn('id', enclosureIds).orderBy('id').forUpdate();
    }
    if (!targetEnclosure && enclosureIds.length > 1 && revision) {
      // A revision returned by either endpoint is enough to identify the box
      // the direct core edit came from. This keeps the API convenient for a
      // client that only has the documentation token.
      const matches = [];
      for (const enclosureId of enclosureIds) {
        const current = await getBoxRevision(enclosureId, trx);
        if (current?.revision === revision) matches.push(enclosureId);
      }
      targetEnclosure = matches[0] || enclosureIds[0];
    }
    if (!targetEnclosure && enclosureIds.length) targetEnclosure = enclosureIds[0];
    const lockedCore = await trx('fiber_cores').where({ id: req.params.id }).forUpdate().first();
    if (!lockedCore) {
      await trx.rollback();
      return res.status(404).json({ error: 'Core not found' });
    }

    if (targetEnclosure && revision) {
      await assertBoxRevision({ req, enclosureId: targetEnclosure, executor: trx });
    }
    const beforeSnapshot = targetEnclosure
      ? await snapshotBox(targetEnclosure, trx)
      : null;

    const updates = { updated_at: trx.fn.now() };
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    await trx('fiber_cores').where({ id: req.params.id }).update(updates);

    const current = targetEnclosure ? await getBoxRevision(targetEnclosure, trx) : null;
    let approval = null;
    if (targetEnclosure && beforeSnapshot) {
      approval = await recordAsBuiltChange(trx, {
        req,
        enclosureId: targetEnclosure,
        changeType: 'fiber_core_update',
        summary: `Updated fiber core ${req.params.id}`,
        beforeSnapshot,
        afterRevision: current?.revision,
      });
    }
    await trx.commit();
    res.json({
      ok: true,
      ...(current ? { revision: current.revision } : {}),
      ...(approval ? { approval_id: approval.id } : {}),
    });
  } catch (err) {
    await trx.rollback();
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
