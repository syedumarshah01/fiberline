const express = require('express');
const db = require('../db');
const { simulateFailure } = require('../services/impactAnalysis');

const router = express.Router();

const FAILURE_KINDS = ['box', 'pole', 'cable'];
const DEFAULT_POLE_RADIUS_M = 15;
const MAX_POLE_RADIUS_M = 200;

/**
 * A pole failure takes down two things: the boxes mounted on it (their splices
 * and splitters die with it) and the cable spans that run through it — a span
 * is only as good as the pole holding it. Spans are found by geometry, so this
 * needs PostGIS; the graph work itself stays in the service.
 */
async function resolvePoleSurface(poleId, radiusM) {
  const [boxes, spans] = await Promise.all([
    db('enclosures').where({ pole_id: poleId }).select('id'),
    db.raw(
      `
      SELECT c.id
      FROM cables c
      JOIN poles p ON p.id = ?
      WHERE c.route IS NOT NULL
        AND p.location IS NOT NULL
        AND ST_DWithin(c.route, p.location, ?)
      `,
      [poleId, radiusM],
    ),
  ]);
  return {
    boxIds: boxes.map((b) => b.id),
    cableIds: spans.rows.map((r) => r.id),
  };
}

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
// GET /api/impact/simulate?kind=box|pole|cable&id=<uuid>[&radius_m=15]
//
// "Simulate failure": take an element out of the network and report every
// customer that goes dark because of it, plus the boxes where light could be
// re-injected and the nearest still-lit box with spare cores to patch from.
// ---------------------------------------------------------------------------
router.get('/simulate', async (req, res, next) => {
  try {
    const { kind, id } = req.query;
    if (!kind || !id) {
      return res.status(400).json({ error: 'kind and id are required' });
    }
    if (!FAILURE_KINDS.includes(kind)) {
      return res
        .status(400)
        .json({ error: `kind must be one of ${FAILURE_KINDS.join(', ')}` });
    }

    let boxIds = [];
    let cableIds = [];
    let element = null;
    let radiusM = DEFAULT_POLE_RADIUS_M;

    if (kind === 'box') {
      const box = await db('enclosures').where({ id }).first();
      if (!box) return res.status(404).json({ error: 'Enclosure not found' });
      boxIds = [id];
      element = { code: box.code, name: box.name ?? null, type: box.type ?? null };
    } else if (kind === 'cable') {
      const cable = await db('cables').where({ id }).first();
      if (!cable) return res.status(404).json({ error: 'Cable not found' });
      cableIds = [id];
      element = { code: cable.code, name: cable.name ?? null, type: cable.cable_type ?? null };
    } else {
      const pole = await db('poles').where({ id }).first();
      if (!pole) return res.status(404).json({ error: 'Pole not found' });
      const requested = Number(req.query.radius_m);
      if (Number.isFinite(requested) && requested > 0) {
        radiusM = Math.min(requested, MAX_POLE_RADIUS_M);
      }
      const surface = await resolvePoleSurface(id, radiusM);
      boxIds = surface.boxIds;
      cableIds = surface.cableIds;
      element = { code: pole.code, name: pole.name ?? null, type: pole.pole_type ?? null };
    }

    const boxLocations = await loadBoxLocations();
    const result = await simulateFailure({
      kind,
      id,
      boxIds,
      cableIds,
      element,
      boxLocations,
    });

    res.json({
      ...result,
      failure: { ...result.failure, pole_radius_m: kind === 'pole' ? radiusM : null },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
