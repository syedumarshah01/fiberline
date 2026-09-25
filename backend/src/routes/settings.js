const express = require('express');
const db = require('../db');
const { getProjectSettings } = require('../services/lossBudget');
const {
  sanitizeSettingsPatch,
  resolveBudget,
  OLT_BUDGETS_DB,
  DEFAULT_ATTENUATION_DB_PER_KM,
  DEFAULT_SPLICE_LOSS_DB,
  DEFAULT_CONNECTOR_LOSS_DB,
  DEFAULT_SAFETY_MARGIN_DB,
  BAD_SPLICE_LOSS_DB,
  SPLITTER_INSERTION_LOSS_DB,
} = require('../utils/lossBudget');
const router = express.Router();

function settingsView(row) {
  return {
    olt_type: row.olt_type,
    budget_db: row.budget_db != null ? Number(row.budget_db) : null,
    safety_margin_db: row.safety_margin_db != null ? Number(row.safety_margin_db) : null,
  };
}

// GET /api/settings — the project's loss-budget settings (raw overrides +
// resolved against the defaults) plus the constants the UI offers as choices.
router.get('/', async (req, res, next) => {
  try {
    const row = await getProjectSettings();
    res.json({
      settings: settingsView(row),
      resolved: resolveBudget(row),
      available: {
        olt_budgets_db: OLT_BUDGETS_DB,
        splitter_insertion_loss_db: SPLITTER_INSERTION_LOSS_DB,
        defaults: {
          attenuation_db_per_km: DEFAULT_ATTENUATION_DB_PER_KM,
          splice_loss_db: DEFAULT_SPLICE_LOSS_DB,
          connector_loss_db: DEFAULT_CONNECTOR_LOSS_DB,
          safety_margin_db: DEFAULT_SAFETY_MARGIN_DB,
          bad_splice_loss_db: BAD_SPLICE_LOSS_DB,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/settings — set the project's OLT/transport type and optional
// budget / safety-margin overrides (blank = fall back to the type default).
router.patch('/', async (req, res, next) => {
  try {
    const { updates, error } = sanitizeSettingsPatch(req.body || {});
    if (error) return res.status(400).json({ error });

    const current = await getProjectSettings(); // ensures the row exists
    const changed = await db('project_settings')
      .where({ id: current.id })
      .update({ ...updates, updated_at: db.fn.now() });
    if (!changed) return res.status(404).json({ error: 'Settings not found' });

    const row = await db('project_settings').where({ id: current.id }).first();
    res.json({ settings: settingsView(row), resolved: resolveBudget(row) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
