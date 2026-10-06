const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateLossBudget } = require('../src/utils/lossBudget');
const {
  routePlan,
  chooseConnection,
  buildConnectionPlan,
} = require('../src/utils/connectionPlan');
const { haversineMeters } = require('../src/services/streetRoute');

const point = { lat: 33.6000, lng: 73.0500 };
const enclosure = {
  id: 'box-1',
  code: 'NAP-1',
  lat: 33.6005,
  lng: 73.0505,
  distance_m: 70,
};

function budgetBase() {
  return calculateLossBudget([
    { type: 'fiber', core_id: 'upstream', cable_id: 'feeder-1', cable_code: 'F-1', length_m: 1000, attenuation_db_per_km: 0.35 },
    { type: 'splice', splice_type: 'fusion' },
  ], { olt_type: 'gpon', safety_margin_db: 3 });
}

describe('connection plan route basis', () => {
  test('keeps a successful street route and its geometry', () => {
    const route = routePlan(point, enclosure, {
      source: 'street_route',
      length_m: 92,
      coordinates: [[73.05, 33.6], [73.049, 33.601]],
    }, haversineMeters);
    assert.equal(route.source, 'street_route');
    assert.equal(route.length_m, 92);
    assert.deepEqual(route.coordinates[1], [73.049, 33.601]);
    assert.equal(route.is_street_route, true);
  });

  test('uses a labelled direct haversine line when routing fails', () => {
    const route = routePlan(point, enclosure, null, haversineMeters);
    assert.equal(route.source, 'direct_haversine');
    assert.equal(route.is_street_route, false);
    assert.match(route.label, /not a street route/);
    assert.equal(route.coordinates.length, 2);
    assert.ok(route.length_m > 0);
  });
});

describe('connection plan capacity choices', () => {
  test('names the exact existing splitter and port', () => {
    const connection = chooseConnection({
      enclosure,
      splitterPorts: [{ splitter_id: 'split-1', splitter_name: 'Tray A', port_number: 4, split_count: 8, input_core_id: 'core-in' }],
      availableCores: [{ id: 'core-available', core_number: 9, cable_code: 'D-1' }],
    });
    assert.equal(connection.type, 'splitter_port');
    assert.equal(connection.splitter.id, 'split-1');
    assert.equal(connection.port.port_number, 4);
  });

  test('chooses an exact free core and explains that a splitter is new', () => {
    const connection = chooseConnection({
      enclosure,
      splitterPorts: [],
      availableCores: [{ id: 'core-available', core_number: 9, cable_code: 'D-1' }],
    });
    assert.equal(connection.type, 'install_splitter_on_core');
    assert.equal(connection.core.core_number, 9);
    assert.match(connection.splitter.name, /1:8/);
  });

  test('carries the connected source path when the target has neither option', () => {
    const connection = chooseConnection({
      enclosure,
      splitterPorts: [],
      availableCores: [],
      source: {
        source_enclosure_id: 'box-2',
        source_enclosure: { id: 'box-2', code: 'NAP-2' },
        source_core: { id: 'core-source', core_number: 2, cable_code: 'F-2' },
        path: [{ cable_id: 'c-1', cable_code: 'F-2', from_code: 'NAP-2', to_code: 'NAP-1', length_m: 400 }],
      },
    });
    assert.equal(connection.type, 'bring_capacity');
    assert.equal(connection.source.source_core.core_number, 2);
    assert.equal(connection.source.path[0].cable_code, 'F-2');
  });
});

describe('connection plan optical budget', () => {
  test('exposes drop fiber, splice and splitter losses with the remaining margin', () => {
    const plan = buildConnectionPlan({
      point,
      enclosure,
      haversine: haversineMeters,
      splitterPorts: [],
      availableCores: [{ id: 'core-available', core_number: 9, cable_code: 'D-1', length_m: 800 }],
      settings: { olt_type: 'gpon', budget_db: 28, safety_margin_db: 3 },
      baseBudget: budgetBase(),
    });
    assert.equal(plan.connection.type, 'install_splitter_on_core');
    assert.ok(plan.optical_budget.breakdown.some((entry) => entry.type === 'fiber' && entry.cable_type === 'drop'));
    assert.ok(plan.optical_budget.breakdown.some((entry) => entry.type === 'splice'));
    assert.ok(plan.optical_budget.breakdown.some((entry) => entry.type === 'splitter'));
    assert.equal(typeof plan.optical_budget.remaining_margin_db, 'number');
    assert.equal(plan.optical_budget.budget_db, 28);
    assert.equal(plan.optical_budget.required_margin_db, 3);
    assert.ok(plan.steps.length >= 3);
    assert.match(plan.steps[0], /core 9 on D-1/);
    assert.match(plan.steps[1], /New 1:8 splitter/);
    assert.match(plan.steps.at(-1), /port 1/);
  });

  test('does not claim a safe result when the existing OLT path is unknown', () => {
    const plan = buildConnectionPlan({
      point,
      enclosure,
      haversine: haversineMeters,
      splitterPorts: [{ splitter_id: 'split-1', splitter_name: 'Tray A', port_number: 1, input_core_id: null }],
      availableCores: [],
      settings: { olt_type: 'gpon', budget_db: 28, safety_margin_db: 3 },
    });
    assert.equal(plan.optical_budget.status, 'UNKNOWN');
    assert.ok(plan.optical_budget.warnings.some((warning) => /not traceable/.test(warning)));
  });

  test('flags a plan that consumes the required safety margin', () => {
    const plan = buildConnectionPlan({
      point,
      enclosure,
      haversine: haversineMeters,
      splitterPorts: [],
      availableCores: [{ id: 'core-available', core_number: 9, cable_code: 'D-1' }],
      settings: { olt_type: 'gpon', budget_db: 10.5, safety_margin_db: 3 },
      baseBudget: budgetBase(),
    });
    assert.equal(plan.optical_budget.exceeds_budget, true);
    assert.equal(plan.optical_budget.status, 'FAIL');
    assert.ok(plan.optical_budget.warnings.some((warning) => /exceeds/.test(warning)));
  });
});
