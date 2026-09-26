/**
 * Splice worksheets: the box's documentation, turned into a job a technician can
 * work through with a toolbox in one hand.
 *
 * The checklist is *derived*, never invented: every line comes from something the
 * documentation already says — a splice whose recorded loss is out of spec, a
 * splitter port with nothing in it, a damaged core, a core pair nobody linked —
 * and each line names the cable, the core and the tray it refers to, so the sheet
 * and the box cannot drift apart. A worksheet that guessed at work would be worse
 * than none at all: it would send someone to a closure to do something nobody
 * asked for.
 *
 * Pure on purpose (no database, no clock of its own): `buildWorkOrder()` takes the
 * payload `loadBoxDocumentation()` returns and gives back the sheet. That keeps it
 * testable, and it keeps a single source of truth for what is in the box.
 */

const { wrapLine } = require('../utils/textWrap');

/** How many spare cores to name in the "pick a pair" line before counting the rest. */
const SPARES_LISTED = 12;

const KIND_LABELS = {
  splice: 'Splice job',
  repair: 'Repair job',
  survey: 'Documentation survey',
  // A new customer's drop: same box documentation, plus the hardware the install
  // needs. Produced from a serviceability check (GET /api/serviceability/check)
  // so the crew that quotes it is the crew that loads the van.
  install: 'New drop installation',
};

/** Sleeve + tray counts that any splice job needs anyway. */
/**
 * The materials a box job needs whatever the box says, plus — for a job whose
 * kind is `install` (a new customer's drop) — the hardware that install adds.
 * A worksheet for work that has not happened yet has to list what to load in
 * the van, or the technician drives back.
 */
function baseMaterials(kind) {
  // Sleeves are not listed here: the rules count them per joint, and a second
  // "one per splice" line beside a counted one is how a materials list stops
  // being believed.
  const base = [
    { item: 'Trays / splice holders', quantity: null, detail: 'as the closure needs' },
    { item: 'Alcohol wipes, lint-free tissue', quantity: 1, detail: 'cleaning before every splice' },
    { item: 'OTDR / splice loss meter', quantity: 1, detail: 'readings go back into the box record' },
  ];
  if (kind === 'install') {
    // A new drop: the hardware the drop itself needs, so one trip does the job.
    base.push(
      { item: 'Drop cable (aerial)', quantity: null, detail: 'length from the serviceability check / as routed' },
      { item: 'ONT / customer premises equipment', quantity: 1, detail: 'one per new customer — confirm with the install order' },
    );
  }
  return base;
}

/** "CBL-F1 #3" — how a technician says a fibre out loud. */
function fiber(cableCode, coreNumber) {
  const code = cableCode || 'cable';
  return coreNumber === null || coreNumber === undefined ? code : `${code} #${coreNumber}`;
}

function trayLabel(splice) {
  const tray = [splice.tray_number, splice.tray_position].filter(Boolean).join('/');
  return tray || null;
}

/**
 * The rules. Each returns zero or more checklist items from the documentation,
 * and may carry the materials that item needs.
 */
