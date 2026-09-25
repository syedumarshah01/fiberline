/**
 * Splice worksheets and work orders.
 *
 *   GET /api/work-orders/:boxId            the sheet, as JSON
 *   GET /api/work-orders/:boxId/text       the sheet as plain text (phone / print)
 *
 * Both are generated on demand from the box's own documentation — there is no
 * work-order table to keep in sync, so the sheet can never describe a box that no
 * longer exists or miss a splice somebody recorded five minutes ago.
 *   ?kind=splice|repair|survey|install   what sort of job (default: splice;
 *                                         install = a new drop)
 *   ?by=<name>                   who is doing it, printed on the sheet
 */
const express = require('express');
const { loadBoxDocumentation } = require('../services/boxDocumentation');
const { buildWorkOrder, worksheetText } = require('../services/workOrder');
const { loadContinuationLinks } = require('../utils/continuationLinks');

const router = express.Router();

/** splice | repair | survey | install — anything else falls back to splice. */
function jobKind(req) {
  const kind = String(req.query.kind || '').toLowerCase();
  return ['splice', 'repair', 'survey', 'install'].includes(kind) ? kind : 'splice';
}

/**
 * Mid-span joints that meet in this box: a cable that runs on into another.
 *
 * Read from the continuation links (recorded when the database has the column,
 * inferred from cable naming when it does not), so the sheet says "this span
 * passes straight through" whether or not the link was ever recorded.
 */
async function throughJointsFor(enclosureId, { links = null } = {}) {
  try {
    const loaded = links || (await loadContinuationLinks());
    const joints = [];
    for (const [childId, parentId] of loaded.childToParent) {
      const child = loaded.byId.get(childId);
      const parent = loaded.byId.get(parentId);
      if (!child || !parent) continue;
      // The joint is in this box when the downstream half starts here (and the
      // upstream half ends here — that is what an inserted closure looks like).
      if (child.from_enclosure_id !== enclosureId) continue;
      joints.push({
        upstream_cable_id: parent.id,
        upstream_code: parent.code,
        downstream_cable_id: child.id,
        downstream_code: child.code,
        box_id: enclosureId,
        inferred: Boolean(loaded.inferred),
      });
    }
    return joints;
  } catch {
    // A worksheet is still useful without this; the caller notes nothing.
    return [];
  }
}

async function buildSheet(req, { install = null } = {}) {
  const enclosureId = req.params.boxId;
  const documentation = await loadBoxDocumentation({ enclosureId });
  if (!documentation) return null;
  const throughJoints = await throughJointsFor(enclosureId);
  const kind = jobKind(req);
  return buildWorkOrder({
    documentation,
    throughJoints,
    kind,
    install: kind === 'install' ? install : null,
    by: typeof req.query.by === 'string' && req.query.by.trim() ? req.query.by.trim() : null,
  });
}

/**
 * What the serviceability check found, in the shape the sheet builder wants.
 *
 * This is how a quote becomes a work order: the check already decided the box,
 * the port and the length, so the sheet prints those instead of asking the
 * technician to re-derive them from the box documentation.
 */
async function installContextFromCheck(check) {
  if (!check?.recommended_box) return null;
  const box = check.recommended_box;
  const port = (box.free_port_numbers || [])[0] ?? null;
  const drop = check.quote?.drop_length_m ?? check.drop?.length_m ?? null;
  return {
    box_id: box.id,
    box_code: box.code,
    box_name: box.name ?? null,
    distance_m: check.distance?.to_recommended_m ?? box.distance_m ?? null,
    route_length_m: drop,
    distance_source: check.drop?.source || null,
    port_number: port,
    splitter_name: box.splitter_name || null,
    needs: check.connection?.needs || null,
    needs_detail: check.connection?.detail || null,
    materials: check.quote?.lines || [],
    quote_total: check.quote?.total ?? null,
    currency: check.quote?.currency ?? null,
    verdict: check.verdict,
    verdict_label: check.verdict_label,
  };
}

router.get('/:boxId/text', async (req, res, next) => {
  try {
    const order = await buildSheet(req);
    if (!order) return res.status(404).json({ error: 'Enclosure not found' });
    res.type('text/plain; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="${order.work_order.reference}.txt"`);
    res.send(worksheetText(order));
  } catch (err) {
    next(err);
  }
});

router.get('/:boxId', async (req, res, next) => {
  try {
    const order = await buildSheet(req);
    if (!order) return res.status(404).json({ error: 'Enclosure not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.throughJointsFor = throughJointsFor;
module.exports.buildSheet = buildSheet;
module.exports.installContextFromCheck = installContextFromCheck;
