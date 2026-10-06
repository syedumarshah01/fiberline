/**
 * Route-level tests for /api/headends — the network root (OLT/CO) that outage
 * analysis needs in order to know which way is downstream.
 *
 * A small stateful fake stands in for Postgres: enough of knex's chain
 * (where/whereIn/insert/update/del/first/returning) to exercise the routes, so
 * the CRUD contract and the constraint handling (unique code → 409, unknown
 * root box → 404) are pinned without a database.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// --- tables --------------------------------------------------------------------

const ENCLOSURES = [
  { id: 'box-olt', code: 'BOX-OLT', name: 'OLT site', type: 'cabinet' },
  { id: 'box-a', code: 'BOX-A', name: null, type: 'splice_closure' },
];

let HEADENDS = [
  { id: 'h-1', code: 'OLT-0001', name: 'Main OLT', site_type: 'olt', root_enclosure_id: 'box-olt', notes: null, created_at: '1', updated_at: '1' },
];

const TABLES = () => ({ headends: HEADENDS, enclosures: ENCLOSURES });

let seq = 1;

function table(name) {
  const state = { where: {}, whereIn: {}, inserted: null, updates: null, returning: false };

  const rows = () =>
    (TABLES()[name] || []).filter(
      (row) =>
        Object.entries(state.where).every(([k, v]) => row[k] === v) &&
        Object.entries(state.whereIn).every(([k, vs]) => vs.includes(row[k])),
    );

  const builder = {
    where(arg, value) {
      if (arg && typeof arg === 'object') Object.assign(state.where, arg);
      else state.where[arg] = value;
      return builder;
    },
    whereIn(col, values) {
      state.whereIn[col] = values;
      return builder;
    },
    select: () => builder,
    orderBy: () => builder,
    returning() {
      state.returning = true;
      return builder;
    },
    insert(row) {
      state.inserted = { ...row };
      return builder;
    },
    update(row) {
      state.updates = row;
      return builder;
    },
    del() {
      // knex's del() resolves to the number of rows removed — and removes them.
      const doomed = rows();
      const ids = new Set(doomed.map((row) => row.id));
      HEADENDS = HEADENDS.filter((row) => !ids.has(row.id));
      return Promise.resolve(doomed.length);
    },
    first: () => Promise.resolve(rows()[0] || null),
    then(onFulfilled, onRejected) {
      let result;
      if (state.inserted) {
        const row = {
          id: `h-${++seq}`,
          notes: null,
          root_enclosure_id: null,
          ...state.inserted,
          created_at: String(seq),
          updated_at: String(seq),
        };
        if ((TABLES().headends || []).some((h) => h.code === row.code)) {
          const err = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          // Route the rejection through the callbacks: `await` on a thenable
          // ignores the value `then` returns, so returning a rejected promise
          // here would hang instead of rejecting.
          return Promise.reject(err).then(onFulfilled, onRejected);
        }
        HEADENDS = [...HEADENDS, row];
        result = state.returning ? [row] : [row.id];
      } else if (state.updates) {
        // knex's update() resolves to the affected-row count (0 when nothing
        // matched — which is how the routes detect a missing record).
        const targets = rows();
        for (const target of targets) Object.assign(target, state.updates);
        result = targets.length;
      } else {
        result = rows();
      }
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

table.raw = () => {
  throw new Error('no raw SQL expected from the headends routes');
};
table.fn = { now: () => 'now' };

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: table };

const headendsRouter = require('../src/routes/headends');

// --- harness -------------------------------------------------------------------

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/headends', headendsRouter);
  app.use((err, req, res, next) => {
    if (err.code === '23505') return res.status(409).json({ error: 'duplicate' });
    res.status(500).json({ error: err.message });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/headends`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const post = (body) =>
  fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// --- tests ---------------------------------------------------------------------

describe('GET /api/headends', () => {
  test('lists roots with the box each one feeds', async () => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].code, 'OLT-0001');
    assert.deepEqual(body[0].root_enclosure, ENCLOSURES[0]);
  });
});

describe('POST /api/headends', () => {
  test('creates a root, auto-coding it when the caller does not', async () => {
    const res = await post({ name: 'Second OLT', root_enclosure_id: 'box-a' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.code, 'OLT-0002'); // nextCode() continued the series
    assert.equal(body.site_type, 'olt'); // default
    assert.equal(body.root_enclosure_id, 'box-a');
  });

  test('rejects a site type that is not one of the known kinds', async () => {
    const res = await post({ code: 'OLT-BAD', site_type: 'datacenter' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /site_type/);
  });

  test('refuses to root at a box that does not exist', async () => {
    const res = await post({ code: 'OLT-GHOST', root_enclosure_id: 'nope' });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /Root enclosure not found/);
  });

  test('a duplicate code is a 409, not a 500', async () => {
    const res = await post({ code: 'OLT-0001' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /already exists/);
  });

  test('a headend may be created unrooted (it exists, it just cannot orient)', async () => {
    const res = await post({ code: 'OLT-LOOSE' });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).root_enclosure_id, null);
  });
});

describe('PATCH /api/headends/:id', () => {
  test('re-roots an existing headend at another box', async () => {
    const res = await fetch(`${base}/h-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_enclosure_id: 'box-a' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).root_enclosure_id, 'box-a');
  });

  test('an empty code is refused', async () => {
    const res = await fetch(`${base}/h-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '   ' }),
    });
    assert.equal(res.status, 400);
  });

  test('an unknown headend is a 404', async () => {
    const res = await fetch(`${base}/missing`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/headends/:id', () => {
  test('deletes the root and answers 204', async () => {
    const created = await (await post({ code: 'OLT-DOOMED' })).json();
    const res = await fetch(`${base}/${created.id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    const after = await (await fetch(base)).json();
    assert.ok(!after.some((h) => h.code === 'OLT-DOOMED'));
  });

  test('deleting twice is a 404', async () => {
    const res = await fetch(`${base}/gone`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});
