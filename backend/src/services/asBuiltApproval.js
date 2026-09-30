const db = require('../db');
const { getBoxRevision, makeBoxRevision } = require('./boxRevision');

const PENDING = 'pending';
const APPROVED = 'approved';
const REJECTED = 'rejected';

function actorFromRequest(req) {
  return {
    id: req.user?.id || req.get?.('x-user-id') || 'field-tech',
    role: String(req.user?.role || req.get?.('x-user-role') || 'technician').toLowerCase(),
  };
}

function requireAdmin(req) {
  const actor = actorFromRequest(req);
  if (actor.role !== 'admin') {
    const error = new Error('An admin reviewer is required for this action');
    error.status = 403;
    error.code = 'APPROVAL_ADMIN_REQUIRED';
    throw error;
  }
  return actor;
}

/**
 * Snapshot only the records that make up a box's as-built documentation. The
 * snapshot is deliberately database-shaped so a rejected change can be
 * restored without trying to reconstruct a splice/splitter operation from UI
 * intent.
 */
async function snapshotBox(enclosureId, executor = db) {
  const enclosure = await executor('enclosures')
    .where({ id: enclosureId })
    .select('id', 'code', 'name', 'pole_id', 'type', 'capacity', 'status', 'mounting', 'notes', 'created_at', 'updated_at')
    .first();
  if (!enclosure) return null;

  const cables = await executor('cables')
    .where({ from_enclosure_id: enclosureId })
    .orWhere({ to_enclosure_id: enclosureId })
    .select('id', 'updated_at');
  const cableIds = cables.map((row) => row.id);
  const cores = cableIds.length
    ? await executor('fiber_cores').whereIn('cable_id', cableIds).select('*')
    : [];
  const splices = await executor('splices').where({ enclosure_id: enclosureId }).select('*');
  const splitters = await executor('splitters').where({ enclosure_id: enclosureId }).select('*');
  const splitterIds = splitters.map((row) => row.id);
  const ports = splitterIds.length
    ? await executor('splitter_ports').whereIn('splitter_id', splitterIds).select('*')
    : [];

  return { enclosure, cables, cores, splices, splitters, ports };
}

function revisionForSnapshot(snapshot) {
  if (!snapshot) return null;
  return makeBoxRevision(snapshot);
}

/** Record the already-applied change as pending reviewer work. */
async function recordAsBuiltChange(trx, {
  req,
  enclosureId,
  changeType,
  summary,
  beforeSnapshot,
  afterSnapshot = null,
  afterRevision = null,
}) {
  if (!enclosureId || !beforeSnapshot) return null;
  const actor = actorFromRequest(req);
  const submittedSnapshot = afterSnapshot || await snapshotBox(enclosureId, trx);
  const current = afterRevision
    ? { revision: afterRevision }
    : { revision: revisionForSnapshot(submittedSnapshot) };

  // Keep one review item per box while a technician continues documenting it.
  // Its original before_snapshot remains the rollback point, while the latest
  // live revision becomes the thing the admin approves or rejects. This avoids
  // creating a chain of stale review cards for three edits made before lunch.
  const existing = await trx('as_built_approvals')
    .where({ enclosure_id: enclosureId, status: PENDING })
    .orderBy('created_at')
    .forUpdate()
    .first();
  if (existing) {
    const [updated] = await trx('as_built_approvals')
      .where({ id: existing.id })
      .update({
        change_type: existing.change_type === changeType ? changeType : 'as_built_batch',
        summary: existing.summary === summary ? summary : `${existing.summary}; ${summary}`,
        submitted_by: actor.id,
        submitted_role: actor.role,
        submitted_snapshot: submittedSnapshot,
        after_revision: current.revision,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    return updated;
  }

  const [approval] = await trx('as_built_approvals')
    .insert({
      enclosure_id: enclosureId,
      change_type: changeType,
      summary,
      submitted_by: actor.id,
      submitted_role: actor.role,
      status: PENDING,
      before_snapshot: beforeSnapshot,
      submitted_snapshot: submittedSnapshot,
      before_revision: revisionForSnapshot(beforeSnapshot),
      after_revision: current.revision,
    })
    .returning('*');
  return approval;
}

/**
 * Restore a snapshot after the reviewer rejects it. The caller must already
 * have verified that the box still has the approval's after_revision; otherwise
 * this would erase a later technician's work.
 */
async function restoreBoxSnapshot(snapshot, executor = db) {
  if (!snapshot?.enclosure?.id) throw new Error('Approval snapshot is incomplete');
  const enclosureId = snapshot.enclosure.id;
  const { id, ...enclosureUpdates } = snapshot.enclosure;
  await executor('enclosures').where({ id }).update(enclosureUpdates);

  // Remove current relationships first, then recreate the exact pre-change
  // rows. This handles creates, edits, deletes, port assignments, and core
  // status changes with one inverse path.
  await executor('splices').where({ enclosure_id: enclosureId }).del();
  const currentSplitters = await executor('splitters').where({ enclosure_id: enclosureId }).select('id');
  const currentSplitterIds = currentSplitters.map((row) => row.id);
  if (currentSplitterIds.length) {
    await executor('splitter_ports').whereIn('splitter_id', currentSplitterIds).del();
    await executor('splitters').whereIn('id', currentSplitterIds).del();
  }

  if (snapshot.splitters?.length) await executor('splitters').insert(snapshot.splitters);
  if (snapshot.ports?.length) await executor('splitter_ports').insert(snapshot.ports);
  if (snapshot.splices?.length) await executor('splices').insert(snapshot.splices);

  // Core rows are shared by both cable endpoints. Only restore rows in the
  // snapshot, and never delete a core that a later cable operation may own.
  for (const core of snapshot.cores || []) {
    const { id: coreId, ...updates } = core;
    await executor('fiber_cores').where({ id: coreId }).update(updates);
  }
}

async function listApprovals({ enclosureId, status = PENDING, executor = db } = {}) {
  const query = executor('as_built_approvals').select('*').orderBy('created_at', 'desc');
  if (enclosureId) query.where({ enclosure_id: enclosureId });
  if (status && status !== 'all') query.where({ status });
  return query;
}

module.exports = {
  PENDING,
  APPROVED,
  REJECTED,
  actorFromRequest,
  requireAdmin,
  snapshotBox,
  revisionForSnapshot,
  recordAsBuiltChange,
  restoreBoxSnapshot,
  listApprovals,
};
