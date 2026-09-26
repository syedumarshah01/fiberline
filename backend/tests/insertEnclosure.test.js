/**
 * Mid-span enclosure insertion, end to end through the app's own code.
 *
 * The user's bug: "when I simulate failure on my OLT and if there is a middle-
 * inserted enclosure, the red line doesn't pass after it."
 *
 * This test does not hand-build the network rows. It POSTs to the real
 * POST /api/cables/:id/insert-enclosure handler against an in-memory stand-in
 * for Postgres, then runs the real impact service over whatever rows the route
 * wrote. If the route forgets to record that the two halves are one fiber, the
 * failure simulation cannot reach past the inserted box — which is exactly what
 * this asserts against.
 *
 * No PostGIS here, so the SQL side (geography columns, ST_*) is faked; the
 * wiring under test — cables.continues_cable_id → graph edge → red path — is
 * the production code path.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// --- in-memory stand-in for the knex surface this route + service use ----------

let store;
let idSeq = 0;
const nextId = (prefix) => `${prefix}-${++idSeq}`;

function project(row, columns) {
  if (!columns || !columns.length) return { ...row };
  const out = {};
  for (const column of columns) {
    const key = String(column).split('.').pop();
    out[key] = row[key];
  }
  return out;
}

/** A knex-ish builder over one table: chainable, awaitable, tiny. */
function table(tableName) {
  const state = { where: {}, columns: [], order: null };

  const matches = (row) =>
    Object.entries(state.where).every(([key, value]) => row[key] === value);

  const run = async () => {
    // Fault injection for the unmigrated-database case.
    if (fakeDb.__failOnTable === tableName) throw fakeDb.__failError;
    // …and for a probe that says the mid-span column is there while the table
    // really does not have it: the SELECT that asks for it fails, 42703.
    if (
      fakeDb.__failOnCableSelect &&
      tableName === 'cables' &&
      state.columns.some((column) => String(column).endsWith('continues_cable_id'))
    ) {
      throw Object.assign(
        new Error('column c.continues_cable_id does not exist'),
        { code: '42703' },
      );
    }
    let rows = (store[tableName] || []).filter(matches);
    for (const { column, values } of state.whereIn || []) {
      rows = rows.filter((row) => values.includes(row[column]));
    }
    for (const column of state.whereNotNull || []) {
      rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
    }
    if (state.order) {
      const { column } = state.order;
      rows = [...rows].sort((a, b) => (a[column] > b[column] ? 1 : -1));
    }
    return rows.map((row) => project(row, state.columns));
  };

  const builder = {
    where(arg) {
      if (typeof arg === 'object' && arg !== null) Object.assign(state.where, arg);
      return builder;
    },
    whereIn(column, values) {
      state.whereIn = [...(state.whereIn || []), { column, values }];
      return builder;
    },
    whereNotNull(column) {
      state.whereNotNull = [...(state.whereNotNull || []), column];
      return builder;
    },
    select(...columns) {
      state.columns = columns;
      return builder;
    },
    orderBy(column) {
      state.order = { column };
      return builder;
    },
    forUpdate() {
      return builder;
    },
    insert(payload) {
      const rows = (Array.isArray(payload) ? payload : [payload]).map((row) => ({
        ...row,
        id: row.id ?? nextId(tableName),
        created_at: row.created_at ?? new Date('2026-02-01T00:00:00Z'),
        updated_at: row.updated_at ?? new Date('2026-02-01T00:00:00Z'),
      }));
      store[tableName] = [...(store[tableName] || []), ...rows];
      return {
        returning: async () => rows,
        // knex resolves a bare insert too
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      };
    },
    update(patch) {
      const rows = (store[tableName] || []).filter(matches);
      for (const row of rows) Object.assign(row, patch);
      return Promise.resolve(rows.length);
    },
    then(resolve, reject) {
      return run().then(resolve, reject);
    },
  };
  return builder;
}

function fakeDb(tableName) {
  if (typeof tableName === 'string') return table(tableName);
  throw new Error(`unexpected db call: ${tableName}`);
}

