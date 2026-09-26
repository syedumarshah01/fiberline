/**
 * "When a box fails, only the cables downstream of it go red."
 *
 * That is the promise the outage map makes to whoever is holding the phone, and
 * it is easy to believe without checking, because the wrong answer looks exactly
 * like the right one: a red span. So this file states it as two invariants and
 * sweeps every box in several topologies:
 *
 *   A  a painted cable lost light — it is never red just for being connected;
 *   B  the span that *feeds* the failed box is not painted (it still has light
 *      on it up to the break, and that is the span a crew would otherwise be
 *      sent to);
 *
 * plus the non-vacuity check, because a build that paints nothing would satisfy
 * A and B perfectly.
 *
 * Direction is supplied three ways, and all three must hold up:
 *   - a declared headend (rootCoreIds/rootBoxIds, the authoritative case);
 *   - an inferred source, when no headend is configured and the shape of the
 *     network says where the light enters (utils/impactGraph.inferSourceBoxes) —
 *     this is the case the bug was reported from;
 *   - neither (a network the shape cannot read), where the analysis is allowed
 *     to over-report but must say so.
 *
 * `analyzeImpact` is pure, so these run without a database.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeImpact,
  inferSourceBoxes,
  rootCoreIdsForBoxes,
} = require('../src/utils/impactGraph');

// --- builders -------------------------------------------------------------------

let seq = 0;
const uid = (p) => `${p}-${(seq += 1)}`;

const box = (code, type = 'nap') => ({ id: `box-${code}`, code, name: code, type, location: null });

/** A cable with `coreCount` fibres, oriented from the source end. */
function cable(code, from, to, coreCount, type = 'distribution') {
  const id = `cable-${code}`;
  const cores = Array.from({ length: coreCount }, (_, i) => ({
    id: `core-${code}-${i + 1}`,
    cable_id: id,
    core_number: i + 1,
    status: 'available',
  }));
  return {
    row: {
      id,
      code,
      name: code,
      cable_type: type,
      core_count: coreCount,
      from_enclosure_id: from?.id ?? null,
      to_enclosure_id: to?.id ?? null,
      length_m: 100,
      status: 'active',
      route: null,
      continues_cable_id: null,
    },
    cores,
    core: (n) => cores[n - 1],
  };
}

const splice = (boxRef, coreA, coreB) => ({
  id: uid('splice'),
  enclosure_id: boxRef.id,
  core_a_id: coreA.id,
  core_b_id: coreB.id,
  splice_type: 'fusion',
  loss_db: null,
});

/** A splitter in a box, fed by a core or by a parent splitter's port. */
function splitter(boxRef, name, splitCount, { inputCore = null, inputPort = null } = {}) {
  const id = uid('splitter');
  const ports = Array.from({ length: splitCount }, (_, i) => ({
    id: `${id}-port-${i + 1}`,
    splitter_id: id,
    port_number: i + 1,
    status: 'active',
    output_core_id: null,
    output_splitter_id: null,
  }));
  return {
    row: { id, enclosure_id: boxRef.id, name, split_count: splitCount, input_core_id: inputCore?.id ?? null, loss_db: null, splice_type: 'fusion' },
    ports,
    inputPort,
    use(portNumber, core) {
      ports[portNumber - 1].output_core_id = core.id;
      return this;
    },
    cascade(portNumber, child) {
      ports[portNumber - 1].output_splitter_id = child.row.id;
      return this;
    },
  };
}

function scene({ boxes, cables, splices = [], splitters = [] }) {
  const attached = [];
  for (const spl of splitters) {
    attached.push(...spl.ports);
    if (spl.inputPort) spl.inputPort.output_splitter_id = spl.row.id;
  }
  return {
    enclosures: boxes,
    cables: cables.map((c) => c.row),
    cores: cables.flatMap((c) => c.cores),
    splices,
    splitters: splitters.map((s) => s.row),
    ports: attached,
    customers: [],
  };
}

// --- topologies -----------------------------------------------------------------
//
// Each carries `feeds`: for a failed box, the code of the span that supplies it —
// the cable that must stay off the map. Stated by hand on purpose: it is the
// human expectation this file exists to check, not something derived from the
// code under test.

