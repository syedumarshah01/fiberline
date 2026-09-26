/**
 * GET /api/cables — the list the map loads — must tell the truth about mid-span
 * links on databases both with and without cables.continues_cable_id.
 *
 * The user's question: "why don't you include the continues_cable_id field?"
 * Answer in code: the field is returned when the database has it, and when it
 * does not the app returns the link it inferred from cable naming instead —
 * same field names, plus a flag saying which of the two it is. Neither case may
 * break the request, and the column must never be named in SQL against a
 * database that does not have it.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// --- the two cable rows: one span, split in two by an inserted closure ---------
const CABLES = [
  {
    id: 'f1', code: 'CBL-F1', name: null, cable_type: 'feeder', core_count: 12,
    status: 'active', from_enclosure_id: 'olt', to_enclosure_id: 'mid',
    customer_id: null, customer_label: null, length_m: 1000, attenuation_db_per_km: 0.35,
    spliced_core_count: '1', route_geojson: '{"type":"LineString","coordinates":[[1,1],[2,2]]}',
  },
  {
    id: 'f1b', code: 'CBL-F1-B', name: null, cable_type: 'feeder', core_count: 12,
    status: 'active', from_enclosure_id: 'mid', to_enclosure_id: 'nap',
    customer_id: null, customer_label: null, length_m: 1200, attenuation_db_per_km: 0.35,
    spliced_core_count: '1', route_geojson: '{"type":"LineString","coordinates":[[2,2],[3,3]]}',
  },
];
// The recorded link, as the column would hold it (null on a database without it).
const RECORDED = CABLES.map((cable) => ({
  ...cable,
  continues_cable_id: cable.id === 'f1b' ? 'f1' : null,
}));

const { isSchemaProbe, schemaProbeRows, emptyDatabaseProbeRows } = require('./helpers/schema');

// What the probe gets back, per fixture: with the column, without it, and a
// database nothing was migrated into.
const PROBE_WITH = schemaProbeRows(true);
const PROBE_WITHOUT = schemaProbeRows(false);
const PROBE_EMPTY = emptyDatabaseProbeRows();

// --- a fake postgres good enough for this route -------------------------------
const queried = [];
let probeRows = PROBE_WITH;
let cableRows = RECORDED;

const db = (table) => {
  if (table === 'enclosures') {
    return {
      select: async () => [
        { id: 'olt', code: 'BOX-OLT' },
        { id: 'mid', code: 'BOX-MID' },
        { id: 'nap', code: 'BOX-NAP' },
      ],
    };
  }
  if (table === 'cables') {
    // GET /api/cables/:id — `select *`-ish, then `.first()`. On a database
    // without the column the row simply has no such field.
    return {
      where: ({ id }) => ({
        first: async () => {
          const row = RECORDED.find((cable) => cable.id === id) || null;
          if (!row) return null;
          const copy = { ...row };
          if (!probeRows.rows[0].columns.length) delete copy.continues_cable_id;
          return copy;
        },
      }),
      // knex-ish: thenable, and `whereNotNull` usable on the same builder
      // (loadContinuationLinks asks for the recorded links this way).
      select: () => {
        const state = { whereNotNull: null };
        const builder = {
          whereNotNull(column) { state.whereNotNull = column; return builder; },
          then(resolve, reject) {
            const rows = allCableRows();
            const filtered = state.whereNotNull
              ? rows.filter((row) => row[state.whereNotNull] != null)
              : rows;
            return Promise.resolve(filtered).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }
  if (table === 'fiber_cores') {
    return {
      where: () => ({
        orderBy: async () => [{ id: 'f1c1', cable_id: 'f1', core_number: 1, status: 'spliced' }],
      }),
    };
  }
  throw new Error(`unexpected table: ${table}`);
};

// loadContinuationLinks loads the whole cable table itself for the detail route.
function allCableRows() {
  return cableRows.map((cable) => {
    const row = { ...cable };
    if (!probeRows.rows[0].columns.length) delete row.continues_cable_id;
    return row;
  });
}

db.raw = async (sql) => {
  queried.push(String(sql));
  if (isSchemaProbe(sql)) return probeRows;
  if (/FROM cables AS child/i.test(sql)) {
    // The inference rule. Stand-in for the SQL: the -B cable continues the one
    // whose code it extends — never reads the column (this database has none).
    // It runs over the table's rows, not over the fixture, so a test that puts
    // one cable in the table gets the answer that table deserves.
    const rows = [];
    for (const child of cableRows) {
      if (!child.code.endsWith('-B')) continue;
      const parent = cableRows.find((c) => c.code === child.code.slice(0, -2));
      if (parent) rows.push({ child_id: child.id, parent_id: parent.id });
    }
    return { rows };
  }
  if (/FROM cables c/i.test(sql)) {
    // The list query. If it asks for the column on a database without it,
    // Postgres would 42703 — so the fake does too, rather than being forgiving.
    if (/continues_cable_id/.test(sql) && !probeRows.rows[0].columns.length) {
      const err = new Error('column c.continues_cable_id does not exist');
      err.code = '42703';
      throw err;
    }
    const rows = cableRows.map((cable) => {
      const row = { ...cable };
      if (!/continues_cable_id/.test(sql)) delete row.continues_cable_id;
      return row;
    });
    return { rows };
  }
  return { rows: [] };
};

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
const { resetSchemaCache } = require('../src/utils/schemaCapabilities');

// --- the app, with just this route -------------------------------------------
const cablesRoute = require('../src/routes/cables');
let server;

function get(path) {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${path}`).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cables', cablesRoute);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

after(() => server?.close());

describe('GET /api/cables with cables.continues_cable_id present', () => {
  test('returns the recorded link on the downstream half', async () => {
    probeRows = PROBE_WITH;
    cableRows = RECORDED;
    resetSchemaCache();

    const { status, body } = await get('/api/cables');
    assert.equal(status, 200);
    const child = body.find((cable) => cable.code === 'CBL-F1-B');
    assert.equal(child.continues_cable_id, 'f1');
    assert.equal(child.continues_cable_code, 'CBL-F1');
    assert.equal(child.continues_at_box_code, 'BOX-MID');
    assert.equal(child.continuation_inferred, false, 'it was recorded, and says so');
    // The upstream half carries the same fields, empty.
    const parent = body.find((cable) => cable.code === 'CBL-F1');
    assert.equal(parent.continues_cable_id, null);
    assert.equal(parent.continuation_inferred, false);
    // …and the map's own fields are untouched in the process.
    assert.deepEqual(parent.route, [[1, 1], [2, 2]]);
  });
});

describe('GET /api/cables without the column (the user\'s database)', () => {
  test('still answers, and the link comes back inferred', async () => {
    probeRows = PROBE_WITHOUT;
    cableRows = CABLES; // no column in the table, so no field on the rows
    resetSchemaCache();

    const { status, body } = await get('/api/cables');
    assert.equal(status, 200, JSON.stringify(body));
    const child = body.find((cable) => cable.code === 'CBL-F1-B');
    assert.equal(child.continues_cable_id, 'f1', 'the link is there anyway');
    assert.equal(child.continues_cable_code, 'CBL-F1');
    assert.equal(child.continues_at_box_code, 'BOX-MID');
    assert.equal(child.continuation_inferred, true, 'and the client can see it is inferred');
  });

  test('never names the missing column in the list query', async () => {
    probeRows = PROBE_WITHOUT;
    cableRows = CABLES;
    resetSchemaCache();
    queried.length = 0;

    const { status } = await get('/api/cables');
    assert.equal(status, 200);
    const listQueries = queried.filter((sql) => /FROM cables c\b/i.test(sql));
    assert.ok(listQueries.length, 'the list query ran');
    for (const sql of listQueries) {
      assert.doesNotMatch(sql, /continues_cable_id/, `the SQL must not name the missing column:\n${sql}`);
    }
  });

  test('a database with no links at all answers with the fields present and null', async () => {
    probeRows = PROBE_WITHOUT;
    cableRows = [CABLES[0]]; // only the upstream half exists
    resetSchemaCache();

    const { status, body } = await get('/api/cables');
    assert.equal(status, 200);
    assert.equal(body[0].continues_cable_id, null);
    assert.equal(body[0].continues_cable_code, null);
    assert.equal(body[0].continues_at_box_code, null);
    assert.equal(body[0].continuation_inferred, false);
  });

  test('a database with no cables table at all does not explode here', async () => {
    probeRows = PROBE_EMPTY;
    cableRows = [];
    resetSchemaCache();

    const { status, body } = await get('/api/cables');
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });
});

describe('GET /api/cables/:id', () => {
  test('the detail of a downstream half says what it continues', async () => {
    probeRows = PROBE_WITH;
    cableRows = RECORDED;
    resetSchemaCache();

    const { status, body } = await get('/api/cables/f1b');
    assert.equal(status, 200);
    assert.equal(body.continues_cable_id, 'f1');
    assert.equal(body.continues_cable_code, 'CBL-F1');
    assert.equal(body.continues_at_box_code, 'BOX-MID');
    assert.equal(body.continuation_inferred, false);
    assert.equal(body.cores.length, 1, 'and the cores are still returned');
  });

  test('…and on a database without the column it is there anyway, inferred', async () => {
    probeRows = PROBE_WITHOUT;
    cableRows = CABLES;
    resetSchemaCache();

    const { status, body } = await get('/api/cables/f1b');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.continues_cable_id, 'f1');
    assert.equal(body.continues_cable_code, 'CBL-F1');
    assert.equal(body.continuation_inferred, true);
  });

  test('an unknown cable is still a plain 404', async () => {
    probeRows = PROBE_WITHOUT;
    cableRows = CABLES;
    resetSchemaCache();

    const { status, body } = await get('/api/cables/nope');
    assert.equal(status, 404);
    assert.equal(body.error, 'Cable not found');
  });
});
