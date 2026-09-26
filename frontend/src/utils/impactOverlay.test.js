import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAILURE_COLOR,
  customerTitle,
  customerNote,
  impactOverlay,
  overlayHeadline,
  failureTitle,
  impactCableStyle,
  impactBoxState,
  customersBehind,
  pathText,
  cableLinkText,
} from './impactOverlay.js';

/** A trimmed-down simulate response (only the fields the map reads). */
const IMPACT = {
  failure: {
    kind: 'box',
    id: 'b',
    label: 'BOX-B',
    box_ids: ['b'],
    cable_ids: [],
  },
  affected: {
    customer_count: 2,
    core_count: 3,
    box_ids: ['b', 'c'],
    cable_ids: ['d1', 'drop1', 'drop2'],
    customers: [
      { customer_label: 'CUST-1', serving_box_id: 'b', hops: 1, path_through_failure: [] },
      { customer_label: 'CUST-2', serving_box_id: 'b', hops: 2, path_through_failure: [] },
    ],
  },
};

/** The shape /api/impact/simulate actually returns (detail objects). */
const IMPACT_DETAIL = {
  failure: { kind: 'cable', id: 'd1', label: 'CBL-D1', box_ids: [], cable_ids: ['d1'] },
  affected: {
    customer_count: 1,
    boxes: [{ id: 'b', code: 'BOX-B', is_failure: false }],
    cables: [
      { id: 'd1', code: 'CBL-D1', is_failure: true },
      { id: 'drop1', code: 'CBL-DROP-1', is_failure: false },
    ],
    customers: [{ customer_label: 'CUST-1', serving_box_id: 'b', hops: 1, path_through_failure: [] }],
  },
};

/** A response where one span lost some of its fibres and another is gone. */
const IMPACT_PARTIAL = {
  failure: { kind: 'cable', id: 'ca', label: 'CBL-A', box_ids: [], cable_ids: ['ca'] },
  affected: {
    customer_count: 1,
    partial_cable_count: 1,
    boxes: [{ id: 'nap', code: 'BOX-NAP', is_failure: false }],
    cables: [
      { id: 'ca', code: 'CBL-A', is_failure: true, cores_dark: 1, cores_in_service: 1 },
      { id: 'x', code: 'CBL-X', is_failure: false, cores_dark: 1, cores_in_service: 2, partially_dark: true },
      { id: 'drop1', code: 'CBL-DROP-1', is_failure: false, cores_dark: 1, cores_in_service: 1 },
    ],
    customers: [{ customer_label: 'CUST-1', serving_box_id: 'nap', hops: 2, path_through_failure: [] }],
  },
};

describe('impactOverlay', () => {
  it('is inactive when nothing is simulated', () => {
    const overlay = impactOverlay(null);
    assert.equal(overlay.active, false);
    assert.deepEqual([...overlay.darkCableIds], []);
  });

  it('collects the dark boxes and cables', () => {
    const overlay = impactOverlay(IMPACT);
    assert.equal(overlay.active, true);
    assert.deepEqual([...overlay.darkBoxIds].sort(), ['b', 'c']);
    assert.deepEqual(overlay.darkCableIds.has('d1'), true);
    assert.equal(overlay.darkCableIds.has('unrelated'), false);
  });

  it('separates spans that lost some fibres from spans that are out', () => {
    const overlay = impactOverlay(IMPACT_PARTIAL);
    assert.deepEqual([...overlay.darkCableIds].sort(), ['ca', 'drop1']);
    assert.deepEqual([...overlay.partialCableIds], ['x']);
  });

  it('draws a partly-out span as a broken line, not as a dead span', () => {
    const overlay = impactOverlay(IMPACT_PARTIAL);
    const gone = impactCableStyle('drop1', overlay);
    const partial = impactCableStyle('x', overlay);
    assert.ok(partial, 'a partly-out cable is still styled');
    assert.equal(partial.color, FAILURE_COLOR);
    assert.ok(partial.weight < gone.weight, 'lighter than a span that is out');
    assert.ok(partial.opacity < 1, 'and translucent');
    assert.notDeepEqual(partial.dash, gone.dash);
  });

  it('still reads as red from across a busy map', () => {
    // Broken is the signal; faint is not. A partly-out span has a dead strand in
    // it and a technician sent to the fault has to be able to see it.
    const partial = impactCableStyle('x', impactOverlay(IMPACT_PARTIAL));
    assert.ok(partial.weight >= 4, `thick enough to see (got ${partial.weight})`);
    assert.ok(partial.opacity >= 0.7, `not washed out (got ${partial.opacity})`);
  });

  it('says how many spans are partly out, without counting them as dark', () => {
    const headline = overlayHeadline(IMPACT_PARTIAL);
    assert.match(headline, /2 cables/);
    assert.match(headline, /1 partly out/);
  });

  it('treats every cable in a slim payload as fully out (no core counts there)', () => {
    const overlay = impactOverlay(IMPACT);
    assert.equal(overlay.partialCableIds.size, 0);
    assert.equal(overlay.darkCableIds.size, 3);
  });

  it('counts customers per serving box for marker badges', () => {
    const overlay = impactOverlay(IMPACT);
    assert.equal(customersBehind('b', overlay), 2);
    assert.equal(customersBehind('c', overlay), 0);
  });

  it('reads the detail objects the API really sends', () => {
    const overlay = impactOverlay(IMPACT_DETAIL);
    assert.deepEqual([...overlay.darkBoxIds], ['b']);
    assert.deepEqual([...overlay.darkCableIds].sort(), ['d1', 'drop1']);
    assert.deepEqual([...overlay.failureCableIds], ['d1']);
    assert.equal(customersBehind('b', overlay), 1);
  });

  it('paints a splitter-port cable named by the downstream customer path', () => {
    const impact = {
      failure: { kind: 'box', id: 'joint', box_ids: ['joint'], cable_ids: [] },
      affected: {
        customer_count: 1,
        boxes: [{ id: 'joint' }],
        // Simulate a compact backend payload that found the customer but omitted
        // the port cable from affected.cables.
        cables: [{ id: 'direct', code: 'CBL-DIRECT' }],
        customers: [{
          customer_label: 'CUST-PORT',
          serving_box_id: 'downstream',
          path_through_failure: [
            { kind: 'fiber', cable_id: 'port-cable', cable_code: 'CBL-PORT' },
            { kind: 'fiber', cable_id: 'drop-port', cable_code: 'CBL-DROP-PORT' },
          ],
        }],
      },
    };
    const overlay = impactOverlay(impact);
    assert.deepEqual([...overlay.darkCableIds].sort(), ['direct', 'drop-port', 'port-cable']);
  });

  it('tolerates a response that lost its arrays', () => {
    const overlay = impactOverlay({ failure: {}, affected: {} });
    assert.equal(overlay.active, true);
    assert.equal(overlay.darkCableIds.size, 0);
    assert.equal(overlay.affectedCustomers, 0);
    assert.equal(customersBehind('b', overlay), 0);
  });
});