// `db.raw` is used for the cable-with-route load and for geography literals.
fakeDb.raw = async (sql, params = []) => {
  // Order matters: the inference rule and the route's cable-with-route load both
  // mention "FROM cables", so the rule has to be recognised as a rule first.
  if (isSchemaProbe(sql)) {
    // Report continues_cable_id unless the test says this database predates
    // migration 14. `__columnFlip` models a stale cached answer: the first probe
    // (the cached one) says present, every later one says absent.
    if (fakeDb.__unmigratedDatabase) return emptyDatabaseProbeRows();
    if (fakeDb.__columnFlip) {
      const first = (fakeDb.__probeCount || 0) === 0;
      fakeDb.__probeCount = (fakeDb.__probeCount || 0) + 1;
      return schemaProbeRows(first);
    }
    return schemaProbeRows(fakeDb.__continuationColumn !== false);
  }

  if (isInferenceQuery(sql)) {
    // Stand-in for the SQL rule: pair each cable named "<upstream code>-B" that
    // starts where the upstream one ends. Deliberately does NOT read
    // continues_cable_id — on an unmigrated database it does not exist.
    const rows = [];
    for (const child of store.cables) {
      if (!child.code?.endsWith('-B') || child.cable_type === 'drop') continue;
      const parentCode = child.code.slice(0, -2);
      const parent = store.cables.find(
        (c) =>
          c.code === parentCode &&
          c.to_enclosure_id === child.from_enclosure_id &&
          c.cable_type === child.cable_type,
      );
      if (parent) {
        rows.push({
          child_id: child.id,
          child_code: child.code,
          parent_id: parent.id,
          parent_code: parent.code,
        });
      }
    }
    return { rows };
  }

  if (/FROM cables/i.test(sql)) {
    const cable = (store.cables || []).find((c) => c.id === params[0]);
    return { rows: cable ? [cable] : [] };
  }

  if (/available_cores/i.test(sql)) {
    // Free cores on any non-drop cable landing at the enclosure — the stand-in
    // for the grouping query capacityGraph issues.
    const rows = (store.enclosures || []).map((enclosure) => {
      const cables = (store.cables || []).filter(
        (c) =>
          c.cable_type !== 'drop' &&
          (c.from_enclosure_id === enclosure.id || c.to_enclosure_id === enclosure.id),
      );
      const available = (store.fiber_cores || []).filter(
        (core) => core.status === 'available' && cables.some((c) => c.id === core.cable_id),
      ).length;
      return { enclosure_id: enclosure.id, available_cores: String(available) };
    });
    return { rows };
  }

  return { rows: [], sql, params };
};
fakeDb.fn = { now: () => new Date('2026-02-01T00:00:00Z') };
fakeDb.transaction = async () => {
  const trx = (tableName) => table(tableName);
  trx.raw = fakeDb.raw;
  trx.fn = fakeDb.fn;
  trx.commit = async () => {};
  trx.rollback = async () => {};
  return trx;
};

// --- fixture: BOX-OLT --CBL-F1--> BOX-NAP --CBL-DROP--> CUST-1 ----------------

const ROUTE = {
  type: 'LineString',
  // ~2.2 km west→east, so the split point falls at a clean midpoint
  coordinates: [[71.4, 34.0], [71.42, 34.0]],
};