const RULES = [
  {
    // A splice reading over the threshold is the one thing the app already
    // flags for QC, so it leads the sheet.
    name: 're-splice',
    run({ documentation, threshold }) {
      return (documentation.qc_flags?.bad_splices || []).map((bad) => ({
        task: `Re-splice ${bad.core_a} ↔ ${bad.core_b}`,
        detail:
          `recorded loss ${bad.loss_db} dB is over the ${threshold} dB limit` +
          (bad.tray ? ` — tray ${bad.tray}` : ''),
        splice_id: bad.splice_id,
        tray: bad.tray || null,
        expected_loss_db: threshold,
        materials: [{ item: 'Fusion splice sleeves', quantity: 1, detail: 'the re-made joint' }],
      }));
    },
  },
  {
    // Cores somebody marked damaged: they are not carrying light, and the sheet
    // should say which ones so nobody re-splices onto them by mistake.
    name: 'damaged-core',
    run({ documentation }) {
      const damaged = [];
      for (const group of documentation.cables_landing_here || []) {
        for (const core of group.cores || []) {
          if (core.status !== 'damaged') continue;
          damaged.push({
            task: `Check and repair ${fiber(group.cable.code, core.core_number)}`,
            detail:
              `marked damaged, on ${group.direction === 'in' ? 'an incoming' : 'an outgoing'} ` +
              `${group.cable.cable_type} cable — re-splice or re-terminate it, then update its status`,
            cable_code: group.cable.code,
            core_number: core.core_number,
            core_id: core.id,
            materials: [{ item: 'Fusion splice sleeves', quantity: 1, detail: 'repair joint' }],
          });
        }
      }
      return damaged;
    },
  },
  {
    // Empty splitter ports are the usual reason a splice job exists at all:
    // somebody wants a new customer connected.
    name: 'free-splitter-port',
    run({ documentation }) {
      const items = [];
      for (const splitter of documentation.splitters || []) {
        for (const port of splitter.ports || []) {
          if (port.output_core_id || port.output_splitter_id) continue;
          items.push({
            task: `Patch a fibre into ${splitter.name || `splitter ${splitter.id}`} port ${port.port_number}`,
            detail:
              `the port is empty${splitter.parent ? `, fed from ${splitter.parent.name || 'a parent splitter'} port ${splitter.parent.port_number}` : ''}` +
              ' — pick a spare core from the incoming cables listed below',
            splitter_id: splitter.id,
            port_number: port.port_number,
            materials: [
              { item: 'Fusion splice sleeves', quantity: 1, detail: 'input side of the new drop' },
              { item: 'Pigtail / drop cable', quantity: 1, detail: 'one per customer being connected' },
            ],
          });
        }
      }
      return items;
    },
  },
  {
    // A splitter with no input core is documented but not connected.
    name: 'splitter-input',
    run({ documentation }) {
      return (documentation.splitters || [])
        .filter((splitter) => !splitter.input_core_id)
        .map((splitter) => ({
          task: `Assign an input fibre to ${splitter.name || `splitter ${splitter.id}`}`,
          detail: 'this splitter has no input core recorded, so nothing feeds it yet',
          splitter_id: splitter.id,
          materials: [{ item: 'Fusion splice sleeves', quantity: 1, detail: 'splitter input' }],
        }));
    },
  },
  {
    // Splices on record with no loss reading: the record is incomplete, and the
    // next person to open the box will want the number.
    name: 'missing-loss',
    run({ documentation }) {
      return (documentation.splices || [])
        .filter((splice) => splice.loss_db === null || splice.loss_db === undefined)
        .map((splice) => ({
          task: `Measure and record the loss of ${fiber(splice.cable_a_code, splice.core_a_number)} ↔ ${fiber(splice.cable_b_code, splice.core_b_number)}`,
          detail: 'the splice is recorded without a loss reading',
          splice_id: splice.id,
          tray: trayLabel(splice),
        }));
    },
  },
  {
    // A mid-span joint (a cable whose other half continues through this box):
    // whoever opens the box should know the fibre passes straight through.
    name: 'through-joint',
    run({ documentation }) {
      const continued = (documentation.through_joints || []).map((joint) => ({
        task: `Check the through-joint ${joint.upstream_code} → ${joint.downstream_code}`,
        detail:
          'these two cables are one span split in this box — the fibre runs straight through, ' +
          `so a splice here is a joint, not a termination${joint.inferred ? ' (link inferred from cable naming)' : ''}`,
        cable_code: joint.downstream_code,
        materials: [{ item: 'Fusion splice sleeves', quantity: 1, detail: 'per through-pair' }],
      }));
      return continued;
    },
  },
  {
    // The spare inventory, so the sheet answers "which core do I use?" without a
    // second trip to the laptop.
    name: 'spare-cores',
    run({ documentation }) {
      const spares = [];
      for (const group of documentation.cables_landing_here || []) {
        for (const core of group.cores || []) {
          if (core.status !== 'available') continue;
          spares.push(`${group.cable.code} #${core.core_number}`);
        }
      }
      if (!spares.length) return [];
      const shown = spares.slice(0, SPARES_LISTED).join(', ');
      const rest = spares.length > SPARES_LISTED ? ` … and ${spares.length - SPARES_LISTED} more` : '';
      return [
        {
          // Not a task: this is the answer to "which core do I use?", so it is
          // information on the sheet rather than a box to tick.
          info: true,
          task: `Spare fibres here: ${spares.length}`,
          detail: `${shown}${rest} — take new drops from these, deepest core first`,
          spare_count: spares.length,
          spares,
        },
      ];
    },
  },
];

