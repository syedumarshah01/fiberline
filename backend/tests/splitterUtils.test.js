/**
 * Unit tests for the splitter naming/notes helpers.
 * Run with: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  defaultSplitterName,
  splitterInputNote,
  splitterOutputNote,
  splitterUnassignNote,
  portIsOccupied,
  sanitizeSplitterPatch,
  SUPPORTED_SPLIT_COUNTS,
  ratioLabel,
  portUsage,
  portCustomerLabel,
  summarizePorts,
  enrichSplitter,
  enrichSplitters,
} = require('../src/utils/splitters');

describe('defaultSplitterName', () => {
  test('REGRESSION: never exposes a raw UUID fragment', () => {
    // The old default was `${input_core_id.slice(0, 6)}... 4-way splitter` —
    // unreadable in the field. Names must describe the feeding fiber/port.
    const name = defaultSplitterName(4, { kind: 'core', cableCode: 'FEED-0001', coreNumber: 3 });
    assert.equal(name, 'Splitter 1:4 on FEED-0001 fiber #3');
    assert.ok(!name.includes('...'));
  });

  test('describes a cascaded input port', () => {
    const name = defaultSplitterName(2, {
      kind: 'port', parentName: 'Main 1:4', parentSplitCount: 4, portNumber: 2,
    });
    assert.equal(name, 'Splitter 1:2 on Main 1:4 · port 2');
  });

  test('falls back gracefully without source info', () => {
    assert.equal(defaultSplitterName(8, null), 'Splitter 1:8');
  });
});

describe('core notes', () => {
  test('input note says what happens to the fiber', () => {
    assert.equal(splitterInputNote('Main 1:4', 4), 'Main 1:4: this fiber is split into 4 outputs here');
  });

  test('output note names the port and splitter', () => {
    assert.equal(splitterOutputNote('Main 1:4', 4, 2), 'Main 1:4: fed from output port 2 of 4');
  });

  test('unassign note names the splitter', () => {
    assert.equal(splitterUnassignNote('Main 1:4', 3), 'Removed from Main 1:4 port 3');
  });
});

describe('portIsOccupied', () => {
  test('occupied by a core or a child splitter', () => {
    assert.equal(portIsOccupied({ output_core_id: 'c1' }), true);
    assert.equal(portIsOccupied({ output_splitter_id: 's1' }), true);
    assert.equal(portIsOccupied({}), false);
    assert.equal(portIsOccupied(null), false);
  });
});

describe('sanitizeSplitterPatch', () => {
  test('passes through editable fields', () => {
    const { updates, error } = sanitizeSplitterPatch({ name: 'Tray A', notes: 'by the door', technician: 'Ali' });
    assert.ifError(error);
    assert.deepEqual(updates, { name: 'Tray A', notes: 'by the door', technician: 'Ali' });
  });

  test('split_count and other structural fields are NOT editable via PATCH', () => {
    const { updates, error } = sanitizeSplitterPatch({ split_count: 8, enclosure_id: 'x', name: 'Tray A' });
    assert.ifError(error);
    assert.deepEqual(updates, { name: 'Tray A' });
  });

  test('empty patch is rejected', () => {
    const { error } = sanitizeSplitterPatch({});
    assert.equal(error, 'No valid fields to update');
  });

  test("blank loss_db/splice_date/technician/name clear the field instead of 500ing Postgres", () => {
    const { updates, error } = sanitizeSplitterPatch({ loss_db: '', splice_date: '', technician: '', name: '' });
    assert.ifError(error);
    assert.deepEqual(updates, { loss_db: null, splice_date: null, technician: null, name: null });
  });

  test('loss_db must be numeric when present', () => {
    const { error } = sanitizeSplitterPatch({ loss_db: 'lots' });
    assert.match(error, /loss_db must be a number/);
    const { updates } = sanitizeSplitterPatch({ loss_db: '0.32' });
    assert.equal(updates.loss_db, 0.32);
  });

  test('splice_type is restricted to fusion/mechanical', () => {
    const { error } = sanitizeSplitterPatch({ splice_type: 'duct-tape' });
    assert.match(error, /splice_type/);
    const { updates, error: ok } = sanitizeSplitterPatch({ splice_type: 'mechanical' });
    assert.ifError(ok);
    assert.equal(updates.splice_type, 'mechanical');
  });

  test('notes and name must be strings when set', () => {
    assert.match(sanitizeSplitterPatch({ notes: 42 }).error, /notes must be a string/);
    assert.match(sanitizeSplitterPatch({ name: 42 }).error, /name must be a string/);
  });
});

// --- Phase 1: port accounting --------------------------------------------------
//
// "Does this box have a free port?" is the question the capacity check, the
// panel badge and the remediation search all ask. These tests exist because the
// three of them must never answer it differently — the free-port rule lives in
// one function and these pin it.

/** A port row as routes/splitters.js returns it. */
const port = (number, extra = {}) => ({ port_number: number, ...extra });
const free = (number) => port(number);
const onCore = (number, customerLabel = null) =>
  port(number, { output_core_id: `core-${number}`, core_number: 1, cable_customer_label: customerLabel });
