/**
 * Drop-cost math — pure functions, no database access.
 *
 * "Can we serve this address, and what will the drop cost?" is a quoting
 * question, so the answer has to be spendable: a price, a band around it, and
 * the rates it was built from, in the units the crew buys them in (metres of
 * cable, one fusion splice, one crew-day).
 *
 * What is deliberately *not* here is a fake pricelist. Every number below is a
 * planning default — a project overrides any of them via project_settings
 * (migration 20260101000016) and the estimate always reports which rates it
 * used, so a CSR can see that "PKR 6,400" is 45/m + 2,500 labour + 350 splice
 * and not a magic number. The band exists for the same reason: a drop measured
 * from a street route is ±15% of what the crew will actually cut, and a quote
 * that pretends otherwise comes back as a complaint.
 */

// --- Planning defaults -------------------------------------------------------
// Sensible for the market this app is deployed in (PKR, aerial drop off a NAP).
// A project that buys cable at a different price sets it once in /api/settings.

const DEFAULT_CURRENCY = 'PKR';
const DEFAULT_DROP_CABLE_COST_PER_M = 45;
const DEFAULT_LABOUR_COST_PER_DROP = 2500;
const DEFAULT_SPLICE_COST = 350;
const DEFAULT_SPLITTER_COST = 3500;
const DEFAULT_EXTENSION_COST_PER_M = 260;
const DEFAULT_SLACK_PCT = 10;

/** A drop beyond this is not a drop any more: it is an extension build, and
 *  the honest answer to the customer is "yes, with a build", not "yes". */
const DEFAULT_MAX_DROP_M = 150;

/** Beyond this, the answer stops being a sales answer: it needs a network
 *  planner and probably a new feeder, so the API says so instead of pricing it. */
const DEFAULT_MAX_EXTENSION_M = 500;

/** Length uncertainty of a route-derived drop: the band is ±this on the cable
 *  and the work that scales with it. Not a margin — a spread. */
const LENGTH_BAND_PCT = 15;

const RATE_FIELDS = [
  'drop_cable_cost_per_m',
  'labour_cost_per_drop',
  'splice_cost',
  'splitter_cost',
  'extension_cost_per_m',
];

const COST_SETTINGS_FIELDS = [...RATE_FIELDS, 'currency', 'slack_pct', 'max_drop_m', 'max_extension_m'];

// --- Small helpers -----------------------------------------------------------

/** pg returns decimals as strings ("45.00"); anything non-numeric becomes null. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/** Money, in whole units: a quote with paisa in it reads like a spreadsheet. */
function money(value) {
  return Math.round(Number(value) || 0);
}

// --- Settings resolution -----------------------------------------------------

/**
 * Merge project settings + explicit overrides into the effective rate card.
 * A NULL column (or a blank the operator cleared) falls back to the default.
 */
function resolveCostModel(settings = {}) {
  const overrides = {};
  for (const field of RATE_FIELDS) {
    const value = num(settings[field]);
    if (value != null && value >= 0) overrides[field] = value;
  }
  const slack = num(settings.slack_pct);
  const maxDrop = num(settings.max_drop_m);
  const maxExtension = num(settings.max_extension_m);
  const currency =
    typeof settings.currency === 'string' && settings.currency.trim()
      ? settings.currency.trim().toUpperCase()
      : DEFAULT_CURRENCY;

  return {
    currency,
    drop_cable_cost_per_m: overrides.drop_cable_cost_per_m ?? DEFAULT_DROP_CABLE_COST_PER_M,
    labour_cost_per_drop: overrides.labour_cost_per_drop ?? DEFAULT_LABOUR_COST_PER_DROP,
    splice_cost: overrides.splice_cost ?? DEFAULT_SPLICE_COST,
    splitter_cost: overrides.splitter_cost ?? DEFAULT_SPLITTER_COST,
    extension_cost_per_m: overrides.extension_cost_per_m ?? DEFAULT_EXTENSION_COST_PER_M,
    slack_pct: slack != null && slack >= 0 ? slack : DEFAULT_SLACK_PCT,
    // Thresholds are distances, not money: they must also be *positive* to be
    // usable, and a nonsensical one falls back rather than answering 0 m.
    max_drop_m: maxDrop != null && maxDrop > 0 ? Math.round(maxDrop) : DEFAULT_MAX_DROP_M,
    max_extension_m:
      maxExtension != null && maxExtension > 0 ? Math.round(maxExtension) : DEFAULT_MAX_EXTENSION_M,
    // Which of the rates above are the project's own numbers, so the answer can
    // say "these are defaults" without the caller diffing two objects.
    overridden: Object.keys(overrides).concat(
      slack != null && slack >= 0 ? ['slack_pct'] : [],
      maxDrop != null && maxDrop > 0 ? ['max_drop_m'] : [],
      maxExtension != null && maxExtension > 0 ? ['max_extension_m'] : [],
      currency !== DEFAULT_CURRENCY ? ['currency'] : [],
    ),
  };
}

