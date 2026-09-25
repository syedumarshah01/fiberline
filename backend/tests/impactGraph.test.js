/**
 * Unit tests for the pure impact-analysis logic (no database).
 *
 * Fixture — one OLT, and two branches spliced off the SAME feeder core at
 * BOX-A, so "reachable" and "affected" are deliberately different sets:
 *
 *                     ┌─ S1 ─ D1 ─[SP1 1:8 @ B]─┬─ DROP-1 ─ CUST-1
 *   [OLT box] ─ F1 ─ A┤                        ├─ DROP-2 ─ CUST-2
 *                     │                        └─ port3 ⤳ SP2 1:2 @ C
 *                     │                                     └─ DROP-3 ─ CUST-3
 *                     └─ S4 ─ D2 ─ D(D5) ─ D3 ─ E(D6) ─ DROP-9 ─ CUST-9
 *
 * CUST-9 is fully connected to BOX-B through the splice at BOX-A, but light
 * never flows back up through that splice — so failing BOX-B (or cutting D1)
 * must leave CUST-9 alone. An undirected walk reports it, which is exactly the
 * over-approximation the headend root exists to prevent.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeImpact,
  failureSurfaceSeeds,
  indexNetwork,
  orientLightPath,
  floodDownstream,
  floodUndirected,
  groupRestorationCandidates,
  haversineMeters,
  coreKey,
  splitterKey,
} = require('../src/utils/impactGraph');

// --- fixture -------------------------------------------------------------------

const BOXES = [
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
  { id: 'drop1', code: 'CBL-DROP-1', cable_type: 'drop', from_enclosure_id: 'b', to_enclosure_id: null, customer_id: 'cust1', customer_label: 'CUST-1' },
  { id: 'drop2', code: 'CBL-DROP-2', cable_type: 'drop', from_enclosure_id: 'b', to_enclosure_id: null, customer_id: 'cust2', customer_label: 'CUST-2' },
  { id: 'drop3', code: 'CBL-DROP-3', cable_type: 'drop', from_enclosure_id: 'c', to_enclosure_id: null, customer_id: 'cust3', customer_label: 'CUST-3' },
  // Sibling branch: spliced off the SAME feeder core at BOX-A, via BOX-D to BOX-E.
  { id: 'd2', code: 'CBL-D2', cable_type: 'distribution', from_enclosure_id: 'a', to_enclosure_id: 'd', customer_id: null, customer_label: null },
  { id: 'd3', code: 'CBL-D3', cable_type: 'distribution', from_enclosure_id: 'd', to_enclosure_id: 'e', customer_id: null, customer_label: null },
  { id: 'drop9', code: 'CBL-DROP-9', cable_type: 'drop', from_enclosure_id: 'e', to_enclosure_id: null, customer_id: 'cust9', customer_label: 'CUST-9' },
];

const CORES = [
  { id: 'f1c1', cable_id: 'f1', core_number: 1, status: 'spliced' },
  { id: 'd1c1', cable_id: 'd1', core_number: 1, status: 'spliced' },
  { id: 'drop1c1', cable_id: 'drop1', core_number: 1, status: 'terminated' },
  { id: 'drop2c1', cable_id: 'drop2', core_number: 1, status: 'terminated' },
  { id: 'drop3c1', cable_id: 'drop3', core_number: 1, status: 'terminated' },
  { id: 'd2c1', cable_id: 'd2', core_number: 1, status: 'spliced' },
  { id: 'd3c1', cable_id: 'd3', core_number: 1, status: 'spliced' },
  { id: 'drop9c1', cable_id: 'drop9', core_number: 1, status: 'terminated' },
  // Unused spare on the distribution: normal, never reported as stranded.
  { id: 'd1c2', cable_id: 'd1', core_number: 2, status: 'available' },
];

const SPLICES = [
  { id: 's1', enclosure_id: 'a', core_a_id: 'f1c1', core_b_id: 'd1c1', splice_type: 'fusion' },
  // The branch: one feeder core spliced to two distribution cores at BOX-A.
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

const CUSTOMERS = [
  { id: 'cust1', customer_code: 'CUST-1', name: 'Ada' },
  { id: 'cust2', customer_code: 'CUST-2', name: 'Grace' },
  { id: 'cust3', customer_code: 'CUST-3', name: 'Alan' },
  { id: 'cust9', customer_code: 'CUST-9', name: 'Barbara' },
];

const ROOT_CORES = ['f1c1']; // the feeder leaving the OLT box

const NET = {
  cores: CORES,
  cables: CABLES,
  enclosures: BOXES,
  splices: SPLICES,
  splitters: SPLITTERS,
  ports: PORTS,
  customers: CUSTOMERS,
};

const labels = (impact) => impact.affected.customers.map((c) => c.customer_label).sort();
const boxIds = (impact) => impact.affected.boxes.map((b) => b.id).sort();

function impactFor(overrides = {}) {
  return analyzeImpact({ ...NET, rootCoreIds: ROOT_CORES, ...overrides });
}

// --- direction: the whole point ------------------------------------------------

describe('analyzeImpact — direction', () => {
  test('a failure only reports the subtree below it, not every connected branch', () => {
    const impact = impactFor({ boxIds: ['b'] });
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2', 'CUST-3']);
    assert.equal(impact.affected.customer_count, 3);
    // CUST-9 hangs off the same OLT and is fully connected to BOX-B in the
    // splice graph — it must NOT be reported.
    assert.ok(!labels(impact).includes('CUST-9'));
    assert.ok(!boxIds(impact).includes('e'), 'BOX-E is on the other branch and still lit');
    assert.ok(!boxIds(impact).includes('d'));
    assert.equal(impact.direction, 'directed');
    assert.equal(impact.directed, true);
  });

  test('failing the shared upstream box takes both branches', () => {
    const impact = impactFor({ boxIds: ['a'] });
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2', 'CUST-3', 'CUST-9']);
    assert.ok(boxIds(impact).includes('b'));
    assert.ok(boxIds(impact).includes('e'));
  });

  test('a failure below the splitter leaves the customers on the other ports alone', () => {
    // Cut only the first drop: CUST-2/CUST-3 stay up.
    const impact = impactFor({ cableIds: ['drop1'] });
    assert.deepEqual(labels(impact), ['CUST-1']);
  });

  test('the upstream (live) end of a cut cable is not painted as dark', () => {
    const impact = impactFor({ cableIds: ['d1'] });
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2', 'CUST-3']);
    // The sibling branch shares the feeder core but not the cut cable.
    assert.ok(!labels(impact).includes('CUST-9'));
    assert.ok(boxIds(impact).includes('b'), 'BOX-B is downstream of the cut');
    assert.ok(!boxIds(impact).includes('a'), 'BOX-A still has light — do not report it');
    assert.ok(
      impact.affected.cables.some((c) => c.id === 'd1' && c.is_failure),
      'the failed cable itself is reported',
    );
  });

  test('hops count the joints crossed below the failure', () => {
    // Failing BOX-A: SP1's input, the cascade port and SP2's port = 3 joints.
    const atA = impactFor({ boxIds: ['a'] }).affected.customers.find(
      (c) => c.customer_label === 'CUST-3',
    );
    assert.equal(atA.hops, 3);
    // Failing BOX-B is one joint closer to that customer.
    const atB = impactFor({ boxIds: ['b'] }).affected.customers.find(
      (c) => c.customer_label === 'CUST-3',
    );
    assert.equal(atB.hops, 2);
    assert.equal(atB.customer_name, 'Alan');
  });

  test('cascaded splitters are crossed: the parent port feeds the child, never the reverse', () => {
    const impact = impactFor({ boxIds: ['b'] });
    const cust3 = impact.affected.customers.find((c) => c.customer_label === 'CUST-3');
    const kinds = cust3.path_through_failure.map((i) => i.kind);
    assert.ok(kinds.includes('splitter_cascade'), 'the cascade link is part of the path');
    assert.ok(
      cust3.path_through_failure.some((i) => i.kind === 'splitter' && i.name === 'Tray A'),
    );
  });

  test('failing the cascade child does not report customers on the parent ports', () => {
    const impact = impactFor({ boxIds: ['c'] });
    assert.deepEqual(labels(impact), ['CUST-3']);
  });

  test('a pole failure takes its box and the span that depends on it', () => {
    // The pole carries BOX-B; the drop cables and D1 run through it.
    const impact = impactFor({ boxIds: ['b'], cableIds: ['d1'] });
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2', 'CUST-3']);
    assert.ok(impact.surface.cable_ids.includes('d1'));
  });
});

// --- undirected fallback ----------------------------------------------------------

describe('mid-span closures (a cable split in two by an inserted box)', () => {
  /**
   * Light does not stop at a closure that was inserted mid-span: the cable was
   * cut into two rows and the fiber continues, core #n into core #n. The link
   * between the halves is `cable.continues_cable_id`; without it the walk dead-
   * ends inside the closure and nothing past it is reported.
   */
  const split = () => ({
    enclosures: [
      { id: 'olt', code: 'BOX-OLT', type: 'cabinet' },
      { id: 'mid', code: 'BOX-MID', type: 'splice_closure' },
      { id: 'nap', code: 'BOX-NAP', type: 'nap' },
    ],
    cables: [
      { id: 'f1', code: 'CBL-F1', cable_type: 'feeder', from_enclosure_id: 'olt', to_enclosure_id: 'mid' },
      { id: 'f1b', code: 'CBL-F1-B', cable_type: 'feeder', from_enclosure_id: 'mid', to_enclosure_id: 'nap', continues_cable_id: 'f1' },
      { id: 'drop1', code: 'CBL-DROP-1', cable_type: 'drop', from_enclosure_id: 'nap', to_enclosure_id: null, customer_id: 'c1', customer_label: 'CUST-1' },
    ],
    cores: [
      { id: 'f1c1', cable_id: 'f1', core_number: 1, status: 'spliced' },
      { id: 'f1bc1', cable_id: 'f1b', core_number: 1, status: 'spliced' },
      { id: 'drop1c1', cable_id: 'drop1', core_number: 1, status: 'terminated' },
    ],
    splices: [{ id: 's1', enclosure_id: 'nap', core_a_id: 'f1bc1', core_b_id: 'drop1c1' }],
    splitters: [],
    ports: [],
    customers: [{ id: 'c1', customer_code: 'CUST-1' }],
  });

  test('failing the OLT reaches every customer past the inserted box', () => {
    const impact = analyzeImpact({ ...split(), boxIds: ['olt'], rootCoreIds: ['f1c1'] });
    assert.deepEqual(labels(impact), ['CUST-1']);
    assert.equal(impact.affected.customer_count, 1);
    // Both halves of the split cable, and the closure itself, are dark.
    assert.deepEqual(impact.affected.cables.map((c) => c.code).sort(), ['CBL-DROP-1', 'CBL-F1', 'CBL-F1-B']);
    assert.deepEqual(impact.affected.boxes.map((b) => b.code).sort(), ['BOX-MID', 'BOX-NAP', 'BOX-OLT']);
  });

  test('the customer path shows the closure the fiber passes through', () => {
    const impact = analyzeImpact({ ...split(), boxIds: ['olt'], rootCoreIds: ['f1c1'] });
    const [customer] = impact.affected.customers;
    const kinds = customer.path_through_failure.map((i) => i.kind);
    assert.deepEqual(kinds, ['fiber', 'continuation', 'fiber', 'splice', 'fiber']);
    const step = customer.path_through_failure.find((i) => i.kind === 'continuation');
    assert.equal(step.box_code, 'BOX-MID');
    assert.equal(step.from_cable_code, 'CBL-F1');
    assert.equal(step.to_cable_code, 'CBL-F1-B');
  });

  test('failing the inserted box itself takes everything downstream of it', () => {
    const impact = analyzeImpact({ ...split(), boxIds: ['mid'], rootCoreIds: ['f1c1'] });
    assert.deepEqual(labels(impact), ['CUST-1']);
    assert.deepEqual(impact.affected.boxes.map((b) => b.code).sort(), ['BOX-MID', 'BOX-NAP']);
  });

  test('failing the NAP does not drag the upstream half into the outage', () => {
    const impact = analyzeImpact({ ...split(), boxIds: ['nap'], rootCoreIds: ['f1c1'] });
    assert.deepEqual(labels(impact), ['CUST-1']);
    assert.deepEqual(impact.affected.boxes.map((b) => b.code), ['BOX-NAP']);
    assert.deepEqual(impact.affected.cables.map((c) => c.code).sort(), ['CBL-DROP-1', 'CBL-F1-B']);
  });

  test('without the link the walk stops at the closure and says so', () => {
    // Old data: the two halves exist but nothing joins them.
    const unlinked = split();
    unlinked.cables = unlinked.cables.map((c) =>
      c.id === 'f1b' ? { ...c, continues_cable_id: null } : c,
    );
    const impact = analyzeImpact({ ...unlinked, boxIds: ['olt'], rootCoreIds: ['f1c1'] });
    assert.equal(impact.affected.customer_count, 0);
    assert.ok(impact.warnings.some((w) => /continues_cable_id/.test(w)));
  });

  test('the warning names the pair to link, so the fix is one UPDATE away', () => {
    const unlinked = split();
    unlinked.cables = unlinked.cables.map((c) =>
      c.id === 'f1b' ? { ...c, continues_cable_id: null } : c,
    );
    const impact = analyzeImpact({ ...unlinked, boxIds: ['olt'], rootCoreIds: ['f1c1'] });

    const hint = impact.warnings.find((w) => /unlinked mid-span split/.test(w));
    assert.ok(hint, `expected a named-pair warning, got: ${JSON.stringify(impact.warnings)}`);
    assert.match(hint, /CBL-F1-B ← CBL-F1/);
    assert.match(hint, /db:link-splits/);
  });

  test('a split that IS linked produces no such hint', () => {
    const impact = analyzeImpact({ ...split(), boxIds: ['olt'], rootCoreIds: ['f1c1'] });
    assert.equal(impact.warnings.some((w) => /unlinked mid-span split/.test(w)), false);
  });

  test('the hint stays quiet about pairs unrelated to the unreached cores', () => {
    // A -B cable somewhere else in the network, fully reachable: naming it
    // would be noise in an outage report.
    const withBystander = split();
    withBystander.enclosures = [
      ...withBystander.enclosures,
      { id: 'other', code: 'BOX-OTHER', type: 'cabinet' },
      { id: 'other-end', code: 'BOX-OTHER-END', type: 'nap' },
    ];
    withBystander.cables = [
      ...withBystander.cables.map((c) =>
        c.id === 'f1b' ? { ...c, continues_cable_id: null } : c,
      ),
      { id: 'x1', code: 'CBL-X1', cable_type: 'feeder', from_enclosure_id: 'other', to_enclosure_id: 'other-end' },
      { id: 'x1b', code: 'CBL-X1-B', cable_type: 'feeder', from_enclosure_id: 'other-end', to_enclosure_id: null },
    ];
    withBystander.cores = [
      ...withBystander.cores,
      { id: 'x1c1', cable_id: 'x1', core_number: 1, status: 'available' },
      { id: 'x1bc1', cable_id: 'x1b', core_number: 1, status: 'available' },
    ];

    const impact = analyzeImpact({ ...withBystander, boxIds: ['olt'], rootCoreIds: ['f1c1'] });
    const hint = impact.warnings.find((w) => /unlinked mid-span split/.test(w)) || '';
    assert.match(hint, /CBL-F1-B/, 'the split in the outage is named');
    assert.doesNotMatch(hint, /CBL-X1-B/, 'the unrelated spare pair is not');
  });

  test('a splitter downstream of the inserted box still counts its ports', () => {
    const withSplitter = split();
    withSplitter.cores = [
      ...withSplitter.cores,
      { id: 'drop2c1', cable_id: 'drop2', core_number: 1, status: 'terminated' },
    ];
    withSplitter.cables = [
      ...withSplitter.cables,
      { id: 'drop2', code: 'CBL-DROP-2', cable_type: 'drop', from_enclosure_id: 'nap', to_enclosure_id: null, customer_id: 'c2', customer_label: 'CUST-2' },
    ];
    withSplitter.splices = [];
    withSplitter.splitters = [{ id: 'sp1', enclosure_id: 'nap', name: 'Tray A', input_core_id: 'f1bc1', split_count: 8 }];
    withSplitter.ports = [
      { id: 'p1', splitter_id: 'sp1', port_number: 1, output_core_id: 'drop1c1' },
      { id: 'p2', splitter_id: 'sp1', port_number: 2, output_core_id: 'drop2c1' },
    ];
    const impact = analyzeImpact({ ...withSplitter, boxIds: ['olt'], rootCoreIds: ['f1c1'] });
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2']);
  });
});

