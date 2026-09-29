const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const servicePath = require.resolve('../src/services/connectionPlan');
const calls = [];
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    createConnectionPlan: async (params) => {
      calls.push(params);
      if (params.lat == null) return { error: 'address or lat/lng is required', status: 400 };
      return {
        customer_point: { lat: 33.6, lng: 73.05 },
        enclosure: { id: 'box-1', code: 'NAP-1', distance_m: 42 },
        route: {
          source: 'direct_haversine',
          label: 'Direct distance (haversine; not a street route)',
          length_m: 58,
          coordinates: [[73.05, 33.6], [73.0505, 33.6005]],
        },
        connection: {
          type: 'splitter_port',
          splitter: { id: 'split-1', name: 'Tray A' },
          port: { port_number: 3 },
        },
        steps: ['Assign Tray A port 3.', 'Run and test the customer drop.'],
        optical_budget: {
          total_loss_db: 17.4,
          budget_db: 28,
          required_margin_db: 3,
          remaining_margin_db: 10.6,
          status: 'OK',
          breakdown: [
            { type: 'fiber', cable_type: 'drop', loss_db: 0.02, running_db: 17.4 },
            { type: 'splice', loss_db: 0.1, running_db: 17.4 },
          ],
        },
      };
    },
  },
};

const router = require('../src/routes/connectionPlans');
const app = express();
app.use('/api/customer-plans', router);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

let server;
let base;
before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/customer-plans/plan`;
});
after(() => server?.close());

test('plan route exposes route basis, exact capacity, and optical budget without verdict or quote fields', async () => {
  const response = await fetch(`${base}?lat=33.6&lng=73.05`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.route.source, 'direct_haversine');
  assert.equal(body.connection.port.port_number, 3);
  assert.equal(body.optical_budget.remaining_margin_db, 10.6);
  assert.equal(body.steps.length, 2);
  assert.equal('verdict' in body, false);
  assert.equal('serviceable' in body, false);
  assert.equal('quote' in body, false);
  assert.deepEqual(calls.at(-1), {
    address: undefined,
    lat: '33.6',
    lng: '73.05',
    radius_m: undefined,
    limit: undefined,
    route: undefined,
  });
});

test('plan route returns structured validation errors', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /address or lat\/lng/);
});
