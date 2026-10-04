const express = require('express');
const db = require('../db');
const { simulateFailure } = require('../services/impactAnalysis');

const router = express.Router();

const FAILURE_KINDS = ['box'];

/** Box coordinates (box's own location, else its pole's) for the distance fallback. */
async function loadBoxLocations() {
  const rows = await db.raw(`
    SELECT e.id,
           COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
           COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng
    FROM enclosures e
    LEFT JOIN poles p ON p.id = e.pole_id
  `);
  const locations = {};
  for (const row of rows.rows) {
    if (row.lat != null && row.lng != null) {
      locations[row.id] = { lat: Number(row.lat), lng: Number(row.lng) };
    }
  }
  return locations;
}

// ---------------------------------------------------------------------------
// GET /api/impact/simulate?kind=box&id=<uuid>
//
// A simulated failure is deliberately a box failure only. A box is where the
// splice/splitter state changes; a cable is a span carrying that state, and the
// impact graph follows its connected fibres away from the failed box. Keeping
// cable and pole cuts out of this endpoint prevents the UI from painting an
// arbitrary input span red and makes the direction of the report unambiguous.
// ---------------------------------------------------------------------------
router.get('/simulate', async (req, res, next) => {
  try {
    const { kind, id } = req.query;
    if (!kind || !id) {
      return res.status(400).json({ error: 'kind and id are required' });
    }
    if (!FAILURE_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'kind must be box; failures are simulated on boxes only' });
    }

    const box = await db('enclosures').where({ id }).first();
    if (!box) return res.status(404).json({ error: 'Enclosure not found' });

    const boxLocations = await loadBoxLocations();
    const result = await simulateFailure({
      kind: 'box',
      id,
      boxIds: [id],
      cableIds: [],
      element: { code: box.code, name: box.name ?? null, type: box.type ?? null },
      boxLocations,
    });

    res.json({
      ...result,
      failure: { ...result.failure, pole_radius_m: null },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