/** Steps that are always on the sheet, whichever job it is. */
const CLOSING_STEPS = [
  { task: 'Photograph the tray layout before closing the box', detail: 'attach it to the box record' },
  { task: 'Record every splice loss in the app', detail: 'the box documentation panel takes them per splice' },
  {
    task: 'Update core statuses',
    detail: 'spliced → spliced, new drop → terminated; the failure simulation and traces believe these',
  },
  { task: 'Close the box, note the date and your name on the job', detail: null },
];

/**
 * One line per material. Quantities from different rules add up (two rules can
 * both need a sleeve); the always-there kit is appended afterwards instead of
 * being merged, because "one per splice" is a rule of thumb, not a count.
 */
function uniqueMaterials(items) {
  const byName = new Map();
  for (const list of items) {
    for (const material of list || []) {
      const existing = byName.get(material.item);
      if (!existing) {
        byName.set(material.item, { ...material });
        continue;
      }
      // Same item from several rules: add up the counts, and keep both details.
      if (material.quantity != null) {
        existing.quantity = (existing.quantity ?? 0) + material.quantity;
      }
      if (material.detail && existing.detail && !existing.detail.includes(material.detail)) {
        existing.detail = `${existing.detail}; ${material.detail}`;
      } else if (material.detail && !existing.detail) {
        existing.detail = material.detail;
      }
    }
  }
  return [...byName.values()];
}

/**
 * Read from documentation without ever letting a half-loaded payload throw:
 * a worksheet that prints with a count missing beats a 500 in the van.
 */