/** OLT ─F1→ NAP-A ─F2→ NAP-B, drops off both. */
function chain() {
  const olt = box('OLT', 'cabinet');
  const a = box('NAP-A');
  const b = box('NAP-B');
  const f1 = cable('F1', olt, a, 3, 'feeder');
  const f2 = cable('F2', a, b, 2, 'feeder');
  const d1 = cable('D1', a, null, 1, 'drop');
  const d2 = cable('D2', b, null, 1, 'drop');

  const spA = splitter(a, 'Tray A', 2, { inputCore: f1.core(1) }).use(1, d1.core(1));
  const spB = splitter(b, 'Tray B', 2, { inputCore: f2.core(1) }).use(1, d2.core(1));
  // F1#2 continues as F2#1 — this is what feeds NAP-B's splitter.
  const s = splice(a, f1.core(2), f2.core(1));

  return {
    name: 'chain',
    root: olt,
    built: scene({ boxes: [olt, a, b], cables: [f1, f2, d1, d2], splices: [s], splitters: [spA, spB] }),
    feeds: { [a.id]: 'F1', [b.id]: 'F2' },
  };
}

/** OLT ─F1→ NAP-A, which feeds two boxes and a cascaded splitter. */
function branchWithCascade() {
  const olt = box('OLT', 'cabinet');
  const a = box('NAP-A');
  const b = box('NAP-B');
  const c = box('NAP-C');
  const f1 = cable('F1', olt, a, 4, 'feeder');
  const f2 = cable('F2', a, b, 2, 'distribution');
  const f3 = cable('F3', a, c, 2, 'distribution');
  const d1 = cable('D1', a, null, 1, 'drop');
  const d2 = cable('D2', b, null, 1, 'drop');
  const d3 = cable('D3', c, null, 1, 'drop');
  const d4 = cable('D4', c, null, 1, 'drop');

  const spA = splitter(a, 'Tray A', 4, { inputCore: f1.core(1) }).use(1, d1.core(1));
  const spB = splitter(b, 'Tray B', 2, { inputCore: f2.core(1) }).use(1, d2.core(1));
  const spC = splitter(c, 'Tray C', 4, { inputCore: f3.core(1) });
  const child = splitter(c, 'Tray C2', 2, { inputPort: spC.ports[3] });
  spC.cascade(4, child);
  child.use(1, d3.core(1)).use(2, d4.core(1));

  const s1 = splice(a, f1.core(2), f2.core(1));
  const s2 = splice(a, f1.core(3), f3.core(1));

  return {
    name: 'branch + cascade',
    root: olt,
    built: scene({
      boxes: [olt, a, b, c],
      cables: [f1, f2, f3, d1, d2, d3, d4],
      splices: [s1, s2],
      splitters: [spA, spB, spC, child],
    }),
    feeds: { [a.id]: 'F1', [b.id]: 'F2', [c.id]: 'F3' },
  };
}

/** Light reaches NAP-B twice, so cutting one way in must not darken its drop. */
function secondPath() {
  const olt = box('OLT', 'cabinet');
  const a = box('NAP-A');
  const b = box('NAP-B');
  const f1 = cable('F1', olt, a, 4, 'feeder');
  const f2 = cable('F2', olt, b, 4, 'feeder');
  const f3 = cable('F3', a, b, 2, 'distribution');
  const d1 = cable('D1', b, null, 1, 'drop');

  const s1 = splice(a, f1.core(1), f3.core(1));
  const s2 = splice(b, f3.core(2), d1.core(1));
  const s3 = splice(b, f2.core(1), d1.core(1));

  return {
    name: 'second path',
    root: olt,
    built: scene({ boxes: [olt, a, b], cables: [f1, f2, f3, d1], splices: [s1, s2, s3] }),
    feeds: {},
  };
}

/** One fibre cut and closed again at MID: F1 continues as F1-B. */
function midspan() {
  const olt = box('OLT', 'cabinet');
  const mid = box('MID');
  const far = box('NAP-FAR');
  const f1 = cable('F1', olt, mid, 2, 'feeder');
  const f1b = cable('F1-B', mid, far, 2, 'feeder');
  f1b.row.continues_cable_id = f1.row.id;
  const d1 = cable('D1', far, null, 1, 'drop');

  const sp = splitter(far, 'Tray A', 2, { inputCore: f1b.core(1) }).use(1, d1.core(1));

  return {
    name: 'mid-span closure',
    root: olt,
    built: scene({ boxes: [olt, mid, far], cables: [f1, f1b, d1], splitters: [sp] }),
    feeds: { [mid.id]: 'F1', [far.id]: 'F1-B' },
  };
}

