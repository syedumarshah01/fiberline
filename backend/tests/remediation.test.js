const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  findCoreRemediation,
  findPortRemediation,
  findPowerRemediationForCore,
} = require('../src/services/remediation');

function oneHopSnapshot({ missingTargetInventory = false } = {}) {
  return {
    enclosures: [
      { id: 'root', code: 'ROOT', lat: 34, lng: 71, connector_count_in: 1, connector_count_out: 1 },
      {
        id: 'target',
        code: 'TARGET',
        lat: 34.001,
        lng: 71.001,
        connector_count_in: missingTargetInventory ? null : 1,
        connector_count_out: missingTargetInventory ? null : 1,
      },
    ],
    headends: [{ id: 'headend-1', code: 'OLT-1', root_enclosure_id: 'root', budget_db: 30 }],
    cables: [{
      id: 'cable-1',
      code: 'FEEDER-1',
      cable_type: 'feeder',
      status: 'active',
      from_enclosure_id: 'root',
      to_enclosure_id: 'target',
      length_m: 500,
      attenuation_db_per_km: 0.35,
    }],
    cores: [{ id: 'core-1', cable_id: 'cable-1', core_number: 1, status: 'spare' }],
    splices: [],
    splitters: [],
    ports: [],
    terminations: [],
    customers: [],
  };
}

function twoHopPortSnapshot({ splitterInputCoreId = 'core-remote-path' } = {}) {
  return {
    enclosures: [
      { id: 'root', code: 'ROOT', lat: 34, lng: 71, connector_count_in: 0, connector_count_out: 0 },
      { id: 'target', code: 'TARGET', lat: 34.001, lng: 71.001, connector_count_in: 0, connector_count_out: 0 },
      { id: 'remote', code: 'REMOTE', lat: 34.002, lng: 71.002, connector_count_in: 0, connector_count_out: 0 },
    ],
    headends: [{ id: 'headend-1', code: 'OLT-1', root_enclosure_id: 'root', budget_db: 30 }],
    cables: [
      { id: 'cable-1', code: 'FEEDER-1', cable_type: 'feeder', status: 'active', from_enclosure_id: 'root', to_enclosure_id: 'target', length_m: 500 },
      { id: 'cable-2', code: 'FEEDER-2', cable_type: 'feeder', status: 'active', from_enclosure_id: 'target', to_enclosure_id: 'remote', length_m: 500 },
    ],
    cores: [
      { id: 'core-root-path', cable_id: 'cable-1', core_number: 1, status: 'in_use' },
      { id: 'core-remote-path', cable_id: 'cable-2', core_number: 1, status: 'in_use' },
      { id: 'core-isolated', cable_id: 'cable-2', core_number: 2, status: 'spare' },
    ],
    splices: [{ id: 'splice-1', enclosure_id: 'target', core_a_id: 'core-root-path', core_b_id: 'core-remote-path', loss_db: 0.1 }],
    splitters: [{ id: 'splitter-1', enclosure_id: 'remote', name: 'S1', split_count: 8, input_core_id: splitterInputCoreId, insertion_loss_db: 10.5, disabled: false }],
    ports: [{ id: 'port-1', splitter_id: 'splitter-1', port_number: 1, status: 'active', disabled: false, output_core_id: null, output_splitter_id: null }],
    terminations: [],
    customers: [],
  };
}

const CUSTOMER = { lat: 34.002, lng: 71.002 };

