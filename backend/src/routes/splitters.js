const express = require('express');
const db = require('../db');
const { validateSplitterData } = require('../middleware/validation');
const {
  defaultSplitterName,
  splitterInputNote,
  splitterOutputNote,
  splitterUnassignNote,
  portIsOccupied,
  sanitizeSplitterPatch,
} = require('../utils/splitters');
const router = express.Router();

// Columns every port listing exposes — including a possible cascaded child
// splitter (a splitter fed from this port instead of a fiber core).
const PORT_SELECT = [
  'splitter_ports.id as port_id',
  'splitter_ports.port_number',
  'splitter_ports.status as port_status',
  'splitter_ports.notes as port_notes',
  'splitter_ports.output_core_id',
  'splitter_ports.output_splitter_id',
  'fiber_cores.id as core_id',
  'fiber_cores.core_number',
  'fiber_cores.status as core_status',
  'cables.code as cable_code',
  'cables.cable_type',
  'child.name as child_splitter_name',
  'child.split_count as child_split_count',
  'child.enclosure_id as child_splitter_enclosure_id',
];

function portsFor(splitterId) {
  return db('splitter_ports')
    .where({ splitter_id: splitterId })
    .leftJoin('fiber_cores', 'fiber_cores.id', 'splitter_ports.output_core_id')
    .leftJoin('cables', 'cables.id', 'fiber_cores.cable_id')
    .leftJoin('splitters as child', 'child.id', 'splitter_ports.output_splitter_id')
    .select(...PORT_SELECT)
    .orderBy('splitter_ports.port_number');
}

// Where does this splitter get its light from? Either an input fiber core, or
// a port of an upstream splitter (cascade). Returns null for neither.
async function parentInfo(splitterId) {
  const row = await db('splitter_ports')
    .where({ output_splitter_id: splitterId })
    .join('splitters as parent', 'parent.id', 'splitter_ports.splitter_id')
    .select(
      'parent.id as splitter_id',
      'parent.name as splitter_name',
      'parent.split_count as splitter_split_count',
      'parent.enclosure_id',
      'splitter_ports.port_number',
    )
    .first();
  return row || null;
}

// GET /api/splitters?enclosureId=xxx — all splitters in a given enclosure (with ports)
router.get('/', async (req, res, next) => {
  try {
    const { enclosureId } = req.query;
    const query = db('splitters').select('*');
    if (enclosureId) query.where({ enclosure_id: enclosureId });
    const splitters = await query.orderBy('created_at');

    // Resolve input cores to cable code + core number for readable labels
    const inputIds = splitters.map((s) => s.input_core_id).filter(Boolean);
    const inputRows = inputIds.length
      ? await db('fiber_cores')
          .whereIn('fiber_cores.id', inputIds)
          .leftJoin('cables', 'cables.id', 'fiber_cores.cable_id')
          .select('fiber_cores.id', 'fiber_cores.core_number', 'cables.code as cable_code')
      : [];
    const inputById = Object.fromEntries(inputRows.map((r) => [r.id, r]));

    // Attach ports + cascade parent + input core info to each splitter
    for (const s of splitters) {
      s.ports = await portsFor(s.id);
      s.parent = await parentInfo(s.id);
      s.input_core = s.input_core_id ? inputById[s.input_core_id] || null : null;
    }

    res.json(splitters);
  } catch (err) {
    next(err);
  }
});