/**
 * Validate + normalize a project-settings PATCH body for the cost fields.
 * Blank string clears an override, exactly like the loss-budget fields.
 * Returns { updates } or { error }.
 */
function sanitizeCostSettingsPatch(body = {}) {
  const updates = {};
  const errors = [];

  for (const field of COST_SETTINGS_FIELDS) {
    if (body[field] === undefined) continue;
    const raw = body[field];

    if (field === 'currency') {
      if (raw === '' || raw === null) {
        updates.currency = null;
        continue;
      }
      const text = String(raw).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(text)) {
        errors.push('currency must be a 3-letter code (e.g. PKR)');
        continue;
      }
      updates.currency = text;
      continue;
    }

    const value = num(raw);
    if (raw === '' || raw === null) {
      updates[field] = null; // clear → fall back to the default
      continue;
    }
    if (value == null) {
      errors.push(`${field} must be a number`);
      continue;
    }
    if (field === 'max_drop_m' || field === 'max_extension_m') {
      if (!Number.isInteger(value) || value <= 0) {
        errors.push(`${field} must be a whole number of metres above 0`);
        continue;
      }
      updates[field] = value;
      continue;
    }
    if (value < 0) {
      errors.push(`${field} cannot be negative`);
      continue;
    }
    if (field === 'slack_pct' && value > 100) {
      errors.push('slack_pct is a percentage over the measured length (max 100)');
      continue;
    }
    updates[field] = value;
  }

  if (errors.length) return { error: errors.join('; ') };
  if (Object.keys(updates).length === 0) return { error: 'No valid cost fields to update' };
  return { updates };
}

// --- The estimate ------------------------------------------------------------

/**
 * What the connection needs at the box, which is what changes the price:
 *
 *   port     — a free splitter port exists: assign it, run the drop, splice.
 *   splitter — no free port (every port taken, or no splitter at all yet):
 *              a splitter has to be installed or replaced first.
 *   capacity — the box has no spare fibre either: capacity work is needed at a
 *              box that does have room (caller names it), so the drop price
 *              stops applying and the line says "survey".
 */
const NEEDS = ['port', 'splitter', 'capacity'];

/**
 * Price a drop from a box to a customer.
 *
 * `drop_m` is the measured length (street route when we have one, straight line
 * otherwise — the caller says which, and it lands in `assumptions`). `needs`
 * is one of NEEDS. `settings` is the resolved cost model.
 *
 * Returns:
 *   currency, lines[{ item, detail, quantity, unit, unit_cost, amount }],
 *   subtotal, total, band{ low, typical, high }, assumptions[], survey_required
 *
 * The band moves the length (±LENGTH_BAND_PCT) and everything that scales with
 * it — never the fixed rates — so "PKR 5,900 – 7,100" is a claim about the
 * survey, not about the pricelist.
 */