function freshStore() {
  idSeq = 0;
  delete fakeDb.__continuationColumn;
  delete fakeDb.__unmigratedDatabase;
  resetSchemaCache();
  store = {
    poles: [],
    enclosures: [
      { id: 'olt', code: 'BOX-OLT', name: 'OLT site', type: 'cabinet', pole_id: null },
      { id: 'nap', code: 'BOX-NAP', name: 'NAP', type: 'nap', pole_id: null },
    ],
    cables: [
      {
        id: 'f1',
        code: 'CBL-F1',
        name: 'Feeder 1',
        cable_type: 'feeder',
        core_count: 2,
        status: 'active',
        from_enclosure_id: 'olt',
        to_enclosure_id: 'nap',
        customer_id: null,
        customer_label: null,
        length_m: 2200,
        attenuation_db_per_km: null,
        notes: null,
        route_geojson: JSON.stringify(ROUTE),
      },
      {
        id: 'drop1',
        code: 'CBL-DROP-1',
        name: 'Drop 1',
        cable_type: 'drop',
        core_count: 1,
        status: 'active',
        from_enclosure_id: 'nap',
        to_enclosure_id: null,
        customer_id: 'c1',
        customer_label: 'CUST-1',
        length_m: 40,
        attenuation_db_per_km: null,
        notes: null,
      },
    ],
    fiber_cores: [
      // Core #1 of the feeder was lit end to end; core #2 was spare.
      { id: 'f1c1', cable_id: 'f1', core_number: 1, status: 'spliced', notes: null },
      { id: 'f1c2', cable_id: 'f1', core_number: 2, status: 'available', notes: null },
      { id: 'drop1c1', cable_id: 'drop1', core_number: 1, status: 'spliced', notes: null },
    ],
    splices: [
      // The customer's drop, to be spliced onto the far half of the feeder once
      // that half exists (the id is not known until the insert route has run).
      { id: 's-nap', enclosure_id: 'nap', core_a_id: 'drop1c1', core_b_id: '__DOWN__', splice_type: 'fusion' },
    ],
    splitters: [],
    splitter_ports: [],
    customers: [{ id: 'c1', customer_code: 'CUST-1', name: 'Customer One' }],
    headends: [
      { id: 'he1', code: 'OLT-01', name: 'OLT 01', site_type: 'olt', root_enclosure_id: 'olt' },
    ],
  };
}

// Stub ../src/db in the require cache BEFORE the route and the service load it.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const cablesRouter = require('../src/routes/cables');
const { simulateFailure } = require('../src/services/impactAnalysis');
// The schema probe caches its answer per process (a running server re-checks on
// a timer), so each test starts from a clean slate.
const { resetSchemaCache } = require('../src/utils/schemaCapabilities');
const { isSchemaProbe, isInferenceQuery, schemaProbeRows, emptyDatabaseProbeRows } = require('./helpers/schema');

let app;
before(() => {
  app = express();
  app.use(express.json());
  app.use('/api/cables', cablesRouter);
});

/** Minimal HTTP client — supertest is not part of this project's deps. */
function post(serverApp, path, body) {
  return new Promise((resolve, reject) => {
    const server = serverApp.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = require('http').request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end(payload);
    });
  });
}

const redCodes = (impact) => impact.affected.cables.map((c) => c.code).sort();
const coreOf = (cableId, coreNumber) =>
  store.fiber_cores.find((c) => c.cable_id === cableId && c.core_number === coreNumber);

/** Insert a closure mid-span on the feeder, exactly as the UI does. */
const insertMidSpanEnclosure = () =>
  post(app, '/api/cables/f1/insert-enclosure', {
    enclosure_code: 'BOX-MID',
    downstream_cable_code: 'CBL-F1-B',
  });

/** Splice the customer's drop onto the given core (the splice to __DOWN__ is a
 *  placeholder in the fixture — the id is not known until the route runs). */
function connectDropTo(core) {
  store.splices.find((s) => s.core_b_id === '__DOWN__').core_b_id = core.id;
}