describe('customer attribution when the documentation is thin', () => {
  // A drop cable exists to reach one premises: its far end IS the customer,
  // even when nobody typed a label or marked the core terminated. The map
  // already paints such a drop red, so it has to be counted — otherwise the
  // panel claims "nobody is affected" while a customer's drop is dark.
  test('a lit, unlabelled drop core is still a customer down', () => {
    const thin = {
      ...NET,
      cores: CORES.map((c) =>
        c.id === 'drop2c1' ? { ...c, status: 'spliced' } : c,
      ),
      cables: CABLES.map((c) =>
        c.id === 'drop2' ? { ...c, customer_id: null, customer_label: null } : c,
      ),
    };
    const impact = analyzeImpact({ ...thin, boxIds: ['b'], rootCoreIds: ROOT_CORES });
    assert.equal(impact.affected.customer_count, 3); // CUST-1, CUST-3 + the unnamed drop
    assert.equal(impact.affected.unnamed_count, 1);
    const unnamed = impact.affected.customers.find((c) => c.unnamed);
    assert.equal(unnamed.cable_code, 'CBL-DROP-2');
    assert.equal(unnamed.source, 'drop');
  });

  test('an unused spare strand in that same drop is not a second customer', () => {
    const withSpare = {
      ...NET,
      cores: [
        ...CORES,
        { id: 'drop1c2', cable_id: 'drop1', core_number: 2, status: 'available' },
        { id: 'drop3c2', cable_id: 'drop3', core_number: 2, status: 'available' },
      ],
    };
    // Those spares are part of the failure surface (their cables land at the
    // failed box / hang off the cascade), but they serve nobody.
    const impact = analyzeImpact({ ...withSpare, boxIds: ['b'], rootCoreIds: ROOT_CORES });
    assert.equal(impact.affected.customer_count, 3);
    assert.equal(impact.affected.unnamed_count, 0);
  });

  test('one drop cable is one customer, however many strands are lit', () => {
    const twinStrand = {
      ...NET,
      cores: [
        ...CORES,
        { id: 'drop1c2', cable_id: 'drop1', core_number: 2, status: 'spliced' },
      ],
      splices: [
        ...SPLICES,
        { id: 's7', enclosure_id: 'b', core_a_id: 'd1c2', core_b_id: 'drop1c2', splice_type: 'fusion' },
      ],
    };
    const impact = analyzeImpact({ ...twinStrand, boxIds: ['b'], rootCoreIds: ROOT_CORES });
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2', 'CUST-3']);
  });

  test('a lit core landing in a customer box counts even without a drop cable', () => {
    const direct = {
      ...NET,
      enclosures: [
        ...BOXES,
        { id: 'custbox', code: 'CUST-BOX-1', name: null, type: 'terminal' },
      ],
      cables: [
        ...CABLES,
        { id: 'direct', code: 'CBL-DIRECT', cable_type: 'distribution', from_enclosure_id: 'b', to_enclosure_id: 'custbox', customer_id: null, customer_label: null },
      ],
      cores: [
        ...CORES,
        { id: 'directc1', cable_id: 'direct', core_number: 1, status: 'spliced' },
      ],
      splices: [
        ...SPLICES,
        { id: 's8', enclosure_id: 'b', core_a_id: 'd1c1', core_b_id: 'directc1', splice_type: 'fusion' },
      ],
    };
    const impact = analyzeImpact({ ...direct, boxIds: ['b'], rootCoreIds: ROOT_CORES });
    assert.equal(impact.affected.customer_count, 4);
    const inferred = impact.affected.customers.find((c) => c.cable_code === 'CBL-DIRECT');
    assert.equal(inferred.source, 'customer_box');
    assert.equal(inferred.serving_box_code, 'BOX-B');
  });

  test('a documented customer keeps its label, and says so', () => {
    const impact = impactFor({ boxIds: ['b'] });
    assert.equal(impact.affected.customers.find((c) => c.customer_label === 'CUST-1').source, 'documented');
  });
});

