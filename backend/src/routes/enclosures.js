const express = require('express');
const db = require('../db');
const { validateEnclosureData } = require('../middleware/validation');
const router = express.Router();

// GET /api/enclosures — all boxes, with parent pole coordinates or direct location
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.raw(`
      SELECT e.id, e.code, e.name, e.type, e.capacity, e.status, e.mounting,
             e.pole_id, p.code AS pole_code,
             COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
             COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng
      FROM enclosures e
      LEFT JOIN poles p ON p.id = e.pole_id
      ORDER BY e.created_at DESC
    `);
    res.json(rows.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/enclosures
// For customer enclosures: provide lat/lng instead of pole_id
router.post('/', validateEnclosureData, async (req, res, next) => {
  try {
    const { code, name, pole_id, type, capacity, status, mounting, notes, lat, lng } = req.body;
    if (!code || !type) {
      return res.status(400).json({ error: 'code and type are required' });
    }
    
    // Either pole_id OR lat/lng must be provided
    if (!pole_id && (lat == null || lng == null)) {
      return res.status(400).json({ error: 'Either pole_id or lat/lng is required' });
    }
    
    const insertData = { code, name, type, capacity: capacity || 0, status, mounting, notes };
    
    if (pole_id) {
      insertData.pole_id = pole_id;
    } else {
      // Customer enclosure - set location directly
      insertData.location = db.raw("ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography", [lng, lat]);
    }
    
    const [row] = await db('enclosures')
      .insert(insertData)
      .returning('*');
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/enclosures/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const fields = ['name', 'type', 'capacity', 'status', 'mounting', 'notes'];
    const updates = { updated_at: db.fn.now() };
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
    await db('enclosures').where({ id: req.params.id }).update(updates);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/enclosures/:id
// Guard: deleting a box that still has cables attached fails with an opaque 500
// (cables.from_enclosure_id/to_enclosure_id are ON DELETE RESTRICT), so reject
// with a clear 409 up front instead.
router.delete('/:id', async (req, res, next) => {
  try {
    const [cableUse] = await db('cables')
      .where({ from_enclosure_id: req.params.id })
      .orWhere({ to_enclosure_id: req.params.id })
      .count('id as count');
    if (parseInt(cableUse.count, 10) > 0) {
      return res.status(409).json({
        error: `Enclosure still has ${cableUse.count} cable(s) attached. Delete or re-route the cables first.`,
      });
    }
    await db('enclosures').where({ id: req.params.id }).del();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

  // ---------------------------------------------------------------------------
  // GET /api/enclosures/:id/documentation
  //
  // Requirement #3 & #4: complete documentation of a box — every core that
  // enters it, every core that leaves it, and how they're spliced together,
  // plus which cores are still free.
  // ---------------------------------------------------------------------------
  router.get('/:id/documentation', async (req, res, next) => {
    try {
      const enclosureId = req.params.id;

      const enclosure = await db('enclosures').where({ id: enclosureId }).first();
      if (!enclosure) return res.status(404).json({ error: 'Enclosure not found' });

      // All cables physically landing at this box (either end)
      const cables = await db('cables')
        .where({ from_enclosure_id: enclosureId })
        .orWhere({ to_enclosure_id: enclosureId })
        .select('id', 'code', 'name', 'cable_type', 'core_count', 'from_enclosure_id', 'to_enclosure_id', 'customer_label');

      const cableIds = cables.map((c) => c.id);

      // Every core belonging to those cables, with status
      const cores = cableIds.length
        ? await db('fiber_cores').whereIn('cable_id', cableIds).select('*')
        : [];

      // Every splice recorded inside this specific box, joined with cable/core context
      const splices = await db.raw(
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
          ? await db('enclosures').whereIn('id', farEnclosureIds).select('id', 'code')
          : [];
        const farBoxCode = Object.fromEntries(farBoxes.map((b) => [b.id, b.code]));

        // Splices in the upstream boxes that involve one of our arriving cores
        const farSplices = farEnclosureIds.length
          ? await db('splices')
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
          ? await db('fiber_cores')
              .whereIn('fiber_cores.id', partnerIds)
              .leftJoin('cables', 'cables.id', 'fiber_cores.cable_id')
              .select('fiber_cores.id', 'fiber_cores.core_number', 'cables.code as cable_code')
          : [];
        const partnerById = Object.fromEntries(
          partnerCores.map((c) => [c.id, `${c.cable_code || 'cable'} #${c.core_number}`]),
        );

        // Splitter ports in the upstream boxes feeding our arriving cores
        const farPorts = farEnclosureIds.length
          ? await db('splitter_ports')
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
          ? await db('splitters')
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
      const splitters = await db('splitters')
        .where({ enclosure_id: enclosureId })
        .select('*')
        .orderBy('created_at');

      const splitterIds = splitters.map((s) => s.id);
      const splitterPorts = splitterIds.length
        ? await db('splitter_ports')
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
        ? await db('splitter_ports')
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

      res.json({
        enclosure,
        cables_landing_here: Object.values(coresByCable),
        splices: splices.rows,
        splitters: splittersWithPorts,
        summary: {
          total_cables: cables.length,
          total_cores: cores.length,
          spliced_cores: cores.filter((c) => c.status === 'spliced').length,
          available_cores: availableCores.length,
          terminated_cores: cores.filter((c) => c.status === 'terminated').length,
          reserved_cores: cores.filter((c) => c.status === 'reserved').length,
          damaged_cores: cores.filter((c) => c.status === 'damaged').length,
        },
      });
    } catch (err) {
      next(err);
    }
  });

// ---------------------------------------------------------------------------
// GET /api/enclosures/:id/visualization
// Returns data in a format optimized for the fiber bundle visualization
// ---------------------------------------------------------------------------
router.get('/:id/visualization', async (req, res, next) => {
  try {
    const enclosureId = req.params.id;

    const enclosure = await db('enclosures').where({ id: enclosureId }).first();
    if (!enclosure) return res.status(404).json({ error: 'Enclosure not found' });

    // Get all cables landing at this box
    const cables = await db('cables')
      .where({ from_enclosure_id: enclosureId })
      .orWhere({ to_enclosure_id: enclosureId })
      .select('id', 'code', 'name', 'cable_type', 'core_count', 'from_enclosure_id', 'to_enclosure_id', 'customer_label');

    const cableIds = cables.map((c) => c.id);

    // Get all cores
    const cores = cableIds.length
      ? await db('fiber_cores').whereIn('cable_id', cableIds).select('*')
      : [];

    // Get splitters
    const splitters = await db('splitters')
      .where({ enclosure_id: enclosureId })
      .select('*')
      .orderBy('created_at');

    const splitterIds = splitters.map((s) => s.id);
const splitterPorts = splitterIds.length
      ? await db('splitter_ports')
          .whereIn('splitter_id', splitterIds)
          .leftJoin('fiber_cores', 'fiber_cores.id', 'splitter_ports.output_core_id')
          .leftJoin('cables', 'cables.id', 'fiber_cores.cable_id')
          .select(
            'splitter_ports.splitter_id',
            'splitter_ports.port_number',
            'splitter_ports.status as port_status',
            'fiber_cores.id as core_id',
            'fiber_cores.core_number',
            'fiber_cores.status as core_status',
            'cables.code as cable_code',
          )
          .orderBy(['splitter_ports.splitter_id', 'splitter_ports.port_number'])
      : [];

    // Build the visualization data structure
    // Find the main trunk cable (the one with most cores)
    const trunkCable = cables.reduce((max, cable) => 
      cable.core_count > (max?.core_count || 0) ? cable : max, null
    );

    // Get cores for the trunk cable
    const trunkCores = trunkCable 
      ? cores.filter((c) => c.cable_id === trunkCable.id)
      : [];

    // Color palette for cores
    const CORE_COLORS = [
      "#0a3d91", // Blue
      "#e67e22", // Orange
      "#27ae60", // Green
      "#7f8c8d", // Gray
      "#ecf0f1", // Light gray
      "#e74c3c", // Red
      "#f1c40f", // Yellow
      "#8e44ad", // Purple
      "#1abc9c", // Teal
    ];

    // Build connections array
    const connections = trunkCores.map((core, index) => ({
      coreIndex: index,
      color: CORE_COLORS[index % CORE_COLORS.length],
      status: core.status === 'available' ? 'active' : 
              core.status === 'spliced' ? 'active' :
              core.status === 'terminated' ? 'active' : 'dotted'
    }));

// Build splitters array
    const splittersData = splitters.map((splitter) => {
      const ports = splitterPorts.filter((p) => p.splitter_id === splitter.id);
      // splitters reference their input core by ID (input_core_id) — there is
      // no input_cable_id column, so the lookup must be by core id.
      const inputCore = cores.find((c) => c.id === splitter.input_core_id);

      return {
        sourceCoreIndex: inputCore ? trunkCores.findIndex((c) => c.id === inputCore.id) : 0,
        splitterType: `1:${splitter.split_count}`,
        outputFibers: ports.map((port, idx) => ({
          color: CORE_COLORS[port.core_number ? port.core_number % CORE_COLORS.length : idx % CORE_COLORS.length] || "#0a3d91",
          status: port.core_status || "available"
        }))
      };
    });
    res.json({
      deviceId: enclosure.code,
      totalCores: trunkCable?.core_count || 0,
      inputCableName: trunkCable ? `${trunkCable.code} (${trunkCable.core_count} Cores)` : "No trunk cable",
      outputCableName: "Distribution Cable (12 Paths)",
      connections,
      splitters: splittersData,
      defaultNotes: {
        box: `Box ${enclosure.code} (${enclosure.name || 'Unnamed'}) is a ${enclosure.type} enclosure with capacity for ${enclosure.capacity} cores. Currently ${enclosure.status}. Mounted ${enclosure.mounting || 'unknown'}. This box manages fiber connections between incoming trunk cables and outgoing distribution cables through splitters.`,
        cables: cables.map(cable => ({
          cableId: cable.id,
          cableCode: cable.code,
          note: `Cable ${cable.code} (${cable.name || 'Unnamed'}) is a ${cable.cable_type} cable with ${cable.core_count} cores. Connects ${cable.from_enclosure_id ? 'Box ' + cable.from_enclosure_id : 'unknown'} to ${cable.to_enclosure_id ? 'Box ' + cable.to_enclosure_id : (cable.customer_id ? 'Customer ' + cable.customer_id : 'unknown')}. Status: ${cable.status}.`
        })),
        splices: `Splices in this box connect incoming fiber cores from trunk cables to outgoing cores in distribution cables. Each splice represents a physical fusion or mechanical connection point inside a splice tray. Check tray numbers and positions for maintenance.`
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
