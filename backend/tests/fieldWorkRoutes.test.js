/**
 * Route-level tests for the two field-work features:
 *
 *   GET /api/qr/svg?data=…            any text → an SVG QR code
 *   GET /api/qr/:kind/:id[/link]      a pole/box/cable/customer → its tag
 *   GET /api/work-orders/:boxId[/text] a box → its splice worksheet
 *
 * What matters at this level is the contract a phone depends on: the tag carries
 * a deep link (`?box=<uuid>`) into *this* deployment, a tag is never issued for
 * something that does not exist, and the worksheet comes back both as JSON (for
 * the panel) and as plain text (for a phone with no printer) with the same
 * content in both.
 *
 * A small stateful fake stands in for Postgres, the same way the other route
 * tests do it — the boxes, cables, cores and splitters the documentation and the
 * worksheets are generated from.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

// --- the network the fake database holds ---------------------------------------

const BOX = {
  id: 'box-11111111',
  code: 'BOX-MID',
  name: 'Mid-span closure',
  type: 'splice_closure',
  pole_id: 'pole-1',
  latitude: 33.6,
  longitude: 73.0,
};

const POLES = [
  { id: 'pole-1', code: 'P-0001', name: null, latitude: 33.6, longitude: 73.0 },
  { id: 'pole-2', code: 'P-0002', name: 'Market corner', latitude: 33.61, longitude: 73.01 },
];

const CABLES = [
  {
    id: 'cable-1',
    code: 'CBL-F1',
    name: null,
    cable_type: 'feeder',
    core_count: 2,
    from_enclosure_id: 'olt',
    to_enclosure_id: BOX.id,
    customer_label: null,
    continues_cable_id: null,
  },
  {
    id: 'cable-2',
    code: 'CBL-D2',
    name: null,
    cable_type: 'distribution',
    core_count: 2,
    from_enclosure_id: BOX.id,
    to_enclosure_id: 'nap',
    customer_label: null,
    continues_cable_id: null,
  },
];

const CORES = [
  { id: 'k1', cable_id: 'cable-1', core_number: 1, status: 'spliced', loss_db: null },
  { id: 'k2', cable_id: 'cable-1', core_number: 2, status: 'available', loss_db: null },
  { id: 'k3', cable_id: 'cable-2', core_number: 1, status: 'spliced', loss_db: null },
  { id: 'k4', cable_id: 'cable-2', core_number: 2, status: 'damaged', loss_db: null },
];

const CUSTOMERS = [
  { id: 'cust-1', code: 'CUST-0001', name: 'Shopkeeper', enclosure_id: BOX.id },
];

const SPLICE_ROWS = [
  {
    id: 's1',
    splice_type: 'fusion',
    tray_number: '3',
    tray_position: 'A',
    loss_db: '0.75', // over the app's 0.5 dB bad-splice threshold (utils/lossBudget)
    technician: 'A. Tech',
    splice_date: '2026-09-01',
    notes: null,
    core_a_id: 'k1',
    core_a_number: 1,
    cable_a_code: 'CBL-F1',
    cable_a_type: 'feeder',
    core_b_id: 'k3',
    core_b_number: 1,
    cable_b_code: 'CBL-D2',
    cable_b_type: 'distribution',
  },
];

const SPLITTERS = [
  { id: 'sp1', enclosure_id: BOX.id, name: 'Tray A', input_core_id: 'k2', split_count: 4, created_at: '2026-01-01' },
];

const PORTS = [
  {
    splitter_id: 'sp1',
    port_number: 1,
    port_status: 'free',
    output_core_id: null,
    output_splitter_id: null,
    core_id: null,
    core_number: null,
    core_status: null,
    cable_code: null,
    child_splitter_name: null,
    child_split_count: null,
  },
];

const TABLES = () => ({
  poles: POLES,
  enclosures: [BOX],
  cables: CABLES,
  fiber_cores: CORES,
  splitters: SPLITTERS,
  splitter_ports: PORTS,
  customers: CUSTOMERS,
  splices: SPLICE_ROWS,
});

function rowsFor(table) {
  return TABLES()[table] || [];
}

/** The raw SQL the documentation service runs for splices and the far-end box. */
function rawResult(sql) {
  const text = String(sql);
  if (/FROM splices s/i.test(text)) return { rows: SPLICE_ROWS };
  if (/FROM enclosures/i.test(text)) return { rows: [{ id: 'olt', code: 'BOX-OLT' }] };
  return { rows: [] };
}