describe('analyzeImpact — no root configured', () => {
  test('without a headend the analysis says so and over-reports', () => {
    const impact = analyzeImpact({ ...NET, boxIds: ['b'] });
    assert.equal(impact.direction, 'undirected');
    assert.equal(impact.directed, false);
    assert.ok(impact.warnings.some((w) => /network root .*is configured/i.test(w)));
    // Undirected: the walk climbs back through BOX-A and reports the sibling
    // branch too — the over-approximation the root exists to prevent.
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2', 'CUST-3', 'CUST-9']);
  });

  test('a spare core in the failed element does not raise an unrooted warning', () => {
    // CBL-D1 carries an unused core that is spliced to nothing. It is part of
    // the failure surface (the cable is cut) but it reaches no customer, so
    // warning "an element is unrooted" would be noise.
    const impact = impactFor({ cableIds: ['d1'] });
    assert.ok(!impact.warnings.some((w) => /not connected to a configured network root/.test(w)));
  });

  test('a broken segment is reported without direction, and says so', () => {
    // Remove the splice that feeds BOX-B: nothing at that failure point can
    // trace back to the OLT any more, so the walk falls back to undirected and
    // the warning has to admit the result may over-report.
    const severed = { ...NET, splices: SPLICES.filter((sp) => sp.id !== 's1') };
    const impact = analyzeImpact({ ...severed, boxIds: ['b'], rootCoreIds: ROOT_CORES });
    assert.ok(impact.warnings.some((w) => /not connected to a configured network root/.test(w)));
    assert.ok(impact.warnings.some((w) => /over-report/.test(w)));
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2', 'CUST-3']);
  });

  test('an unreachable-from-root core is flagged rather than silently ignored', () => {
    // Take the spare core off the graph by not splicing it anywhere: it can
    // never be reached from the OLT, and the analysis reports it.
    const isolated = {
      ...NET,
      cores: [...CORES, { id: 'orphan', cable_id: 'd1', core_number: 9, status: 'spliced' }],
    };
    const impact = analyzeImpact({ ...isolated, boxIds: ['b'], rootCoreIds: ROOT_CORES });
    assert.equal(impact.unreached.core_count, 1); // the unspliced spare is not counted
    assert.ok(impact.warnings.some((w) => /not reachable from the network root/.test(w)));
  });
});

