/**
 * Route-level tests for GET/PATCH /api/settings.
 *
 * The settings row now carries two groups of numbers: the optical loss budget
 * (OLT type, budget, safety margin) and the drop-cost rates the serviceability
 * quote uses. They share one PATCH on purpose — an operator sets both on one
 * screen — so the tests are mostly about that merge: a valid field in one group
 * must never be dropped because the other group had a typo in it, and the
 * response always says what the effective rate card is.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// --- a tiny in-memory project_settings row -------------------------------------

let row = {
  id: 'settings-1',
  olt_type: 'gpon',
  budget_db: null,
  safety_margin_db: null,
  currency: null,
  drop_cable_cost_per_m: null,
  labour_cost_per_drop: null,
  splice_cost: null,
  splitter_cost: null,
  extension_cost_per_m: null,
  slack_pct: null,
  max_drop_m: null,
  max_extension_m: null,
  created_at: new Date(),
  updated_at: new Date(),
};

function fakeDb(table) {
  assert.equal(table, 'project_settings');
  const builder = {
    orderBy: () => builder,
    where: () => builder,
    first: async () => ({ ...row }),
    update: async (patch) => {
      // Simulates a database that predates the cost-rate columns. Flag-driven
      // because the route binds `db` at require time: replacing the module
      // export afterwards has no effect (the same trap impactRoute.test.js
      // documents).
      if (fakeDb.failCostPatch && Object.keys(patch).some((key) => key.endsWith('cost_per_m') || key === 'splice_cost' || key === 'slack_pct' || key === 'currency')) {
        const err = new Error('column "drop_cable_cost_per_m" of relation "project_settings" does not exist');
        err.code = '42703';
        throw err;
      }
      row = { ...row, ...patch, updated_at: new Date() };
      return 1;
    },
  };
  return builder;
}
fakeDb.fn = { now: () => new Date() };
fakeDb.raw = async () => ({ rows: [] });

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const settingsRouter = require('../src/routes/settings');

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/settings`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Back to a fresh project_settings row (no overrides) between tests. */
function resetRow() {
  row = {
    id: 'settings-1',
    olt_type: 'gpon',
    budget_db: null,
    safety_margin_db: null,
    currency: null,
    drop_cable_cost_per_m: null,
    labour_cost_per_drop: null,
    splice_cost: null,
    splitter_cost: null,
    extension_cost_per_m: null,
    slack_pct: null,
    max_drop_m: null,
    max_extension_m: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

const patch = (body) =>
  fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('GET /api/settings', () => {
  test('a fresh project gets the defaults, and they are labelled as defaults', async () => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cost_model.currency, 'PKR');
    assert.equal(body.cost_model.drop_cable_cost_per_m, 45);
    assert.deepEqual(body.cost_model.overridden, []);
    assert.equal(body.available.cost_defaults.labour_cost_per_drop, 2500);
    assert.ok(body.available.cost_fields.includes('extension_cost_per_m'));
  });
});

describe('PATCH /api/settings — the two groups of numbers', () => {
  test('a cost rate is stored and shows up in the resolved rate card', async () => {
    const res = await patch({ drop_cable_cost_per_m: 52.5, currency: 'usd' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.settings.drop_cable_cost_per_m, 52.5);
    assert.equal(body.cost_model.drop_cable_cost_per_m, 52.5);
    assert.equal(body.cost_model.currency, 'USD');
    assert.ok(body.cost_model.overridden.includes('drop_cable_cost_per_m'));
  });

  test('a loss-budget field and a cost rate go in one request, and both stick', async () => {
    const res = await patch({ olt_type: 'xgs_pon', splice_cost: 400 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resolved.olt_type, 'xgs_pon');
    assert.equal(body.cost_model.splice_cost, 400);
  });

  test('a typo in one group cannot silently drop the other', async () => {
    const res = await patch({ labour_cost_per_drop: -5, olt_type: 'gpon' });
    assert.equal(res.status, 200, 'the valid field is applied');
    const body = await res.json();
    assert.equal(body.resolved.olt_type, 'gpon');
    assert.match(body.warnings.join(' '), /labour_cost_per_drop cannot be negative/);
    assert.equal(body.cost_model.labour_cost_per_drop, 2500, 'and the bad one is untouched');
  });

  test('both groups invalid is a 400 naming both', async () => {
    const res = await patch({ olt_type: 'quantum', currency: 'rupees' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /olt_type must be one of/);
    assert.match(body.error, /3-letter code/);
  });

  test('an empty PATCH is refused rather than pretending to save', async () => {
    const res = await patch({});
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /No valid fields to update/);
  });

  test('clearing a rate puts the default back', async () => {
    const res = await patch({ splice_cost: '' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.settings.splice_cost, null);
    assert.equal(body.cost_model.splice_cost, 350);
  });
});

describe('a database that predates the cost columns', () => {
  test('PATCHing a rate says which migration is missing, instead of a bare 42703', async () => {
    fakeDb.failCostPatch = true;
    try {
      const res = await patch({ drop_cable_cost_per_m: 60 });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.match(body.error, /20260101000016_serviceability_costs\.js/);
      assert.match(body.error, /npm run db:schema/);
    } finally {
      fakeDb.failCostPatch = false;
    }
  });

  test('and the read side still works: the defaults are reported without them', async () => {
    // A row with none of the cost columns set is exactly what a pre-migration
    // database returns, so the GET has to keep answering (and say what it would use).
    resetRow();
    const res = await fetch(base);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cost_model.drop_cable_cost_per_m, 45, 'the planning default stands in');
    assert.equal(body.cost_model.currency, 'PKR');
    assert.deepEqual(body.cost_model.overridden, []);
  });
});
