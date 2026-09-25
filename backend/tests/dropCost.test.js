/**
 * Unit tests for the drop-cost math (pure — no database).
 *
 * The point of these is that a quoted price is *explainable*: every line names
 * the rate it used, the band comes from length uncertainty rather than from
 * padding, and an operator's own rates replace the defaults everywhere at once.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateDropCost,
  resolveCostModel,
  sanitizeCostSettingsPatch,
  formatMoney,
  formatBand,
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
} = require('../src/utils/dropCost');

describe('resolveCostModel', () => {
  test('an empty row is the planning defaults, currency included', () => {
    const model = resolveCostModel({});
    assert.equal(model.currency, DEFAULT_CURRENCY);
    assert.equal(model.drop_cable_cost_per_m, DEFAULT_DROP_CABLE_COST_PER_M);
    assert.equal(model.labour_cost_per_drop, DEFAULT_LABOUR_COST_PER_DROP);
    assert.equal(model.splice_cost, DEFAULT_SPLICE_COST);
    assert.equal(model.splitter_cost, DEFAULT_SPLITTER_COST);
    assert.equal(model.extension_cost_per_m, DEFAULT_EXTENSION_COST_PER_M);
    assert.equal(model.slack_pct, DEFAULT_SLACK_PCT);
    assert.equal(model.max_drop_m, DEFAULT_MAX_DROP_M);
    assert.equal(model.max_extension_m, DEFAULT_MAX_EXTENSION_M);
    assert.deepEqual(model.overridden, [], 'nothing is overridden yet');
  });

  test('a PATCHed rate replaces the default and is named in overridden', () => {
    const model = resolveCostModel({ drop_cable_cost_per_m: '52.50' });
    assert.equal(model.drop_cable_cost_per_m, 52.5);
    assert.deepEqual(model.overridden, ['drop_cable_cost_per_m']);
  });

  test('a decimal string from Postgres is a number here, not NaN', () => {
    const model = resolveCostModel({ splice_cost: '350.00', slack_pct: '0.00' });
    assert.equal(model.splice_cost, 350);
    assert.equal(model.slack_pct, 0, 'an operator may genuinely want no slack');
  });

  test('nonsensical values fall back rather than producing a 0 m drop', () => {
    const model = resolveCostModel({ max_drop_m: 0, max_extension_m: -5, drop_cable_cost_per_m: -1 });
    assert.equal(model.max_drop_m, DEFAULT_MAX_DROP_M);
    assert.equal(model.max_extension_m, DEFAULT_MAX_EXTENSION_M);
    assert.equal(model.drop_cable_cost_per_m, DEFAULT_DROP_CABLE_COST_PER_M);
  });

  test('a lowercase currency code is normalised', () => {
    assert.equal(resolveCostModel({ currency: ' usd ' }).currency, 'USD');
  });
});

describe('estimateDropCost', () => {
  const at = (overrides = {}, settings = {}) =>
    estimateDropCost({ drop_m: 40, needs: 'port', settings, ...overrides });

  test('a 40 m drop off a free port is cable + labour + one splice', () => {
    const quote = at();
    assert.equal(quote.currency, DEFAULT_CURRENCY);
    assert.equal(quote.drop_length_m, 40);
    assert.equal(quote.cable_length_m, Math.round(40 * (1 + DEFAULT_SLACK_PCT / 100)), 'slack is added to the cut length');
    const items = quote.lines.map((line) => line.item);
    assert.deepEqual(items, ['drop cable', 'drop installation', 'splice at the box']);
    assert.equal(quote.total, 44 * DEFAULT_DROP_CABLE_COST_PER_M + DEFAULT_LABOUR_COST_PER_DROP + DEFAULT_SPLICE_COST);
    assert.equal(quote.subtotal, quote.total);
  });

  test('every line multiplies out to its amount, and they sum to the total', () => {
    const quote = at({ needs: 'splitter' });
    for (const line of quote.lines) {
      assert.equal(line.amount, Math.round(line.quantity * line.unit_cost), `${line.item} amount`);
    }
    assert.equal(
      quote.lines.reduce((sum, line) => sum + line.amount, 0),
      quote.total,
      'the lines are the price — there is nothing hidden in the total',
    );
  });

  test('a full splitter adds exactly one splitter to the price', () => {
    const port = at();
    const splitter = at({ needs: 'splitter' });
    assert.equal(splitter.total - port.total, DEFAULT_SPLITTER_COST);
    assert.ok(splitter.lines.some((line) => line.item === 'splitter'));
  });

  test('capacity work prices no drop — it is a survey, not a quote', () => {
    const quote = at({ needs: 'capacity' });
    assert.equal(quote.survey_required, true);
    assert.equal(quote.total, DEFAULT_LABOUR_COST_PER_DROP + DEFAULT_SPLICE_COST, 'no cable is priced for a box that cannot take the drop');
  });

  test('the band moves only the length, not the fixed work', () => {
    const quote = at();
    const cable = quote.lines.find((line) => line.item === 'drop cable').amount;
    assert.equal(quote.band.typical, quote.total);
    assert.equal(quote.band.low, quote.total - Math.round(cable * (LENGTH_BAND_PCT / 100)));
    assert.equal(quote.band.high, quote.total + Math.round(cable * (LENGTH_BAND_PCT / 100)));
    assert.ok(quote.band.low < quote.band.high);
  });

  test('the project\'s own rates are what gets used', () => {
    const quote = estimateDropCost({
      drop_m: 100,
      needs: 'port',
      settings: { currency: 'usd', drop_cable_cost_per_m: 2, labour_cost_per_drop: 80, splice_cost: 10, slack_pct: 0 },
    });
    assert.equal(quote.currency, 'USD');
    assert.equal(quote.cable_length_m, 100, 'slack_pct 0 means no slack');
    assert.equal(quote.total, 200 + 80 + 10);
  });

  test('an extension build is priced per metre on top of the drop', () => {
    const quote = estimateDropCost({ drop_m: 0, needs: 'port', settings: {}, extension_m: 300 });
    assert.equal(quote.drop_length_m, 0);
    assert.ok(quote.lines.some((line) => line.item === 'extension build'));
    assert.equal(quote.total, 300 * DEFAULT_EXTENSION_COST_PER_M + DEFAULT_LABOUR_COST_PER_DROP + DEFAULT_SPLICE_COST);
    assert.ok(quote.assumptions.some((a) => /poles/.test(a)), 'the pole assumption is stated, not implied');
  });

  test('a zero-length run still prices the work that happens at the box', () => {
    const quote = estimateDropCost({ drop_m: 0, needs: 'port', settings: {} });
    assert.equal(quote.lines.some((line) => line.item === 'drop cable'), false);
    assert.equal(quote.total, DEFAULT_LABOUR_COST_PER_DROP + DEFAULT_SPLICE_COST);
  });

  test('garbage lengths and needs degrade instead of throwing', () => {
    const quote = estimateDropCost({ drop_m: 'nonsense', needs: 'teleport', settings: {} });
    assert.equal(quote.drop_length_m, 0);
    assert.equal(quote.needs, 'port');
    assert.ok(Number.isFinite(quote.total));
  });
});

describe('sanitizeCostSettingsPatch', () => {
  test('blank clears an override back to the default', () => {
    const { updates } = sanitizeCostSettingsPatch({ splice_cost: '' });
    assert.deepEqual(updates, { splice_cost: null });
  });

  test('the loss-budget fields are left to the other validator', () => {
    const { updates } = sanitizeCostSettingsPatch({ olt_type: 'gpon', budget_db: 28 });
    assert.equal(updates, undefined);
  });

  test('a negative rate is refused with the field named', () => {
    const { error } = sanitizeCostSettingsPatch({ labour_cost_per_drop: -5 });
    assert.match(error, /labour_cost_per_drop cannot be negative/);
  });

  test('currency must look like a currency code', () => {
    assert.match(sanitizeCostSettingsPatch({ currency: 'rupees' }).error, /3-letter code/);
    assert.equal(sanitizeCostSettingsPatch({ currency: 'pkr' }).updates.currency, 'PKR');
  });

  test('distances must be whole positive metres', () => {
    assert.match(sanitizeCostSettingsPatch({ max_drop_m: 12.5 }).error, /whole number of metres/);
    assert.match(sanitizeCostSettingsPatch({ max_drop_m: 0 }).error, /above 0/);
    assert.equal(sanitizeCostSettingsPatch({ max_drop_m: 200 }).updates.max_drop_m, 200);
  });

  test('slack is a percentage, not a multiplier', () => {
    assert.match(sanitizeCostSettingsPatch({ slack_pct: 250 }).error, /max 100/);
    assert.equal(sanitizeCostSettingsPatch({ slack_pct: 15 }).updates.slack_pct, 15);
  });

  test('nothing recognisable is an error, not a silent no-op', () => {
    assert.match(sanitizeCostSettingsPatch({}).error, /No valid cost fields/);
  });
});

describe('money formatting', () => {
  test('whole units with a thousands separator, currency in front', () => {
    assert.equal(formatMoney(6400, 'PKR'), 'PKR 6,400');
    assert.equal(formatMoney(6400.4), 'PKR 6,400');
  });

  test('the band is a range, and a single price when there is no spread', () => {
    assert.equal(formatBand({ low: 5900, typical: 6400, high: 7100 }, 'PKR'), 'PKR 5,900 – PKR 7,100');
    assert.equal(formatBand({ low: 6400, typical: 6400, high: 6400 }, 'PKR'), 'PKR 6,400');
    assert.equal(formatBand(null), null);
  });
});

describe('what the capacity case does not price', () => {
  test('it says why no cable is on the quote', () => {
    const quote = estimateDropCost({ drop_m: 40, needs: 'capacity', settings: {} });
    assert.equal(quote.lines.some((line) => line.item === 'drop cable'), false);
    assert.ok(
      quote.assumptions.some((a) => /no drop cable is priced/.test(a)),
      JSON.stringify(quote.assumptions),
    );
  });

  test('but the work that does happen at the box is still counted', () => {
    const quote = estimateDropCost({ drop_m: 40, needs: 'capacity', settings: {} });
    assert.equal(quote.total, DEFAULT_LABOUR_COST_PER_DROP + DEFAULT_SPLICE_COST);
  });
});