function builder(name) {
  const state = { where: {}, orWhere: {}, first: false };
  const matches = (row, conditions) =>
    Object.entries(conditions).every(([key, value]) => String(row[key]) === String(value));
  // `where(...).orWhere(...)` is "either end of the cable lands here", so a row
  // matching the whole where-clause or any orWhere-clause comes back — the way
  // the documentation query asks for a box's cables.
  const matching = () =>
    rowsFor(name).filter(
      (row) => matches(row, state.where) || (Object.keys(state.orWhere).length > 0 && matches(row, state.orWhere)),
    );
  const api = {
    where(arg, value) {
      if (typeof arg === 'object' && arg !== null) Object.assign(state.where, arg);
      else state.where[arg] = value;
      return api;
    },
    orWhere(arg, value) {
      if (typeof arg === 'object' && arg !== null) Object.assign(state.orWhere, arg);
      else state.orWhere[arg] = value;
      return api;
    },
    whereIn() { return api; },
    whereNotIn() { return api; },
    whereNull() { return api; },
    whereNotNull() { return api; },
    join() { return api; },
    leftJoin() { return api; },
    select() { return api; },
    orderBy() { return api; },
    groupBy() { return api; },
    limit() { return api; },
    offset() { return api; },
    forUpdate() { return api; },
    returning() { return api; },
    update() { return Promise.resolve(1); },
    insert() { return api; },
    del() { return Promise.resolve(1); },
    first() { state.first = true; return Promise.resolve(matching()[0] ?? null); },
    then(resolve, reject) { return Promise.resolve(matching()).then(resolve, reject); },
    catch(handler) { return Promise.resolve(matching()).catch(handler); },
  };
  return api;
}

/** The knex-shaped entry point the routes require as `../db`. */
function fakeDb(table) {
  if (!table) return fakeDb;
  const name = typeof table === 'string' ? table : table;
  return builder(name);
}
fakeDb.raw = (sql) => Promise.resolve(rawResult(sql));

const dbPath = path.join(__dirname, '..', 'src', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

// Load the routes only after the fake is in place.
const qrRouter = require('../src/routes/qr');
const workOrdersRouter = require('../src/routes/workOrders');
const enclosuresRouter = require('../src/routes/enclosures');

// --- harness -------------------------------------------------------------------

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/qr', qrRouter);
  app.use('/api/work-orders', workOrdersRouter);
  app.use('/api/enclosures', enclosuresRouter);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const get = (path) => fetch(`${base}${path}`);

// --- QR: the generic endpoint --------------------------------------------------

describe('GET /api/qr/svg — the code the browser asks for', () => {
  test('renders an SVG for the text it is given', async () => {
    const res = await get('/qr/svg?data=https%3A%2F%2Fapp.example.com%2F%3Fbox%3Dbox-11111111&scale=8');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    const svg = await res.text();
    assert.match(svg, /^<svg /);
    assert.match(svg, /data-qr-version=/);
    assert.match(svg, /width="\d+"/);
  });

  test('refuses to render nothing, with a message that says so', async () => {
    const res = await get('/qr/svg');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /data is required/);
  });

  test('a link too long for a QR code is a 413 that names the limit, not a broken image', async () => {
    const res = await get(`/qr/svg?data=${'x'.repeat(400)}&ec=H`);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.match(body.error, /too long for a QR code/);
    assert.match(body.error, /119/); // H ceiling, so the caller knows what to cut to
  });

  test('clamps silly scale and quiet-zone values instead of rendering them', async () => {
    const res = await get('/qr/svg?data=BOX-MID&scale=9999&quiet=-4');
    assert.equal(res.status, 200);
    const svg = await res.text();
    const width = Number(svg.match(/width="(\d+)"/)[1]);
    assert.ok(width <= (21 + 2 * 16) * 40, `width ${width} was not clamped`);
  });

  test('the error correction level the caller asks for is the one in the code', async () => {
    for (const ec of ['L', 'M', 'Q', 'H']) {
      const res = await get(`/qr/svg?data=BOX-MID&ec=${ec}`);
      const svg = await res.text();
      assert.equal(svg.match(/data-qr-ec="(\w)"/)[1], ec);
    }
  });
});