function safe(read, fallback) {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Build the worksheet for one box.
 *
 * @param {object} args
 * @param {object} args.documentation  what `loadBoxDocumentation()` returned
 * @param {string} [args.kind]         splice | repair | survey
 * @param {string} [args.by]           who is doing the job (printed on the sheet)
 * @param {Date|string} [args.generatedAt]
 * @param {object} [args.throughJoints] mid-span pairs meeting in this box
 * @param {object} [args.install] what a serviceability check decided for a new
 *   drop (box, port, length, price) — printed on an `install` sheet, purely
 *   informational: the box documentation below it is still the source of truth
 */
function buildWorkOrder({
  documentation,
  kind = 'splice',
  by = null,
  generatedAt = new Date(),
  throughJoints = [],
  install = null,
} = {}) {
  if (!documentation?.enclosure) {
    throw new Error('buildWorkOrder needs box documentation — see loadBoxDocumentation()');
  }
  const jobKind = KIND_LABELS[kind] ? kind : 'splice';
  // Read the collections once, defensively. Everything downstream — the rules,
  // the counts, the JSON — works from these, so a single unreadable table costs
  // one warning line and never the whole sheet.
  const flags = safe(() => documentation.qc_flags, null) || { bad_splice_threshold_db: null, bad_splices: [] };
  const landing = safe(() => documentation.cables_landing_here, []) || [];
  const spliceList = safe(() => documentation.splices, []) || [];
  const splitterList = safe(() => documentation.splitters, []) || [];
  const threshold = flags.bad_splice_threshold_db ?? null;
  const payload = { ...documentation, cables_landing_here: landing, splices: spliceList, splitters: splitterList, qc_flags: flags };
  const context = { documentation: { ...payload, through_joints: throughJoints }, threshold };

  const derived = [];
  for (const rule of RULES) {
    let items = [];
    try {
      items = rule.run(context) || [];
    } catch (err) {
      // A worksheet rule that throws must not cost the technician the whole
      // sheet: the rest of the checklist is still right.
      items = [
        {
          task: `Could not work out the "${rule.name}" steps from the documentation`,
          detail: err.message,
          warning: true,
        },
      ];
    }
    for (const item of items) derived.push({ ...item, source: rule.name });
  }

  // A new drop: the plan the serviceability check produced goes at the top of the
  // sheet, in the order the work happens (box → port → cable → splice → costs).
  // It is informational — the steps below it still come from the box's own
  // documentation — but it is what the crew was sent out to install.
  const plan = jobKind === 'install' && install ? installPlan(install) : null;
  if (plan) {
    derived.unshift(
      ...plan.items.map((item) => ({ ...item, source: 'install-plan', info: false })),
    );
  }

  // Numbering is the technician's friend: stable, and the same order the rules
  // run in, which is "worst first".
  // Number only the work. An informational line with a number would make the
  // count of steps wrong, and "step 2 of 7" is how people read these.
  let step = 0;
  const checklist = [...derived, ...CLOSING_STEPS.map((item) => ({ ...item, source: 'close-out' }))].map(
    (item) => (item.info ? { ...item, step: null } : { ...item, step: (step += 1) }),
  );

  const box = documentation.enclosure;
  const date = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const summary = safe(() => documentation.summary, null) || {};

  return {
    work_order: {
      reference: `WO-${box.code || box.id}-${stamp}`,
      kind: jobKind,
      kind_label: KIND_LABELS[jobKind],
      title: `${KIND_LABELS[jobKind]} — ${box.code}`,
      generated_at: date.toISOString(),
      generated_by: by,
      box: {
        id: box.id,
        code: box.code,
        name: box.name ?? null,
        type: box.type ?? null,
        pole_id: box.pole_id ?? null,
      },
      url: `/api/enclosures/${box.id}/documentation`,
    },
    summary: {
      cables: summary.total_cables ?? landing.length,
      cores: summary.total_cores ?? 0,
      spliced_cores: summary.spliced_cores ?? 0,
      available_cores: summary.available_cores ?? 0,
      damaged_cores: summary.damaged_cores ?? 0,
      splices: spliceList.length,
      splitters: splitterList.length,
      free_splitter_ports: splitterList.reduce(
        (count, splitter) =>
          count + safe(() => splitter.ports, []).filter((port) => !port.output_core_id && !port.output_splitter_id).length,
        0,
      ),
      bad_splices: safe(() => flags.bad_splices, []).length,
      checklist_steps: checklist.length,
      // Steps somebody has to do — the informational lines are on the sheet but
      // are not work.
      open_steps: derived.filter((item) => !item.info).length,
    },
    checklist,
    materials: [
      ...uniqueMaterials(derived.filter((item) => !item.info).map((item) => item.materials)),
      ...baseMaterials(kind),
      ...(plan ? plan.materials : []),
    ],
    // The two collections the sheet prints tables from. The splitter list is not
    // copied in: the checklist already names every splitter task, and the counts
    // are in `summary` — a worksheet that repeats the whole documentation payload
    // is just a second copy of the box to keep in step.
    cables_landing_here: landing,
    splices: spliceList,
    qc_flags: {
      bad_splice_threshold_db: threshold,
      bad_splices: safe(() => flags.bad_splices, []) || [],
    },
    through_joints: throughJoints,
    ...(plan ? { install_plan: plan.plan } : {}),
  };
}

/**
 * A new drop, as steps and materials, from what the serviceability check found.
 *
 * Only what the check actually decided is claimed here: no port number, no
 * metres and no price if the caller did not pass them. A sheet that invents a
 * port number sends a technician to the wrong tray.
 */
function installPlan(install = {}) {
  const items = [];
  const materials = [];
  const box = install.box_code || 'the serving box';

  items.push({
    task: `Open ${box}${install.box_name ? ` (${install.box_name})` : ''} and work to the serviceability check's plan`,
    detail:
      `${install.verdict_label || 'Serviceability check'}${install.needs_detail ? ` — ${install.needs_detail}` : ''}`,
  });

  if (install.port_number != null) {
    items.push({
      task: `Assign splitter ${install.splitter_name ? `"${install.splitter_name}" ` : ''}port ${install.port_number} to the new drop`,
      detail: 'the port is free now — confirm it is still free before cutting the drop',
      materials: [{ item: 'Pigtail / drop cable', quantity: 1, detail: 'the drop being installed' }],
    });
  } else if (install.needs === 'splitter') {
    items.push({
      task: `Install a splitter in ${box} for the new drop`,
      detail: 'the box has no free port yet — the check added a splitter to the price',
      materials: [{ item: 'Splitter (as ordered)', quantity: 1, detail: 'for the new drop' }],
    });
  } else if (install.needs === 'capacity') {
    items.push({
      task: `Bring capacity into ${box} before the drop can be spliced`,
      detail: 'the box has no free port and no spare fibre — survey it first',
      warning: true,
    });
  }

  if (install.route_length_m) {
    items.push({
      task: `Run the drop: about ${install.route_length_m} m from ${box} to the address`,
      detail:
        install.distance_source === 'street_route'
          ? 'measured along the street by the serviceability check — confirm on site'
          : 'straight-line estimate — measure the actual route before cutting',
      materials: [
        { item: 'Drop cable (aerial)', quantity: null, detail: `≈ ${install.route_length_m} m + slack` },
      ],
    });
  }

  items.push({
    task: 'Splice the drop onto the assigned port and record the loss',
    detail: 'the reading goes into the box record — the sheet is regenerated from it',
    materials: [{ item: 'Fusion splice sleeves', quantity: 1, detail: 'the new joint' }],
  });

  items.push({
    task: 'Register the customer and attach the drop cable to their record',
    detail: 'the locator, the QR tag and the outage report all read that link',
  });

  for (const line of install.materials || []) {
    // The priced lines are the plan's own material estimate, with money on them
    // so the sheet and the quote cannot disagree.
    const quantity = line.unit === 'm' || line.unit === 'unit' ? line.quantity : null;
    materials.push({
      item: line.item,
      quantity,
      detail: `${line.detail}${install.currency && line.amount ? ` — ${install.currency} ${line.amount}` : ''}`,
    });
  }

  const plan = {
    box_id: install.box_id ?? null,
    box_code: install.box_code ?? null,
    box_name: install.box_name ?? null,
    port_number: install.port_number ?? null,
    splitter_name: install.splitter_name ?? null,
    needs: install.needs ?? null,
    distance_m: install.distance_m ?? null,
    route_length_m: install.route_length_m ?? null,
    distance_source: install.distance_source ?? null,
    quote_total: install.quote_total ?? null,
    currency: install.currency ?? null,
    verdict: install.verdict ?? null,
    verdict_label: install.verdict_label ?? null,
    note: 'generated from a serviceability check — the box documentation below is the source of truth',
  };
  return { items, materials, plan };
}

// Fold a long line into several, so the sheet stays readable in a terminal, in a
// chat window, and on a phone with a font big enough to read outdoors. Wrapping
// happens at render time rather than in the data: the JSON keeps sentences
// intact. Shared with the serviceability quote (utils/textWrap.js) — same 78
// columns, same hanging indents, one implementation.

/** Push a (possibly long) line, wrapped, with an indent for continuations. */
function pushWrapped(lines, text, { width = 78, indent = '', hanging = null } = {}) {
  for (const line of wrapLine(text, { width, indent, hanging })) lines.push(line);
}

/**
 * The same sheet as plain text — for a phone with no printer, a WhatsApp message,
 * or `lp` on a laptop. Deliberately not a rendering of the JSON: it is written
 * the way someone reads it standing at the pole.
 */
function worksheetText(order) {
  const lines = [];
  const rule = '='.repeat(58);
  const thin = '-'.repeat(58);
  lines.push(rule);
  lines.push(order.work_order.title.toUpperCase());
  lines.push(`Reference ${order.work_order.reference}`);
  lines.push(`Generated ${order.work_order.generated_at}`);
  if (order.work_order.generated_by) lines.push(`For ${order.work_order.generated_by}`);
  lines.push(rule);
  const s = order.summary;
  // A printed sheet that says "1 splices" reads as a template nobody looked at,
  // so give the count its right word - the sheet is a document somebody signs.
  const count = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;
  lines.push(
    [
      count(s.cables, 'cable', 'cables'),
      count(s.cores, 'fibre', 'fibres'),
      count(s.splices, 'splice', 'splices'),
      count(s.splitters, 'splitter', 'splitters'),
    ].join(' · '),
  );
  if (s.free_splitter_ports) {
    lines.push(count(s.free_splitter_ports, 'free splitter port', 'free splitter ports'));
  }
  if (s.damaged_cores) lines.push(count(s.damaged_cores, 'damaged fibre', 'damaged fibres'));
  if (s.bad_splices) {
    lines.push(`${count(s.bad_splices, 'splice', 'splices')} over the loss limit`);
  }
  const plan = order.install_plan;
  if (plan) {
    lines.push('');
    lines.push('INSTALL PLAN (from the serviceability check)');
    lines.push(thin);
    lines.push(`  ${plan.verdict_label || 'Assessment'} — ${plan.needs || 'connection'}`);
    if (plan.box_code) lines.push(`  Serve from: ${plan.box_code}${plan.box_name ? ` (${plan.box_name})` : ''}, ${plan.distance_m ?? '?'} m`);
    if (plan.route_length_m) {
      lines.push(
        `  Run: about ${plan.route_length_m} m${plan.distance_source === 'street_route' ? ' along the street' : ' (straight-line estimate)'}`,
      );
    }
    if (plan.port_number != null) lines.push(`  Port to assign: ${plan.port_number}${plan.splitter_name ? ` (${plan.splitter_name})` : ''}`);
    if (plan.quote_total != null) lines.push(`  Quoted: ${plan.currency || ''} ${plan.quote_total}`.trimEnd());
    lines.push('');
  }
  lines.push('CHECKLIST');
  lines.push(thin);
  for (const item of order.checklist) {
    pushWrapped(lines, item.info ? `· ${item.task}` : `[ ] ${item.step}. ${item.task}`, {
      indent: '  ',
      hanging: item.info ? '    ' : '      ',
    });
    if (item.detail) pushWrapped(lines, item.detail, { indent: '      ', hanging: '      ' });
  }
  lines.push('');
  lines.push('MATERIALS');
  lines.push(thin);
  for (const material of order.materials) {
    const quantity = material.quantity == null ? 'as needed' : `x${material.quantity}`;
    pushWrapped(lines, `${material.item}${material.detail ? ` — ${material.detail}` : ''}`, {
      indent: `  ${quantity.padEnd(10)} `,
      hanging: ' '.repeat(13),
    });
  }
  if (order.splices.length) {
    lines.push('');
    lines.push('SPLICES ON RECORD');
    lines.push(thin);
    for (const splice of order.splices) {
      const loss = splice.loss_db == null ? 'no reading' : `${Number(splice.loss_db).toFixed(2)} dB`;
      const tray = trayLabel(splice) ? ` tray ${trayLabel(splice)}` : '';
      pushWrapped(
        lines,
        `${fiber(splice.cable_a_code, splice.core_a_number)} ↔ ${fiber(splice.cable_b_code, splice.core_b_number)}` +
          `  ${loss}${tray}`,
        { indent: '  ', hanging: '      ' },
      );
    }
  }
  const landing = order.cables_landing_here || [];
  if (landing.length) {
    lines.push('');
    lines.push('FIBRES IN THIS BOX');
    lines.push(thin);
    for (const group of landing) {
      const arrow = group.direction === 'in' ? 'IN ' : group.direction === 'out' ? 'OUT' : '·  ';
      const coreCount = `${group.cable.core_count} fibre${group.cable.core_count === 1 ? '' : 's'}`;
      lines.push(`  ${arrow} ${group.cable.code} (${group.cable.cable_type}, ${coreCount})`);
      for (const core of group.cores) {
        const far = core.far_endpoint?.connection && core.far_endpoint.connection !== 'free'
          ? ` ← ${core.far_endpoint.label}${core.far_endpoint.enclosure_code ? ` at ${core.far_endpoint.enclosure_code}` : ''}`
          : '';
        pushWrapped(lines, `#${core.core_number} ${core.status}${far}`, {
          indent: '      ',
          hanging: '        ',
        });
      }
    }
  }
  lines.push('');
  lines.push('SIGN-OFF');
  lines.push(thin);
  lines.push('  Technician: ____________________   Date: ____________');
  lines.push('  Loss readings recorded in the app:  [ ] yes');
  lines.push('  Box closed and locked:              [ ] yes');
  lines.push('');
  return lines.join('\n');
}

module.exports = { buildWorkOrder, worksheetText, wrapLine, KIND_LABELS, RULES, SPARES_LISTED };