const cascaded = (number) =>
  port(number, { output_splitter_id: `child-${number}`, child_splitter_name: 'Splitter 1:4' });

describe('ratioLabel', () => {
  test('writes the ratio the way it appears on the tray', () => {
    assert.equal(ratioLabel(8), '1:8');
    assert.equal(ratioLabel(32), '1:32');
    assert.equal(ratioLabel('4'), '1:4'); // pg hands back strings for integers too
  });

  test('gives null rather than "1:NaN" for a splitter with no usable count', () => {
    assert.equal(ratioLabel(null), null);
    assert.equal(ratioLabel(0), null);
    assert.equal(ratioLabel('eight'), null);
  });
});

describe('SUPPORTED_SPLIT_COUNTS', () => {
  test('covers every ratio the loss model prices, at least up to 1:32', () => {
    // A ratio the form offers but the budget cannot price is a quote with a
    // missing number in it, so the two lists are checked against each other.
    const { SPLITTER_INSERTION_LOSS_DB } = require('../src/utils/lossBudget');
    for (const count of SUPPORTED_SPLIT_COUNTS) {
      assert.ok(
        SPLITTER_INSERTION_LOSS_DB[count] != null,
        `1:${count} is offered to users but has no planning loss value`,
      );
    }
    assert.deepEqual(SUPPORTED_SPLIT_COUNTS, [...SUPPORTED_SPLIT_COUNTS].sort((a, b) => a - b));
  });
});

describe('portUsage', () => {
  test('an empty port is free', () => {
    assert.equal(portUsage(free(1)), 'free');
  });

  test('a port carrying a core is in use', () => {
    assert.equal(portUsage(onCore(2)), 'core');
  });

  test('a port feeding a child splitter is occupied, not free', () => {
    // Regression guard: cascade ports were once counted as free because only
    // output_core_id was checked, so a box reported headroom it had spent.
    assert.equal(portUsage(cascaded(3)), 'cascaded');
  });

  test('a port with both a core and a child splitter is never reported free', () => {
    const both = port(4, { output_core_id: 'core-4', output_splitter_id: 'child-4' });
    assert.notEqual(portUsage(both), 'free');
  });
});

describe('portCustomerLabel', () => {
  test('reads the label recorded on the connected core\'s cable', () => {
    assert.equal(portCustomerLabel(onCore(1, 'CUST-10234')), 'CUST-10234');
  });

  test('a cascaded port has no customer label', () => {
    assert.equal(portCustomerLabel(cascaded(1)), null);
  });

  test('an empty port has no customer label, and blank is null not ""', () => {
    assert.equal(portCustomerLabel(free(1)), null);
    assert.equal(portCustomerLabel(onCore(1, '')), null);
  });
});

describe('summarizePorts', () => {
  test('counts free, used and cascaded ports and names them by number', () => {
    const summary = summarizePorts([
      free(1), onCore(2, 'CUST-1'), cascaded(3), free(4),
    ]);
    assert.equal(summary.total, 4);
    assert.equal(summary.free, 2);
    assert.equal(summary.used, 1);
    assert.equal(summary.cascaded, 1);
    assert.deepEqual(summary.free_port_numbers, [1, 4]);
    assert.deepEqual(summary.used_port_numbers, [2]);
    assert.deepEqual(summary.cascaded_port_numbers, [3]);
    assert.deepEqual(summary.customer_labels, ['CUST-1']);
  });

  test('a damaged port carrying a customer is both in use and damaged', () => {
    // The customer is on it (so it is not spare capacity) and it is broken (so
    // somebody has to fix it). Reporting only one of those hides the other.
    const summary = summarizePorts([
      onCore(1, 'CUST-1'),
      port(2, { status: 'damaged', output_core_id: 'c2', cable_customer_label: 'CUST-2' }),
    ]);
    assert.deepEqual(summary.used_port_numbers, [1, 2]);
    assert.deepEqual(summary.damaged_port_numbers, [2]);
    assert.deepEqual(summary.free_port_numbers, []);
    assert.deepEqual(summary.customer_labels, ['CUST-1', 'CUST-2']);
  });

  test('a damaged port is neither free nor occupied', () => {
    // Planning a drop onto a damaged port is the failure this prevents: the
    // port exists, it is empty, and it will not carry light.
    const summary = summarizePorts([free(1), port(2, { status: 'damaged' }), onCore(3, 'CUST-9')]);
    assert.equal(summary.free, 1);
    assert.equal(summary.used, 1);
    assert.equal(summary.damaged, 1);
    assert.deepEqual(summary.damaged_port_numbers, [2]);
    assert.deepEqual(summary.free_port_numbers, [1]);
  });

  test('free + used + cascaded may be less than total when a port is damaged', () => {
    // Arithmetic worth pinning: the counts answer different questions.
    const summary = summarizePorts([free(1), port(2, { status: 'damaged' }), onCore(3, 'A'), cascaded(4)]);
    assert.equal(summary.total, 4);
    assert.equal(summary.free + summary.used + summary.cascaded, 3);
    assert.equal(summary.damaged, 1);
  });

  test('a full splitter is free: 0 and keeps its port numbers empty', () => {
    const summary = summarizePorts([onCore(1, 'A'), onCore(2, 'B'), cascaded(3), onCore(4, 'C')]);
    assert.equal(summary.free, 0);
    assert.deepEqual(summary.free_port_numbers, []);
    assert.deepEqual(summary.customer_labels, ['A', 'B', 'C']);
  });

  test('an empty port list is zeroes, not a crash', () => {
    const summary = summarizePorts([]);
    assert.equal(summary.total, 0);
    assert.equal(summary.free, 0);
    assert.deepEqual(summary.free_port_numbers, []);
  });
});

