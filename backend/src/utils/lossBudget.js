/**
 * Optical loss-budget math — pure functions, no database access.
 *
 * A loss budget adds up every dB the light loses between the OLT and the
 * customer: fiber attenuation (length × dB/km), every splice crossed, every
 * splitter crossed, and (when the model grows connector records) connectors.
 * The total is compared against the OLT's optical budget (GPON Class B+
 * ~28 dB, XGS-PON ~29 dB, P2P depends on the optics) to decide whether the
 * path is healthy (OK), tight (MARGINAL) or over budget (FAIL).
 *
 * Anything a tech has actually measured — an OTDR/power-meter splice reading
 * or a splitter's insertion loss — wins over the planning default and is
 * flagged `measured: true`, so the UI can color-code verified vs assumed dB.
 */

// --- Planning constants ------------------------------------------------------

/** Default fiber attenuation: G.652 singlemode @ 1310 nm. */
const DEFAULT_ATTENUATION_DB_PER_KM = 0.35;

/** Assumed splice loss when no reading is recorded. Fusion splices are
 *  typically ≤ 0.1 dB; mechanical splices run about three times worse. */
const DEFAULT_SPLICE_LOSS_DB = { fusion: 0.1, mechanical: 0.3 };

/** Assumed loss per connector (e.g. an ONT/ODF patch point) for hops that
 *  carry connector data — the current schema has none, but the budget knows
 *  how to price them the day it does. */
const DEFAULT_CONNECTOR_LOSS_DB = 0.3;

/** Typical worst-case insertion loss of a 1:N splitter (G.671 planning
 *  values). A measured splitters.loss_db always wins when present. */
const SPLITTER_INSERTION_LOSS_DB = { 2: 3.6, 4: 7.2, 8: 10.5, 16: 13.8, 32: 17.1, 64: 20.5 };

/** Total optical budget by OLT/transport type (downstream, planning level).
 *  These are defaults — a project overrides via project_settings.budget_db. */
const OLT_BUDGETS_DB = {
  gpon: 28, // GPON Class B+ (ITU-T G.984.2)
  xgs_pon: 29, // XGS-PON N1 (ITU-T G.9807.1)
  p2p: 24, // P2P / active-Ethernet optics class (e.g. 10GBASE-ER)
};

/** Margin that must survive for a path to count as healthy. */
const DEFAULT_SAFETY_MARGIN_DB = 3;

/** A recorded splice loss above this is a suspect bad splice (QC flag). */
const BAD_SPLICE_LOSS_DB = 0.5;

// --- Small helpers -----------------------------------------------------------

/** pg returns decimals as strings ("0.35"); anything non-numeric becomes null. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Loss contribution of a splice hop: measured value or planning default. */
function spliceLossDb(splice) {
  const measured = num(splice.loss_db);
  if (measured != null) return { loss_db: measured, measured: true };
  const fallback =
    DEFAULT_SPLICE_LOSS_DB[splice.splice_type] ?? DEFAULT_SPLICE_LOSS_DB.fusion;
  return { loss_db: fallback, measured: false };
}

/** Loss contribution of a splitter: measured value, the G.671 planning
 *  table, or — for exotic split ratios — 10·log10(N) + 1 dB. */
function splitterLossDb(splitter) {
  const measured = num(splitter.loss_db);
  if (measured != null) return { loss_db: measured, measured: true };
  const n = num(splitter.split_count);
  if (n != null && SPLITTER_INSERTION_LOSS_DB[n] != null) {
    return { loss_db: SPLITTER_INSERTION_LOSS_DB[n], measured: false };
  }
  if (n != null && n > 1) {
    return { loss_db: round2(10 * Math.log10(n) + 1), measured: false };
  }
  return { loss_db: null, measured: false };
}

// --- Budget resolution + input sanitizing -------------------------------------

/** Merge project settings + explicit overrides into the effective budget. */
function resolveBudget({ olt_type, budget_db, safety_margin_db } = {}) {
  const type =
    olt_type != null && OLT_BUDGETS_DB[olt_type] !== undefined ? olt_type : 'gpon';
  const override = num(budget_db);
  const margin = num(safety_margin_db);
  return {
    olt_type: type,
    budget_db: override != null ? override : OLT_BUDGETS_DB[type],
    safety_margin_db: margin != null ? margin : DEFAULT_SAFETY_MARGIN_DB,
  };
}

