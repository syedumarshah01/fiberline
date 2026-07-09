const express = require('express');
const db = require('../db');
const { getAvailableCoreCounts, findNearestSource } = require('../services/capacityGraph');
const router = express.Router();

// GET /api/capacity/enclosures — every box with its current spare-core count
router.get('/enclosures', async (req, res, next) => {
  try {
    const capacity = await getAvailableCoreCounts();
    const enclosures = await db.raw(`
      SELECT e.id, e.code, e.name, e.type,
             ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng
      FROM enclosures e JOIN poles p ON p.id = e.pole_id
    `);
    const result = enclosures.rows.map((e) => ({ ...e, available_cores: capacity[e.id] || 0 }));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/capacity/find-source?enclosureId=...
// Requirement #7: "I don't have a connection left in the box near them,
// which box can I bring a connection from?"
// ---------------------------------------------------------------------------
router.get('/find-source', async (req, res, next) => {
  try {
    const { enclosureId } = req.query;
    if (!enclosureId) return res.status(400).json({ error: 'enclosureId is required' });

    const enclosure = await db('enclosures').where({ id: enclosureId }).first();
    if (!enclosure) return res.status(404).json({ error: 'Enclosure not found' });

    const result = await findNearestSource(enclosureId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/capacity/customer-lookup?lat=&lng=&radius=500
// Requirement #8: "customer sends their location, find near boxes and check
// if there's a connection available; if not, which is the best box to bring
// a connection from."
// ---------------------------------------------------------------------------
router.get('/customer-lookup', async (req, res, next) => {
  try {
    const { lat, lng, radius = 500, limit = 5 } = req.query;
    if (lat == null || lng == null) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const nearby = await db.raw(
      `
      SELECT e.id, e.code, e.name, e.type,
             ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
             ST_Distance(p.location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_m
      FROM enclosures e JOIN poles p ON p.id = e.pole_id
      WHERE ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)
      ORDER BY distance_m ASC
      LIMIT ?
      `,
      [lng, lat, lng, lat, radius, limit]
    );

    const capacity = await getAvailableCoreCounts();
    const nearbyBoxes = nearby.rows.map((e) => ({
      ...e,
      distance_m: Math.round(e.distance_m),
      available_cores: capacity[e.id] || 0,
    }));

    const withCapacity = nearbyBoxes.find((b) => b.available_cores > 0);

    let suggestedSource = null;
    if (!withCapacity && nearbyBoxes.length) {
      // No nearby box has room — search outward from the closest one for a
      // box that could feed a new splice path into it.
      suggestedSource = await findNearestSource(nearbyBoxes[0].id);
    }

    res.json({
      query: { lat: Number(lat), lng: Number(lng), radius_m: Number(radius) },
      nearby_boxes: nearbyBoxes,
      recommended_box: withCapacity || null,
      suggested_source: withCapacity ? null : suggestedSource,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