// --- surfaces, paths, plates --------------------------------------------------------

describe('failureSurfaceSeeds', () => {
  const index = indexNetwork(NET);

  test('a box failure seeds every splice, splitter and landing core in it', () => {
    const seeds = failureSurfaceSeeds(index, { failureBoxIds: new Set(['b']) });
    // Cores landing at BOX-B, plus the cores of the splitter inside it.
    assert.ok(seeds.seedCoreIds.includes('d1c1'));
    assert.ok(seeds.seedCoreIds.includes('drop1c1'));
    assert.ok(seeds.seedCoreIds.includes('drop2c1'));
    assert.ok(seeds.seedSplitterIds.includes('sp1'));
    assert.equal(seeds.seedKeys.length, seeds.seedCoreIds.length + seeds.seedSplitterIds.length);
  });

  test('a cable failure seeds just that cable’s cores', () => {
    const seeds = failureSurfaceSeeds(index, { failureCableIds: new Set(['drop2']) });
    assert.deepEqual(seeds.seedCoreIds, ['drop2c1']);
  });
});

describe('impact paths and boxes', () => {
  test('the path runs from the failure out to the customer, in light order', () => {
    const impact = impactFor({ boxIds: ['b'] });
    const cust1 = impact.affected.customers.find((c) => c.customer_label === 'CUST-1');
    const path = cust1.path_through_failure;
    assert.equal(path[0].kind, 'fiber');
    const kinds = path.map((i) => i.kind);
    assert.deepEqual(kinds, ['fiber', 'splitter_input', 'splitter', 'splitter_port', 'fiber']);
    // The final hop is the customer's own drop core, labelled for the field tech.
    assert.equal(path[path.length - 1].cable_code, 'CBL-DROP-1');
    assert.equal(path[path.length - 1].customer_label, 'CUST-1');
  });

  test('a customer attached straight to the failed box is patched at that box', () => {
    const impact = impactFor({ boxIds: ['b'] });
    const cust1 = impact.affected.customers.find((c) => c.customer_label === 'CUST-1');
    assert.equal(cust1.patch_box_id, 'b');
    assert.equal(cust1.patch_box_code, 'BOX-B');
  });

  test('a customer below the failure is patched at the first intact box downstream', () => {
    const impact = impactFor({ boxIds: ['b'] });
    const cust3 = impact.affected.customers.find((c) => c.customer_label === 'CUST-3');
    assert.equal(cust3.patch_box_id, 'c');
    assert.equal(cust3.serving_box_code, 'BOX-C');
  });

  test('unnamed terminations (equipment, no label) are counted separately', () => {
    const cores = CORES.map((c) =>
      c.id === 'drop1c1' ? { ...c, status: 'terminated' } : c,
    );
    const bare = {
      ...NET,
      cores,
      cables: CABLES.map((c) =>
        c.id === 'drop1' ? { ...c, customer_id: null, customer_label: null } : c,
      ),
    };
    const impact = analyzeImpact({ ...bare, boxIds: ['b'], rootCoreIds: ROOT_CORES });
    assert.equal(impact.affected.customer_count, 3);
    assert.equal(impact.affected.unnamed_count, 1);
  });

  test('the same customer reached twice is listed once, on the shortest path', () => {
    // Loop the splitter output back into a second port feeding the same drop.
    const looped = {
      ...NET,
      ports: [
        ...PORTS,
        { id: 'p5', splitter_id: 'sp1', port_number: 4, output_core_id: 'drop1c1', output_splitter_id: null },
      ],
    };
    const impact = analyzeImpact({ ...looped, boxIds: ['b'], rootCoreIds: ROOT_CORES });
    assert.deepEqual(labels(impact), ['CUST-1', 'CUST-2', 'CUST-3']);
  });

  test('an empty failure point warns instead of inventing customers', () => {
    const impact = impactFor({ boxIds: ['nonexistent-box'] });
    assert.equal(impact.affected.customer_count, 0);
    assert.deepEqual(impact.surface.seed_core_ids, []);
    assert.ok(impact.warnings.some((w) => /No fibers are documented/.test(w)));
  });

  test('floods are capped so a bad dataset cannot hang a request', () => {
    const impact = impactFor({ boxIds: ['b'], maxNodes: 2 });
    assert.equal(impact.affected.truncated, true);
    assert.ok(impact.warnings.some((w) => /truncated/.test(w)));
  });
});