const SETTINGS_FIELDS = ['olt_type', 'budget_db', 'safety_margin_db'];

/**
 * Validate + normalize a project-settings PATCH body. Blank strings mean
 * "clear the override, fall back to the type default" for the numeric
 * columns. Returns { updates } or { error }.
 */
function sanitizeSettingsPatch(body) {
  const updates = {};
  for (const f of SETTINGS_FIELDS) {
    if (body[f] !== undefined) updates[f] = body[f];
  }
  if (updates.budget_db === '') updates.budget_db = null;
  if (updates.safety_margin_db === '') updates.safety_margin_db = null;

  if (
    updates.olt_type !== undefined &&
    updates.olt_type !== null &&
    !Object.prototype.hasOwnProperty.call(OLT_BUDGETS_DB, updates.olt_type)
  ) {
    return {
      error: `olt_type must be one of ${Object.keys(OLT_BUDGETS_DB).join(', ')}`,
    };
  }
  for (const f of ['budget_db', 'safety_margin_db']) {
    if (updates[f] != null) {
      const n = num(updates[f]);
      if (n == null || n <= 0) {
        return { error: `${f} must be a positive number` };
      }
      updates[f] = n;
    }
  }
  if (Object.keys(updates).length === 0) {
    return { error: 'No valid fields to update' };
  }
  return { updates };
}

/**
 * Validate + normalize cables.attenuation_db_per_km input.
 *   undefined → { value: undefined }  (field not sent — leave untouched)
 *   '' / null → { value: null }       (clear → use the project default)
 *   number-ish → { value: Number }    (explicit per-cable override)
 */
function sanitizeAttenuationDbPerKm(value) {
  if (value === undefined) return { value: undefined };
  if (value === '' || value === null) return { value: null };
  const n = num(value);
  if (n == null || n < 0) {
    return { error: 'attenuation_db_per_km must be a non-negative number' };
  }
  return { value: n };
}

// --- The budget itself --------------------------------------------------------

/**
 * Accumulate the loss budget for a traced fiber path.
 *
 * `hops` is the output of traceFiber(): an ordered list alternating between
 * splice markers ({ splice_id, enclosure_id, splice_type, loss_db }) and core
 * rows ({ core_id, cable_id, cable_code, length_m, attenuation_db_per_km, … }),
 * where the service has already merged in each cable's length + attenuation.
 * Segments in the generic shape ({ type: 'fiber' | 'splice' | 'connector', … })
 * are accepted too.
 *
 * `options`:
 *   - olt_type / budget_db / safety_margin_db — the project budget
 *     (see resolveBudget)
 *   - splittersByCoreId — { coreId: [splitter, …] } for every splitter the
 *     path crosses (input side, output port, or a cascade parent of one).
 *
 * Returns { total_loss_db, breakdown, margin_db, status, warnings, … } where
 * every breakdown entry carries its own loss and a running total (running_db)
 * so the UI can show the loss pile up along the path. Entries that rest on a
 * real measurement get measured: true; defaulted ones measured: false.
 */
