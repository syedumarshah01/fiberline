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
  if (isInferenceQuery(sql)) return { rows: fakeDb.__inferredPairs || [] };
  if (typeof sql === 'string' && /available_cores/.test(sql)) {
    return { rows: CAPACITY_ROWS };
  }
  throw new Error(`unexpected raw query in test stub: ${sql}`);
};

// Stub ../src/db in the require cache BEFORE loading the service.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { isSchemaProbe, isInferenceQuery, schemaProbeRows } = require('./helpers/schema');
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
    const { rooted, inferred, rootCoreIds, source } = resolveRoots({
      headends: [
        { id: 'h2', code: 'OLT-02', root_enclosure_id: null },
        { id: 'h3', code: 'OLT-03', root_enclosure_id: 'gone' },
      ],
      enclosures: ENCLOSURES,
      cables: CABLES,
      cores: CORES,
    });
    assert.equal(rooted.length, 0);
    // A headend row that points nowhere used to leave the analysis directionless.
    // The shape of the network can still answer, so it does — and says it did.
    assert.equal(source, 'inferred');
    assert.deepEqual(inferred.map((b) => b.code), ['BOX-OLT']);
    assert.deepEqual(rootCoreIds, ['f1c1']);
  });

  test('the declared headend always beats the inferred one', () => {
    // BOX-C is a nap with only drops leaving it; the declared root is a box the
    // shape would not have picked, and it must win outright — an inference is a
    // fallback, never an override.
    const { source, rootBoxIds, rootCoreIds } = resolveRoots({
      headends: [{ id: 'h9', code: 'OLT-09', root_enclosure_id: 'a' }],
      enclosures: ENCLOSURES,
      cables: CABLES,
      cores: CORES,
    });
    assert.equal(source, 'headend');
    assert.deepEqual(rootBoxIds, ['a']);
    assert.deepEqual(rootCoreIds.sort(), ['d1c1', 'd1c2', 'd2c1', 'f1c1']);
  });

  test('a network that does not say where the light enters stays undirected', () => {
    // A backhaul cable arriving at the OLT box means no box is unfed any more,
    // so the shape has no answer and the analysis must not invent one.
    const { source, rootCoreIds } = resolveRoots({
      headends: [],
      enclosures: ENCLOSURES,
      cables: [...CABLES, { id: 'bh', code: 'CBL-BH', cable_type: 'distribution', from_enclosure_id: 'e', to_enclosure_id: 'olt' }],
      cores: CORES,
    });
    assert.equal(source, 'none');
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
    // Red means "no light in it": the span that *feeds* BOX-B (CBL-D1) still has
    // light on it up to the box, so it is not painted — the drops behind the box
    // are. (Same rule the "cutting a cable keeps the box upstream of the cut
    // lit" case below states from the other side.)
    assert.ok(
      !result.affected.cables.some((c) => c.code === 'CBL-D1'),
      `CBL-D1 still has light: ${JSON.stringify(result.affected.cables.map((c) => c.code))}`,
    );
    assert.deepEqual(
      result.affected.cables.map((c) => c.code).sort(),
      ['CBL-DROP-1', 'CBL-DROP-2', 'CBL-DROP-3'],
    );

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

  test('failure simulation rejects cable targets', async () => {
    await assert.rejects(
      () => simulateFailure({
        kind: 'cable',
        id: 'd1',
        cableIds: ['d1'],
        element: { code: 'CBL-D1' },
        boxLocations: BOX_LOCATIONS,
      }),
      /supports boxes only/,
    );
  });

  test('without a headend the direction is inferred, so the feeding span is not painted', async () => {
    // The reported bug: with no headend the walk went both ways and reported the
    // feeder that supplies BOX-B as out. The shape of the network knows better.
    HEADEND_ROWS = [];
    try {
      const result = await simulateFailure({
        kind: 'box',
        id: 'b',
        boxIds: ['b'],
        boxLocations: BOX_LOCATIONS,
      });
      assert.equal(result.direction_resolved, true);
      assert.equal(result.direction_source, 'inferred');
      assert.deepEqual(result.inferred_root_boxes.map((b) => b.code), ['BOX-OLT']);
      assert.equal(result.headend, null, 'nothing was configured, so there is no headend to report');
      assert.equal(result.affected_count, 3, 'CUST-1, CUST-2 and CUST-3 hang off BOX-B');
      // CBL-D1 and CBL-D2 feed BOX-B and BOX-D and still have light on them.
      assert.ok(
        !result.affected.cables.some((c) => c.code === 'CBL-D1'),
        'the span feeding BOX-B must not be reported out',
      );
      assert.ok(result.warnings.some((w) => /direction was inferred/.test(w) && /BOX-OLT/.test(w)));
      assert.ok(!result.warnings.some((w) => /network root .*is configured/i.test(w)));
    } finally {
      HEADEND_ROWS = HEADENDS;
    }
  });

  test('a headend row that points nowhere is called out, and the inference fills in', async () => {
    HEADEND_ROWS = [{ id: 'h2', code: 'OLT-02', name: 'New OLT', site_type: 'olt', root_enclosure_id: null }];
    try {
      const result = await simulateFailure({ kind: 'box', id: 'b', boxIds: ['b'], boxLocations: BOX_LOCATIONS });
      assert.equal(result.direction_resolved, true, 'the shape still orients the analysis');
      assert.equal(result.direction_source, 'inferred');
      const warned = result.warnings.find((w) => /none point at an existing enclosure/.test(w));
      assert.ok(warned, 'the broken headend row is still reported');
      assert.match(warned, /BOX-OLT/, 'and it names the box the shape suggests');
      assert.ok(!result.warnings.some((w) => /network root .*is configured/i.test(w)));
    } finally {
      HEADEND_ROWS = HEADENDS;
    }
  });

  test('a genuinely directionless network says so instead of guessing', async () => {
    // No headend, and a backhaul arriving at the OLT box: no box is unfed, so
    // there is nothing to infer from. This is the case the old warning described.
    HEADEND_ROWS = [];
    const backhaul = {
      id: 'bh', code: 'CBL-BH', cable_type: 'distribution',
      from_enclosure_id: 'e', to_enclosure_id: 'olt', customer_id: null, customer_label: null,
    };
    CABLES.push(backhaul);
    try {
      const result = await simulateFailure({ kind: 'box', id: 'b', boxIds: ['b'], boxLocations: BOX_LOCATIONS });
      assert.equal(result.direction_resolved, false);
      assert.equal(result.direction_source, 'none');
      assert.equal(result.affected_count, 4, 'the undirected over-approximation');
      assert.deepEqual(result.upstream_reroute_candidates, []);
      assert.ok(result.warnings.some((w) => /does not say where the light enters/.test(w)));
    } finally {
      CABLES.pop();
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