describe('conservative remediation handlers', () => {
  test('core remediation budgets measured connector inventory and reports the breakdown', async () => {
    const result = await findCoreRemediation('target', CUSTOMER, {
      snapshot: oneHopSnapshot(),
      excludeSelf: false,
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].budget.connector_count, 4);
    assert.equal(result.candidates[0].budget.breakdown.find((item) => item.type === 'connector').loss_db, 1.2);
  });

  test('core and power remediation fail closed with CONNECTOR_COUNT_UNAVAILABLE', async () => {
    const snapshot = oneHopSnapshot({ missingTargetInventory: true });
    const coreResult = await findCoreRemediation('target', CUSTOMER, { snapshot, excludeSelf: false });
    assert.equal(coreResult.status, 'unknown');
    assert.equal(coreResult.issue.reason, 'CONNECTOR_COUNT_UNAVAILABLE');
    assert.deepEqual(coreResult.candidates, []);

    const powerResult = await findPowerRemediationForCore({
      core_id: 'core-1',
      enclosure_id: 'target',
      customer_location: CUSTOMER,
    }, { snapshot });
    assert.equal(powerResult.status, 'unknown');
    assert.equal(powerResult.issue.reason, 'CONNECTOR_COUNT_UNAVAILABLE');
    assert.deepEqual(powerResult.candidates, []);
  });

  test('local tier-one port selection requires an explicitly active, enabled, free port', async () => {
    const snapshot = {
      enclosures: [{ id: 'target', code: 'TARGET' }],
      splitters: [{ id: 'splitter-1', enclosure_id: 'target', name: 'S1', disabled: false }],
      ports: [
        { id: 'port-1', splitter_id: 'splitter-1', port_number: 1, status: 'active', disabled: false, output_core_id: null, output_splitter_id: null },
        { id: 'port-2', splitter_id: 'splitter-1', port_number: 2, status: 'inactive', disabled: true, output_core_id: null, output_splitter_id: null },
      ],
    };
    const result = await findPortRemediation('target', null, { snapshot });
    assert.equal(result.status, 'ok');
    assert.equal(result.tier, 1);
    assert.deepEqual(result.candidates.map((candidate) => candidate.port_number), [1]);
  });

  test('remote tier-two ports are returned only when the splitter input is on the documented optical path', async () => {
    const connected = await findPortRemediation('target', null, {
      snapshot: twoHopPortSnapshot({ splitterInputCoreId: 'core-remote-path' }),
    });
    assert.equal(connected.status, 'ok');
    assert.equal(connected.tier, 2);
    assert.equal(connected.candidates[0].existing_core_path_valid, true);
    assert.equal(connected.candidates[0].splitter_input_core_id, 'core-remote-path');

    const disconnected = await findPortRemediation('target', null, {
      snapshot: twoHopPortSnapshot({ splitterInputCoreId: 'core-isolated' }),
    });
    assert.notEqual(disconnected.tier, 2);
    assert.deepEqual(disconnected.candidates, []);
  });

  test('tier-three cascade options never propose inactive or customer-serving ports for sacrifice', async () => {
    const base = {
      enclosures: [{ id: 'target', code: 'TARGET' }],
      headends: [],
      cables: [{ id: 'drop-cable', code: 'FEEDER-1', cable_type: 'feeder', status: 'active', from_enclosure_id: 'target', to_enclosure_id: null, customer_id: null }],
      cores: [{ id: 'drop-core', cable_id: 'drop-cable', core_number: 1, status: 'in_use' }],
      splitters: [{ id: 'splitter-1', enclosure_id: 'target', name: 'S1', split_count: 8, input_core_id: 'drop-core', disabled: false }],
      terminations: [],
      customers: [],
    };

    const inactive = await findPortRemediation('target', CUSTOMER, {
      snapshot: {
        ...base,
        ports: [{ id: 'port-1', splitter_id: 'splitter-1', port_number: 1, status: 'inactive', disabled: true, output_core_id: 'drop-core', output_splitter_id: null }],
      },
    });
    assert.equal(inactive.status, 'manual_review_required');
    assert.deepEqual(inactive.candidates, []);

    const customerServing = await findPortRemediation('target', CUSTOMER, {
      snapshot: {
        ...base,
        ports: [{ id: 'port-1', splitter_id: 'splitter-1', port_number: 1, status: 'active', disabled: false, output_core_id: 'drop-core', output_splitter_id: null }],
        terminations: [{ id: 'termination-1', core_id: 'drop-core', customer_id: 'customer-1', customer_label: 'Customer 1' }],
      },
    });
    assert.equal(customerServing.status, 'manual_review_required');
    assert.deepEqual(customerServing.candidates, []);
    assert.equal(customerServing.requires_review, true);
  });
});