function estimateDropCost({ drop_m, needs = 'port', settings = {}, extension_m = 0 } = {}) {
  const model = resolveCostModel(settings);
  const lines = [];
  const assumptions = [];

  const length = Math.max(0, Math.round(Number(drop_m) || 0));
  const cableM = Math.round(length * (1 + model.slack_pct / 100));
  const extensionLength = Math.max(0, Math.round(Number(extension_m) || 0));

  const add = (item, detail, quantity, unit, unit_cost) => {
    lines.push({
      item,
      detail,
      quantity,
      unit,
      unit_cost: money(unit_cost * 100) / 100,
      amount: money(Number(quantity) * Number(unit_cost)),
    });
  };

  // The cable is only priced when there is a settled box to run it from. In the
  // capacity case the serving box is exactly what is not decided yet, so a cable
  // quantity would be a guess dressed up as a measurement — the work at the box
  // (and the survey that settles the rest) is what can be quoted.
  const priceCable = needs !== 'capacity';
  if (priceCable && cableM > 0) {
    add('drop cable', 'aerial drop, cut length including slack', cableM, 'm', model.drop_cable_cost_per_m);
  }
  add('drop installation', 'one crew, one drop', 1, 'drop', model.labour_cost_per_drop);
  add('splice at the box', 'fusion splice onto the assigned port', 1, 'splice', model.splice_cost);

  if (needs === 'splitter') {
    add('splitter', 'installed in the serving box to free a port', 1, 'unit', model.splitter_cost);
  }

  if (extensionLength > 0) {
    // The fibre has to reach the serving box first. Poles are assumed to be in
    // place (a build that needs new poles is a design job, not a quote).
    add('extension build', 'aerial cable, hardware and labour', extensionLength, 'm', model.extension_cost_per_m);
    assumptions.push(
      'the extension is priced per metre of aerial cable with poles assumed in place — ' +
        'a route that needs new poles needs a survey',
    );
  }

  const survey_required = needs === 'capacity';
  const priced = lines.reduce((total, line) => total + line.amount, 0);

  // The band: a shorter and a longer build of the same work. Lines that scale
  // with length move; the fixed ones (labour, splice, splitter) do not.
  const scaled = (factor) =>
    lines.reduce((total, line) => {
      const withLength = ['drop cable', 'extension build'].includes(line.item);
      return total + (withLength ? money(line.amount * factor) : line.amount);
    }, 0);

  assumptions.push(
    `rates are the project's planning defaults unless /api/settings overrides them ` +
      `(currency ${model.currency})`,
  );
  if (!priceCable) {
    assumptions.push(
      'no drop cable is priced: capacity has to be brought into this box before the serving box — and ' +
        'so the length of the run — is known. The figure covers the work at the box only.',
    );
  }
  if (model.slack_pct > 0 && cableM > length) {
    assumptions.push(`cable quantity adds ${model.slack_pct}% slack over the measured ${length} m`);
  }

  return {
    currency: model.currency,
    needs: NEEDS.includes(needs) ? needs : 'port',
    drop_length_m: length,
    cable_length_m: cableM,
    lines,
    subtotal: priced,
    total: priced,
    band: {
      low: scaled(1 - LENGTH_BAND_PCT / 100),
      typical: priced,
      high: scaled(1 + LENGTH_BAND_PCT / 100),
    },
    survey_required,
    assumptions,
  };
}

/** "PKR 6,400" — the one place money is turned into words. */
function formatMoney(amount, currency = DEFAULT_CURRENCY) {
  const rounded = money(amount);
  return `${currency} ${rounded.toLocaleString('en-US')}`;
}

/** "PKR 5,900 – 7,100" (band), or just the total when they are the same. */
function formatBand(band, currency = DEFAULT_CURRENCY) {
  if (!band) return null;
  if (band.low === band.high) return formatMoney(band.typical, currency);
  return `${formatMoney(band.low, currency)} – ${formatMoney(band.high, currency)}`;
}

module.exports = {
  estimateDropCost,
  resolveCostModel,
  sanitizeCostSettingsPatch,
  formatMoney,
  formatBand,
  money,
  NEEDS,
  RATE_FIELDS,
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
  LENGTH_BAND_PCT,
};