describe('overlayHeadline / failureTitle', () => {
  it('summarises what went dark', () => {
    assert.equal(overlayHeadline(IMPACT), '2 customers · 2 boxes · 3 cables');
  });

  it('does not say "1 customers"', () => {
    assert.equal(
      overlayHeadline({
        affected: { customer_count: 1, boxes: [{ id: 'a' }], cables: [] },
      }),
      '1 customer · 1 box',
    );
  });

  it('falls back to the name then the id for the title', () => {
    assert.equal(failureTitle(IMPACT), 'BOX-B');
    assert.equal(failureTitle({ failure: { id: 'xyz', name: 'Riser 4' } }), 'Riser 4');
    assert.equal(failureTitle(null), '');
  });
});

describe('impactCableStyle', () => {
  it('leaves untouched cables to the caller', () => {
    assert.equal(impactCableStyle('unrelated', impactOverlay(IMPACT)), null);
    assert.equal(impactCableStyle('d1', null), null);
  });

  it('paints dark cables solid red and the failed cable dashed', () => {
    const overlay = impactOverlay(IMPACT);
    assert.deepEqual(impactCableStyle('d1', overlay), {
      color: FAILURE_COLOR,
      weight: 5,
      opacity: 1,
      dash: [12, 5],
      animated: false,
    });

    const cut = impactOverlay({
      ...IMPACT,
      failure: { ...IMPACT.failure, kind: 'cable', cable_ids: ['d1'] },
    });
    const style = impactCableStyle('d1', cut);
    assert.equal(style.dash.length, 2);
    assert.equal(style.weight, 7);
  });

  it('does not animate dark cables — marching ants mean live traffic', () => {
    assert.equal(impactCableStyle('d1', impactOverlay(IMPACT)).animated, false);
  });
});

describe('impactBoxState', () => {
  it('marks the failed box and the dark boxes behind it', () => {
    const overlay = impactOverlay(IMPACT);
    assert.deepEqual(impactBoxState('b', overlay), { dark: true, failed: true });
    assert.deepEqual(impactBoxState('c', overlay), { dark: true, failed: false });
    assert.deepEqual(impactBoxState('a', overlay), { dark: false, failed: false });
  });

  it('is inert without a simulation', () => {
    assert.deepEqual(impactBoxState('b', null), { dark: false, failed: false });
  });
});