// --- QR: per entity ------------------------------------------------------------

describe('GET /api/qr/:kind/:id — one tag per pole, box, cable and customer', () => {
  test('a box tag carries a deep link that opens that box in the app', async () => {
    const res = await get('/qr/box/box-11111111?base=https%3A%2F%2Fapp.example.com');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.link, 'https://app.example.com/?box=box-11111111');
    assert.equal(body.code, 'BOX-MID');
    assert.equal(body.base_url, 'https://app.example.com');
    assert.match(body.svg, /^<svg /);
  });

  test('a pole tag points at the pole, and "enclosure" is accepted as a box', async () => {
    const pole = await (await get('/qr/pole/pole-1')).json();
    assert.equal(pole.link.endsWith('/?pole=pole-1'), true);
    assert.equal(pole.code, 'P-0001');

    const enclosure = await (await get('/qr/enclosure/box-11111111')).json();
    assert.equal(enclosure.link.endsWith('/?box=box-11111111'), true);
  });

  test('a tag can be fetched as a downloadable SVG the browser can save directly', async () => {
    const res = await get('/qr/box/box-11111111.svg?download=1');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="box-BOX-MID\.svg"/);
    assert.match(await res.text(), /^<svg /);
  });

  test('an unknown kind is a 400 listing the kinds, so a typo is obvious', async () => {
    const res = await get('/qr/sausage/box-11111111');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /pole, box, enclosure, cable, customer/);
  });

  test('no tag is issued for a box that does not exist', async () => {
    // A sticker that scans to "not found" is worse than no sticker.
    const res = await get('/qr/box/ghost');
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /box not found/);
  });

  test('the base URL falls back through ?base → APP_BASE_URL → the request origin', async () => {
    const previous = process.env.APP_BASE_URL;
    try {
      // With neither, the tag points at whatever host served the request: right
      // when one server does both, which is how the app ships.
      delete process.env.APP_BASE_URL;
      const fromRequest = await (await get('/qr/pole/pole-2')).json();
      assert.match(fromRequest.link, /^http:\/\/127\.0\.0\.1:\d+\/\?pole=pole-2$/);

      // A deployment that prints labels from a script sets APP_BASE_URL.
      process.env.APP_BASE_URL = 'https://fiber.example.net/';
      const configured = await (await get('/qr/pole/pole-2')).json();
      assert.equal(configured.link, 'https://fiber.example.net/?pole=pole-2');

      // And ?base beats both, which is how the browser passes its own origin.
      const asked = await (await get('/qr/pole/pole-2?base=https://dev.local:5173/')).json();
      assert.equal(asked.link, 'https://dev.local:5173/?pole=pole-2');
    } finally {
      if (previous === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = previous;
    }
  });

  test('an id with characters that would break the link is encoded, not pasted in', async () => {
    const res = await get('/qr/customer/cust-1?base=https://app.example.com');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).link, 'https://app.example.com/?customer=cust-1');
  });
});

describe('GET /api/qr/:kind/:id/link — what a tag would say, before printing fifty of them', () => {
  test('answers with the label and the link', async () => {
    const res = await get('/qr/box/box-11111111/link?base=https://app.example.com');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      kind: 'box',
      id: 'box-11111111',
      label: 'BOX-MID',
      link: 'https://app.example.com/?box=box-11111111',
    });
  });

  test('a deleted box says so rather than promising a page that will not open', async () => {
    const res = await get('/qr/box/ghost/link');
    assert.equal(res.status, 404);
  });
});

