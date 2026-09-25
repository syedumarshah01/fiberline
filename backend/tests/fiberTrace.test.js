/**
 * Unit tests for the fiber trace service, using a stubbed db module.
 *
 * Regression coverage: the old implementation only ever walked ONE direction
 * from the start core (the "backward" walk was dead code) and picked the splice
 * with an unordered `.first()`. Tracing from a mid-chain core — which chaining
 * makes common — silently returned half the path.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// --- In-memory fixture -------------------------------------------------------
// cable1.coreA --S1--> cable2.coreB --S2--> cable3.coreC
//                                  \--S3--> cable4.coreD   (chained branch)
const CORES = {
  A: { core_id: 'A', core_number: 1, core_status: 'spliced', cable_id: 'c1', cable_code: 'CBL-1', cable_type: 'feeder' },
  B: { core_id: 'B', core_number: 1, core_status: 'spliced', cable_id: 'c2', cable_code: 'CBL-2', cable_type: 'feeder', length_m: 5000, attenuation_db_per_km: 0.4 },
  C: { core_id: 'C', core_number: 2, core_status: 'terminated', cable_id: 'c3', cable_code: 'CBL-3', cable_type: 'distribution' },
  D: { core_id: 'D', core_number: 3, core_status: 'spliced', cable_id: 'c4', cable_code: 'CBL-4', cable_type: 'drop' },
};
const SPLICES = [
  { id: 'S1', enclosure_id: 'box1', splice_type: 'fusion', core_a_id: 'A', core_b_id: 'B', splice_date: '2026-01-01', created_at: '1' },
  { id: 'S2', enclosure_id: 'box2', splice_type: 'fusion', core_a_id: 'B', core_b_id: 'C', splice_date: '2026-01-02', created_at: '2', loss_db: 0.15 },
  { id: 'S3', enclosure_id: 'box2', splice_type: 'mechanical', core_a_id: 'B', core_b_id: 'D', splice_date: '2026-01-03', created_at: '3' },
];

// A closure inserted mid-span on cable c5: the cable was cut into c5 (upstream,
// carrying core G) and c5-B (downstream, carrying core H), linked by
// continues_cable_id. The fiber continues across the box with no splice row.
// Deliberately a separate cable from the chain above, so the splice-walk tests
// keep asserting exactly what they always did.
const MID_CORES = {
  G: { core_id: 'G', core_number: 1, core_status: 'spliced', cable_id: 'c5', cable_code: 'CBL-5', cable_type: 'distribution' },
  H: { core_id: 'H', core_number: 1, core_status: 'spliced', cable_id: 'c5-B', cable_code: 'CBL-5-B', cable_type: 'distribution', continues_cable_id: 'c5' },
};
const MID_CABLES = {
  c5: { id: 'c5', code: 'CBL-5', cable_type: 'distribution', continues_cable_id: null, from_enclosure_id: 'box-up' },
  'c5-B': { id: 'c5-B', code: 'CBL-5-B', cable_type: 'distribution', continues_cable_id: 'c5', from_enclosure_id: 'box-mid' },
};

// The schema probe (schemaCapabilities) asks through db.raw; this fixture's
// database has the mid-span column unless a test says otherwise. When it does
// not, the links are inferred through the rule query instead.
fakeDb.raw = async (sql) => {
  if (isInferenceQuery(sql)) return { rows: fakeDb.__inferredPairs || [] };
  return schemaProbeRows(fakeDb.__continuationColumn !== false);
};

function fakeDb(table) {
  if (table === 'splices') {
    let coreId = null;
    const builder = {
      where(fn) {
        fn.call({
          where(_col, val) { coreId = val; return this; },
          orWhere(_col, val) { coreId = val; return this; },
        });
        return builder;
      },
      orderBy() {
        return Promise.resolve(
          SPLICES
            .filter((s) => s.core_a_id === coreId || s.core_b_id === coreId)
            .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
        );
      },
    };
    return builder;
  }

  // db('cables'): the trace loads the mid-span links from here — every cable
  // row, then (when the column exists) the recorded links.
  if (table === 'cables') {
    const state = { where: {}, whereNotNull: null };
    const builder = {
      where(arg) { Object.assign(state.where, arg); return builder; },
      whereNotNull(column) { state.whereNotNull = column; return builder; },
      select() { return builder; },
      async first() {
        if (state.where.continues_cable_id) {
          return Object.values(MID_CABLES).find(
            (c) => c.continues_cable_id === state.where.continues_cable_id,
          ) || null;
        }
        return null;
      },
      then(resolve, reject) {
        const rows = Object.values(MID_CABLES);
        const filtered = state.whereNotNull
          ? rows.filter((row) => row[state.whereNotNull] != null)
          : rows;
        return Promise.resolve(filtered).then(resolve, reject);
      },
    };
    return builder;
  }

  // 'fiber_cores as fc' (and the plain fiber_cores lookup)
  let coreId = null;
  const where = {};
  const builder = {
    join() { return builder; },
    where(col, val) {
      if (typeof col === 'object') Object.assign(where, col);
      else if (String(col).startsWith('fc.')) coreId = val;
      else where[col] = val;
      return builder;
    },
    select() { return builder; },
    async first() {
      if (where.cable_id) {
        return [...Object.values(CORES), ...Object.values(MID_CORES)].find(
          (c) => c.cable_id === where.cable_id && c.core_number === where.core_number,
        ) || null;
      }
      return CORES[coreId] || MID_CORES[coreId] || null;
    },
  };
  return builder;
}

// Stub ../src/db in the require cache BEFORE loading the service.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const { traceFiber } = require('../src/services/fiberTrace');
const { resetSchemaCache } = require('../src/utils/schemaCapabilities');
const { schemaProbeRows, isInferenceQuery } = require('./helpers/schema');

function hopIds(segments) {
  return segments.map((h) => h.core_id || h.splice_id);
}

describe('traceFiber across a mid-span (inserted) closure', () => {
  test('the trace follows the fiber through the inserted box', async () => {
    const segments = await traceFiber('G');
    assert.deepEqual(
      segments.map((h) => h.core_id ?? h.splice_type),
      ['G', 'continuation', 'H'],
    );
    const step = segments.find((h) => h.splice_type === 'continuation');
    assert.equal(step.enclosure_id, 'box-mid'); // the closure the fiber passes through
    assert.equal(step.continues_from_cable_id, 'c5');
    assert.equal(step.continues_to_cable_id, 'c5-B');
    assert.equal(step.continues_to_cable_code, 'CBL-5-B');
  });

  test('a trace started on the downstream half walks back up through the box', async () => {
    const segments = await traceFiber('H');
    assert.deepEqual(
      segments.map((h) => h.core_id ?? h.splice_type),
      ['H', 'continuation', 'G'],
    );
  });

  test('the continuation is priced as a fusion splice, not skipped', async () => {
    const segments = await traceFiber('G');
    const step = segments.find((h) => h.splice_type === 'continuation');
    assert.equal(step.loss_db, null); // no reading recorded → planning default
    const { calculateLossBudget } = require('../src/utils/lossBudget');
    const budget = calculateLossBudget(segments);
    const spliceEntry = budget.breakdown.find((e) => e.type === 'splice');
    assert.equal(spliceEntry.loss_db, 0.1);
    assert.equal(spliceEntry.box_id, 'box-mid');
  });
});

describe('a trace on a database without the mid-span column', () => {
  test('still steps across the closure, using the inferred link', async () => {
    // Migration 20260101000014 not applied: no column, so nothing is recorded.
    // The rule query answers with the pair the insert route's naming convention
    // describes, and the walk uses it exactly as it uses a recorded one.
    fakeDb.__continuationColumn = false;
    fakeDb.__inferredPairs = [{ child_id: 'c5-B', parent_id: 'c5' }];
    resetSchemaCache();
    try {
      const segments = await traceFiber('G');
      assert.deepEqual(
        segments.map((h) => h.core_id ?? h.splice_type),
        ['G', 'continuation', 'H'],
        'the trace must not stop at the closure just because the link is inferred',
      );
      const step = segments.find((h) => h.splice_type === 'continuation');
      assert.equal(step.continues_to_cable_id, 'c5-B');
      assert.equal(step.enclosure_id, 'box-mid');
    } finally {
      delete fakeDb.__continuationColumn;
      delete fakeDb.__inferredPairs;
      resetSchemaCache();
    }
  });

  test('and stops cleanly when nothing matches the rule', async () => {
    fakeDb.__continuationColumn = false;
    fakeDb.__inferredPairs = [];
    resetSchemaCache();
    try {
      const segments = await traceFiber('G');
      assert.deepEqual(segments.map((h) => h.core_id ?? h.splice_type), ['G']);
    } finally {
      delete fakeDb.__continuationColumn;
      delete fakeDb.__inferredPairs;
      resetSchemaCache();
    }
  });
});

describe('traceFiber', () => {
  test('traces endpoint → endpoint from the start of a chain (including branches)', async () => {
    const ids = hopIds(await traceFiber('A'));
    assert.deepEqual(ids, ['A', 'S1', 'B', 'S2', 'C', 'S3', 'D']);
  });

  test('REGRESSION: tracing from a mid-chain core covers both directions', async () => {
    const ids = hopIds(await traceFiber('B'));
    // Old code returned only one arbitrary branch from here.
    assert.ok(ids.includes('A'), 'upstream end missing');
    assert.ok(ids.includes('C'), 'downstream end missing');
    assert.ok(ids.includes('B'), 'start core missing');
  });

  test('follows chained branches out of the same core', async () => {
    const ids = hopIds(await traceFiber('B'));
    assert.ok(ids.includes('D'), 'branched core missing');
    assert.ok(ids.includes('S3'), 'branch splice missing');
  });

  test('tracing from the far end walks upstream and includes branches', async () => {
    const ids = hopIds(await traceFiber('C'));
    assert.deepEqual(ids, ['C', 'S2', 'B', 'S1', 'A', 'S3', 'D']);
  });

  test('splice markers carry the recorded loss reading for the loss budget', async () => {
    // S2 has a measured reading in the fixture; S1 does not.
    const segs = await traceFiber('A');
    const s2 = segs.find((s) => s.splice_id === 'S2');
    const s1 = segs.find((s) => s.splice_id === 'S1');
    assert.equal(s2.loss_db, 0.15);
    assert.equal(s1.loss_db, undefined);
  });

  test('core hops expose the cable length and attenuation override', async () => {
    const segs = await traceFiber('A');
    const b = segs.find((s) => s.core_id === 'B');
    assert.equal(b.length_m, 5000);
    assert.equal(b.attenuation_db_per_km, 0.4);
  });
});
