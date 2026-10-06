const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkServiceability,
  connectorCountForEnclosures,
  fullBudgetForState,
} = require('../src/services/serviceability');

describe('serviceability connector inventory', () => {
  test('sums measured counts once per enclosure and fails closed on missing inventory', () => {
    const snapshot = {
      enclosures: [
        { id: 'root', connector_count_in: 1, connector_count_out: 2 },
        { id: 'junction', connector_count_in: 2, connector_count_out: 1 },
        { id: 'unsurveyed', connector_count_in: null, connector_count_out: null },
      ],
    };

    assert.deepEqual(
      connectorCountForEnclosures(snapshot, ['root', 'junction', 'root']),
      {
        known: true,
        connector_count: 6,
        inventory: [
          { enclosure_id: 'root', connector_count_in: 1, connector_count_out: 2 },
          { enclosure_id: 'junction', connector_count_in: 2, connector_count_out: 1 },
        ],
      },
    );
    assert.deepEqual(
      connectorCountForEnclosures(snapshot, ['root', 'unsurveyed']),
      {
        known: false,
        reason: 'CONNECTOR_COUNT_UNAVAILABLE',
        missing: ['connector_count_in', 'connector_count_out'],
        missing_enclosure_ids: ['unsurveyed'],
      },
    );
  });

  test('an unknown connector count makes the full optical budget unknown', () => {
    const budget = fullBudgetForState(
      { fiber_segments: [{ length_m: 500 }], splices: [], splitters: [] },
      30,
      null,
      3,
      null,
    );
    assert.equal(budget.known, false);
    assert.equal(budget.reason, 'UNKNOWN_TOPOLOGY');
    assert.equal(budget.detail, 'CONNECTOR_COUNT_UNAVAILABLE');
  });

  test('customer serviceability reports unknown instead of assuming zero connectors', async () => {
    const snapshot = {
      enclosures: [
        { id: 'root', code: 'ROOT', headend_id: 'headend-1', lat: 34, lng: 71, connector_count_in: 0, connector_count_out: 0 },
        { id: 'target', code: 'TARGET', lat: 34.001, lng: 71.001, connector_count_in: null, connector_count_out: null },
      ],
      headends: [{ id: 'headend-1', code: 'OLT-1', root_enclosure_id: 'root', budget_db: 30 }],
      cables: [{
        id: 'cable-1',
        code: 'FEEDER-1',
        cable_type: 'feeder',
        status: 'active',
        from_enclosure_id: 'root',
        to_enclosure_id: 'target',
        length_m: 1000,
        attenuation_db_per_km: 0.35,
      }],
      cores: [{ id: 'core-1', cable_id: 'cable-1', core_number: 1, status: 'spare' }],
      splices: [],
      splitters: [],
      ports: [],
      terminations: [],
      customers: [],
    };

    const result = await checkServiceability(
      { enclosure_id: 'target', lat: 34.002, lng: 71.002 },
      { snapshot },
    );

    assert.equal(result.status, 'unknown');
    assert.equal(result.power, undefined);
    assert.ok(result.issues.some((item) =>
      item.type === 'UNKNOWN_TOPOLOGY' && item.reason === 'CONNECTOR_COUNT_UNAVAILABLE',
    ));
  });
});
