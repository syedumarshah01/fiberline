/**
 * Everything documented about one box: every cable landing in it, every core
 * with its far end, every splice inside it, every splitter with its ports, and
 * the QC flags — the payload behind the box documentation panel.
 *
 * A service rather than a route body because there is a second reader now: the
 * splice worksheet (src/services/workOrder.js) is generated *from* this, so the
 * checklist and the panel can never disagree about what the box contains.
 *
 * Returns null when the box does not exist; the caller decides what that means
 * (the HTTP route answers 404).
 */
const db = require('../db');
const { BAD_SPLICE_LOSS_DB } = require('../utils/lossBudget');

async function loadBoxDocumentation({ enclosureId, executor = db } = {}) {
  const enclosure = await executor('enclosures').where({ id: enclosureId }).first();
  if (!enclosure) {
    return null; // the caller turns this into its own 404
  }

  // All cables physically landing at this box (either end)
  const cables = await executor('cables')
    .where({ from_enclosure_id: enclosureId })
    .orWhere({ to_enclosure_id: enclosureId })
    .select('id', 'code', 'name', 'cable_type', 'core_count', 'from_enclosure_id', 'to_enclosure_id', 'customer_label');

  const cableIds = cables.map((c) => c.id);

  // Every core belonging to those cables, with status
  const cores = cableIds.length
    ? await executor('fiber_cores').whereIn('cable_id', cableIds).select('*')
    : [];

  // Every splice recorded inside this specific box, joined with cable/core context
  const splices = await executor.raw(
    `
    SELECT s.id, s.splice_type, s.tray_number, s.tray_position, s.loss_db,
           s.technician, s.splice_date, s.notes,
           ca.id AS core_a_id, ca.core_number AS core_a_number, cca.code AS cable_a_code, cca.cable_type AS cable_a_type,
           cb.id AS core_b_id, cb.core_number AS core_b_number, ccb.code AS cable_b_code, ccb.cable_type AS cable_b_type
    FROM splices s
    JOIN fiber_cores ca ON ca.id = s.core_a_id
    JOIN fiber_cores cb ON cb.id = s.core_b_id
    JOIN cables cca ON cca.id = ca.cable_id
    JOIN cables ccb ON ccb.id = cb.cable_id
    WHERE s.enclosure_id = ?
    ORDER BY s.tray_number, s.tray_position
    `,
    [enclosureId]
  );

  // ---------------------------------------------------------------------
  // Far-end wiring for IN cables: for each fiber arriving at this box,
  // what is its other end connected to in the UPSTREAM box — spliced to
  // which core of which cable, fed from which splitter port, or feeding
  // which splitter. This answers "where does this fiber come from?"
  // without opening the other box.
  // ---------------------------------------------------------------------
  const inCableIds = cables.filter((c) => c.to_enclosure_id === enclosureId).map((c) => c.id);
  const inCores = cores.filter((c) => inCableIds.includes(c.cable_id));
  const farByCoreId = {};
  if (inCores.length) {
    const cableById = Object.fromEntries(cables.map((c) => [c.id, c]));
    const farEnclosureIds = [
      ...new Set(inCableIds.map((id) => cableById[id].from_enclosure_id).filter(Boolean)),
    ];
    const inCoreIds = inCores.map((c) => c.id);

    const farBoxes = farEnclosureIds.length
      ? await executor('enclosures').whereIn('id', farEnclosureIds).select('id', 'code')
      : [];
    const farBoxCode = Object.fromEntries(farBoxes.map((b) => [b.id, b.code]));

    // Splices in the upstream boxes that involve one of our arriving cores
    const farSplices = farEnclosureIds.length
      ? await executor('splices')
          .whereIn('enclosure_id', farEnclosureIds)
          .where(function () {
            this.whereIn('core_a_id', inCoreIds).orWhereIn('core_b_id', inCoreIds);
          })
          .select('id', 'enclosure_id', 'core_a_id', 'core_b_id')
      : [];
    // Resolve splice partner cores to "CABLE-CODE #core"
    const partnerIds = [
      ...new Set(
        farSplices
          .flatMap((s) => [s.core_a_id, s.core_b_id])
          .filter((id) => !inCoreIds.includes(id)),
      ),
    ];
    const partnerCores = partnerIds.length
      ? await executor('fiber_cores')
          .whereIn('fiber_cores.id', partnerIds)
          .leftJoin('cables', 'cables.id', 'fiber_cores.cable_id')
          .select('fiber_cores.id', 'fiber_cores.core_number', 'cables.code as cable_code')
      : [];
    const partnerById = Object.fromEntries(
      partnerCores.map((c) => [c.id, `${c.cable_code || 'cable'} #${c.core_number}`]),
    );

    // Splitter ports in the upstream boxes feeding our arriving cores
    const farPorts = farEnclosureIds.length
      ? await executor('splitter_ports')
          .join('splitters', 'splitters.id', 'splitter_ports.splitter_id')
          .whereIn('splitters.enclosure_id', farEnclosureIds)
          .whereIn('splitter_ports.output_core_id', inCoreIds)
          .select(
            'splitter_ports.output_core_id',
            'splitter_ports.port_number',
            'splitters.name as splitter_name',
            'splitters.split_count',
            'splitters.enclosure_id',
          )
      : [];
    const farPortByCore = Object.fromEntries(farPorts.map((p) => [p.output_core_id, p]));

    // Splitters in the upstream boxes whose INPUT is one of our arriving cores
    const farInputs = farEnclosureIds.length
      ? await executor('splitters')
          .whereIn('enclosure_id', farEnclosureIds)
          .whereIn('input_core_id', inCoreIds)
          .select('input_core_id', 'name', 'split_count', 'enclosure_id')
      : [];
    const farInputByCore = Object.fromEntries(farInputs.map((s) => [s.input_core_id, s]));

    for (const core of inCores) {
      const cable = cableById[core.cable_id];
      const farId = cable?.from_enclosure_id;
      const boxCode = farBoxCode[farId] || null;
      const splice = farSplices.find(
        (s) => s.enclosure_id === farId && (s.core_a_id === core.id || s.core_b_id === core.id),
      );
      const port = farPortByCore[core.id];
      const input = farInputByCore[core.id];

      let connection = 'free';
      let label = 'not connected there';
      if (splice) {
        const partnerId = splice.core_a_id === core.id ? splice.core_b_id : splice.core_a_id;
        connection = 'splice';
        label = `spliced to ${partnerById[partnerId] || 'another fiber'}`;
      } else if (port) {
        connection = 'splitter_port';
        label = `port ${port.port_number} of ${port.splitter_name || `1:${port.split_count} splitter`}`;
      } else if (input) {
        connection = 'splitter_input';
        label = `input of ${input.name || `1:${input.split_count} splitter`}`;
      }
      farByCoreId[core.id] = { enclosure_code: boxCode, connection, label };
    }
  }

  // Build cores by cable with direction info (IN vs OUT)
  const coresByCable = {};
  for (const cable of cables) {
    const isIncoming = cable.to_enclosure_id === enclosureId; // Cable ends here (IN)
    const isOutgoing = cable.from_enclosure_id === enclosureId; // Cable starts here (OUT)
    coresByCable[cable.id] = {
      cable,
      direction: isIncoming ? 'in' : isOutgoing ? 'out' : 'unknown',
      cores: cores
        .filter((c) => c.cable_id === cable.id)
        .map((c) => (farByCoreId[c.id] ? { ...c, far_endpoint: farByCoreId[c.id] } : c)),
    };
  }

  // Every splitter in this box, with their ports
  const splitters = await executor('splitters')
    .where({ enclosure_id: enclosureId })
    .select('*')
    .orderBy('created_at');

  const splitterIds = splitters.map((s) => s.id);
  const splitterPorts = splitterIds.length
    ? await executor('splitter_ports')
        .whereIn('splitter_id', splitterIds)
        .leftJoin('fiber_cores', 'fiber_cores.id', 'splitter_ports.output_core_id')
        .leftJoin('cables', 'cables.id', 'fiber_cores.cable_id')
        .leftJoin('splitters as child', 'child.id', 'splitter_ports.output_splitter_id')
        .select(
          'splitter_ports.splitter_id',
          'splitter_ports.port_number',
          'splitter_ports.status as port_status',
          'splitter_ports.output_core_id',
          'splitter_ports.output_splitter_id',
          'fiber_cores.id as core_id',
          'fiber_cores.core_number',
          'fiber_cores.status as core_status',
          'cables.code as cable_code',
          'child.name as child_splitter_name',
          'child.split_count as child_split_count',
        )
        .orderBy(['splitter_ports.splitter_id', 'splitter_ports.port_number'])
    : [];

  // Cascade parents: which upstream splitter port feeds each splitter here
  const parentRows = splitterIds.length
    ? await executor('splitter_ports')
        .whereIn('output_splitter_id', splitterIds)
        .join('splitters as parent', 'parent.id', 'splitter_ports.splitter_id')
        .select(
          'splitter_ports.output_splitter_id',
          'splitter_ports.port_number',
          'parent.id as parent_id',
          'parent.name as parent_name',
          'parent.split_count as parent_split_count',
        )
    : [];
  const parentByChild = Object.fromEntries(
    parentRows.map((r) => [
      r.output_splitter_id,
      { splitter_id: r.parent_id, name: r.parent_name, split_count: r.parent_split_count, port_number: r.port_number },
    ]),
  );

  const splittersWithPorts = splitters.map((s) => ({
    ...s,
    parent: parentByChild[s.id] || null,
    ports: splitterPorts.filter((p) => p.splitter_id === s.id),
  }));

  const availableCores = cores.filter((c) => c.status === 'available');

  // QC: any splice in this box whose RECORDED loss is suspiciously high is
  // auto-flagged as a probable bad splice — techs get a work list without
  // hunting through every tray reading.
  const badSplices = splices.rows
    .filter((s) => s.loss_db != null && Number(s.loss_db) > BAD_SPLICE_LOSS_DB)
    .map((s) => ({
      splice_id: s.id,
      loss_db: Number(s.loss_db),
      splice_type: s.splice_type,
      tray: [s.tray_number, s.tray_position].filter(Boolean).join('/') || null,
      core_a: `${s.cable_a_code} #${s.core_a_number}`,
      core_b: `${s.cable_b_code} #${s.core_b_number}`,
    }));

  return {
    enclosure,
    cables_landing_here: Object.values(coresByCable),
    splices: splices.rows,
    splitters: splittersWithPorts,
    qc_flags: {
      bad_splice_threshold_db: BAD_SPLICE_LOSS_DB,
      bad_splices: badSplices,
    },
    summary: {
      total_cables: cables.length,
      total_cores: cores.length,
      spliced_cores: cores.filter((c) => c.status === 'spliced').length,
      available_cores: availableCores.length,
      terminated_cores: cores.filter((c) => c.status === 'terminated').length,
      reserved_cores: cores.filter((c) => c.status === 'reserved').length,
      damaged_cores: cores.filter((c) => c.status === 'damaged').length,
      bad_splices: badSplices.length,
    },
  };
}

module.exports = { loadBoxDocumentation };
