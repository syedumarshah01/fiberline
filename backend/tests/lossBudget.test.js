/**
 * Unit tests for the pure loss-budget math (no database): fiber attenuation,
 * splice defaults vs measured readings, splitter crossings incl. cascades,
 * connectors, running totals, margins/status, and the input sanitizers.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ATTENUATION_DB_PER_KM,
  DEFAULT_SPLICE_LOSS_DB,
  DEFAULT_CONNECTOR_LOSS_DB,
  SPLITTER_INSERTION_LOSS_DB,
  OLT_BUDGETS_DB,
  BAD_SPLICE_LOSS_DB,
  spliceLossDb,
  splitterLossDb,
  resolveBudget,
  sanitizeSettingsPatch,
  sanitizeAttenuationDbPerKm,
  calculateLossBudget,
} = require('../src/utils/lossBudget');

// --- helpers -----------------------------------------------------------------

const fiber = (over = {}) => ({
  core_id: 'core-1',
  core_number: 1,
  cable_id: 'cbl-1',
  cable_code: 'CBL-1',
  cable_type: 'distribution',
  ...over,
});
const splice = (over = {}) => ({
  splice_id: 'sp-1',
  enclosure_id: 'box-1',
  splice_type: 'fusion',
  ...over,
});

// --- spliceLossDb -------------------------------------------------------------

describe('spliceLossDb', () => {
  test('uses the measured reading when recorded', () => {
    assert.deepEqual(spliceLossDb(splice({ loss_db: 0.15 })), { loss_db: 0.15, measured: true });
  });

  test('pg-style decimal strings are measured too', () => {
    assert.deepEqual(spliceLossDb(splice({ loss_db: '0.22' })), { loss_db: 0.22, measured: true });
  });

  test('falls back to the fusion default when no reading', () => {
    assert.deepEqual(spliceLossDb(splice()), { loss_db: DEFAULT_SPLICE_LOSS_DB.fusion, measured: false });
  });

  test('mechanical splices default higher than fusion', () => {
    const mech = spliceLossDb(splice({ splice_type: 'mechanical' }));
    assert.equal(mech.measured, false);
    assert.ok(mech.loss_db > DEFAULT_SPLICE_LOSS_DB.fusion);
  });

  test('null/empty readings count as un-measured', () => {
    assert.equal(spliceLossDb(splice({ loss_db: null })).measured, false);
    assert.equal(spliceLossDb(splice({ loss_db: '' })).measured, false);
  });
});

// --- splitterLossDb -------------------------------------------------------------

describe('splitterLossDb', () => {
  test('a measured splitter loss wins over the planning table', () => {
    assert.deepEqual(splitterLossDb({ id: 'x', split_count: 4, loss_db: 7.55 }), { loss_db: 7.55, measured: true });
  });

  test('unmeasured splitters use the G.671 planning values', () => {
    assert.deepEqual(splitterLossDb({ id: 'x', split_count: 4 }), { loss_db: SPLITTER_INSERTION_LOSS_DB[4], measured: false });
    assert.deepEqual(splitterLossDb({ id: 'x', split_count: 2 }), { loss_db: SPLITTER_INSERTION_LOSS_DB[2], measured: false });
    assert.deepEqual(splitterLossDb({ id: 'x', split_count: 8 }), { loss_db: SPLITTER_INSERTION_LOSS_DB[8], measured: false });
  });

  test('exotic split ratios fall back to 10·log10(N) + 1 dB', () => {
    const { loss_db, measured } = splitterLossDb({ id: 'x', split_count: 3 });
    assert.equal(measured, false);
    assert.equal(loss_db, 5.77); // 10*log10(3)+1 ≈ 5.77
  });

  test('insertion loss grows with split count', () => {
    assert.ok(SPLITTER_INSERTION_LOSS_DB[8] > SPLITTER_INSERTION_LOSS_DB[4]);
    assert.ok(SPLITTER_INSERTION_LOSS_DB[4] > SPLITTER_INSERTION_LOSS_DB[2]);
  });
});

// --- resolveBudget ---------------------------------------------------------------

describe('resolveBudget', () => {
  test('defaults to GPON Class B+ with a 3 dB safety margin', () => {
    assert.deepEqual(resolveBudget(), {
      olt_type: 'gpon',
      budget_db: OLT_BUDGETS_DB.gpon,
      safety_margin_db: 3,
    });
  });

  test('each OLT type carries its own budget', () => {
    assert.deepEqual(resolveBudget({ olt_type: 'xgs_pon' }).budget_db, OLT_BUDGETS_DB.xgs_pon);
    assert.deepEqual(resolveBudget({ olt_type: 'p2p' }).budget_db, OLT_BUDGETS_DB.p2p);
    assert.notEqual(OLT_BUDGETS_DB.gpon, OLT_BUDGETS_DB.xgs_pon);
  });

  test('unknown OLT types fall back to gpon rather than crashing', () => {
    assert.equal(resolveBudget({ olt_type: 'pon-9000' }).olt_type, 'gpon');
  });

  test('a project budget override beats the type constant', () => {
    const r = resolveBudget({ olt_type: 'gpon', budget_db: '26.5', safety_margin_db: 2 });
    assert.equal(r.budget_db, 26.5);
    assert.equal(r.safety_margin_db, 2);
  });
});

// --- sanitizeSettingsPatch ---------------------------------------------------------

describe('sanitizeSettingsPatch', () => {
  test('passes through valid fields', () => {
    const { updates, error } = sanitizeSettingsPatch({ olt_type: 'xgs_pon', safety_margin_db: 4 });
    assert.ifError(error);
    assert.deepEqual(updates, { olt_type: 'xgs_pon', safety_margin_db: 4 });
  });

  test('blank numeric fields clear the override (fall back to the type default)', () => {
    const { updates, error } = sanitizeSettingsPatch({ budget_db: '', safety_margin_db: '' });
    assert.ifError(error);
    assert.deepEqual(updates, { budget_db: null, safety_margin_db: null });
  });

  test('rejects unknown OLT types', () => {
    assert.match(sanitizeSettingsPatch({ olt_type: 'magic' }).error, /olt_type must be one of/);
  });

  test('rejects non-numeric or non-positive budget values', () => {
    assert.match(sanitizeSettingsPatch({ budget_db: 'lots' }).error, /budget_db must be a positive number/);
    assert.match(sanitizeSettingsPatch({ budget_db: 0 }).error, /budget_db must be a positive number/);
  });

  test('structural fields are not editable; a patch with no valid fields is rejected', () => {
    assert.match(sanitizeSettingsPatch({ id: 'hack' }).error, /No valid fields to update/);
    assert.equal(sanitizeSettingsPatch({}).error, 'No valid fields to update');
  });
});

// --- sanitizeAttenuationDbPerKm -----------------------------------------------------

describe('sanitizeAttenuationDbPerKm', () => {
  test("undefined means \"not sent\" — leave the column untouched", () => {
    assert.deepEqual(sanitizeAttenuationDbPerKm(undefined), { value: undefined });
  });

  test("'' / null clear the override back to the project default", () => {
    assert.deepEqual(sanitizeAttenuationDbPerKm(''), { value: null });
    assert.deepEqual(sanitizeAttenuationDbPerKm(null), { value: null });
  });

  test('numeric strings become numbers (pg decimals arrive as strings)', () => {
    assert.deepEqual(sanitizeAttenuationDbPerKm('0.4'), { value: 0.4 });
    assert.deepEqual(sanitizeAttenuationDbPerKm(0.28), { value: 0.28 });
  });

  test('rejects garbage and negative attenuation', () => {
    assert.match(sanitizeAttenuationDbPerKm('very lossy').error, /non-negative number/);
    assert.match(sanitizeAttenuationDbPerKm(-1).error, /non-negative number/);
  });
});

// --- calculateLossBudget: fiber segments ----------------------------------------------

describe('calculateLossBudget — fiber segments', () => {
  test('fiber loss = length/1000 × attenuation', () => {
    const r = calculateLossBudget([fiber({ length_m: 2000, attenuation_db_per_km: 0.35 })]);
    assert.equal(r.total_loss_db, 0.7);
    const entry = r.breakdown[0];
    assert.equal(entry.type, 'fiber');
    assert.equal(entry.loss_db, 0.7);
    assert.equal(entry.length_m, 2000);
    assert.equal(entry.attenuation_db_per_km, 0.35);
    assert.equal(entry.attenuation_defaulted, false);
  });

  test('a per-cable attenuation override is honored', () => {
    const r = calculateLossBudget([fiber({ length_m: 1000, attenuation_db_per_km: 0.4 })]);
    assert.equal(r.total_loss_db, 0.4);
  });

  test('null attenuation falls back to the singlemode default and is flagged assumed', () => {
    const r = calculateLossBudget([fiber({ length_m: 1000, attenuation_db_per_km: null })]);
    const entry = r.breakdown[0];
    assert.equal(entry.attenuation_defaulted, true);
    assert.equal(entry.attenuation_db_per_km, DEFAULT_ATTENUATION_DB_PER_KM);
    assert.equal(entry.loss_db, 0.35);
  });

  test('pg-style decimal strings are handled', () => {
    const r = calculateLossBudget([fiber({ length_m: '3000.00', attenuation_db_per_km: '0.40' })]);
    assert.equal(r.total_loss_db, 1.2);
  });

  test('a cable with no recorded length contributes nothing and warns', () => {
    const r = calculateLossBudget([fiber({ length_m: null })]);
    const entry = r.breakdown[0];
    assert.equal(entry.loss_db, null);
    assert.equal(entry.length_missing, true);
    assert.equal(r.total_loss_db, 0);
    assert.equal(r.counts.missing_lengths, 1);
    assert.ok(r.warnings.some((w) => /no recorded length/.test(w)));
  });

  test('the same cable visited twice is documented but only counted once', () => {
    const r = calculateLossBudget([
      fiber({ length_m: 1000, attenuation_db_per_km: 0.35 }),
      splice(),
      fiber({ core_id: 'core-2', cable_id: 'cbl-1', core_number: 2, length_m: 1000 }),
    ]);
    // 0.35 dB fiber (counted once) + 0.1 dB default splice — round2'd
    assert.equal(r.total_loss_db, 0.45);
    assert.equal(r.breakdown[2].duplicate_cable, true);
    assert.equal(r.breakdown[2].loss_db, null);
  });
});

// --- calculateLossBudget: splices ------------------------------------------------------

describe('calculateLossBudget — splices', () => {
  test('unmeasured fusion and mechanical splices use their defaults', () => {
    const r = calculateLossBudget([
      splice({ splice_type: 'fusion' }),
      splice({ splice_id: 'sp-2', splice_type: 'mechanical' }),
    ]);
    assert.equal(r.breakdown[0].loss_db, DEFAULT_SPLICE_LOSS_DB.fusion);
    assert.equal(r.breakdown[0].measured, false);
    assert.equal(r.breakdown[1].loss_db, DEFAULT_SPLICE_LOSS_DB.mechanical);
    assert.equal(r.total_loss_db, DEFAULT_SPLICE_LOSS_DB.fusion + DEFAULT_SPLICE_LOSS_DB.mechanical);
    assert.equal(r.counts.assumed_entries, 2);
  });

  test('measured splice readings are used as-is', () => {
    const r = calculateLossBudget([splice({ loss_db: '0.15' })]);
    assert.equal(r.breakdown[0].loss_db, 0.15);
    assert.equal(r.breakdown[0].measured, true);
    assert.equal(r.counts.measured_entries, 1);
  });

  test('a measured splice above the bad-splice threshold is flagged', () => {
    const r = calculateLossBudget([splice({ loss_db: 0.62 })]);
    const entry = r.breakdown[0];
    assert.equal(entry.flagged, 'bad_splice');
    assert.equal(r.counts.flagged_bad_splices, 1);
    assert.ok(r.warnings.some((w) => /bad-splice threshold/.test(w)));
  });

  test('splices at or below the threshold are not flagged', () => {
    assert.equal(calculateLossBudget([splice({ loss_db: BAD_SPLICE_LOSS_DB })]).counts.flagged_bad_splices, 0);
    assert.equal(calculateLossBudget([splice()]).counts.flagged_bad_splices, 0);
  });
});

// --- calculateLossBudget: splitters ----------------------------------------------------

describe('calculateLossBudget — splitter crossings', () => {
  test('a splitter attached to a traced core adds its insertion loss', () => {
    const r = calculateLossBudget(
      [fiber({ core_id: 'c', cable_id: 'd', length_m: 1000 })],
      { splittersByCoreId: { c: [{ id: 'sp1', enclosure_id: 'b1', split_count: 4 }] } },
    );
    const splitterEntry = r.breakdown[0];
    assert.equal(splitterEntry.type, 'splitter');
    assert.equal(splitterEntry.loss_db, SPLITTER_INSERTION_LOSS_DB[4]);
    assert.equal(splitterEntry.measured, false);
    assert.equal(splitterEntry.split_count, 4);
    // fiber (0.35) + splitter (7.2)
    assert.equal(r.total_loss_db, 7.55);
  });

  test('a measured splitter loss wins over the planning value', () => {
    const r = calculateLossBudget(
      [fiber({ core_id: 'c', cable_id: 'd', length_m: 0 })],
      { splittersByCoreId: { c: [{ id: 'sp1', split_count: 8, loss_db: 10.1 }] } },
    );
    assert.equal(r.breakdown[0].loss_db, 10.1);
    assert.equal(r.breakdown[0].measured, true);
  });

  test('cascade parents are counted alongside the child, once each', () => {
    const r = calculateLossBudget(
      [fiber({ core_id: 'c', cable_id: 'd', length_m: 0 })],
      {
        splittersByCoreId: {
          c: [
            { id: 'child', enclosure_id: 'b2', split_count: 2 },
            { id: 'parent', enclosure_id: 'b1', split_count: 8 }, // attached by the service
          ],
        },
      },
    );
    const splitterEntries = r.breakdown.filter((e) => e.type === 'splitter');
    assert.equal(splitterEntries.length, 2);
    assert.equal(
      r.total_loss_db,
      SPLITTER_INSERTION_LOSS_DB[2] + SPLITTER_INSERTION_LOSS_DB[8],
    );
  });

  test('the same splitter reached via several cores is only counted once', () => {
    const shared = { id: 'sp1', enclosure_id: 'b1', split_count: 4 };
    const r = calculateLossBudget(
      [fiber({ core_id: 'a', cable_id: 'x', length_m: 0 }), fiber({ core_id: 'b', cable_id: 'y', length_m: 0 })],
      { splittersByCoreId: { a: [shared], b: [shared] } },
    );
    assert.equal(r.breakdown.filter((e) => e.type === 'splitter').length, 1);
  });
});

// --- calculateLossBudget: connectors ---------------------------------------------------

describe('calculateLossBudget — connectors', () => {
  test('connector hops are priced at the default when unmeasured', () => {
    const r = calculateLossBudget([{ type: 'connector', connector_id: 'cn-1' }]);
    assert.equal(r.breakdown[0].loss_db, DEFAULT_CONNECTOR_LOSS_DB);
    assert.equal(r.breakdown[0].measured, false);
  });

  test('measured connector loss wins', () => {
    const r = calculateLossBudget([{ type: 'connector', loss_db: 0.45 }]);
    assert.equal(r.breakdown[0].loss_db, 0.45);
    assert.equal(r.breakdown[0].measured, true);
  });
});

// --- calculateLossBudget: running totals, margin & status -------------------------------

describe('calculateLossBudget — running totals, margin & status', () => {
  const hops = [
    fiber({ core_id: 'c1', cable_id: 'cb1', length_m: 2000, attenuation_db_per_km: 0.35 }), // 0.7
    splice({ splice_id: 's1', loss_db: 0.15 }),
    fiber({ core_id: 'c2', cable_id: 'cb2', core_number: 2, length_m: 1000, attenuation_db_per_km: 0.35 }), // 0.35
    splice({ splice_id: 's2' }), // 0.1 default
    fiber({ core_id: 'c3', cable_id: 'cb3', core_number: 3, length_m: 1000, attenuation_db_per_km: 0.35 }), // 0.35
  ];

  test('each entry carries a running total in path order', () => {
    const r = calculateLossBudget(hops);
    assert.deepEqual(
      r.breakdown.map((e) => e.running_db),
      [0.7, 0.85, 1.2, 1.3, 1.65],
    );
    assert.equal(r.total_loss_db, 1.65);
  });

  test('margin = budget − total; OK when it clears the safety margin', () => {
    const r = calculateLossBudget(hops, { olt_type: 'gpon' });
    assert.equal(r.margin_db, 28 - 1.65);
    assert.equal(r.status, 'OK');
  });

  test('MARGINAL when the margin survives but is inside the safety margin', () => {
    // 28 dB budget − 26 dB loss = 2 dB margin < 3 dB safety margin
    const r = calculateLossBudget(
      [fiber({ core_id: 'c1', cable_id: 'cb1', length_m: 20000, attenuation_db_per_km: 1.3 })],
      { olt_type: 'gpon' },
    );
    assert.equal(r.total_loss_db, 26);
    assert.equal(r.margin_db, 2);
    assert.equal(r.status, 'MARGINAL');
  });

  test('FAIL when the path eats the whole budget', () => {
    const r = calculateLossBudget(
      [fiber({ core_id: 'c1', cable_id: 'cb1', length_m: 40000, attenuation_db_per_km: 1.0 })],
      { olt_type: 'gpon' },
    );
    assert.equal(r.total_loss_db, 40);
    assert.equal(r.status, 'FAIL');
    assert.ok(r.margin_db <= 0);
  });

  test('project budget and safety-margin overrides change the verdict', () => {
    const loss = [fiber({ core_id: 'c1', cable_id: 'cb1', length_m: 25000, attenuation_db_per_km: 1.0 })]; // 25 dB
    assert.equal(calculateLossBudget(loss, { olt_type: 'gpon' }).status, 'MARGINAL'); // margin 3, not > 3
    assert.equal(
      calculateLossBudget(loss, { olt_type: 'gpon', budget_db: 24 }).status,
      'FAIL',
    );
    assert.equal(
      calculateLossBudget(loss, { olt_type: 'gpon', safety_margin_db: 1 }).status,
      'OK',
    );
  });

  test('segments in the generic {type: …} shape are accepted too', () => {
    const r = calculateLossBudget([
      { type: 'fiber', cable_id: 'z', cable_code: 'Z', length_m: 1000, attenuation_db_per_km: 0.35 },
      { type: 'splice', id: 's9', box_id: 'b9', splice_type: 'fusion' },
    ]);
    assert.equal(r.total_loss_db, 0.45); // 0.35 fiber + 0.1 default fusion splice
    assert.equal(r.breakdown[1].splice_id, 's9');
    assert.equal(r.breakdown[1].box_id, 'b9');
  });

  test('empty path → zero loss, full margin, OK', () => {
    const r = calculateLossBudget([]);
    assert.equal(r.total_loss_db, 0);
    assert.equal(r.status, 'OK');
  });
});