const TOPOLOGIES = [chain(), branchWithCascade(), secondPath(), midspan()];

// --- root resolution, mirroring services/impactAnalysis.js ----------------------

function rootsFor(topology, mode) {
  const { built, root } = topology;
  if (mode === 'headend') {
    const rootBoxIds = [root.id];
    return { rootBoxIds, rootCoreIds: rootCoreIdsForBoxes(built, rootBoxIds) };
  }
  const inferred = inferSourceBoxes(built);
  const rootBoxIds = inferred.map((b) => b.id);
  return { rootBoxIds, rootCoreIds: rootCoreIdsForBoxes(built, rootBoxIds) };
}

/**
 * A scene the shape cannot read: a backhaul arrives at the OLT box, so no box is
 * unfed and there is no source to infer.
 */
function unreadableScene(topology) {
  const { built, root } = topology;
  const backhaul = {
    id: 'cable-BH',
    code: 'CBL-BH',
    name: 'backhaul',
    cable_type: 'distribution',
    core_count: 1,
    from_enclosure_id: built.enclosures[built.enclosures.length - 1].id,
    to_enclosure_id: root.id,
    length_m: 100,
    status: 'active',
    route: null,
    continues_cable_id: null,
  };
  const core = { id: 'core-BH-1', cable_id: backhaul.id, core_number: 1, status: 'spliced' };
  return { ...built, cables: [...built.cables, backhaul], cores: [...built.cores, core] };
}

// --- the sweep ------------------------------------------------------------------

describe('a box failure paints only what lost light', () => {
  for (const topology of TOPOLOGIES) {
    describe(topology.name, () => {
      for (const mode of ['headend', 'inferred']) {
        test(`${mode}: the feeding span stays lit on every box`, () => {
          const { built, feeds } = topology;
          const { rootBoxIds, rootCoreIds } = rootsFor(topology, mode);
          const failingRoot = rootBoxIds.includes(topology.root.id);

          for (const target of built.enclosures) {
            const failureId = target.id;
            assert.ok(
              failureId,
              'every box must have an id',
            );
            const analysis = analyzeImpact({
              ...built,
              boxIds: [failureId],
              rootBoxIds,
              rootCoreIds,
            });

            assert.equal(analysis.directed, true, `${mode}: ${target.code} should be analysed with direction`);

            const painted = analysis.affected.cables;
            const where = `${mode} / fail ${target.code}`;

            // Non-vacuity: failing a box with anything hanging off it must paint
            // something, otherwise A and B are satisfied by painting nothing.
            const failingTheSource = mode === 'headend' && failureId === topology.root.id;
            assert.ok(
              painted.length > 0,
              `${where}: nothing at all was painted — the invariant checks would be vacuous`,
            );

            // A — a cable is never painted just for being connected.
            for (const c of painted) {
              assert.ok(
                c.cores_dark > 0 || c.is_failure,
                `${where}: ${c.code} is painted with no dark fibre (in service ${c.cores_in_service})`,
              );
            }

            // B — the span that supplies the failed box still has light on it.
            const feeder = feeds[failureId];
            if (feeder && !failingTheSource) {
              assert.ok(
                !painted.some((c) => c.code === feeder),
                `${where}: ${feeder} feeds this box and must not be reported out`,
              );
            }
          }
        });
      }

      test('without a root, a box failure still follows connected outputs only', () => {
        const built = unreadableScene(topology);
        const analysis = analyzeImpact({ ...built, boxIds: [topology.root.id] });
        assert.equal(analysis.directed, false);
        assert.ok(
          analysis.warnings.some((w) => /IN cable is not included|direction could not be resolved/i.test(w)),
          'the box-local fallback must announce its limited direction',
        );
        const feeder = topology.feeds[topology.root.id];
        if (feeder) {
          assert.ok(!analysis.affected.cables.some((c) => c.code === feeder));
        }
      });
    });
  }
});

// --- the inference itself -------------------------------------------------------