// GET /api/splitters/:id — splitter details with its ports
router.get('/:id', async (req, res, next) => {
  try {
    const splitter = await db('splitters').where({ id: req.params.id }).first();
    if (!splitter) return res.status(404).json({ error: 'Splitter not found' });

    // LEFT JOINs (not inner): freshly created ports have output_core_id = NULL
    // and would silently vanish from the response otherwise — inconsistent with
    // the list endpoint above.
    const ports = await portsFor(req.params.id);
    const parent = await parentInfo(req.params.id);

    res.json({ ...splitter, ports, parent });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/splitters
// Creates a 1:N splitter in an enclosure. The input is EITHER a fiber core
// (input_core_id — must be 'available'/'reserved'/'spliced' for branching,
// and flips to 'spliced') OR a free output port of another splitter in the
// same box (input_port — cascaded distribution tree). Output ports start
// empty; cores are assigned to them later as drops get spliced.
// ---------------------------------------------------------------------------
router.post('/', validateSplitterData, async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const {
      enclosure_id,
      name,
      split_count = 4, // 2, 4, or 8
      input_core_id,
      input_port, // { splitter_id, port_number } — cascade onto a free port
      splice_type = 'fusion',
      loss_db,
      technician,
      notes,
    } = req.body;

    const validSplits = [2, 4, 8];
    if (!validSplits.includes(Number(split_count))) {
      await trx.rollback();
      return res.status(400).json({ error: 'split_count must be 2, 4, or 8' });
    }

    let inputCore = null;
    let parentPort = null;
    // Source description for auto-naming and human-readable notes
    let inputSource = null;

    if (input_port) {
      // ---- Cascaded input: this splitter is fed by a port of another splitter
      const parentSplitter = await trx('splitters').where({ id: input_port.splitter_id }).first();
      if (!parentSplitter) {
        await trx.rollback();
        return res.status(404).json({ error: 'Parent splitter not found' });
      }
      if (parentSplitter.enclosure_id !== enclosure_id) {
        await trx.rollback();
        return res.status(400).json({
          error: 'Cascaded splitter must be in the same box as the parent splitter',
        });
      }
      parentPort = await trx('splitter_ports')
        .where({ splitter_id: parentSplitter.id, port_number: input_port.port_number })
        .first();
      if (!parentPort) {
        await trx.rollback();
        return res.status(404).json({
          error: `Port ${input_port.port_number} not found on the parent splitter`,
        });
      }
      if (portIsOccupied(parentPort)) {
        await trx.rollback();
        return res.status(409).json({
          error: `Port ${input_port.port_number} of the parent splitter is already in use`,
        });
      }
      inputSource = {
        kind: 'port',
        parentName: parentSplitter.name,
        parentSplitCount: parentSplitter.split_count,
        portNumber: parentPort.port_number,
      };
    } else {
      // ---- Fiber-core input
      inputCore = await trx('fiber_cores').where({ id: input_core_id }).forUpdate().first();
      if (!inputCore) {
        await trx.rollback();
        return res.status(404).json({ error: 'Input core not found' });
      }
      // Allow spliced cores for branching (adding splitter to an already-spliced core)
      if (!['available', 'reserved', 'spliced'].includes(inputCore.status)) {
        await trx.rollback();
        return res.status(409).json({ error: 'Input core is not available to splice', status: inputCore.status });
      }
      const inputCable = await trx('cables').where({ id: inputCore.cable_id }).select('code').first();
      inputSource = {
        kind: 'core',
        cableCode: inputCable?.code || 'cable',
        coreNumber: inputCore.core_number,
      };
    }

    const splitterName = name || defaultSplitterName(split_count, inputSource);

    // Create the splitter (convert empty loss_db to null for numeric column)
    const [splitter] = await trx('splitters')
      .insert({
        enclosure_id,
        name: splitterName,
        split_count,
        input_core_id: inputCore ? inputCore.id : null,
        splice_type,
        loss_db: loss_db ? Number(loss_db) : null,
        technician: technician || null,
        notes: notes || null,
      })
      .returning('*');

    // Create N empty output ports (cores get assigned later)
    const portRows = Array.from({ length: Number(split_count) }, (_, index) => ({
      splitter_id: splitter.id,
      output_core_id: null,
      port_number: index + 1,
    }));
    await trx('splitter_ports').insert(portRows);

    if (parentPort) {
      // Occupy the parent port with this new splitter
      await trx('splitter_ports')
        .where({ id: parentPort.id })
        .update({ output_splitter_id: splitter.id, updated_at: trx.fn.now() });
    } else if (inputCore) {
      // Mark input core as 'spliced' (it's connected to the splitter)
      await trx('fiber_cores').where({ id: inputCore.id }).update({
        status: 'spliced',
        notes: splitterInputNote(splitterName, split_count),
        updated_at: trx.fn.now(),
      });
    }

    await trx.commit();
    res.status(201).json(splitter);
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/splitters/:id/assign-port
// Assign a fiber core to a splitter output port (for later splicing to customer drops)
// ---------------------------------------------------------------------------
router.post('/:id/assign-port', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const { port_number, core_id } = req.body;
    
    if (!port_number || !core_id) {
      await trx.rollback();
      return res.status(400).json({ error: 'port_number and core_id are required' });
    }

    const splitter = await trx('splitters').where({ id: req.params.id }).first();
    if (!splitter) {
      await trx.rollback();
      return res.status(404).json({ error: 'Splitter not found' });
    }

    const port = await trx('splitter_ports')
      .where({ splitter_id: req.params.id, port_number })
      .first();
    if (!port) {
      await trx.rollback();
      return res.status(404).json({ error: `Port ${port_number} not found` });
    }

    if (portIsOccupied(port)) {
      await trx.rollback();
      return res.status(409).json({
        error: `Port ${port_number} is already in use${port.output_splitter_id ? ' by another splitter' : ''}`,
      });
    }

    const core = await trx('fiber_cores').where({ id: core_id }).forUpdate().first();
    if (!core) {
      await trx.rollback();
      return res.status(404).json({ error: 'Core not found' });
    }

// For splitter output ports, we need available cores (not spliced)
    // because the output core will be spliced to a customer drop
    if (!['available', 'reserved'].includes(core.status)) {
      await trx.rollback();
      return res.status(409).json({ error: 'Core is not available', status: core.status });
    }

    await trx('splitter_ports').where({ id: port.id }).update({ output_core_id: core_id });
    await trx('fiber_cores').where({ id: core_id }).update({
      status: 'spliced',
      notes: splitterOutputNote(splitter.name, splitter.split_count, Number(port_number)),
      updated_at: trx.fn.now(),
    });

    await trx.commit();
    res.json({ message: 'Core assigned to port', port_id: port.id, core_id });
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// DELETE /api/splitters/:id/assign-port
// Unassign a core from a splitter output port
router.delete('/:id/assign-port', async (req, res,next) => {
  const trx = await db.transaction();
  try {
    const { port_number } = req.query;
    
    if (!port_number) {
      await trx.rollback();
      return res.status(400).json({ error: 'port_number is required' });
    }

    const port = await trx('splitter_ports')
      .where({ splitter_id: req.params.id, port_number: port_number })
      .first();
    
    if (!port || !port.output_core_id) {
      await trx.rollback();
      return res.status(404).json({ error: 'Port has no core assigned' });
    }

    const splitter = await trx('splitters').where({ id: req.params.id }).first();
    await trx('fiber_cores').where({ id: port.output_core_id }).update({
      status: 'available',
      notes: splitterUnassignNote(splitter?.name, Number(port_number)),
      updated_at: trx.fn.now(),
    });

    await trx('splitter_ports').where({ id: port.id }).update({ output_core_id: null });

    await trx.commit();
    res.json({ message: 'Core unassigned from port', port_id: port.id });
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// PATCH /api/splitters/:id — edit the stuff techs need to fix in the field:
// the name, the notes, who spliced it and the measured loss. Port structure
// (split_count / port assignments) is NOT editable here by design.
router.patch('/:id', async (req, res, next) => {
  try {
    const splitter = await db('splitters').where({ id: req.params.id }).first();
    if (!splitter) return res.status(404).json({ error: 'Splitter not found' });

    const { updates, error } = sanitizeSplitterPatch(req.body || {});
    if (error) return res.status(400).json({ error });

    updates.updated_at = db.fn.now();
    const [updated] = await db('splitters')
      .where({ id: req.params.id })
      .update(updates)
      .returning('*');
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/splitters/:id — removes splitter and returns cores to available
router.delete('/:id', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const splitter = await trx('splitters').where({ id: req.params.id }).first();
    if (!splitter) {
      await trx.rollback();
      return res.status(404).json({ error: 'Splitter not found' });
    }

    // Cascading guard: refuse to delete while another splitter hangs off one
    // of this splitter's ports — the child would silently lose its input.
    const [childLink] = await trx('splitter_ports')
      .where({ splitter_id: req.params.id })
      .whereNotNull('output_splitter_id')
      .count('id as count');
    if (parseInt(childLink.count, 10) > 0) {
      await trx.rollback();
      return res.status(409).json({
        error: 'Another splitter is attached to one of this splitter\'s ports — remove that splitter first',
      });
    }

    // Get all output ports (ignore empty ports — NULL core ids would end up in
    // the whereIn list otherwise)
    const ports = await trx('splitter_ports').where({ splitter_id: req.params.id });
    const outputCoreIds = ports.map((p) => p.output_core_id).filter(Boolean);

    // Return input core to available
    if (splitter.input_core_id) {
      await trx('fiber_cores').where({ id: splitter.input_core_id }).update({
        status: 'available',
        notes: `Removed from splitter ${splitter.name}`,
        updated_at: trx.fn.now(),
      });
    }

    // If this splitter was sitting on a parent splitter's port, free that port
    const parentPort = await trx('splitter_ports')
      .where({ output_splitter_id: req.params.id })
      .first();
    if (parentPort) {
      await trx('splitter_ports')
        .where({ id: parentPort.id })
        .update({ output_splitter_id: null, updated_at: trx.fn.now() });
    }

    // Return output cores to available
    if (outputCoreIds.length) {
      await trx('fiber_cores').whereIn('id', outputCoreIds).update({
        status: 'available',
        notes: 'Splitter removed',
        updated_at: trx.fn.now(),
      });
    }

    // Delete ports and splitter
    await trx('splitter_ports').where({ splitter_id: req.params.id }).del();
    await trx('splitters').where({ id: req.params.id }).del();

    await trx.commit();
    res.status(204).send();
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

module.exports = router;