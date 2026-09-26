/**
 * Serviceability check — the sales/CSR question, answered in one call.
 *
 *   GET /api/serviceability/check?address=House 12-B, Street 4
 *   GET /api/serviceability/check?lat=33.6&lng=73.05
 *
 *   ?address=<text>   free text: an asset code ("NAP-14"), a customer address,
 *                     or — if the deployment configured GEOCODE_BASE_URL — an
 *                     address a geocoder can place
 *   ?lat=&lng=        the point directly (that is what "Locate customer" gives)
 *   ?radius_m=500     how far to look for boxes (default 500, max 5000; the
 *                     search is never narrower than the build limit, or the
 *                     verdict would depend on the radius)
 *   ?limit=25         how many boxes to consider (max 100)
 *   ?route=0          skip the street route and answer from straight-line distance
 *
 *   .../check/text    the same answer as plain text, for reading out loud,
 *                     pasting into a CRM, or messaging to the installer
 *   .../check/sheet   a printable install work order for the box the check
 *                     picked: the plan at the top, the box's own documentation
 *                     underneath, and the materials at the end
 *
 * The reply always carries: the verdict, the nearest box, the box to serve from
 * (which is not always the nearest one), what the connection needs at that box,
 * the run in metres, the price with the rates behind it, the alternatives, and
 * the next steps. An address that matches nothing comes back 404 with the scored
 * candidates, so the CSR can pick one or click the map.
 */
const express = require('express');
const { checkServiceability } = require('../services/serviceability');
const { serviceabilityText } = require('../utils/serviceability');
const { loadBoxDocumentation } = require('../services/boxDocumentation');
const { buildWorkOrder, worksheetText } = require('../services/workOrder');
// The install sheet is the worksheet format, so it borrows that route's two
// helpers rather than re-deriving them: one place knows how a mid-span joint is
// read, and one place knows how a serviceability check becomes a sheet.
const { throughJointsFor, installContextFromCheck } = require('./workOrders');

const router = express.Router();

async function buildCheck(req) {
  return checkServiceability({
    address: req.query.address,
    lat: req.query.lat,
    lng: req.query.lng,
    radius_m: req.query.radius_m,
    limit: req.query.limit,
    route: req.query.route,
  });
}

router.get('/check/text', async (req, res, next) => {
  try {
    const result = await buildCheck(req);
    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        address: result.address ?? null,
        candidates: result.candidates ?? [],
        hint: result.hint,
        warnings: result.warnings ?? [],
      });
    }
    res.type('text/plain; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="serviceability.txt"');
    res.send(serviceabilityText(result));
  } catch (err) {
    next(err);
  }
});

/**
 * The quote as a job sheet for the crew.
 *
 * Deliberately the *worksheet* format (same as /api/work-orders/:boxId) rather
 * than a new document: it is a splice job at that box with a drop added, and the
 * technician already knows how to read the box's own checklist. The check's plan
 * goes on top; everything below it is the box's documentation, unaltered.
 */
router.get('/check/sheet', async (req, res, next) => {
  try {
    const result = await buildCheck(req);
    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        address: result.address ?? null,
        candidates: result.candidates ?? [],
        hint: result.hint,
        warnings: result.warnings ?? [],
      });
    }
    const context = await installContextFromCheck(result);
    if (!context?.box_id) {
      return res.status(409).json({
        error: 'No box on this address can take the drop, so there is no install sheet to print',
        verdict: result.verdict,
        verdict_label: result.verdict_label,
        next_steps: result.next_steps,
      });
    }
    const documentation = await loadBoxDocumentation({ enclosureId: context.box_id });
    if (!documentation) return res.status(404).json({ error: 'Box not found' });
    const sheet = buildWorkOrder({
      documentation,
      throughJoints: await throughJointsFor(context.box_id),
      kind: 'install',
      install: context,
      by: typeof req.query.by === 'string' && req.query.by.trim() ? req.query.by.trim() : null,
    });
    res.json({
      ...sheet,
      serviceability: {
        query: result.query,
        verdict: result.verdict,
        verdict_label: result.verdict_label,
        summary: result.summary,
        confidence: result.confidence,
        warnings: result.warnings,
        next_steps: result.next_steps,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/check/sheet/text', async (req, res, next) => {
  try {
    const result = await buildCheck(req);
    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        address: result.address ?? null,
        candidates: result.candidates ?? [],
        hint: result.hint,
        warnings: result.warnings ?? [],
      });
    }
    const context = await installContextFromCheck(result);
    if (!context?.box_id) {
      return res.status(409).json({
        error: 'No box on this address can take the drop, so there is no install sheet to print',
        verdict: result.verdict,
      });
    }
    const documentation = await loadBoxDocumentation({ enclosureId: context.box_id });
    if (!documentation) return res.status(404).json({ error: 'Box not found' });
    const sheet = buildWorkOrder({
      documentation,
      throughJoints: await throughJointsFor(context.box_id),
      kind: 'install',
      install: context,
      by: typeof req.query.by === 'string' && req.query.by.trim() ? req.query.by.trim() : null,
    });
    res.type('text/plain; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="install-sheet.txt"');
    res.send(worksheetText(sheet));
  } catch (err) {
    next(err);
  }
});

router.get('/check', async (req, res, next) => {
  try {
    const result = await buildCheck(req);
    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        address: result.address ?? null,
        candidates: result.candidates ?? [],
        hint: result.hint,
        warnings: result.warnings ?? [],
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.buildCheck = buildCheck;
