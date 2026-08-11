const express = require('express');
const db = require('../db');
const { validateSplitterData } = require('../middleware/validation');
const router = express.Router();

// GET /api/splitters?enclosureId=xxx — all splitters in a given enclosure (with ports)
router.get('/', async (req, res, next) => {
  try {
    const { enclosureId } = req.query;
    const query = db('splitters').select('*');
    if (enclosureId) query.where({ enclosure_id: enclosureId });
    const splitters = await query.orderBy('created_at');

    // Attach ports to each splitter
    for (const s of splitters) {
      const ports = await db('splitter_ports')
        .where({ splitter_id: s.id })
        .leftJoin('fiber_cores', 'fiber_cores.id', 'splitter_ports.output_core_id')
        .leftJoin('cables', 'cables.id', 'fiber_cores.cable_id')
        .select(
          'splitter_ports.id as port_id',
          'splitter_ports.port_number',
          'splitter_ports.status as port_status',
          'splitter_ports.notes as port_notes',
          'splitter_ports.output_core_id',
          'fiber_cores.id as core_id',
          'fiber_cores.core_number',
          'fiber_cores.status as core_status',
          'cables.code as cable_code',
          'cables.cable_type',
        )
        .orderBy('splitter_ports.port_number');
      s.ports = ports;
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
    const ports = await db('splitter_ports')
      .where({ splitter_id: req.params.id })
      .leftJoin('fiber_cores', 'fiber_cores.id', 'splitter_ports.output_core_id')
      .leftJoin('cables', 'cables.id', 'fiber_cores.cable_id')
      .select(
        'splitter_ports.id as port_id',
        'splitter_ports.port_number',
        'splitter_ports.status as port_status',
        'splitter_ports.notes',
        'splitter_ports.output_core_id',
        'fiber_cores.id as core_id',
        'fiber_cores.core_number',
        'fiber_cores.status as core_status',
        'cables.code as cable_code',
        'cables.cable_type',
      )
      .orderBy('splitter_ports.port_number');

    res.json({ ...splitter, ports });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/splitters
// Creates a 1:N splitter in an enclosure. Takes 1 input core and N output cores.
// The input core must be 'available' or 'reserved'. Output cores must be
// 'available'. On success the input flips to 'spliced' and outputs to 'spliced'.
// ---------------------------------------------------------------------------
router.post('/', validateSplitterData, async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const {
      enclosure_id,
      name,
      split_count = 4, // 2, 4, or 8
      input_core_id,
      output_core_ids, // Array of N core IDs
      splice_type = 'fusion',
      loss_db,
      technician,
      notes,
    } = req.body;

    if (!enclosure_id || !input_core_id) {
      await trx.rollback();
      return res.status(400).json({ error: 'enclosure_id and input_core_id are required' });
    }

    const validSplits = [2, 4, 8];
    if (!validSplits.includes(Number(split_count))) {
      await trx.rollback();
      return res.status(400).json({ error: 'split_count must be 2, 4, or 8' });
    }

// Lock input core
    const inputCore = await trx('fiber_cores').where({ id: input_core_id }).forUpdate().first();
    if (!inputCore) {
      await trx.rollback();
      return res.status(404).json({ error: 'Input core not found' });
    }
    // Allow spliced cores for branching (adding splitter to an already-spliced core)
    if (!['available', 'reserved', 'spliced'].includes(inputCore.status)) {
      await trx.rollback();
      return res.status(409).json({ error: 'Input core is not available to splice', status: inputCore.status });
    }

    // Output cores are NOT assigned at splitter creation time.
    // They will be assigned later when splicing the splitter ports to customer drops.
    // For now, we just create the splitter and its empty ports.
    const outputCores = [];

    // Create the splitter (convert empty loss_db to null for numeric column)
    const [splitter] = await trx('splitters')
      .insert({
        enclosure_id,
        name: name || `${input_core_id.slice(0, 6)}... ${split_count}-way splitter`,
        split_count,
        input_core_id,
        splice_type,
        loss_db: loss_db ? Number(loss_db) : null,
        technician: technician || null,
        notes: notes || null,
      })
      .returning('*');

    // Create N empty output ports (no cores assigned yet - they'll be assigned later)
    const portRows = Array.from({ length: Number(split_count) }, (_, index) => ({
      splitter_id: splitter.id,
      output_core_id: null,
      port_number: index + 1,
    }));
    await trx('splitter_ports').insert(portRows);

    // Mark input core as 'spliced' (it's connected to the splitter)
    await trx('fiber_cores').where({ id: input_core_id }).update({
      status: 'spliced',
      notes: notes ? `Splitter input: ${notes}` : `Splitter input (${split_count}-way)`,
      updated_at: trx.fn.now(),
    });

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

    if (port.output_core_id) {
      await trx.rollback();
      return res.status(409).json({ error: `Port ${port_number} already has a core assigned` });
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
      notes: `Splitter output port ${port_number}`,
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

    await trx('fiber_cores').where({ id: port.output_core_id }).update({
      status: 'available',
      notes: 'Unassigned from splitter',
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

// DELETE /api/splitters/:id — removes splitter and returns cores to available
router.delete('/:id', async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const splitter = await trx('splitters').where({ id: req.params.id }).first();
    if (!splitter) {
      await trx.rollback();
      return res.status(404).json({ error: 'Splitter not found' });
    }

    // Get all output ports (ignore empty ports — NULL core ids would end up in
    // the whereIn list otherwise)
    const ports = await trx('splitter_ports').where({ splitter_id: req.params.id });
    const outputCoreIds = ports.map((p) => p.output_core_id).filter(Boolean);

    // Return input core to available
    await trx('fiber_cores').where({ id: splitter.input_core_id }).update({
      status: 'available',
      notes: 'Splitter removed',
      updated_at: trx.fn.now(),
    });

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