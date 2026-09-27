import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPlanDistance,
  routeBasis,
  connectionChoiceLabel,
  budgetTone,
  budgetSummary,
  planClipboardText,
} from './connectionPlanView.js';

const plan = (overrides = {}) => ({
  enclosure: { id: 'box-1', code: 'NAP-1', distance_m: 42 },
  route: { source: 'direct_haversine', length_m: 58 },
  connection: {
    type: 'splitter_port',
    splitter: { id: 'split-1', name: 'Tray A' },
    port: { port_number: 3 },
  },
  optical_budget: {
    status: 'OK',
    total_loss_db: 18.4,
    budget_db: 28,
    required_margin_db: 3,
    remaining_margin_db: 9.6,
    consumes_required_margin: false,
    breakdown: [{ type: 'fiber', loss_db: 0.2, running_db: 0.2 }],
  },
  steps: ['Assign port 3.', 'Run the drop.'],
  ...overrides,
});

test('distance and route labels distinguish a street route from a direct fallback', () => {
  assert.equal(formatPlanDistance(42), '42 m');
  assert.equal(formatPlanDistance(1200), '1.2 km');
  assert.match(routeBasis({ source: 'street_route', length_m: 62 }), /62 m street route/);
  assert.match(routeBasis({ source: 'direct_haversine', length_m: 62 }), /not a street route/);
});

test('capacity labels carry exact splitter port, core, and source choices', () => {
  assert.match(connectionChoiceLabel(plan().connection), /Tray A, port 3/);
  assert.match(connectionChoiceLabel({
    type: 'install_splitter_on_core',
    splitter: { name: 'New 1:8 splitter' },
    core: { core_number: 7, cable_code: 'FD-1' },
  }), /core 7 of FD-1/);
  assert.match(connectionChoiceLabel({
    type: 'bring_capacity',
    source: { source_enclosure: { code: 'NAP-2' } },
  }), /NAP-2/);
});

test('budget status is rendered as a budget result, not a connection verdict', () => {
  assert.equal(budgetTone(plan().optical_budget), 'ok');
  assert.equal(budgetTone({ status: 'MARGINAL' }), 'warn');
  assert.equal(budgetTone({ status: 'UNKNOWN' }), 'unknown');
  assert.match(budgetSummary(plan().optical_budget), /9\.60 dB remaining/);
  assert.match(budgetSummary({ status: 'FAIL', exceeds_budget: true, budget_db: 28, remaining_margin_db: -1 }), /Exceeds/);
});

test('clipboard plan includes ordered steps and every budget breakdown entry', () => {
  const text = planClipboardText(plan());
  assert.match(text, /CUSTOMER CONNECTION PLAN/);
  assert.match(text, /1\. Assign port 3/);
  assert.match(text, /fiber: \+0\.2 dB/);
  assert.equal(text.includes('Can serve'), false);
  assert.equal(text.includes('PKR'), false);
});
