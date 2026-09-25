/**
 * Route-level tests for GET /api/impact/simulate.
 *
 * The service is stubbed out here on purpose: this file is about the HTTP
 * contract the frontend consumes (validation, 404s, radius clamping, the shape
 * of the payload) and about the one piece the service cannot do for itself —
 * turning a *pole* failure into the boxes and spans it takes down. That
 * mapping is geometry, so the test asserts the SQL and parameters the route
 * issues, without needing a live PostGIS.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// --- fixture -------------------------------------------------------------------

const ENCLOSURES = [
  { id: 'box-b', code: 'BOX-B', pole_id: 'pole-1' },
  { id: 'box-c', code: 'BOX-C', pole_id: 'pole-2' },
  // Exists, but the stubbed service is told to blow up on it (below).
  { id: 'box-boom', code: 'BOX-BOOM', pole_id: null },
];
const CABLES = [
  { id: 'cable-d1', code: 'CBL-D1' },
];
const POLES = [
  { id: 'pole-1', code: 'POLE-0001', name: null, pole_type: 'concrete' },
];

// What the stubbed service should hand back (trimmed to what the route relays).
const SERVICE_RESULT = {
  failure: { kind: 'box', id: 'box-b', label: 'BOX-B', box_ids: ['box-b'], cable_ids: [] },
  direction_resolved: true,
  headend: { code: 'OLT-01', root_enclosure_code: 'BOX-OLT' },
  headend_count: 1,
  surface: {},
  affected_count: 2,
  affected: { customer_count: 2, customers: [], boxes: [], cables: [] },
  upstream_reroute_candidates: [],
  restoration: { source_box_ids: [], patch_box_ids: [], options: 0 },
  unreached: { core_ids: [], core_count: 0 },
  warnings: [],
  summary: {},
};

// --- stubs ---------------------------------------------------------------------

const rawCalls = [];
let serviceCall = null;

function fakeDb(table) {
  const eq = [];
  const rows = () => ({ enclosures: ENCLOSURES, cables: CABLES, poles: POLES }[table] || []).filter(
    (row) => eq.every(([col, value]) => row[col] === value),
  );
  const builder = {
    where(arg, value) {
      if (arg && typeof arg === 'object') {
        for (const [col, v] of Object.entries(arg)) eq.push([col, v]);
      } else {
        eq.push([arg, value]);
      }
      return builder;
    },
    select: () => builder,
    orderBy: () => builder,
    first: () => Promise.resolve(rows()[0] || null),
    then: (onFulfilled, onRejected) => Promise.resolve(rows()).then(onFulfilled, onRejected),
  };
  return builder;
}

fakeDb.raw = async (sql, params) => {
  rawCalls.push({ sql, params });
  if (/ST_DWithin\(c\.route/.test(sql)) {
    return { rows: [{ id: 'cable-near' }, { id: 'cable-far' }] };
  }
  if (/ST_Y\(e\.location/.test(sql)) {
    return {
      rows: [
        { id: 'box-b', lat: '34.01', lng: '71.5' },
        { id: 'box-c', lat: null, lng: null },
      ],
    };
  }
  throw new Error(`unexpected raw query: ${sql}`);
};

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const servicePath = require.resolve('../src/services/impactAnalysis');
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    // Failures are driven by the element, because the route binds this
    // function at require time — swapping the export afterwards has no effect.
    simulateFailure: async (params) => {
      serviceCall = params;
      if (params.id === 'box-boom') throw new Error('database on fire');
      return { ...SERVICE_RESULT, failure: { ...SERVICE_RESULT.failure, kind: params.kind } };
    },
  },
};

const impactRouter = require('../src/routes/impact');

// --- harness -------------------------------------------------------------------

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/impact', impactRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/impact/simulate`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const simulate = (query) => fetch(`${base}?${new URLSearchParams(query)}`);

// --- tests ---------------------------------------------------------------------

describe('GET /api/impact/simulate — validation', () => {
  test('kind and id are both required', async () => {
    const res = await simulate({});
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /kind and id are required/);
  });

  test('an unknown kind is rejected by name', async () => {
    const res = await simulate({ kind: 'splice', id: 'x' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /box, pole, cable/);
  });

  test('an element that does not exist is a 404, not an empty outage', async () => {
    for (const kind of ['box', 'cable', 'pole']) {
      const res = await simulate({ kind, id: 'nope' });
      assert.equal(res.status, 404);
      assert.match((await res.json()).error, /not found/i);
    }
  });
});

describe('GET /api/impact/simulate — box and cable', () => {
  test('a box failure is handed to the service with just that box', async () => {
    const res = await simulate({ kind: 'box', id: 'box-b' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.failure.kind, 'box');
    assert.equal(body.failure.pole_radius_m, null);
    assert.deepEqual(serviceCall.boxIds, ['box-b']);
    assert.deepEqual(serviceCall.cableIds, []);
    assert.equal(serviceCall.element.code, 'BOX-B');
    // Box coordinates are loaded so the no-cable-path fallback can measure.
    assert.deepEqual(serviceCall.boxLocations, { 'box-b': { lat: 34.01, lng: 71.5 } });
  });

  test('a cut cable goes to the service as a cable failure', async () => {
    const res = await simulate({ kind: 'cable', id: 'cable-d1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(serviceCall.cableIds, ['cable-d1']);
    assert.deepEqual(serviceCall.boxIds, []);
    assert.equal(body.failure.pole_radius_m, null);
  });
});

describe('GET /api/impact/simulate — pole', () => {
  test('a pole failure resolves the boxes on it and the spans through it', async () => {
    rawCalls.length = 0;
    const res = await simulate({ kind: 'pole', id: 'pole-1' });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.deepEqual(serviceCall.boxIds, ['box-b']); // the box mounted on the pole
    assert.deepEqual(serviceCall.cableIds, ['cable-near', 'cable-far']); // spans within the radius
    assert.equal(serviceCall.element.code, 'POLE-0001');
    assert.equal(body.failure.pole_radius_m, 15); // default when the caller is silent

    const spanQuery = rawCalls.find((call) => /ST_DWithin\(c\.route/.test(call.sql));
    assert.ok(spanQuery, 'the span search should be a PostGIS distance query');
    assert.deepEqual(spanQuery.params, ['pole-1', 15]);
    assert.match(spanQuery.sql, /c\.route IS NOT NULL/);
  });

  test('the radius is clamped to a sane maximum', async () => {
    rawCalls.length = 0;
    await simulate({ kind: 'pole', id: 'pole-1', radius_m: '5000' });
    const spanQuery = rawCalls.find((call) => /ST_DWithin\(c\.route/.test(call.sql));
    assert.deepEqual(spanQuery.params, ['pole-1', 200]);
  });

  test('a nonsense radius falls back to the default instead of NaN', async () => {
    rawCalls.length = 0;
    await simulate({ kind: 'pole', id: 'pole-1', radius_m: 'wide' });
    const spanQuery = rawCalls.find((call) => /ST_DWithin\(c\.route/.test(call.sql));
    assert.deepEqual(spanQuery.params, ['pole-1', 15]);
  });
});

describe('GET /api/impact/simulate — failures', () => {
  test('a service error becomes a 500 with its message', async () => {
    const res = await simulate({ kind: 'box', id: 'box-boom' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'database on fire');
  });
});
