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
  B: { core_id: 'B', core_number: 1, core_status: 'spliced', cable_id: 'c2', cable_code: 'CBL-2', cable_type: 'feeder' },
  C: { core_id: 'C', core_number: 2, core_status: 'terminated', cable_id: 'c3', cable_code: 'CBL-3', cable_type: 'distribution' },
  D: { core_id: 'D', core_number: 3, core_status: 'spliced', cable_id: 'c4', cable_code: 'CBL-4', cable_type: 'drop' },
};
const SPLICES = [
  { id: 'S1', enclosure_id: 'box1', splice_type: 'fusion', core_a_id: 'A', core_b_id: 'B', splice_date: '2026-01-01', created_at: '1' },
  { id: 'S2', enclosure_id: 'box2', splice_type: 'fusion', core_a_id: 'B', core_b_id: 'C', splice_date: '2026-01-02', created_at: '2' },
  { id: 'S3', enclosure_id: 'box2', splice_type: 'mechanical', core_a_id: 'B', core_b_id: 'D', splice_date: '2026-01-03', created_at: '3' },
];

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

  // 'fiber_cores as fc'
  let coreId = null;
  const builder = {
    join() { return builder; },
    where(_col, val) { coreId = val; return builder; },
    select() { return builder; },
    first() { return Promise.resolve(CORES[coreId] || null); },
  };
  return builder;
}

// Stub ../src/db in the require cache BEFORE loading the service.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const { traceFiber } = require('../src/services/fiberTrace');

function hopIds(segments) {
  return segments.map((h) => h.core_id || h.splice_id);
}

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
});