describe('customerTitle / customerNote', () => {
  it('uses the label when there is one', () => {
    assert.equal(customerTitle({ customer_label: 'CUST-7', source: 'documented' }), 'CUST-7');
    assert.equal(customerNote({ customer_label: 'CUST-7' }), '');
  });

  it('names an inferred leg instead of leaving the row blank', () => {
    assert.equal(
      customerTitle({ customer_label: null, cable_code: 'CBL-DROP-9', source: 'drop' }),
      'Unlabelled drop on CBL-DROP-9',
    );
    assert.equal(
      customerTitle({ customer_label: null, cable_code: 'CBL-X', source: 'customer_box' }),
      'Customer box on CBL-X',
    );
    assert.equal(
      customerTitle({ customer_label: null, cable_code: 'CBL-Y', source: 'terminated' }),
      'Unlabelled termination on CBL-Y',
    );
  });

  it('explains why an unnamed leg counts', () => {
    assert.match(customerNote({ customer_label: null, source: 'drop' }), /drop cable exists to reach one premises/);
    assert.match(customerNote({ customer_label: null, source: 'customer_box' }), /lands in a customer box/);
    assert.equal(customerNote(null), '');
  });
});

describe('pathText', () => {
  it('reads as the light travelled: cable, joint, cable', () => {
    assert.equal(
      pathText([
        { kind: 'fiber', cable_code: 'CBL-D1', core_number: 1 },
        { kind: 'splitter', box_code: 'BOX-B' },
        { kind: 'splitter_port', box_code: 'BOX-B', port_number: 3 },
        { kind: 'fiber', cable_code: 'CBL-DROP-1', core_number: 1 },
      ]),
      'CBL-D1 #1 → splitter @ BOX-B → port 3 @ BOX-B → CBL-DROP-1 #1',
    );
  });

  it('spells out a cascaded splitter hop', () => {
    assert.equal(
      pathText([
        { kind: 'fiber', cable_code: 'CBL-D1', core_number: 1 },
        { kind: 'splitter_input', box_code: 'BOX-B' },
        { kind: 'splitter', box_code: 'BOX-B' },
        { kind: 'splitter_cascade', box_code: 'BOX-B' },
        { kind: 'splitter', box_code: 'BOX-C' },
        { kind: 'splitter_port', box_code: 'BOX-C', port_number: 1 },
        { kind: 'fiber', cable_code: 'CBL-DROP-3', core_number: 1 },
      ]),
      'CBL-D1 #1 → in @ BOX-B → splitter @ BOX-B → cascade @ BOX-B → splitter @ BOX-C → port 1 @ BOX-C → CBL-DROP-3 #1',
    );
  });

  it('shows the closure a cable passes through after a mid-span insert', () => {
    assert.equal(
      pathText([
        { kind: 'fiber', cable_code: 'CBL-F1', core_number: 1 },
        { kind: 'continuation', box_code: 'BOX-MID', from_cable_code: 'CBL-F1', to_cable_code: 'CBL-F1-B' },
        { kind: 'fiber', cable_code: 'CBL-F1-B', core_number: 1 },
        { kind: 'splice', box_code: 'BOX-NAP' },
        { kind: 'fiber', cable_code: 'CBL-DROP-1', core_number: 1 },
      ]),
      'CBL-F1 #1 → through BOX-MID → CBL-F1-B #1 → splice @ BOX-NAP → CBL-DROP-1 #1',
    );
  });

  it('is empty for a missing path', () => {
    assert.equal(pathText(undefined), '');
    assert.equal(pathText([]), '');
  });
});

describe('cableLinkText', () => {
  it('is empty for a cable with no mid-span link', () => {
    assert.equal(cableLinkText({ code: 'CBL-DROP-1', continued_by: [] }), '');
    assert.equal(cableLinkText(null), '');
  });

  it('reads the upstream link, and says when it was inferred', () => {
    assert.equal(
      cableLinkText({
        continues_cable_code: 'CBL-F1',
        continues_at_box_code: 'BOX-MID',
        continuation_inferred: true,
      }),
      'Continues CBL-F1 through BOX-MID (inferred from cable naming)',
    );
  });

  it('reads the downstream link, listing every half the span was split into', () => {
    assert.equal(
      cableLinkText({
        continued_by: [
          { code: 'CBL-F1-B', at_box_code: 'BOX-MID' },
          { code: 'CBL-F1-C', at_box_code: 'BOX-MID-2' },
        ],
      }),
      'Split into CBL-F1-B at BOX-MID, CBL-F1-C at BOX-MID-2',
    );
  });

  it('reads both directions when a cable is in the middle of a split chain', () => {
    const text = cableLinkText({
      continues_cable_code: 'CBL-F1',
      continues_at_box_code: 'BOX-MID',
      continued_by: [{ code: 'CBL-F1-B', at_box_code: 'BOX-MID-2' }],
    });
    assert.match(text, /^Continues CBL-F1 through BOX-MID/);
    assert.match(text, /Split into CBL-F1-B at BOX-MID-2$/);
  });

  it('copes with a link whose box code the API could not resolve', () => {
    assert.equal(cableLinkText({ continues_cable_code: 'CBL-F1' }), 'Continues CBL-F1');
    assert.equal(cableLinkText({ continued_by: [{ id: 'x' }] }), 'Split into an unnamed cable');
  });
});