// --- flood mechanics ------------------------------------------------------------------

describe('graph orientation and floods', () => {
  const index = indexNetwork(NET);
  const roots = [coreKey('f1c1')];

  test('the rooted tree follows splitters downstream only', () => {
    const orientation = orientLightPath(index, roots);
    // The splitter's input core is upstream of it …
    assert.equal(orientation.parents.get(splitterKey('sp1')).node, coreKey('d1c1'));
    // … and its ports are children, never parents.
    const children = orientation.children.get(splitterKey('sp1')).map((e) => e.node);
    assert.deepEqual(children, [coreKey('drop1c1'), coreKey('drop2c1'), splitterKey('sp2')]);
    // The splice at BOX-A orients from the OLT side outwards.
    assert.equal(orientation.parents.get(coreKey('d1c1')).node, coreKey('f1c1'));
    assert.equal(orientation.depths.get(coreKey('drop3c1')), 4);
  });

  test('downstream flooding never climbs back up a splice', () => {
    const orientation = orientLightPath(index, roots);
    const fromCut = floodDownstream(index, orientation, [coreKey('d1c1')]);
    assert.ok(fromCut.visited.has(coreKey('drop1c1')));
    assert.ok(fromCut.visited.has(coreKey('drop3c1')));
    // f1c1 feeds d1c1 through the splice at BOX-A — it is upstream, not affected.
    assert.ok(!fromCut.visited.has(coreKey('f1c1')));
    // The sibling branch hangs off f1c1 through the splice at BOX-A: it is one
    // step upstream, so it is not dragged into the outage.
    assert.ok(!fromCut.visited.has(coreKey('drop9c1')));
    assert.ok(!fromCut.visited.has(coreKey('d3c1')));
  });

  test('a splitter is never oriented backwards, even flooded from an output core', () => {
    const orientation = orientLightPath(index, roots);
    const fromOutput = floodDownstream(index, orientation, [coreKey('drop1c1')]);
    assert.deepEqual(fromOutput.keys, [coreKey('drop1c1')]); // end of the line
    assert.ok(!fromOutput.visited.has(coreKey('sp1')));
  });

  test('an undirected flood does climb back up (the fallback behaviour)', () => {
    const flood = floodUndirected(index, [splitterKey('sp1')]);
    assert.ok(flood.visited.has(coreKey('d1c1')));
    assert.ok(flood.visited.has(coreKey('f1c1')));
    assert.ok(flood.visited.has(coreKey('drop9c1')));
  });
});