describe('POST /api/cables/:id/insert-enclosure — the halves stay one fiber', () => {
  test('the route records the downstream half as a continuation of the parent', async () => {
    freshStore();
    const res = await post(app, '/api/cables/f1/insert-enclosure', {
      enclosure_code: 'BOX-MID',
      downstream_cable_code: 'CBL-F1-B',
    });

    assert.equal(res.status, 201);
    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    assert.ok(downstream, 'the downstream half should have been created');
    assert.equal(downstream.continues_cable_id, 'f1');
    // …and the upstream half now ends at the new closure
    const upstream = store.cables.find((c) => c.id === 'f1');
    assert.equal(upstream.to_enclosure_id, store.enclosures.find((e) => e.code === 'BOX-MID').id);
    // The live core (#1) is through-spliced; the spare (#2) is left available.
    const midSplice = store.splices.find((s) => s.enclosure_id === upstream.to_enclosure_id);
    assert.ok(midSplice, 'a live core should be through-spliced at the new box');
    assert.equal(
      store.fiber_cores.find((c) => c.id === midSplice.core_b_id).status,
      'spliced',
    );
    assert.equal(res.body.summary.auto_spliced_pairs, 1);
    assert.equal(res.body.summary.left_available_cores, 1);
  });

  test('simulating an OLT failure paints through the inserted box and counts the customer', async () => {
    freshStore();
    const res = await insertMidSpanEnclosure();
    assert.equal(res.status, 201);

    // Splice the downstream half's core #1 onward to the customer's drop, the
    // way a tech would after the closure is in place.
    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    connectDropTo(coreOf(downstream.id, 1));

    const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });

    assert.equal(impact.direction_resolved, true);
    assert.deepEqual(redCodes(impact), ['CBL-DROP-1', 'CBL-F1', 'CBL-F1-B']);
    assert.deepEqual(
      impact.affected.boxes.map((b) => b.code).sort(),
      ['BOX-MID', 'BOX-NAP', 'BOX-OLT'],
    );
    assert.equal(impact.affected.customer_count, 1);
    assert.deepEqual(
      impact.affected.customers.map((c) => c.customer_label),
      ['CUST-1'],
    );
    // The customer's path walks through the closure: the live core was
    // through-spliced there, so that is the documented joint the light crosses.
    const path = impact.affected.customers[0].path_through_failure;
    const at = path.findIndex((item) => item.box_code === 'BOX-MID');
    assert.notEqual(at, -1, 'the path should show the closure it passes through');
    assert.equal(path[at].kind, 'splice');
    assert.equal(path[at + 1].cable_code, 'CBL-F1-B', 'and carry on down the far half');
  });

  test('a spare core inserted over still carries the failure once spliced on', async () => {
    freshStore();
    // THE REPORTED CASE: the core was merely available when the closure went in,
    // so no through-splice was written at the new box. Nothing in the splice
    // table joins the halves — only the recorded continuation does.
    store.fiber_cores.find((c) => c.id === 'f1c1').status = 'available';
    await insertMidSpanEnclosure();

    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    const downstreamCore = coreOf(downstream.id, 1);
    assert.equal(
      store.splices.some((s) => s.enclosure_id === store.enclosures.find((e) => e.code === 'BOX-MID').id),
      false,
      'nothing should be spliced at the inserted box in this scenario',
    );
    connectDropTo(downstreamCore);
    // The tech splices the spare on at the inserted box afterwards.
    store.fiber_cores.find((c) => c.id === 'f1c1').status = 'spliced';
    downstreamCore.status = 'spliced';

    const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });

    assert.deepEqual(redCodes(impact), ['CBL-DROP-1', 'CBL-F1', 'CBL-F1-B']);
    assert.equal(impact.affected.customer_count, 1);
    const step = impact.affected.customers[0].path_through_failure.find(
      (item) => item.kind === 'continuation',
    );
    assert.ok(step, 'the path should show the fiber continuing through the box');
    assert.equal(step.box_code, 'BOX-MID');
    assert.equal(step.to_cable_code, 'CBL-F1-B');
  });

  test('failing the inserted closure itself takes the customer downstream', async () => {
    freshStore();
    await insertMidSpanEnclosure();
    const mid = store.enclosures.find((e) => e.code === 'BOX-MID');
    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    connectDropTo(coreOf(downstream.id, 1));

    const impact = await simulateFailure({ kind: 'box', id: mid.id, boxIds: [mid.id] });

    assert.equal(impact.affected.customer_count, 1);
    assert.deepEqual(impact.affected.boxes.map((b) => b.code).sort(), ['BOX-MID', 'BOX-NAP']);
    // The cut is at the box: the load side (CBL-F1-B) and the drop behind it go
    // dark. The span feeding the box from the OLT (CBL-F1) still carries light
    // up to the box, so it is *not* painted — the whole route going red was the
    // reported bug.
    assert.deepEqual(redCodes(impact), ['CBL-DROP-1', 'CBL-F1-B']);
    assert.ok(!impact.affected.boxes.some((b) => b.code === 'BOX-OLT'), 'the OLT is upstream');
  });
});