function calculateLossBudget(hops, options = {}) {
  const budget = resolveBudget(options);
  const splittersByCoreId = options.splittersByCoreId || {};

  const breakdown = [];
  const warnings = [];
  const seenCables = new Set(); // a branched trace can revisit a cable — its loss counts once
  const seenSplitters = new Set();
  let totalDb = 0;

  const push = (entry) => {
    totalDb += entry.loss_db == null ? 0 : entry.loss_db;
    entry.running_db = round2(totalDb);
    breakdown.push(entry);
  };

  const addSplitter = (splitter) => {
    if (!splitter || seenSplitters.has(splitter.id)) return;
    seenSplitters.add(splitter.id);
    const { loss_db, measured } = splitterLossDb(splitter);
    push({
      type: 'splitter',
      splitter_id: splitter.id,
      box_id: splitter.enclosure_id,
      name: splitter.name || null,
      split_count: num(splitter.split_count),
      loss_db: round2(loss_db),
      measured,
    });
  };

  for (const hop of hops || []) {
    // Connector hop — nothing in the schema emits these yet, but the budget
    // prices them the day connector records exist.
    if (hop.type === 'connector' || hop.connector_id != null) {
      const measured = num(hop.loss_db);
      push({
        type: 'connector',
        connector_id: hop.connector_id ?? null,
        loss_db: round2(measured != null ? measured : DEFAULT_CONNECTOR_LOSS_DB),
        measured: measured != null,
      });
      continue;
    }

    // Splice marker — measured reading or the splice-type default.
    if (hop.splice_id != null || hop.type === 'splice') {
      const { loss_db, measured } = spliceLossDb(hop);
      const entry = {
        type: 'splice',
        splice_id: hop.splice_id ?? hop.id ?? null,
        box_id: hop.enclosure_id ?? hop.box_id ?? null,
        splice_type: hop.splice_type || 'fusion',
        loss_db: round2(loss_db),
        measured,
      };
      if (measured && loss_db > BAD_SPLICE_LOSS_DB) {
        entry.flagged = 'bad_splice';
        warnings.push(
          `Splice ${entry.splice_id} measures ${round2(loss_db)} dB — above the ${BAD_SPLICE_LOSS_DB} dB bad-splice threshold; re-splice recommended.`,
        );
      }
      push(entry);
      continue;
    }

    // Core row — a fiber segment (its cable's length × attenuation), plus any
    // splitter crossings that attach to this core.
    if (hop.core_id != null || hop.type === 'fiber') {
      for (const splitter of splittersByCoreId[hop.core_id] || []) {
        addSplitter(splitter);
      }

      if (hop.cable_id != null && seenCables.has(hop.cable_id)) {
        // Same cable visited twice (a splice looped two of its cores, or a
        // branch re-enters it): the light only crosses it once, so the second
        // visit is listed for documentation but contributes no loss.
        push({
          type: 'fiber',
          cable_id: hop.cable_id,
          cable_code: hop.cable_code ?? null,
          core_id: hop.core_id,
          core_number: hop.core_number,
          loss_db: null,
          duplicate_cable: true,
        });
        continue;
      }
      if (hop.cable_id != null) seenCables.add(hop.cable_id);

      const lengthM = num(hop.length_m);
      const attenuation = num(hop.attenuation_db_per_km);
      const attenuationDefaulted = attenuation == null;
      const effectiveAttenuation = attenuationDefaulted
        ? DEFAULT_ATTENUATION_DB_PER_KM
        : attenuation;

      const entry = {
        type: 'fiber',
        cable_id: hop.cable_id ?? null,
        cable_code: hop.cable_code ?? null,
        cable_type: hop.cable_type ?? null,
        core_id: hop.core_id,
        core_number: hop.core_number,
        length_m: lengthM,
        attenuation_db_per_km: effectiveAttenuation,
        attenuation_defaulted: attenuationDefaulted,
        loss_db: null,
      };
      if (lengthM == null) {
        entry.length_missing = true;
        warnings.push(
          `Cable ${hop.cable_code || hop.cable_id} has no recorded length — its fiber loss is unknown and NOT counted.`,
        );
      } else {
        entry.loss_db = round2((lengthM / 1000) * effectiveAttenuation);
      }
      push(entry);
      continue;
    }
  }

  const totalLossDb = round2(totalDb);
  const marginDb = round2(budget.budget_db - totalLossDb);
  const status =
    marginDb > budget.safety_margin_db ? 'OK' : marginDb > 0 ? 'MARGINAL' : 'FAIL';

  return {
    olt_type: budget.olt_type,
    budget_db: budget.budget_db,
    safety_margin_db: budget.safety_margin_db,
    total_loss_db: totalLossDb,
    margin_db: marginDb,
    status,
    breakdown,
    warnings,
    counts: {
      measured_entries: breakdown.filter((e) => e.measured === true).length,
      assumed_entries: breakdown.filter((e) => e.measured === false).length,
      flagged_bad_splices: breakdown.filter((e) => e.flagged === 'bad_splice').length,
      missing_lengths: breakdown.filter((e) => e.length_missing === true).length,
    },
  };
}

module.exports = {
  DEFAULT_ATTENUATION_DB_PER_KM,
  DEFAULT_SPLICE_LOSS_DB,
  DEFAULT_CONNECTOR_LOSS_DB,
  SPLITTER_INSERTION_LOSS_DB,
  OLT_BUDGETS_DB,
  DEFAULT_SAFETY_MARGIN_DB,
  BAD_SPLICE_LOSS_DB,
  num,
  round2,
  spliceLossDb,
  splitterLossDb,
  resolveBudget,
  sanitizeSettingsPatch,
  sanitizeAttenuationDbPerKm,
  calculateLossBudget,
};
