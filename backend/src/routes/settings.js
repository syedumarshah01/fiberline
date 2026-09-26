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
const { isMissingColumnError } = require('../utils/schemaHint');
const {
  resolveCostModel,
  sanitizeCostSettingsPatch,
  COST_SETTINGS_FIELDS,
  DEFAULT_CURRENCY,
  DEFAULT_DROP_CABLE_COST_PER_M,
  DEFAULT_LABOUR_COST_PER_DROP,
  DEFAULT_SPLICE_COST,
  DEFAULT_SPLITTER_COST,
  DEFAULT_EXTENSION_COST_PER_M,
  DEFAULT_SLACK_PCT,
  DEFAULT_MAX_DROP_M,
  DEFAULT_MAX_EXTENSION_M,
} = require('../utils/dropCost');
const router = express.Router();

function settingsView(row) {
  return {
    olt_type: row.olt_type,
    budget_db: row.budget_db != null ? Number(row.budget_db) : null,
    safety_margin_db: row.safety_margin_db != null ? Number(row.safety_margin_db) : null,
    // Drop-cost rates (the serviceability quote). NULL everywhere means "use the
    // planning defaults", which is what a fresh project_settings row looks like.
    currency: row.currency ?? null,
    drop_cable_cost_per_m: row.drop_cable_cost_per_m != null ? Number(row.drop_cable_cost_per_m) : null,
    labour_cost_per_drop: row.labour_cost_per_drop != null ? Number(row.labour_cost_per_drop) : null,
    splice_cost: row.splice_cost != null ? Number(row.splice_cost) : null,
    splitter_cost: row.splitter_cost != null ? Number(row.splitter_cost) : null,
    extension_cost_per_m: row.extension_cost_per_m != null ? Number(row.extension_cost_per_m) : null,
    slack_pct: row.slack_pct != null ? Number(row.slack_pct) : null,
    max_drop_m: row.max_drop_m != null ? Number(row.max_drop_m) : null,
    max_extension_m: row.max_extension_m != null ? Number(row.max_extension_m) : null,
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
      // The effective rate card the serviceability quote uses for this project
      // (overrides applied, defaults filled in) plus what a fresh project gets.
      cost_model: resolveCostModel(row),
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
        cost_defaults: {
          currency: DEFAULT_CURRENCY,
          drop_cable_cost_per_m: DEFAULT_DROP_CABLE_COST_PER_M,
          labour_cost_per_drop: DEFAULT_LABOUR_COST_PER_DROP,
          splice_cost: DEFAULT_SPLICE_COST,
          splitter_cost: DEFAULT_SPLITTER_COST,
          extension_cost_per_m: DEFAULT_EXTENSION_COST_PER_M,
          slack_pct: DEFAULT_SLACK_PCT,
          max_drop_m: DEFAULT_MAX_DROP_M,
          max_extension_m: DEFAULT_MAX_EXTENSION_M,
        },
        cost_fields: COST_SETTINGS_FIELDS,
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
    // Two groups of fields share this one row: the optical loss budget and the
    // drop-cost rates. Validate each with its own rules and merge, so a PATCH may
    // carry either or both — and an invalid field in one group cannot silently
    // drop a valid one in the other.
    const body = req.body || {};
    const { updates, error } = sanitizeSettingsPatch(body);
    const { updates: costUpdates, error: costError } = sanitizeCostSettingsPatch(body);
    if (error && costError) return res.status(400).json({ error: `${error}; ${costError}` });
    if (error && !Object.keys(costUpdates || {}).length) return res.status(400).json({ error });
    if (costError && !Object.keys(updates || {}).length) return res.status(400).json({ error: costError });
    const merged = { ...(updates || {}), ...(costUpdates || {}) };
    if (Object.keys(merged).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const current = await getProjectSettings(); // ensures the row exists
    let changed;
    try {
      changed = await db('project_settings')
        .where({ id: current.id })
        .update({ ...merged, updated_at: db.fn.now() });
    } catch (err) {
      // A database that predates the cost-rate columns and whose startup
      // migration pass could not run: say which migration, the way the rest of
      // the app does, instead of a bare 42703.
      if (isMissingColumnError(err, 'drop_cable_cost_per_m')) {
        return res.status(503).json({
          error:
            'The drop-cost rates need the columns added by 20260101000016_serviceability_costs.js, ' +
            'which this database does not have yet — the API applies pending migrations when it ' +
            'starts, so this means that pass could not run (rights, or SCHEMA_BOOTSTRAP=off). ' +
            'Run "npm run db:schema" in backend/ for the exact step, or "npm run migrate".',
        });
      }
      throw err;
    }
    if (!changed) return res.status(404).json({ error: 'Settings not found' });

    const row = await db('project_settings').where({ id: current.id }).first();
    res.json({
      settings: settingsView(row),
      resolved: resolveBudget(row),
      cost_model: resolveCostModel(row),
      ...(error ? { warnings: [error] } : {}),
      ...(costError ? { warnings: [...(error ? [error] : []), costError] } : {}),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
