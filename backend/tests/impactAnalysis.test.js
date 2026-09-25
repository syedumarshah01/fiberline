/**
 * Service-level tests for simulateFailure with a stubbed db module: the
 * segment loads, the headend root orients the graph, and restoration options
 * come out of the capacity BFS (#7) with dark boxes excluded.
 *
 * Fixture (same shape as impactGraph.test.js):
 *
 *                     ┌─ S1 ─ D1 ─[SP1 1:8 @ B]─┬─ DROP-1 ─ CUST-1
 *   [OLT box] ─ F1 ─ A┤                        ├─ DROP-2 ─ CUST-2
 *                     │                        └─ port3 ⤳ SP2 1:2 @ C
 *                     │                                     └─ DROP-3 ─ CUST-3
 *                     └─ S4 ─ D2 ─ D ─ D3 ─ E ─ DROP-9 ─ CUST-9
 *
 * BOX-A has spare cores and stays live in every scenario here, so it is the
 * box a patch would be pulled from.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// --- fixture -------------------------------------------------------------------

const ENCLOSURES = [
  { id: 'olt', code: 'BOX-OLT', name: 'OLT site', type: 'cabinet' },
  { id: 'a', code: 'BOX-A', name: null, type: 'splice_closure' },
  { id: 'b', code: 'BOX-B', name: null, type: 'nap' },
  { id: 'c', code: 'BOX-C', name: null, type: 'nap' },
  { id: 'd', code: 'BOX-D', name: null, type: 'splice_closure' },
  { id: 'e', code: 'BOX-E', name: null, type: 'nap' },
];

const CABLES = [
  { id: 'f1', code: 'CBL-F1', cable_type: 'feeder', from_enclosure_id: 'olt', to_enclosure_id: 'a', customer_id: null, customer_label: null },
  { id: 'd1', code: 'CBL-D1', cable_type: 'distribution', from_enclosure_id: 'a', to_enclosure_id: 'b', customer_id: null, customer_label: null },
  { id: 'd2', code: 'CBL-D2', cable_type: 'distribution', from_enclosure_id: 'a', to_enclosure_id: 'd', customer_id: null, customer_label: null },
  { id: 'd3', code: 'CBL-D3', cable_type: 'distribution', from_enclosure_id: 'd', to_enclosure_id: 'e', customer_id: null, customer_label: null },
  { id: 'drop1', code: 'CBL-DROP-1', cable_type: 'drop', from_enclosure_id: 'b', to_enclosure_id: null, customer_id: 'cust1', customer_label: 'CUST-1' },
  { id: 'drop2', code: 'CBL-DROP-2', cable_type: 'drop', from_enclosure_id: 'b', to_enclosure_id: null, customer_id: 'cust2', customer_label: 'CUST-2' },
  { id: 'drop3', code: 'CBL-DROP-3', cable_type: 'drop', from_enclosure_id: 'c', to_enclosure_id: null, customer_id: 'cust3', customer_label: 'CUST-3' },
  { id: 'drop9', code: 'CBL-DROP-9', cable_type: 'drop', from_enclosure_id: 'e', to_enclosure_id: null, customer_id: 'cust9', customer_label: 'CUST-9' },
];

const CORES = [
  { id: 'f1c1', cable_id: 'f1', core_number: 1, status: 'spliced' },
  { id: 'd1c1', cable_id: 'd1', core_number: 1, status: 'spliced' },
  { id: 'd1c2', cable_id: 'd1', core_number: 2, status: 'available' },
  { id: 'd2c1', cable_id: 'd2', core_number: 1, status: 'spliced' },
  { id: 'd3c1', cable_id: 'd3', core_number: 1, status: 'spliced' },
  { id: 'drop1c1', cable_id: 'drop1', core_number: 1, status: 'terminated' },
  { id: 'drop2c1', cable_id: 'drop2', core_number: 1, status: 'terminated' },
  { id: 'drop3c1', cable_id: 'drop3', core_number: 1, status: 'terminated' },
  { id: 'drop9c1', cable_id: 'drop9', core_number: 1, status: 'terminated' },
];

const SPLICES = [
  { id: 's1', enclosure_id: 'a', core_a_id: 'f1c1', core_b_id: 'd1c1', splice_type: 'fusion' },
  { id: 's4', enclosure_id: 'a', core_a_id: 'f1c1', core_b_id: 'd2c1', splice_type: 'fusion' },
  { id: 's5', enclosure_id: 'd', core_a_id: 'd2c1', core_b_id: 'd3c1', splice_type: 'fusion' },
  { id: 's6', enclosure_id: 'e', core_a_id: 'd3c1', core_b_id: 'drop9c1', splice_type: 'fusion' },
];

const SPLITTERS = [
  { id: 'sp1', enclosure_id: 'b', name: 'Tray A', input_core_id: 'd1c1', split_count: 8 },
  { id: 'sp2', enclosure_id: 'c', name: null, input_core_id: null, split_count: 2 },
];

const PORTS = [
  { id: 'p1', splitter_id: 'sp1', port_number: 1, output_core_id: 'drop1c1', output_splitter_id: null },
  { id: 'p2', splitter_id: 'sp1', port_number: 2, output_core_id: 'drop2c1', output_splitter_id: null },
  { id: 'p3', splitter_id: 'sp1', port_number: 3, output_core_id: null, output_splitter_id: 'sp2' },
  { id: 'p4', splitter_id: 'sp2', port_number: 1, output_core_id: 'drop3c1', output_splitter_id: null },
];

const HEADENDS = [
  { id: 'h1', code: 'OLT-01', name: 'Main OLT', site_type: 'olt', root_enclosure_id: 'olt' },
];

const CUSTOMERS_LIST = [
  { id: 'cust1', customer_code: 'CUST-1', name: 'Ada' },
  { id: 'cust2', customer_code: 'CUST-2', name: 'Grace' },
  { id: 'cust3', customer_code: 'CUST-3', name: 'Alan' },
  { id: 'cust9', customer_code: 'CUST-9', name: 'Barbara' },
];

// "capacity at a box" is what getAvailableCoreCounts() reports; tests tweak it.
let CAPACITY_ROWS = [
  { enclosure_id: 'a', available_cores: '4' },
  { enclosure_id: 'e', available_cores: '2' },
];
let HEADEND_ROWS = HEADENDS;

const BOX_LOCATIONS = {
  olt: { lat: 34.0, lng: 71.5 },
  a: { lat: 34.01, lng: 71.5 },
  b: { lat: 34.02, lng: 71.5 },
  c: { lat: 34.03, lng: 71.5 },
  d: { lat: 34.04, lng: 71.5 },
  e: { lat: 34.05, lng: 71.5 },
};

// --- knex-shaped stub ------------------------------------------------------------

const TABLES = () => ({
  enclosures: ENCLOSURES,
  cables: CABLES,
  fiber_cores: CORES,
  splices: SPLICES,
  splitters: SPLITTERS,
  splitter_ports: PORTS,
  headends: HEADEND_ROWS,
  customers: CUSTOMERS_LIST,
});

function matches(row, q) {
  return (
    q.eq.every(([col, val]) => row[col] === val) &&
    q.in_.every(([col, vals]) => vals.includes(row[col])) &&
    q.notNull.every((col) => row[col] != null)
  );
}

function fakeDb(table) {
  const q = { eq: [], in_: [], notNull: [] };
  const rows = () => (TABLES()[table] || []).filter((row) => matches(row, q));
  const builder = {
    where(arg, val) {
      if (arg && typeof arg === 'object') {
        for (const [col, v] of Object.entries(arg)) q.eq.push([col, v]);
      } else {
        q.eq.push([arg, val]);
      }
      return builder;
    },
    whereIn(col, vals) {
      q.in_.push([col, vals]);
      return builder;
    },
    whereNotNull(col) {
      q.notNull.push(col);
      return builder;
    },
    select: () => builder,
    orderBy: () => builder,
    first: () => Promise.resolve(rows()[0] || null),
    then: (onFulfilled, onRejected) => Promise.resolve(rows()).then(onFulfilled, onRejected),
  };
  return builder;
}

// capacityGraph.getAvailableCoreCounts() runs one raw aggregate query, and the
// service opens by asking the schema probe which columns this database has.
fakeDb.raw = async (sql) => {
  if (isSchemaProbe(sql)) return schemaProbeRows(true);
  if (typeof sql === 'string' && /available_cores/.test(sql)) {
    return { rows: CAPACITY_ROWS };
  }
  throw new Error(`unexpected raw query in test stub: ${sql}`);
};

// Stub ../src/db in the require cache BEFORE loading the service.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { isSchemaProbe, schemaProbeRows } = require('./helpers/schema');
const { resetSchemaCache } = require('../src/utils/schemaCapabilities');
beforeEach(() => resetSchemaCache());

const {
  resolveRoots,
  bfsNearestSource,
  nearestLiveSource,
  simulateFailure,
} = require('../src/services/impactAnalysis');

// --- tests ------------------------------------------------------------------------

describe('resolveRoots', () => {
  test('a headend roots the segment at the box its feeder lands in', () => {
    const { rooted, rootBoxIds, rootCoreIds } = resolveRoots({
      headends: HEADENDS,
      enclosures: ENCLOSURES,
      cables: CABLES,
      cores: CORES,
    });
    assert.equal(rooted.length, 1);
    assert.deepEqual(rootBoxIds, ['olt']);
    assert.deepEqual(rootCoreIds, ['f1c1']); // the feeder's core
  });

  test('a headend with no root box or a deleted box is ignored', () => {
    const { rooted, rootCoreIds } = resolveRoots({
      headends: [
        { id: 'h2', code: 'OLT-02', root_enclosure_id: null },
        { id: 'h3', code: 'OLT-03', root_enclosure_id: 'gone' },
      ],
      enclosures: ENCLOSURES,
      cables: CABLES,
      cores: CORES,
    });
    assert.equal(rooted.length, 0);
    assert.deepEqual(rootCoreIds, []);
  });
});

describe('simulateFailure', () => {
  test('a box failure reports downstream customers, boxes and cables', async () => {
    const result = await simulateFailure({
      kind: 'box',
      id: 'b',
      boxIds: ['b'],
      element: { code: 'BOX-B' },
      boxLocations: BOX_LOCATIONS,
    });

    assert.equal(result.direction_resolved, true);
    assert.equal(result.headend.code, 'OLT-01');
    assert.equal(result.headend.root_enclosure_code, 'BOX-OLT');
    assert.equal(result.failure.kind, 'box');
    assert.equal(result.failure.label, 'BOX-B');
    assert.equal(result.affected_count, 3);
    assert.deepEqual(
      result.affected.customers.map((c) => c.customer_label).sort(),
      ['CUST-1', 'CUST-2', 'CUST-3'],
    );
    assert.deepEqual(
      result.affected.boxes.map((b) => b.code).sort(),
      ['BOX-B', 'BOX-C'],
    );
    assert.equal(result.affected.boxes.find((b) => b.code === 'BOX-B').is_failure, true);
    assert.ok(result.affected.cables.some((c) => c.code === 'CBL-D1'));

    // Every affected customer carries the path light used to take.
    const cust1 = result.affected.customers.find((c) => c.customer_label === 'CUST-1');
    assert.ok(cust1.path_through_failure.length >= 3);
    assert.equal(cust1.path_through_failure[cust1.path_through_failure.length - 1].cable_code, 'CBL-DROP-1');
  });

  test('restoration options come from the capacity BFS with dark boxes excluded', async () => {
    const result = await simulateFailure({
      kind: 'box',
      id: 'b',
      boxIds: ['b'],
      boxLocations: BOX_LOCATIONS,
    });

    const [first, second] = result.upstream_reroute_candidates;
    // CUST-1 and CUST-2 share BOX-B as their patch point → one option for both.
    assert.equal(first.patch_box_code, 'BOX-B');
    assert.equal(first.restorable_count, 2);
    assert.equal(first.viability, 'cabled');
    assert.equal(first.source_box_code, 'BOX-A');
    assert.equal(first.hops, 1);
    assert.equal(first.available_cores, 4);
    assert.deepEqual(
      first.restorable_customers.map((c) => c.customer_label),
      ['CUST-1', 'CUST-2'],
    );

    // BOX-C has no cable back to a live box in this fixture, so the plan falls
    // back to the nearest live box with spare cores and says it is a new span.
    assert.equal(second.patch_box_code, 'BOX-C');
    assert.equal(second.viability, 'new_span');
    assert.equal(second.source_box_id, null);
    assert.ok(second.approx_distance_m > 0);

    assert.deepEqual(result.restoration.source_box_ids, ['a']);
    assert.deepEqual(result.restoration.patch_box_ids.sort(), ['b', 'c']);
    assert.equal(result.restoration.options, 2);
    assert.equal(result.summary.restoration_options, 2);
  });

  test('a dark box is never offered as the source to patch from', async () => {
    CAPACITY_ROWS = [{ enclosure_id: 'b', available_cores: '12' }]; // only the failed box
    try {
      const result = await simulateFailure({
        kind: 'box',
        id: 'b',
        boxIds: ['b'],
        boxLocations: BOX_LOCATIONS,
      });
      const option = result.upstream_reroute_candidates.find((c) => c.patch_box_code === 'BOX-B');
      assert.equal(option.source_box_id, null);
      assert.equal(option.viability, 'unknown');
      assert.equal(option.restorable_count, 2);
    } finally {
      CAPACITY_ROWS = [
        { enclosure_id: 'a', available_cores: '4' },
        { enclosure_id: 'e', available_cores: '2' },
      ];
    }
  });

  test('cutting a cable keeps the box upstream of the cut lit', async () => {
    const result = await simulateFailure({
      kind: 'cable',
      id: 'd1',
      cableIds: ['d1'],
      element: { code: 'CBL-D1' },
      boxLocations: BOX_LOCATIONS,
    });

    assert.deepEqual(
      result.affected.boxes.map((b) => b.code).sort(),
      ['BOX-B', 'BOX-C'],
    );
    // BOX-A still has light, so it is the source offered for the patch.
    assert.equal(result.upstream_reroute_candidates[0].source_box_code, 'BOX-A');
    assert.equal(result.affected.cables.find((c) => c.code === 'CBL-D1').is_failure, true);
  });

  test('without a headend the result is directionless and offers no patch plan', async () => {
    HEADEND_ROWS = [];
    try {
      const result = await simulateFailure({
        kind: 'box',
        id: 'b',
        boxIds: ['b'],
        boxLocations: BOX_LOCATIONS,
      });
      assert.equal(result.direction_resolved, false);
      assert.equal(result.headend, null);
      assert.equal(result.affected_count, 4); // the undirected over-approximation
      assert.deepEqual(result.upstream_reroute_candidates, []);
      assert.ok(result.warnings.some((w) => /network root .*is configured/i.test(w)));
    } finally {
      HEADEND_ROWS = HEADENDS;
    }
  });

  test('a headend row that points nowhere is called out, not misdiagnosed', async () => {
    HEADEND_ROWS = [{ id: 'h2', code: 'OLT-02', name: 'New OLT', site_type: 'olt', root_enclosure_id: null }];
    try {
      const result = await simulateFailure({ kind: 'box', id: 'b', boxIds: ['b'], boxLocations: BOX_LOCATIONS });
      assert.equal(result.direction_resolved, false);
      assert.ok(result.warnings.some((w) => /none point at an existing enclosure/.test(w)));
      assert.ok(!result.warnings.some((w) => /network root .*is configured/i.test(w)));
    } finally {
      HEADEND_ROWS = HEADENDS;
    }
  });

  test('a failure point with nothing documented is reported, not invented', async () => {
    const result = await simulateFailure({
      kind: 'box',
      id: 'ghost',
      boxIds: ['ghost'],
      boxLocations: BOX_LOCATIONS,
    });
    assert.equal(result.affected_count, 0);
    assert.equal(result.surface.entry_count, 0);
    assert.ok(result.warnings.some((w) => /No fibers are documented/.test(w)));
  });
});

describe('restoration search helpers', () => {
  const adjacency = {
    b: [{ neighbor: 'a', cableId: 'd1', cableCode: 'CBL-D1', lengthM: 100 }],
    a: [{ neighbor: 'olt', cableId: 'f1', cableCode: 'CBL-F1', lengthM: 200 }],
  };
  const live = new Set(['olt', 'a']);
  const capacity = { a: 4 };

  test('the BFS prefers the nearest live box with spare cores', () => {
    const found = bfsNearestSource('b', {
      adjacency,
      capacity,
      live,
      darkBoxIds: new Set(['b']),
    });
    assert.equal(found.found, true);
    assert.equal(found.source_box_id, 'a');
    assert.equal(found.hops, 1);
    assert.equal(found.same_box, false);
    assert.equal(found.path[0].cable_code, 'CBL-D1');
  });

  test('a live patch box can use its own spare cores', () => {
    const found = bfsNearestSource('a', {
      adjacency,
      capacity,
      live,
      darkBoxIds: new Set(['b']),
    });
    assert.equal(found.found, true);
    assert.equal(found.source_box_id, 'a');
    assert.equal(found.same_box, true);
    assert.equal(found.hops, 0);
  });

  test('a dark patch box that has capacity is not its own source', () => {
    const found = bfsNearestSource('b', {
      adjacency,
      capacity: { b: 8, a: 4 },
      live,
      darkBoxIds: new Set(['b']),
    });
    assert.equal(found.source_box_id, 'a');
  });

  test('no reachable live box → not found, then the distance fallback decides', () => {
    const found = bfsNearestSource('e', {
      adjacency,
      capacity,
      live,
      darkBoxIds: new Set(['b']),
    });
    assert.equal(found.found, false);

    const nearest = nearestLiveSource('e', {
      live,
      capacity,
      boxLocations: BOX_LOCATIONS,
    });
    assert.equal(nearest.box_id, 'a'); // ~4.4 km away vs ~5.5 km for olt/olt
    assert.ok(nearest.distance_m > 4000);
  });
});
