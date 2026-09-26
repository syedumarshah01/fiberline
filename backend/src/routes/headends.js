const express = require('express');
const db = require('../db');
const { nextCode } = require('../utils/codegen');

const router = express.Router();

const SITE_TYPES = ['olt', 'co', 'pop', 'other'];

function validateSiteType(value) {
  if (value === undefined || value === null) return null;
  return SITE_TYPES.includes(value)
    ? null
    : `site_type must be one of ${SITE_TYPES.join(', ')}`;
}

// GET /api/headends — the network roots, with the box each one feeds
router.get('/', async (req, res, next) => {
  try {
    const headends = await db('headends').select('*').orderBy('created_at');
    const boxIds = [...new Set(headends.map((h) => h.root_enclosure_id).filter(Boolean))];
    const boxes = boxIds.length
      ? await db('enclosures').whereIn('id', boxIds).select('id', 'code', 'name', 'type')
      : [];
    const boxById = Object.fromEntries(boxes.map((b) => [b.id, b]));
    res.json(
      headends.map((h) => ({
        ...h,
        root_enclosure: h.root_enclosure_id ? boxById[h.root_enclosure_id] || null : null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/headends — declare a network root. `root_enclosure_id` is the box
// the OLT/CO feeds; without it the headend exists but cannot orient a trace.
router.post('/', async (req, res, next) => {
  try {
    const { code, name, site_type, root_enclosure_id, notes } = req.body || {};

    const typeError = validateSiteType(site_type);
    if (typeError) return res.status(400).json({ error: typeError });

    if (root_enclosure_id) {
      const box = await db('enclosures').where({ id: root_enclosure_id }).first();
      if (!box) return res.status(404).json({ error: 'Root enclosure not found' });
    }

    let finalCode = code;
    if (!finalCode || !String(finalCode).trim()) {
      const existing = await db('headends').select('code');
      finalCode = nextCode(existing.map((r) => r.code), 'OLT-');
    }

    const [row] = await db('headends')
      .insert({
        code: finalCode,
        name: name ?? null,
        site_type: site_type ?? 'olt',
        root_enclosure_id: root_enclosure_id ?? null,
        notes: notes ?? null,
      })
      .returning('*');

    res.status(201).json(row);
  } catch (err) {
    // Unique code violation gets a clean 409 instead of a 500.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A headend with that code already exists' });
    }
    next(err);
  }
});

// PATCH /api/headends/:id — rename, change the site type, or re-root at another box
router.patch('/:id', async (req, res, next) => {
  try {
    const fields = ['code', 'name', 'site_type', 'root_enclosure_id', 'notes'];
    const updates = { updated_at: db.fn.now() };
    for (const field of fields) {
      if (req.body?.[field] !== undefined) updates[field] = req.body[field];
    }

    const typeError = validateSiteType(updates.site_type);
    if (typeError) return res.status(400).json({ error: typeError });

    if (updates.code !== undefined && !String(updates.code).trim()) {
      return res.status(400).json({ error: 'code must not be empty' });
    }
    if (updates.root_enclosure_id) {
      const box = await db('enclosures').where({ id: updates.root_enclosure_id }).first();
      if (!box) return res.status(404).json({ error: 'Root enclosure not found' });
    }

    const changed = await db('headends').where({ id: req.params.id }).update(updates);
    if (!changed) return res.status(404).json({ error: 'Headend not found' });
    res.json(await db('headends').where({ id: req.params.id }).first());
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A headend with that code already exists' });
    }
    next(err);
  }
});

// DELETE /api/headends/:id — drops the root only; the box itself is untouched
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await db('headends').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Headend not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
