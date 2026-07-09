const express = require('express');
const db = require('../db');
const router = express.Router();

// GET /api/enclosures — all boxes, with parent pole coordinates
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.raw(`
      SELECT e.id, e.code, e.name, e.type, e.capacity, e.status, e.mounting,
             e.pole_id, p.code AS pole_code,
             ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng
      FROM enclosures e
      JOIN poles p ON p.id = e.pole_id
      ORDER BY e.created_at DESC
    `);
    res.json(rows.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/enclosures
router.post('/', async (req, res, next) => {
  try {
    const { code, name, pole_id, type, capacity, status, mounting, notes } = req.body;
    if (!code || !pole_id || !type) {
      return res.status(400).json({ error: 'code, pole_id, and type are required' });
    }
    const [row] = await db('enclosures')
      .insert({ code, name, pole_id, type, capacity: capacity || 0, status, mounting, notes })
      .returning('*');
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/enclosures/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const fields = ['name', 'type', 'capacity', 'status', 'mounting', 'notes'];
    const updates = { updated_at: db.fn.now() };
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
    await db('enclosures').where({ id: req.params.id }).update(updates);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/enclosures/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await db('enclosures').where({ id: req.params.id }).del();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/enclosures/:id/documentation
//
// Requirement #3 & #4: complete documentation of a box — every core that
// enters it, every core that leaves it, and how they're spliced together,
// plus which cores are still free.
// ---------------------------------------------------------------------------
router.get('/:id/documentation', async (req, res, next) => {
  try {
    const enclosureId = req.params.id;

    const enclosure = await db('enclosures').where({ id: enclosureId }).first();
    if (!enclosure) return res.status(404).json({ error: 'Enclosure not found' });

    // All cables physically landing at this box (either end)
    const cables = await db('cables')
      .where({ from_enclosure_id: enclosureId })
      .orWhere({ to_enclosure_id: enclosureId })
      .select('id', 'code', 'name', 'cable_type', 'core_count', 'from_enclosure_id', 'to_enclosure_id', 'customer_label');

    const cableIds = cables.map((c) => c.id);

    // Every core belonging to those cables, with status
    const cores = cableIds.length
      ? await db('fiber_cores').whereIn('cable_id', cableIds).select('*')
      : [];

    // Every splice recorded inside this specific box, joined with cable/core context
    const splices = await db.raw(
      `
      SELECT s.id, s.splice_type, s.tray_number, s.tray_position, s.loss_db,
             s.technician, s.splice_date, s.notes,
             ca.id AS core_a_id, ca.core_number AS core_a_number, cca.code AS cable_a_code, cca.cable_type AS cable_a_type,
             cb.id AS core_b_id, cb.core_number AS core_b_number, ccb.code AS cable_b_code, ccb.cable_type AS cable_b_type
      FROM splices s
      JOIN fiber_cores ca ON ca.id = s.core_a_id
      JOIN fiber_cores cb ON cb.id = s.core_b_id
      JOIN cables cca ON cca.id = ca.cable_id
      JOIN cables ccb ON ccb.id = cb.cable_id
      WHERE s.enclosure_id = ?
      ORDER BY s.tray_number, s.tray_position
      `,
      [enclosureId]
    );

    const coresByCable = {};
    for (const cable of cables) {
      coresByCable[cable.id] = {
        cable,
        cores: cores.filter((c) => c.cable_id === cable.id),
      };
    }

    const availableCores = cores.filter((c) => c.status === 'available');

    res.json({
      enclosure,
      cables_landing_here: Object.values(coresByCable),
      splices: splices.rows,
      summary: {
        total_cables: cables.length,
        total_cores: cores.length,
        spliced_cores: cores.filter((c) => c.status === 'spliced').length,
        available_cores: availableCores.length,
        terminated_cores: cores.filter((c) => c.status === 'terminated').length,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
