/**
 * Tests for the splice worksheet builder.
 *
 * The promise this feature makes to a technician is: everything on the sheet is
 * derived from what the box documentation already says, and nothing is invented.
 * So these tests are written the way the sheet is read — "does it tell me to
 * re-splice the joint with the bad reading?", "does it name the spare fibre I
 * should use?", "if a rule breaks, do I lose the sheet?" — against documentation
 * payloads taken straight from `loadBoxDocumentation()`.
 *
 * Nothing here touches a database: the builder is pure by design, which is also
 * what makes the sheet safe to generate on every page load.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildWorkOrder, worksheetText, KIND_LABELS, RULES, SPARES_LISTED } = require('../src/services/workOrder');

// --- documentation fixtures ----------------------------------------------------

/** A core as the documentation payload carries it. */
const core = (id, number, status, extra = {}) => ({ id, core_number: number, status, ...extra });

/**
 * A box with one incoming feeder and one outgoing distribution cable: the shape
 * of the mid-span closure these sheets are mostly written for.
 */
function documentation(overrides = {}) {
  return {
    enclosure: {
      id: 'box1',
      code: 'BOX-MID',
      name: 'Mid-span closure',
      type: 'splice_closure',
      pole_id: 'pole1',
    },
    summary: {
      total_cables: 2,
      total_cores: 4,
      spliced_cores: 1,
      available_cores: 1,
      damaged_cores: 1,
      bad_splices: 0,
    },
    cables_landing_here: [
      {
        cable: { id: 'c1', code: 'CBL-F1', cable_type: 'feeder', core_count: 2 },
        direction: 'in',
        cores: [
          core('k1', 1, 'spliced', { far_endpoint: { connection: 'splice', label: 'CBL-D2 #1' } }),
          core('k2', 2, 'available', { far_endpoint: { connection: 'free', label: null } }),
        ],
      },
      {
        cable: { id: 'c2', code: 'CBL-D2', cable_type: 'distribution', core_count: 2 },
        direction: 'out',
        cores: [
          core('k3', 1, 'spliced'),
          core('k4', 2, 'damaged'),
        ],
      },
    ],
    splices: [
      {
        id: 's1',
        cable_a_code: 'CBL-F1',
        core_a_number: 1,
        cable_b_code: 'CBL-D2',
        core_b_number: 1,
        loss_db: '0.15',
        tray_number: '3',
        tray_position: 'A',
        splice_date: '2026-09-01',
      },
    ],
    splitters: [],
    qc_flags: { bad_splice_threshold_db: 0.3, bad_splices: [] },
    ...overrides,
  };
}

/** Every task line on the sheet, in order (informational lines included). */
const tasks = (order) => order.checklist.map((item) => item.task);
/** Only the numbered work. */
const steps = (order) => order.checklist.filter((item) => !item.info);
const find = (order, fragment) => tasks(order).find((task) => task.includes(fragment));

// --- identity ------------------------------------------------------------------

describe('buildWorkOrder — the header a technician reads first', () => {
  test('names the job, the box and the day, so two sheets are never confused', () => {
    const order = buildWorkOrder({ documentation: documentation(), generatedAt: '2026-09-25T08:30:00Z' });
    assert.equal(order.work_order.reference, 'WO-BOX-MID-20260925');
    assert.equal(order.work_order.kind, 'splice');
    assert.equal(order.work_order.kind_label, 'Splice job');
    assert.equal(order.work_order.title, 'Splice job — BOX-MID');
    assert.equal(order.work_order.generated_at, '2026-09-25T08:30:00.000Z');
    assert.equal(order.work_order.generated_by, null);
    assert.deepEqual(order.work_order.box, {
      id: 'box1',
      code: 'BOX-MID',
      name: 'Mid-span closure',
      type: 'splice_closure',
      pole_id: 'pole1',
    });
    // The sheet points back at the panel it was generated from.
    assert.equal(order.work_order.url, '/api/enclosures/box1/documentation');
  });

  test('carries the technician name and the job kind the caller asked for', () => {
    const order = buildWorkOrder({
      documentation: documentation(),
      kind: 'repair',
      by: 'A. Tech',
      generatedAt: '2026-09-25T08:30:00Z',
    });
    assert.equal(order.work_order.kind_label, KIND_LABELS.repair);
    assert.equal(order.work_order.title, 'Repair job — BOX-MID');
    assert.equal(order.work_order.generated_by, 'A. Tech');
  });

  test('an unknown job kind falls back to a splice job rather than an empty title', () => {
    const order = buildWorkOrder({ documentation: documentation(), kind: 'teleport' });
    assert.equal(order.work_order.kind, 'splice');
  });

  test('refuses to build a sheet with no box, instead of printing an empty one', () => {
    assert.throws(() => buildWorkOrder({ documentation: {} }), /needs box documentation/);
    assert.throws(() => buildWorkOrder({}), /needs box documentation/);
  });
});