describe('a database that has not been migrated yet', () => {
  test('the simulation says to run the migration instead of leaking a SQL error', async () => {
    freshStore();
    await insertMidSpanEnclosure();
    // What Postgres answers when cables.continues_cable_id is not there yet.
    fakeDb.__failOnTable = 'cables';
    fakeDb.__failError = Object.assign(
      new Error('column c.continues_cable_id does not exist'),
      { code: '42703' },
    );
    try {
      await assert.rejects(
        () => simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] }),
        (err) => {
          assert.match(err.message, /npm run migrate/);
          assert.match(err.message, /continues_cable_id/);
          return true;
        },
      );
    } finally {
      delete fakeDb.__failOnTable;
      delete fakeDb.__failError;
    }
  });
});

describe('a database that has not run migration 14 (the column is absent)', () => {
  /** Pretend the probe looked at a database without cables.continues_cable_id. */
  function pretendUnmigrated() {
    fakeDb.__continuationColumn = false;
    resetSchemaCache(); // pretend the server just started against this database
    // The real column would not be there, so a read naming it must fail loudly
    // if the code ever asks for it anyway.
    const rows = store.cables;
    store.cables = new Proxy(rows, {
      get(target, prop) {
        if (prop === 'continues_cable_id') {
          throw Object.assign(new Error('column "continues_cable_id" does not exist'), {
            code: '42703',
          });
        }
        return target[prop];
      },
    });
  }

  test('the insert still works and reports that the halves are not linked', async () => {
    freshStore();
    pretendUnmigrated();
    const res = await insertMidSpanEnclosure();

    assert.equal(res.status, 201);
    assert.equal(res.body.summary.continuation_recorded, false);
    assert.equal(res.body.summary.continuation_inferred, true);
    assert.match(res.body.warnings.join(' '), /still/);
    assert.match(res.body.warnings.join(' '), /npm run db:schema/);
    // The cut itself happened: upstream now ends at the new box, downstream exists.
    const mid = store.enclosures.find((e) => e.code === 'BOX-MID');
    assert.equal(store.cables.find((c) => c.id === 'f1').to_enclosure_id, mid.id);
    assert.ok(store.cables.find((c) => c.code === 'CBL-F1-B'));
  });

  test('the failure simulation still paints THROUGH the closure, by inference', async () => {
    // The reported bug, on a database that never got the column: the red line
    // must not stop at the inserted box just because the link is not recorded.
    freshStore();
    await insertMidSpanEnclosure();
    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    connectDropTo(coreOf(downstream.id, 1));
    pretendUnmigrated();

    const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });

    assert.deepEqual(redCodes(impact), ['CBL-DROP-1', 'CBL-F1', 'CBL-F1-B'], 'both halves are dark');
    assert.deepEqual(
      impact.affected.boxes.map((b) => b.code).sort(),
      ['BOX-MID', 'BOX-NAP', 'BOX-OLT'],
      'including the box the fiber passes through',
    );
    assert.equal(impact.affected.customer_count, 1, 'and the customer behind it is counted');
  });

  test('...and says the links were inferred, not recorded', async () => {
    freshStore();
    await insertMidSpanEnclosure();
    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    connectDropTo(coreOf(downstream.id, 1));
    pretendUnmigrated();

    const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });

    // The cables in the report carry the link, and say where it came from.
    const child = impact.affected.cables.find((c) => c.code === 'CBL-F1-B');
    assert.equal(child.continues_cable_code, 'CBL-F1');
    assert.equal(child.continues_at_box_code, 'BOX-MID');
    assert.equal(child.continuation_inferred, true, 'inferred on this database');

    const notice = impact.warnings.find((w) => /inferred from cable naming/.test(w));
    assert.ok(notice, `expected an inference notice, got: ${JSON.stringify(impact.warnings)}`);
    assert.match(notice, /already include them/);
    assert.match(notice, /npm run db:schema/);
    // It is a notice, not an alarm: the report above is complete and correct.
    assert.equal(impact.affected.customer_count, 1);
  });

  test('a stale cached answer heals itself instead of demanding a migration', async () => {
    freshStore();
    await insertMidSpanEnclosure();
    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    connectDropTo(coreOf(downstream.id, 1));
    // The API's cached probe answer says the column exists (a long-running
    // process, a column dropped since), so the network load asks for it — and
    // Postgres answers 42703. The app must re-probe, drop the column from the
    // SELECT and infer the links, not hand the user a SQL error.
    fakeDb.__columnFlip = true;
    fakeDb.__failOnCableSelect = true;
    resetSchemaCache();
    try {
      const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });
      assert.deepEqual(redCodes(impact), ['CBL-DROP-1', 'CBL-F1', 'CBL-F1-B']);
      assert.equal(impact.affected.customer_count, 1);
    } finally {
      delete fakeDb.__columnFlip;
      delete fakeDb.__probeCount;
      delete fakeDb.__failOnCableSelect;
      resetSchemaCache();
    }
  });

  test('a migrated database reports the same fields, flagged as recorded', async () => {
    freshStore();
    await insertMidSpanEnclosure();
    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    connectDropTo(coreOf(downstream.id, 1));

    const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });

    const child = impact.affected.cables.find((c) => c.code === 'CBL-F1-B');
    assert.equal(child.continues_cable_id, downstream.continues_cable_id ?? child.continues_cable_id);
    assert.equal(child.continues_cable_code, 'CBL-F1');
    assert.equal(child.continues_at_box_code, 'BOX-MID');
    assert.equal(child.continuation_inferred, false, 'recorded in the column, not guessed');
  });

  test('no inference notice when there is nothing to infer', async () => {
    freshStore();
    const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });
    assert.equal(impact.warnings.some((w) => /inferred from cable naming/.test(w)), false);
  });

  test('a database with no tables at all says so in one line', async () => {
    freshStore();
    fakeDb.__unmigratedDatabase = true;
    resetSchemaCache();

    await assert.rejects(
      () => simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] }),
      (err) => {
        assert.match(err.message, /no "cables" table/);
        assert.match(err.message, /npm run migrate/);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  test('a migrated database reports no such warning', async () => {
    freshStore();
    await insertMidSpanEnclosure();
    const downstream = store.cables.find((c) => c.code === 'CBL-F1-B');
    connectDropTo(coreOf(downstream.id, 1));

    const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });

    assert.equal(impact.affected.customer_count, 1);
    assert.equal(impact.warnings.some((w) => /npm run migrate/.test(w)), false);
  });
});