// --- work orders ---------------------------------------------------------------

describe('GET /api/work-orders/:boxId — the worksheet, from the box documentation', () => {
  test('generates the sheet from the box that is actually there', async () => {
    const res = await get('/work-orders/box-11111111?by=A.%20Tech');
    assert.equal(res.status, 200);
    const order = await res.json();
    assert.equal(order.work_order.reference, `WO-BOX-MID-${order.work_order.generated_at.slice(0, 10).replace(/-/g, '')}`);
    assert.equal(order.work_order.generated_by, 'A. Tech');
    assert.equal(order.work_order.box.id, BOX.id);
    assert.equal(order.summary.cables, 2);
    assert.equal(order.summary.splices, 1);
    assert.equal(order.summary.damaged_cores, 1);
    assert.equal(order.summary.bad_splices, 1); // the 0.75 dB joint, over the app's 0.5 dB limit
    assert.ok(order.checklist.length >= 4);
    assert.ok(order.checklist.every((item) => typeof item.task === 'string' && item.task.length > 0));
  });

  test('the same sheet as plain text, for a phone with no printer', async () => {
    const res = await get('/work-orders/box-11111111/text');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.match(res.headers.get('content-disposition'), /inline; filename="WO-BOX-MID-\d+\.txt"/);
    const text = await res.text();
    assert.match(text, /SPLICE JOB — BOX-MID/);
    // The sheet uses the app's own threshold, so "bad splice" means the same
    // thing in the van as it does on the dashboard.
    assert.match(text, /\[ \] 1\. Re-splice CBL-F1 #1 ↔ CBL-D2 #1/);
    assert.match(text, /recorded loss 0\.75 dB is over the 0\.5 dB limit/);
    assert.match(text, /SIGN-OFF/);
    assert.ok(!text.includes('[object Object]'));
  });

  test('the sheet and the documentation it came from agree about the box', async () => {
    const order = await (await get('/work-orders/box-11111111')).json();
    const doc = await (await get('/enclosures/box-11111111/documentation')).json();
    assert.deepEqual(order.work_order.box, {
      id: doc.enclosure.id,
      code: doc.enclosure.code,
      name: doc.enclosure.name ?? null,
      type: doc.enclosure.type ?? null,
      pole_id: doc.enclosure.pole_id ?? null,
    });
    assert.equal(order.summary.cables, doc.summary.total_cables);
    assert.equal(order.summary.splices, doc.splices.length);
    assert.equal(order.cables_landing_here.length, doc.cables_landing_here.length);
    // The far ends the panel shows are the far ends the sheet prints.
    const sheetCore = order.cables_landing_here[0].cores[0];
    const docCore = doc.cables_landing_here[0].cores[0];
    assert.equal(sheetCore.far_endpoint?.label ?? null, docCore.far_endpoint?.label ?? null);
  });

  test('a job kind and a technician name are carried onto the sheet', async () => {
    const order = await (await get('/work-orders/box-11111111?kind=repair&by=S.%20Khan')).json();
    assert.equal(order.work_order.kind, 'repair');
    assert.equal(order.work_order.title, 'Repair job — BOX-MID');
    assert.equal(order.work_order.generated_by, 'S. Khan');

    // An unknown kind must not produce a sheet with no heading.
    const fallback = await (await get('/work-orders/box-11111111?kind=teaparty')).json();
    assert.equal(fallback.work_order.kind, 'splice');
  });

  test('asking for the worksheet of a box that does not exist is a 404, not an empty checklist', async () => {
    for (const path of ['/work-orders/ghost', '/work-orders/ghost/text']) {
      const res = await get(path);
      assert.equal(res.status, 404, `${path} should 404`);
      assert.match((await res.json()).error, /Enclosure not found/);
    }
  });
});
