/**
 * Route-level tests for GET /api/serviceability/check (+ /text, /sheet).
 *
 * services/serviceability.js is stubbed: this file is about the HTTP contract
 * the CSR screen and the field phone consume — validation, the shape of the
 * payload, plain-text output, the install sheet — while the arithmetic behind
 * the verdict is covered by tests/serviceability.test.js and the address
 * matching by tests/addressMatch.test.js.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// --- fixture -------------------------------------------------------------------

const ASSESSMENT = {
  point: { lat: 33.6, lng: 73.05 },
  verdict: 'serviceable',
  verdict_label: 'Can serve',
  verdict_detail: 'a box is within drop range and can take the connection today',
  serviceable: true,
  serviceable_now: true,
  requires_work: false,
  requires_build: false,
  survey_required: false,
  confidence: 'high',
  confidence_reason: 'street route measured and a free port confirmed',
  summary: 'Can serve — NAP-12 is 40 m away (2 free ports); run ≈ 62 m, PKR 5,300 – 6,500.',
  nearest_box: { id: 'nap12', code: 'NAP-12', distance_m: 40, free_ports: 2, free_port_numbers: [3, 5] },
  recommended_box: { id: 'nap12', code: 'NAP-12', name: null, distance_m: 40, free_ports: 2, free_port_numbers: [3, 5], splitter_name: 'Tray A', available_cores: 4, needs: 'port' },
  connection: { needs: 'port', label: 'Free splitter port available', detail: 'NAP-12 has 2 free splitter ports (3, 5)' },
  distance: { to_nearest_m: 40, to_recommended_m: 40, run_m: 62, run_source: 'street_route' },
  drop: { length_m: 62, cable_length_m: 69, source: 'street_route', route: [[73.05, 33.6], [73.0505, 33.6005]] },
  extension: null,
  quote: {
    currency: 'PKR',
    total: 5905,
    band: { low: 5480, typical: 5905, high: 6330 },
    lines: [{ item: 'drop cable', detail: 'aerial drop', quantity: 69, unit: 'm', unit_cost: 45, amount: 3105 }],
    assumptions: ['rates are the project\'s planning defaults'],
    survey_required: false,
  },
  alternatives: [],
  suggested_source: null,
  searched: { radius_m: 500, boxes_seen: 3, boxes_within_drop_m: 2 },
  warnings: [],
  next_steps: ['Assign a free splitter port in NAP-12 (port 3, or 5).'],
  query: { input: 'House 12-B, Street 4', label: 'House 12-B, Street 4 (CUST-1)', source: 'customer_address' },
};

// --- stubs ---------------------------------------------------------------------

const calls = [];

const servicePath = require.resolve('../src/services/serviceability');
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    checkServiceability: async (params) => {
      calls.push(params);
      // The route passes raw query strings through; the service does the casting.
      if (String(params.address || '').includes('nowhere')) {
        return {
          error: 'Address could not be matched to a location',
          status: 404,
          address: params.address,
          candidates: [{ kind: 'customer', id: 'c9', code: 'CUST-9', score: 0.4, placeable: true }],
          warnings: [],
          hint: 'Pass lat/lng',
        };
      }
      if (params.address == null && params.lat == null) {
        return { error: 'address or lat/lng is required', status: 400 };
      }
      if (String(params.address || '').includes('far away')) {
        return {
          ...ASSESSMENT,
          verdict: 'out_of_reach',
          verdict_label: 'Cannot serve',
          recommended_box: null,
          next_steps: ['Hand it to network planning.'],
        };
      }
      return { ...ASSESSMENT, query: { ...ASSESSMENT.query, input: params.address ?? null } };
    },
  },
};

// The install sheet needs box documentation and the continuation links; both are
// stubbed down to what the route reads.
const docPath = require.resolve('../src/services/boxDocumentation');
require.cache[docPath] = {
  id: docPath,
  filename: docPath,
  loaded: true,
  exports: {
    loadBoxDocumentation: async ({ enclosureId }) => {
      if (enclosureId !== 'nap12') return null;
      return {
        enclosure: { id: 'nap12', code: 'NAP-12', name: null, type: 'nap' },
        summary: { total_cables: 2, total_cores: 8, spliced_cores: 1, available_cores: 4, damaged_cores: 0 },
        cables_landing_here: [],
        splices: [],
        splitters: [],
        qc_flags: { bad_splice_threshold_db: 0.5, bad_splices: [] },
      };
    },
  },
};

// Mid-span links read the database; the stub answers "no joints here", which is
// also what the route's own try/catch would do — minus the connection noise.
const linksPath = require.resolve('../src/utils/continuationLinks');
require.cache[linksPath] = {
  id: linksPath,
  filename: linksPath,
  loaded: true,
  exports: {
    loadContinuationLinks: async () => ({ childToParent: new Map(), byId: new Map(), inferred: false }),
  },
};

const workOrdersPath = require.resolve('../src/routes/workOrders');
delete require.cache[workOrdersPath];

const serviceabilityRouter = require('../src/routes/serviceability');

// --- harness -------------------------------------------------------------------

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/serviceability', serviceabilityRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/serviceability/check`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const check = (query) => fetch(`${base}?${new URLSearchParams(query)}`);

// --- tests ---------------------------------------------------------------------

describe('GET /api/serviceability/check — the answer', () => {
  test('an address comes back with the verdict, the boxes and the price', async () => {
    const res = await check({ address: 'House 12-B, Street 4' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verdict, 'serviceable');
    assert.equal(body.serviceable_now, true);
    assert.equal(body.nearest_box.code, 'NAP-12');
    assert.equal(body.recommended_box.code, 'NAP-12');
    assert.equal(body.connection.needs, 'port');
    assert.equal(body.drop.length_m, 62);
    assert.equal(body.quote.currency, 'PKR');
    assert.ok(body.quote.band.low < body.quote.band.high, 'a band, not a single number');
    assert.ok(body.next_steps.length >= 1);
  });

  test('coordinates are passed straight through — that is the map click', async () => {
    calls.length = 0;
    const res = await check({ lat: '33.6', lng: '73.05' });
    assert.equal(res.status, 200);
    assert.equal(calls[0].lat, '33.6');
    assert.equal(calls[0].lng, '73.05');
  });

  test('neither an address nor a point is a 400', async () => {
    const res = await check({});
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /address or lat\/lng is required/);
  });

  test('an address that matches nothing is a 404 carrying its suggestions', async () => {
    const res = await check({ address: 'nowhere in particular' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /could not be matched/);
    assert.equal(body.candidates[0].code, 'CUST-9');
    assert.ok(body.hint, 'and it says what to do instead');
  });

  test('radius and limit reach the service untouched for it to range-check', async () => {
    calls.length = 0;
    await check({ lat: '33.6', lng: '73.05', radius_m: '9000', limit: '3', route: '0' });
    assert.equal(calls[0].radius_m, '9000');
    assert.equal(calls[0].limit, '3');
    assert.equal(calls[0].route, '0');
  });
});

describe('GET /api/serviceability/check/text — the CSR reads it out', () => {
  test('plain text, printable, with the verdict and the price', async () => {
    const res = await fetch(`${base}/text?address=House+12-B%2C+Street+4`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.match(text, /SERVICEABILITY/);
    assert.match(text, /Can serve/);
    assert.match(text, /PKR /);
  });

  test('a failure comes back as JSON, not as a text error page', async () => {
    const res = await fetch(`${base}/text`);
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
});

describe('GET /api/serviceability/check/sheet — the quote as a job', () => {
  test('the install sheet prints the plan, then the box documentation', async () => {
    const res = await fetch(`${base}/sheet?address=House+12-B%2C+Street+4`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.work_order.kind, 'install');
    assert.equal(body.work_order.kind_label, 'New drop installation');
    assert.equal(body.work_order.box.code, 'NAP-12');
    assert.ok(body.install_plan, 'the plan the check produced is on the sheet');
    assert.equal(body.install_plan.port_number, 3);
    assert.equal(body.install_plan.route_length_m, 62);
    assert.ok(body.checklist.some((item) => /Assign splitter/.test(item.task)));
    assert.ok(body.materials.some((m) => /Drop cable/.test(m.item)));
    assert.equal(body.serviceability.verdict, 'serviceable');
  });

  test('an install sheet lists the install hardware as well as the box kit', async () => {
    const res = await fetch(`${base}/sheet?address=House+12-B%2C+Street+4`);
    const body = await res.json();
    assert.ok(body.materials.some((m) => /ONT/.test(m.item)), 'the ONT is on the van list');
    assert.ok(body.materials.some((m) => /Alcohol wipes/.test(m.item)), 'and so is the usual kit');
  });

  test('no box that can take the drop means no sheet, and it says why', async () => {
    const res = await fetch(`${base}/sheet?address=far+away`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /no install sheet to print/i);
    assert.equal(body.verdict, 'out_of_reach');
    assert.ok(body.next_steps.length, 'and it hands the CSR the next step');
  });

  test('the text form of the sheet is printable', async () => {
    const res = await fetch(`${base}/sheet/text?address=House+12-B%2C+Street+4`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.match(text, /NEW DROP INSTALLATION/);
    assert.match(text, /INSTALL PLAN/);
    assert.match(text, /CHECKLIST/);
  });
});
