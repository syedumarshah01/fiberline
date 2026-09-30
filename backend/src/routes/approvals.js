const express = require('express');
const db = require('../db');
const { getBoxRevision } = require('../services/boxRevision');
const {
  PENDING,
  APPROVED,
  REJECTED,
  requireAdmin,
  restoreBoxSnapshot,
  listApprovals,
} = require('../services/asBuiltApproval');

const router = express.Router();

function staleApprovalError(approval, current) {
  const error = new Error('This approval is stale because the box changed after the field submission');
  error.status = 409;
  error.code = 'APPROVAL_STALE';
  error.approval = {
    id: approval.id,
    expected_revision: approval.after_revision,
    current_revision: current?.revision || null,
    current: current?.parts || null,
  };
  return error;
}

// GET /api/approvals?status=pending&enclosure_id=…
router.get('/', async (req, res, next) => {
  try {
    const approvals = await listApprovals({
      enclosureId: req.query.enclosure_id,
      status: req.query.status || PENDING,
    });
    res.json(approvals);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const approval = await db('as_built_approvals').where({ id: req.params.id }).first();
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    res.json(approval);
  } catch (err) {
    next(err);
  }
});

// POST /api/approvals/:id/approve — admin reviewer only
router.post('/:id/approve', async (req, res, next) => {
  let reviewer;
  try {
    reviewer = requireAdmin(req);
  } catch (err) {
    return next(err);
  }
  const trx = await db.transaction();
  try {
    const approval = await trx('as_built_approvals').where({ id: req.params.id }).forUpdate().first();
    if (!approval) {
      await trx.rollback();
      return res.status(404).json({ error: 'Approval not found' });
    }
    if (approval.status !== PENDING) {
      await trx.rollback();
      return res.status(409).json({ error: `Approval is already ${approval.status}`, approval });
    }

    await trx('enclosures').where({ id: approval.enclosure_id }).forUpdate();
    const current = await getBoxRevision(approval.enclosure_id, trx);
    if (!current || current.revision !== approval.after_revision) {
      await trx.rollback();
      throw staleApprovalError(approval, current);
    }

    const [updated] = await trx('as_built_approvals')
      .where({ id: approval.id })
      .update({
        status: APPROVED,
        reviewed_by: reviewer.id,
        review_comment: req.body?.comment || null,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    await trx.commit();
    res.json(updated);
  } catch (err) {
    try { await trx.rollback(); } catch (_) { /* already rolled back */ }
    next(err);
  }
});

// POST /api/approvals/:id/reject — admin reviewer only; restores the prior box
router.post('/:id/reject', async (req, res, next) => {
  let reviewer;
  try {
    reviewer = requireAdmin(req);
  } catch (err) {
    return next(err);
  }
  const trx = await db.transaction();
  try {
    const approval = await trx('as_built_approvals').where({ id: req.params.id }).forUpdate().first();
    if (!approval) {
      await trx.rollback();
      return res.status(404).json({ error: 'Approval not found' });
    }
    if (approval.status !== PENDING) {
      await trx.rollback();
      return res.status(409).json({ error: `Approval is already ${approval.status}`, approval });
    }

    await trx('enclosures').where({ id: approval.enclosure_id }).forUpdate();
    const current = await getBoxRevision(approval.enclosure_id, trx);
    if (!current || current.revision !== approval.after_revision) {
      await trx.rollback();
      throw staleApprovalError(approval, current);
    }

    await restoreBoxSnapshot(approval.before_snapshot, trx);
    const restored = await getBoxRevision(approval.enclosure_id, trx);
    const [updated] = await trx('as_built_approvals')
      .where({ id: approval.id })
      .update({
        status: REJECTED,
        reviewed_by: reviewer.id,
        review_comment: req.body?.comment || null,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    await trx.commit();
    res.json({ ...updated, restored_revision: restored?.revision || null });
  } catch (err) {
    try { await trx.rollback(); } catch (_) { /* already rolled back */ }
    next(err);
  }
});

module.exports = router;