describe('enrichSplitter', () => {
  const splitter = { id: 'sp1', enclosure_id: 'box1', name: 'Tray A', split_count: 8, loss_db: null };

  test('labels the ratio and charges the planning loss for it', () => {
    const enriched = enrichSplitter(splitter, { ports: [free(1)] });
    assert.equal(enriched.ratio, '1:8');
    assert.equal(enriched.effective_loss_db, 10.5); // G.671 planning value for 1:8
    assert.equal(enriched.loss_measured, false);
  });

  test('a recorded insertion loss wins over the planning value', () => {
    // Same rule as the loss budget: a measurement is not a default. If these
    // two disagreed, the panel would show one number and the quote another.
    const enriched = enrichSplitter({ ...splitter, loss_db: '9.12' }, { ports: [] });
    assert.equal(enriched.effective_loss_db, 9.12);
    assert.equal(enriched.loss_measured, true);
  });

  test('carries the port counts and per-port usage for display', () => {
    const enriched = enrichSplitter(splitter, {
      ports: [free(1), onCore(2, 'CUST-7'), cascaded(3)],
    });
    assert.deepEqual(enriched.port_summary.free_port_numbers, [1]);
    assert.equal(enriched.port_summary.customer_labels[0], 'CUST-7');
    assert.deepEqual(
      enriched.ports.map((p) => p.usage),
      ['free', 'core', 'cascaded'],
    );
    assert.equal(enriched.ports[1].customer_label, 'CUST-7');
  });

  test('marks a port available only when it is empty AND not damaged', () => {
    const enriched = enrichSplitter(
      { id: 'sp1', split_count: 4, loss_db: null },
      { ports: [free(1), port(2, { status: 'damaged' }), onCore(3), cascaded(4)] },
    );
    assert.deepEqual(
      enriched.ports.map((p) => p.available),
      [true, false, false, false],
    );
    assert.equal(enriched.ports[1].damaged, true);
  });

  test('keeps the raw row intact for callers that read stored columns', () => {
    const enriched = enrichSplitter(splitter, { ports: [] });
    assert.equal(enriched.split_count, 8);
    assert.equal(enriched.enclosure_id, 'box1');
    assert.equal(enriched.name, 'Tray A');
  });
});

describe('enrichSplitters', () => {
  const splitters = [
    { id: 'sp1', split_count: 4, loss_db: null },
    { id: 'sp2', split_count: 2, loss_db: null },
  ];

  test('totals the box across every splitter', () => {
    const { splitters: enriched, totals } = enrichSplitters(
      splitters,
      { sp1: [free(1), onCore(2, 'CUST-1')], sp2: [onCore(1, 'CUST-2'), free(2)] },
      {},
    );
    assert.equal(enriched.length, 2);
    assert.deepEqual(totals, {
      splitters: 2, ports: 4, free_ports: 2, used_ports: 2, cascaded_ports: 0, damaged_ports: 0,
    });
  });

  test('a box with no splitters totals zero — and is not a full box', () => {
    // The distinction the checker needs: no splitters means the splitter check
    // does not apply to this box, which is not the same as "no free ports".
    const { splitters: enriched, totals } = enrichSplitters([], {}, {});
    assert.deepEqual(enriched, []);
    assert.equal(totals.splitters, 0);
    assert.equal(totals.free_ports, 0);
  });

  test('passes the cascade parent through to the splitter it feeds', () => {
    const parent = { splitter_id: 'sp-parent', name: 'Main 1:4', port_number: 2, split_count: 4 };
    const { splitters: enriched } = enrichSplitters([splitters[0]], { sp1: [] }, { sp1: parent });
    assert.deepEqual(enriched[0].parent, parent);
  });
});