describe('inferSourceBoxes', () => {
  test('picks the box no cable feeds', () => {
    const sources = inferSourceBoxes(chain().built);
    assert.deepEqual(sources.map((s) => s.code), ['OLT']);
  });

  test('picks every unfed box, so several OLTs each get their own source', () => {
    const a = box('OLT-A', 'cabinet');
    const b = box('OLT-B', 'cabinet');
    const c = box('NAP-C');
    const built = scene({
      boxes: [a, b, c],
      cables: [cable('F1', a, c, 2, 'feeder'), cable('F2', b, c, 2, 'feeder')],
    });
    assert.deepEqual(inferSourceBoxes(built).map((s) => s.code).sort(), ['OLT-A', 'OLT-B']);
  });

  test('a box that only hands out drops is a distribution point, not a source', () => {
    // A box whose only documented cables are drops feeding customers — an OLT
    // serving them directly, or a NAP whose feeder nobody has recorded yet. It
    // distributes; the light comes from somewhere this data does not show.
    const nap = box('NAP');
    const built = scene({
      boxes: [nap],
      cables: [cable('DROP-1', nap, null, 1, 'drop'), cable('DROP-2', nap, null, 1, 'drop')],
    });
    assert.deepEqual(inferSourceBoxes(built), []);
  });

  test('a drop drawn from the customer end does not make their box the light source', () => {
    // The app lets a cable be drawn from either end ("Start box (0%)"), so a drop
    // recorded customer → NAP is normal data-entry, not a fault. Without the drop
    // guard that customer's box is the one nothing feeds — and the whole network
    // would be lit from a living room.
    const olt = box('OLT', 'cabinet');
    const nap = box('NAP');
    const home = box('HOME-1', 'terminal');
    const built = scene({
      boxes: [olt, nap, home],
      cables: [
        cable('F1', olt, nap, 4, 'feeder'),
        cable('DROP-1', home, nap, 1, 'drop'), // drawn the other way round
      ],
    });
    assert.deepEqual(inferSourceBoxes(built).map((s) => s.code), ['OLT']);
  });

  test('a customer box with a drop landing on it is not a source', () => {
    const olt = box('OLT', 'cabinet');
    const nap = box('NAP');
    const home = box('HOME-1', 'terminal');
    const built = scene({
      boxes: [olt, nap, home],
      cables: [cable('F1', olt, nap, 4, 'feeder'), cable('DROP-1', nap, home, 1, 'drop')],
    });
    assert.deepEqual(inferSourceBoxes(built).map((s) => s.code), ['OLT']);
  });

  test('an island with no fed box is a source of its own', () => {
    // Two segments with the OLT documented as feeding only one of them.
    const olt = box('OLT', 'cabinet');
    const a = box('NAP-A');
    const island = box('NAP-ISLAND');
    const built = scene({
      boxes: [olt, a, island],
      cables: [cable('F1', olt, a, 2, 'feeder'), cable('F2', island, a, 2, 'distribution')],
    });
    // NAP-ISLAND sends a distribution cable out and nothing feeds it, so light is
    // assumed to enter there too — better than calling its whole subtree dark.
    assert.deepEqual(inferSourceBoxes(built).map((s) => s.code), ['OLT', 'NAP-ISLAND']);
  });

  test('LIMITATION: a plant cable drawn backwards looks like a second source', () => {
    // Structurally identical to the island case above: a box that sends a plant
    // cable and is fed by nothing. No amount of local reasoning separates "a
    // second OLT" from "this cable was drawn the wrong way round" — which is why
    // the analysis reports the direction as inferred and names the boxes it
    // picked, instead of presenting the result as known.
    const olt = box('OLT', 'cabinet');
    const a = box('NAP-A');
    const b = box('NAP-B');
    const built = scene({
      boxes: [olt, a, b],
      cables: [
        cable('F1', olt, a, 4, 'feeder'),
        cable('F2-BACKWARDS', b, a, 2, 'distribution'), // meant to arrive at B
        cable('F3', b, a, 2, 'distribution'),
      ],
    });
    assert.deepEqual(inferSourceBoxes(built).map((s) => s.code), ['OLT', 'NAP-B']);
  });

  test('a network where every box is fed infers nothing', () => {
    const built = unreadableScene(chain());
    assert.deepEqual(inferSourceBoxes(built), []);
  });

  test('rootCoreIdsForBoxes takes every core of every cable landing there', () => {
    const built = chain().built;
    const olt = built.enclosures.find((e) => e.code === 'OLT');
    const ids = rootCoreIdsForBoxes(built, [olt.id]);
    assert.deepEqual(ids.sort(), ['core-F1-1', 'core-F1-2', 'core-F1-3']);
  });
});