// --- restoration planning ----------------------------------------------------------------

describe('groupRestorationCandidates', () => {
  const customers = [
    { customer_label: 'CUST-1', core_id: 'drop1c1', patch_box_id: 'b', patch_box_code: 'BOX-B', serving_box_code: 'BOX-B', cable_code: 'CBL-DROP-1' },
    { customer_label: 'CUST-2', core_id: 'drop2c1', patch_box_id: 'b', patch_box_code: 'BOX-B', serving_box_code: 'BOX-B', cable_code: 'CBL-DROP-2' },
    { customer_label: 'CUST-3', core_id: 'drop3c1', patch_box_id: 'c', patch_box_code: 'BOX-C', serving_box_code: 'BOX-C', cable_code: 'CBL-DROP-3' },
  ];

  test('customers sharing a patch point are grouped, biggest group first', () => {
    const candidates = groupRestorationCandidates(customers, {
      b: {
        found: true,
        source_box_id: 'a',
        source_box_code: 'BOX-A',
        available_cores: 4,
        hops: 1,
        path: [{ cable_code: 'CBL-D1', to_enclosure_id: 'b' }],
      },
      c: {
        found: true,
        source_box_id: 'a',
        source_box_code: 'BOX-A',
        available_cores: 4,
        hops: 3,
        path: [],
      },
    });
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].patch_box_code, 'BOX-B');
    assert.equal(candidates[0].restorable_count, 2);
    assert.deepEqual(candidates[0].restorable_customers.map((c) => c.customer_label), ['CUST-1', 'CUST-2']);
    assert.equal(candidates[0].viability, 'cabled');
    assert.equal(candidates[0].source_box_code, 'BOX-A');
    assert.equal(candidates[0].hops, 1);
    assert.equal(candidates[1].patch_box_code, 'BOX-C');
  });

  test('no intact path → the nearest live box is suggested as a new span', () => {
    const candidates = groupRestorationCandidates([customers[2]], {
      c: {
        found: false,
        nearest: { box_id: 'olt', box_code: 'BOX-OLT', available_cores: 12, distance_m: 240 },
      },
    });
    assert.equal(candidates[0].viability, 'new_span');
    assert.equal(candidates[0].source_box_id, null);
    assert.equal(candidates[0].approx_distance_m, 240);
    // The suggestion has to name where the span would come from.
    assert.equal(candidates[0].nearest_source_box_code, 'BOX-OLT');
  });

  test('nothing found at all is reported, not invented', () => {
    const candidates = groupRestorationCandidates([customers[2]], { c: { found: false } });
    assert.equal(candidates[0].viability, 'unknown');
    assert.equal(candidates[0].restorable_count, 1);
  });

  test('customers with no patch point are skipped', () => {
    const candidates = groupRestorationCandidates(
      [{ customer_label: 'CUST-X', patch_box_id: null }],
      {},
    );
    assert.deepEqual(candidates, []);
  });
});

describe('haversineMeters', () => {
  test('measures real-world distance', () => {
    // Peshawar city centre → ~1 km north
    const d = haversineMeters({ lat: 34.0083, lng: 71.5788 }, { lat: 34.0173, lng: 71.5788 });
    assert.ok(d > 950 && d < 1050, `expected ~1000 m, got ${d}`);
  });

  test('missing coordinates give null instead of NaN', () => {
    assert.equal(haversineMeters({ lat: null, lng: 1 }, { lat: 1, lng: 1 }), null);
    assert.equal(haversineMeters(null, { lat: 1, lng: 1 }), null);
  });
});
