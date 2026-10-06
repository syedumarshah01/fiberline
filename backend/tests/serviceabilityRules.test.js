const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SPLICE_LOSS_DB,
  DEFAULT_CONNECTOR_LOSS_DB,
  DEFAULT_FIBER_ATTENUATION_DB_PER_KM,
  SPLITTER_INSERTION_LOSS_DB,
  SAFETY_MARGIN_DB,
  isSpareCore,
  isFreePort,
  calculateLossBudget,
} = require('../src/utils/serviceabilityRules');

describe('authoritative serviceability rules', () => {
  test('uses the production loss defaults without substituting a connector count', () => {
    assert.equal(DEFAULT_SPLICE_LOSS_DB, 0.1);
    assert.equal(DEFAULT_CONNECTOR_LOSS_DB, 0.3);
    assert.equal(DEFAULT_FIBER_ATTENUATION_DB_PER_KM, 0.35);
    assert.deepEqual(SPLITTER_INSERTION_LOSS_DB, { 2: 3.5, 4: 7.2, 8: 10.5, 16: 13.5, 32: 17.3 });
    assert.equal(SAFETY_MARGIN_DB, 3);

    const unknown = calculateLossBudget({ budget_db: 30 });
    assert.equal(unknown.known, false);
    assert.equal(unknown.reason, 'UNKNOWN_TOPOLOGY');
    assert.equal(unknown.detail, 'CONNECTOR_COUNT_UNAVAILABLE');
    assert.deepEqual(unknown.missing, ['connector_count']);
  });

  test('adds fiber, splice, connector, and splitter losses in dB against the explicit budget', () => {
    const result = calculateLossBudget({
      fiber_segments: [{ length_km: 2 }],
      splices: [{}],
      connector_count: 2,
      splitters: [{ split_count: 8 }],
      budget_db: 20,
    });
    assert.equal(result.known, true);
    assert.equal(result.total_loss_db, 11.9);
    assert.equal(result.margin_db, 8.1);
    assert.equal(result.severity, 'OK');
    assert.deepEqual(result.breakdown.map((entry) => entry.type), ['fiber', 'splice', 'splitter', 'connector']);
    assert.equal(result.breakdown.at(-1).loss_db, 0.6);
  });

  test('requires a headend-supplied budget and rejects an unsupported splitter ratio', () => {
    assert.equal(calculateLossBudget({ connector_count: 0 }).reason, 'UNKNOWN_BUDGET');
    const unsupported = calculateLossBudget({
      connector_count: 0,
      budget_db: 30,
      splitters: [{ split_count: 6 }],
    });
    assert.equal(unsupported.known, false);
    assert.equal(unsupported.reason, 'UNKNOWN_TOPOLOGY');
  });

  test('spare cores require explicit zero relationship counts and status=spare', () => {
    const eligible = {
      status: 'spare',
      splice_count: 0,
      termination_count: 0,
      splitter_use_count: 0,
    };
    assert.equal(isSpareCore(eligible), true);
    assert.equal(isSpareCore({ ...eligible, splice_count: 1 }), false);
    assert.equal(isSpareCore({ ...eligible, termination_count: 1 }), false);
    assert.equal(isSpareCore({ ...eligible, splitter_use_count: 1 }), false);
    assert.equal(isSpareCore({ ...eligible, status: 'reserved' }), false);
    assert.equal(isSpareCore({ status: 'spare' }), false, 'missing relationship counts are ambiguous, not zero');
    assert.equal(isSpareCore({ ...eligible, splice_count: null }), false);
  });

  test('splitter ports are free only when known active, enabled, and unconnected', () => {
    const free = { status: 'active', disabled: false, output_core_id: null, output_splitter_id: null };
    assert.equal(isFreePort(free), true);
    assert.equal(isFreePort({ ...free, status: undefined }), false);
    assert.equal(isFreePort({ ...free, disabled: null }), false);
    assert.equal(isFreePort({ ...free, disabled: true }), false);
    assert.equal(isFreePort({ ...free, output_core_id: 'core-1' }), false);
    assert.equal(isFreePort({ ...free, output_splitter_id: 'splitter-1' }), false);
  });
});