// --- the rules -----------------------------------------------------------------

describe('buildWorkOrder — the work is derived from the documentation', () => {
  test('a splice over the loss limit is the first thing on the sheet', () => {
    const doc = documentation({
      qc_flags: {
        bad_splice_threshold_db: 0.3,
        bad_splices: [
          { splice_id: 's1', loss_db: 0.45, core_a: 'CBL-F1 #1', core_b: 'CBL-D2 #1', tray: '3/A' },
        ],
      },
    });
    const order = buildWorkOrder({ documentation: doc });
    const first = order.checklist[0];
    assert.equal(first.step, 1);
    assert.equal(first.task, 'Re-splice CBL-F1 #1 ↔ CBL-D2 #1');
    assert.equal(first.source, 're-splice');
    assert.match(first.detail, /0\.45 dB is over the 0\.3 dB limit/);
    assert.match(first.detail, /tray 3\/A/);
    assert.equal(first.splice_id, 's1');
  });

  test('a damaged core becomes a repair step that names the cable and the fibre', () => {
    const order = buildWorkOrder({ documentation: documentation() });
    const step = steps(order).find((item) => item.task === 'Check and repair CBL-D2 #2');
    assert.ok(step, `no damaged-core step in: ${tasks(order).join(' | ')}`);
    assert.equal(step.source, 'damaged-core');
    assert.equal(step.core_number, 2);
    assert.match(step.detail, /marked damaged, on an outgoing distribution cable/);
  });

  test('an empty splitter port becomes a patch step with the materials for a new drop', () => {
    const doc = documentation({
      splitters: [
        {
          id: 'sp1',
          name: 'Tray A',
          input_core_id: 'k2',
          ports: [
            { port_number: 1, output_core_id: 'k3', output_splitter_id: null },
            { port_number: 2, output_core_id: null, output_splitter_id: null },
          ],
        },
      ],
    });
    const order = buildWorkOrder({ documentation: doc });
    const step = steps(order).find((item) => item.source === 'free-splitter-port');
    assert.ok(step);
    assert.equal(step.task, 'Patch a fibre into Tray A port 2');
    assert.equal(step.port_number, 2);
    const items = order.materials.map((material) => material.item);
    assert.ok(items.includes('Pigtail / drop cable'));
  });

  test('a port fed from a parent splitter says so — the tech has to trace it', () => {
    const doc = documentation({
      splitters: [
        {
          id: 'sp2',
          name: 'Tray B',
          input_core_id: 'k2',
          parent: { name: 'Tray A', port_number: 3 },
          ports: [{ port_number: 1, output_core_id: null }],
        },
      ],
    });
    const order = buildWorkOrder({ documentation: doc });
    const step = steps(order).find((item) => item.source === 'free-splitter-port');
    assert.match(step.detail, /fed from Tray A port 3/);
  });

  test('a splitter with no input fibre is flagged — it is documented but not connected', () => {
    const doc = documentation({
      splitters: [{ id: 'sp3', name: null, input_core_id: null, ports: [] }],
    });
    const order = buildWorkOrder({ documentation: doc });
    const step = steps(order).find((item) => item.source === 'splitter-input');
    assert.ok(step);
    assert.equal(step.task, 'Assign an input fibre to splitter sp3');
    assert.match(step.detail, /no input core recorded/);
  });

  test('a splice with no loss reading asks for the measurement, with the tray', () => {
    const doc = documentation({
      splices: [
        ...documentation().splices,
        {
          id: 's2',
          cable_a_code: 'CBL-F1',
          core_a_number: 2,
          cable_b_code: 'CBL-D2',
          core_b_number: 2,
          loss_db: null,
          tray_number: '4',
          tray_position: null,
        },
      ],
    });
    const order = buildWorkOrder({ documentation: doc });
    const step = steps(order).find((item) => item.source === 'missing-loss');
    assert.equal(step.task, 'Measure and record the loss of CBL-F1 #2 ↔ CBL-D2 #2');
    assert.match(step.detail, /without a loss reading/);
    assert.equal(step.tray, '4');
  });

  test('a mid-span joint is explained, and says whether the link was inferred', () => {
    const order = buildWorkOrder({
      documentation: documentation(),
      throughJoints: [
        { upstream_code: 'CBL-X', downstream_code: 'CBL-X-B', inferred: true },
      ],
    });
    const step = steps(order).find((item) => item.source === 'through-joint');
    assert.equal(step.task, 'Check the through-joint CBL-X → CBL-X-B');
    assert.match(step.detail, /one span split in this box/);
    assert.match(step.detail, /link inferred from cable naming/);
    assert.equal(order.through_joints.length, 1);
  });

  test('spare fibres are listed as information, not as a step to tick', () => {
    const order = buildWorkOrder({ documentation: documentation() });
    const info = order.checklist.find((item) => item.info);
    assert.ok(info);
    assert.equal(info.step, null);
    assert.equal(info.task, 'Spare fibres here: 1');
    assert.match(info.detail, /CBL-F1 #2/);
    assert.deepEqual(info.spares, ['CBL-F1 #2']);
    // And it is not counted as work.
    assert.equal(order.summary.open_steps, steps(order).length - 4);
  });

  test('a box with a great many spares counts them instead of printing a wall of codes', () => {
    const many = Array.from({ length: SPARES_LISTED + 5 }, (_, index) =>
      core(`k${index + 100}`, index + 10, 'available'),
    );
    const doc = documentation({
      cables_landing_here: [
        {
          cable: { id: 'c9', code: 'CBL-BIG', cable_type: 'feeder', core_count: many.length },
          direction: 'in',
          cores: many,
        },
      ],
    });
    const order = buildWorkOrder({ documentation: doc });
    const info = order.checklist.find((item) => item.info);
    assert.equal(info.task, `Spare fibres here: ${many.length}`);
    assert.match(info.detail, /and 5 more/);
    assert.equal(info.spares.length, many.length); // the list itself is complete
  });

  test('the close-out steps are always there, after the derived work', () => {
    const order = buildWorkOrder({ documentation: documentation() });
    const sources = order.checklist.map((item) => item.source);
    const last = sources.lastIndexOf('close-out');
    assert.ok(last > 0);
    // No derived (non-close-out) item appears after the first close-out item.
    assert.equal(
      order.checklist.slice(last).every((item) => item.source === 'close-out'),
      true,
    );
    assert.ok(tasks(order).includes('Close the box, note the date and your name on the job'));
    assert.ok(tasks(order).some((task) => task.includes('Record every splice loss in the app')));
  });

  test('an empty box still produces a sheet: close-out steps and nothing invented', () => {
    const doc = documentation({
      cables_landing_here: [],
      splices: [],
      splitters: [],
      summary: {},
      qc_flags: { bad_splice_threshold_db: 0.3, bad_splices: [] },
    });
    const order = buildWorkOrder({ documentation: doc });
    assert.equal(order.summary.cables, 0);
    assert.equal(order.summary.splices, 0);
    assert.equal(order.checklist.length, 4); // close-out only
    assert.equal(order.summary.open_steps, 0);
    assert.equal(order.summary.checklist_steps, 4);
    // and the text still renders
    assert.match(worksheetText(order), /Close the box/);
  });

  test('numbering runs 1..n over the work and skips the informational lines', () => {
    const doc = documentation({
      qc_flags: { bad_splice_threshold_db: 0.3, bad_splices: [{ splice_id: 's1', loss_db: 0.9, core_a: 'A #1', core_b: 'B #1' }] },
    });
    const order = buildWorkOrder({ documentation: doc });
    const numbers = order.checklist.filter((item) => !item.info).map((item) => item.step);
    assert.deepEqual(numbers, numbers.map((_, index) => index + 1));
    assert.equal(order.summary.checklist_steps, order.checklist.length);
  });

  test('the rules that produced the sheet are exported, so the sheet is explainable', () => {
    const names = RULES.map((rule) => rule.name);
    assert.deepEqual(names, [
      're-splice',
      'damaged-core',
      'free-splitter-port',
      'splitter-input',
      'missing-loss',
      'through-joint',
      'spare-cores',
    ]);
    // Every item on a full sheet can be traced to one of them, or to close-out.
    const order = buildWorkOrder({ documentation: documentation() });
    const known = new Set([...names, 'close-out']);
    for (const item of order.checklist) assert.ok(known.has(item.source), `unknown source ${item.source}`);
  });
});

// --- rules that break ----------------------------------------------------------

describe('buildWorkOrder — one broken rule never costs the technician the sheet', () => {
  test('a rule that throws becomes a warning line, and the rest of the sheet survives', () => {
    // A cable group with no cable object is exactly the kind of half-loaded row
    // that would throw inside the damaged-core rule.
    const doc = documentation({
      cables_landing_here: [
        { cable: null, direction: 'in', cores: [core('k9', 1, 'damaged')] },
      ],
    });
    const order = buildWorkOrder({ documentation: doc });
    const warning = order.checklist.find((item) => item.warning);
    assert.ok(warning, 'expected a warning item');
    assert.equal(warning.source, 'damaged-core');
    assert.match(warning.task, /Could not work out the "damaged-core" steps/);
    // The steps that do not depend on that rule are still on the sheet.
    assert.ok(tasks(order).some((task) => task.includes('Record every splice loss in the app')));
    // And the warning is work — somebody has to fix the record.
    assert.equal(warning.info, undefined);
    assert.equal(typeof warning.step, 'number');
  });

  test('an unreadable table is one warning, not a failed request', () => {
    const doc = documentation({
      splitters: [{ id: 'sp1', name: 'Tray A', input_core_id: 'k2' }],
    });
    // The splitter rows arrive without their ports: the rules that walk ports
    // break, and the sheet still has to come off the printer.
    Object.defineProperty(doc.splitters[0], 'ports', {
      get() {
        throw new Error('port table unreadable');
      },
      enumerable: true,
    });
    const order = buildWorkOrder({ documentation: doc });
    // One rule walks the ports, so one rule warns; the other reads input_core_id
    // and is unaffected — a broken table costs the line that needed it, not the sheet.
    const warnings = order.checklist.filter((item) => item.warning);
    assert.equal(warnings.length, 1, `unexpected warnings: ${JSON.stringify(warnings)}`);
    assert.equal(warnings[0].source, 'free-splitter-port');
    assert.equal(warnings[0].detail, 'port table unreadable');
    assert.ok(!tasks(order).some((task) => task.includes('Assign an input fibre')), 'the working rule dropped out');
    // The counts fall back rather than throwing, and the sheet still renders.
    assert.equal(order.summary.splitters, 1);
    assert.equal(order.summary.free_splitter_ports, 0);
    assert.equal(order.splitters, undefined, 'the raw splitter payload should not be echoed back');
    assert.ok(tasks(order).some((task) => task.includes('Close the box')));
    assert.match(worksheetText(order), /SIGN-OFF/);
    // The sheet is JSON-serialisable as-is (that is what the route sends), and it
    // carries no stack traces: a failure is a line on the checklist, not a dump.
    const sent = JSON.parse(JSON.stringify(order));
    assert.ok(!JSON.stringify(sent).includes('    at '));
  });
});

// --- materials -----------------------------------------------------------------

describe('buildWorkOrder — materials', () => {
  test('counts the sleeves the work needs, and lists them once', () => {
    const doc = documentation({
      qc_flags: { bad_splice_threshold_db: 0.3, bad_splices: [{ splice_id: 's1', loss_db: 0.5, core_a: 'A #1', core_b: 'B #1' }] },
    });
    const order = buildWorkOrder({ documentation: doc });
    const sleeves = order.materials.filter((material) => material.item === 'Fusion splice sleeves');
    assert.equal(sleeves.length, 1, 'sleeves appear on more than one line');
    // re-splice (1) + damaged core (1) — the two rules that need a sleeve here.
    assert.equal(sleeves[0].quantity, 2);
    assert.match(sleeves[0].detail, /the re-made joint/);
    assert.match(sleeves[0].detail, /repair joint/);
  });

  test('a material with no meaningful count says "as needed" rather than "×0"', () => {
    const order = buildWorkOrder({ documentation: documentation() });
    const trays = order.materials.find((material) => material.item === 'Trays / splice holders');
    assert.equal(trays.quantity, null);
  });

  test('the kit nobody has to be told twice about is on the sheet: wipes and a meter', () => {
    const order = buildWorkOrder({ documentation: documentation() });
    const items = order.materials.map((material) => material.item);
    assert.ok(items.includes('Alcohol wipes, lint-free tissue'));
    assert.ok(items.includes('OTDR / splice loss meter'));
  });
});

// --- plain text ----------------------------------------------------------------

describe('worksheetText — the phone version', () => {
  const order = buildWorkOrder({
    documentation: documentation({
      qc_flags: { bad_splice_threshold_db: 0.3, bad_splices: [{ splice_id: 's1', loss_db: 0.45, core_a: 'CBL-F1 #1', core_b: 'CBL-D2 #1', tray: '3/A' }] },
    }),
    by: 'A. Tech',
    generatedAt: '2026-09-25T08:30:00Z',
    throughJoints: [{ upstream_code: 'CBL-X', downstream_code: 'CBL-X-B', inferred: false }],
  });
  const text = worksheetText(order);

  test('carries the header, the reference and who it is for', () => {
    assert.match(text, /SPLICE JOB — BOX-MID/);
    assert.match(text, /Reference WO-BOX-MID-20260925/);
    assert.match(text, /For A\. Tech/);
  });

  test('renders steps as tick boxes and information as bullets', () => {
    assert.match(text, /\[ \] 1\. Re-splice CBL-F1 #1 ↔ CBL-D2 #1/);
    assert.match(text, /recorded loss 0\.45 dB is over the 0\.3 dB limit — tray 3\/A/);
    assert.match(text, /  · Spare fibres here: 1/);
    assert.ok(!/\[ \] \d+\. Spare fibres/.test(text), 'informational line was numbered');
  });

  test('lists the materials, the splices on record and every fibre in the box', () => {
    assert.match(text, /MATERIALS/);
    // re-splice + damaged core + the through-joint: three joints, three sleeves,
    // and the reasons are folded in beside them.
    assert.match(text, /x3\s+Fusion splice sleeves — the re-made joint; repair joint; per\n\s+through-pair/);
    assert.match(text, /as needed\s+Trays \/ splice holders/);
    assert.match(text, /SPLICES ON RECORD/);
    // The reading on record here is the 0.15 dB in `splices` (the 0.45 dB above is
    // the QC flag saying the record is out of spec) — the sheet shows the record.
    assert.match(text, /CBL-F1 #1 ↔ CBL-D2 #1\s+0\.15 dB tray 3\/A/);
    assert.match(text, /FIBRES IN THIS BOX/);
    assert.match(text, /IN {2}CBL-F1 \(feeder, 2 fibres\)/);
    assert.match(text, /#1 spliced ← CBL-D2 #1/, 'the far end of a spliced core is not shown');
    assert.match(text, /#2 available/, 'an available core is missing from the sheet');
  });

  test('ends with a sign-off block somebody actually signs', () => {
    assert.match(text, /SIGN-OFF/);
    assert.match(text, /Technician: _{20} {3}Date: _{12}/);
    assert.match(text, /Box closed and locked: {14}\[ \] yes/);
  });

  test('a splice with no reading says so instead of printing "null dB"', () => {
    const bare = buildWorkOrder({
      documentation: documentation({ splices: [{ ...documentation().splices[0], loss_db: null, tray_position: null }] }),
    });
    const rendered = worksheetText(bare);
    assert.match(rendered, /CBL-F1 #1 ↔ CBL-D2 #1\s+no reading/);
    assert.ok(!rendered.includes('null'));
  });

  test('folds long lines, so a detail does not run off the edge of a phone', () => {
    const longDetail = worksheetText(
      buildWorkOrder({
        documentation: documentation({
          splitters: [
            {
              id: 'sp-long',
              name: 'Tray with a very long name that somebody typed in a hurry indeed',
              input_core_id: 'k2',
              ports: [{ port_number: 1, output_core_id: null }],
            },
          ],
        }),
      }),
    );
    assert.ok(longDetail.split('\n').every((line) => line.length <= 80));
    // Wrapped, not truncated: every word of the name is still on the sheet, and
    // the continuation is indented under it rather than starting a new step.
    assert.match(longDetail, /Tray with a very long name that somebody typed in\n\s+a hurry indeed port 1/);
  });

  test('is plain text: no markup, tabs or escape codes that mangle over WhatsApp', () => {
    assert.ok(!/<\/?[a-z][^>]*>/i.test(text), 'looks like markup leaked in');
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\x1b|\\t/.test(text));
    assert.ok(text.split('\n').every((line) => line.length <= 80));
  });
});