describe('old data: a split made before the link existed', () => {
  test('the simulation stops at the closure and explains why', async () => {
    freshStore();
    // Same topology, but someone created the two halves by hand (or with a
    // build from before migration 14): nothing joins them.
    store.cables[0].to_enclosure_id = 'mid-manual';
    store.enclosures.push({ id: 'mid-manual', code: 'BOX-MID', type: 'splice_closure', pole_id: null });
    store.cables.push({
      id: 'f1b',
      code: 'CBL-F1-B',
      cable_type: 'feeder',
      from_enclosure_id: 'mid-manual',
      to_enclosure_id: 'nap',
      continues_cable_id: null,
    });
    const downstreamCore = { id: 'f1bc1', cable_id: 'f1b', core_number: 1, status: 'spliced' };
    store.fiber_cores.push(downstreamCore);
    store.splices.find((s) => s.core_b_id === '__DOWN__').core_b_id = 'f1bc1';

    const impact = await simulateFailure({ kind: 'box', id: 'olt', boxIds: ['olt'] });

    // This database HAS the column and the row says NULL — "not a continuation".
    // That is a human decision, so the app does not overrule it by inference.
    assert.equal(impact.affected.customer_count, 0);
    assert.ok(
      impact.warnings.some((w) => /could not pair up/.test(w)),
      `expected the warning to describe the pair it could not join, got: ${JSON.stringify(impact.warnings)}`,
    );
    assert.ok(
      impact.warnings.some((w) => /CBL-F1-B ← CBL-F1/.test(w)),
      'and to name the pair, so a human can confirm it in one command',
    );
    assert.equal(
      impact.warnings.some((w) => /inferred from cable naming/.test(w)),
      false,
      'an explicit NULL is never overridden by inference',
    );
  });
});
