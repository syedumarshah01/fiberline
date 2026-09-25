/**
 * Service-level tests for buildLossBudget with a stubbed db module: the trace
 * runs, cable length/attenuation is merged in, splitter crossings (port side
 * and cascade parents) are discovered, and the project settings row is
 * created lazily on first use.
 *
 * Fixture network (a small cascaded PON):
 *
 *   FX (feeder C-F core 2) ── input of SP1 (1:8, box B1)
 *                                │ port 2 feeds SP2 (cascade)
 *   FC1 (feeder C-F, 1000 m)     │            DC1 (distribution C-D, 2000 m)   PC1 (drop C-P, 500 m)
 *        │                       └──────────────┤ output port of SP2 (1:2, B3)      │
 *        └──── S1 fusion 0.12 dB ───────────────┴──── S2 mechanical (no reading) ───┘
 *
 * SP1's input core (FX) is deliberately NOT part of the spliced path, so the
 * only way the budget can know about SP1 is the cascade-parent walk.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// --- in-memory fixture --------------------------------------------------------

const CORES = {
  // Trace rows (no loss data — the service must enrich them from `cables`).
  FC1: { core_id: 'FC1', core_number: 1, core_status: 'spliced', cable_id: 'CF', cable_code: 'C-F', cable_type: 'feeder' },
  FX: { core_id: 'FX', core_number: 2, core_status: 'spliced', cable_id: 'CF', cable_code: 'C-F', cable_type: 'feeder' },
  DC1: { core_id: 'DC1', core_number: 1, core_status: 'spliced', cable_id: 'CD', cable_code: 'C-D', cable_type: 'distribution' },
  PC1: { core_id: 'PC1', core_number: 1, core_status: 'terminated', cable_id: 'CP', cable_code: 'C-P', cable_type: 'drop' },
};
const SPLICES = [
  { id: 'S1', enclosure_id: 'B1', splice_type: 'fusion', core_a_id: 'FC1', core_b_id: 'DC1', loss_db: '0.12', splice_date: '2026-01-01', created_at: '1' },
  { id: 'S2', enclosure_id: 'B2', splice_type: 'mechanical', core_a_id: 'DC1', core_b_id: 'PC1', loss_db: null, splice_date: '2026-01-02', created_at: '2' },
];
const CABLES = [
  { id: 'CF', length_m: 1000, attenuation_db_per_km: null }, // default 0.35
  { id: 'CD', length_m: 2000, attenuation_db_per_km: '0.40' }, // pg decimal string
  { id: 'CP', length_m: 500, attenuation_db_per_km: null },
];
const SPLITTERS = [
  { id: 'SP1', enclosure_id: 'B1', name: null, split_count: 8, loss_db: null, input_core_id: 'FX' },
  { id: 'SP2', enclosure_id: 'B3', name: null, split_count: 2, loss_db: null, input_core_id: null },
];
const SPLITTER_PORTS = [
  { splitter_id: 'SP1', port_number: 1, output_core_id: null, output_splitter_id: null },
  { splitter_id: 'SP1', port_number: 2, output_core_id: null, output_splitter_id: 'SP2' }, // cascade feed
  { splitter_id: 'SP2', port_number: 1, output_core_id: 'DC1', output_splitter_id: null },
];
// Lazily created by the service on first read (starts missing on purpose).
let SETTINGS_ROW = null;

// --- knex-shaped stub -----------------------------------------------------------

function run(q) {
  switch (q.table) {
    case 'fiber_cores as fc':
      return CORES[q.coreId] || null;
    case 'splices':
      return SPLICES.filter((s) => s.core_a_id === q.coreId || s.core_b_id === q.coreId);
    case 'cables':
      return CABLES.filter((c) => (q.whereInVals || []).includes(c.id));
    case 'splitters':
      return SPLITTERS.filter((s) => (q.whereInVals || []).includes(s.input_core_id));
    case 'splitter_ports as sp': {
      const ports = q.whereInCol === 'sp.output_core_id'
        ? SPLITTER_PORTS.filter((p) => p.output_core_id && q.whereInVals.includes(p.output_core_id))
        : SPLITTER_PORTS.filter((p) => p.output_splitter_id && q.whereInVals.includes(p.output_splitter_id));
      return ports.map((p) => {
        const splitter = SPLITTERS.find((s) => s.id === p.splitter_id);
        return q.whereInCol === 'sp.output_core_id'
          ? { ...splitter, port_number: p.port_number, output_core_id: p.output_core_id }
          : { ...splitter, child_id: p.output_splitter_id };
      });
    }
    case 'project_settings':
      if (q.insertRow) {
        SETTINGS_ROW = { id: 'PS1', olt_type: 'gpon', budget_db: null, safety_margin_db: null };
        return [SETTINGS_ROW];
      }
      return SETTINGS_ROW ? [SETTINGS_ROW] : [];
    default:
      throw new Error(`unexpected table ${q.table}`);
  }
}

function fakeDb(table) {
  const q = { table };
  const b = {
    join: () => b,
    where(colOrFn, val) {
      if (typeof colOrFn === 'function') {
        const ctx = {
          where: (_c, v) => { q.coreId = v; return ctx; },
          orWhere: (_c, v) => { q.coreId = v; return ctx; },
        };
        colOrFn.call(ctx);
      } else {
        q.coreId = val;
      }
      return b;
    },
    whereIn: (col, vals) => { q.whereInCol = col; q.whereInVals = vals; return b; },
    select: () => b,
    orderBy: () => b,
    returning: () => b,
    insert: (row) => { q.insertRow = row; return b; },
    first: () => Promise.resolve(Array.isArray(run(q)) ? run(q)[0] || null : run(q)),
    then: (onFulfilled, onRejected) => Promise.resolve(run(q)).then(onFulfilled, onRejected),
  };
  return b;
}

// The trace behind the budget opens by asking the schema probe which columns
// this database has (there are no mid-span splits in this fixture network).
fakeDb.raw = async (sql) => {
  if (isSchemaProbe(sql)) return schemaProbeRows(true);
  throw new Error(`unexpected raw query in test stub: ${sql}`);
};

// Stub ../src/db in the require cache BEFORE loading the service.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const { isSchemaProbe, schemaProbeRows } = require('./helpers/schema');
const { resetSchemaCache } = require('../src/utils/schemaCapabilities');
beforeEach(() => resetSchemaCache());
const { buildLossBudget } = require('../src/services/lossBudget');

// Both directions must add up to the same total:
//   fiber 0.35 + splice 0.12 + splitters (3.6 + 10.5) + fiber 0.8 + splice 0.3 + fiber 0.18
//   = 15.85 dB against a 28 dB GPON Class B+ budget.
const EXPECTED_TOTAL = 15.85;

describe('buildLossBudget (stubbed db)', () => {
  test('tracing downstream: enriches lengths, finds port + cascade crossings, lazy-creates settings', async () => {
    const budget = await buildLossBudget('FC1');
    assert.deepEqual(
      budget.breakdown.map((e) => e.type),
      ['fiber', 'splice', 'splitter', 'splitter', 'fiber', 'splice', 'fiber'],
    );
    assert.equal(budget.total_loss_db, EXPECTED_TOTAL);
    assert.equal(budget.olt_type, 'gpon'); // from the lazily created settings row
    assert.equal(budget.budget_db, 28);
    assert.equal(budget.margin_db, 12.15);
    assert.equal(budget.status, 'OK');

    // The measured splice reading is used as-is; the mechanical one defaults.
    const s1 = budget.breakdown.find((e) => e.splice_id === 'S1');
    assert.equal(s1.loss_db, 0.12);
    assert.equal(s1.measured, true);
    const s2 = budget.breakdown.find((e) => e.splice_id === 'S2');
    assert.equal(s2.loss_db, 0.3);
    assert.equal(s2.measured, false);

    // Fiber math: null attenuation fell back to 0.35, the 0.40 override won on C-D.
    const fc1 = budget.breakdown.find((e) => e.cable_code === 'C-F');
    assert.equal(fc1.loss_db, 0.35);
    assert.equal(fc1.attenuation_defaulted, true);
    const dc1 = budget.breakdown.find((e) => e.cable_code === 'C-D');
    assert.equal(dc1.loss_db, 0.8);
    assert.equal(dc1.attenuation_defaulted, false);

    // The cascade parent SP1 (input core FX is OFF the traced path) is found
    // via the parent walk and counted exactly once.
    const splitterIds = budget.breakdown.filter((e) => e.type === 'splitter').map((e) => e.splitter_id);
    assert.deepEqual(splitterIds, ['SP2', 'SP1']);
  });

  test('tracing upstream: same path in reverse, same crossings, same total', async () => {
    const budget = await buildLossBudget('PC1');
    assert.deepEqual(
      budget.breakdown.map((e) => e.type),
      ['fiber', 'splice', 'splitter', 'splitter', 'fiber', 'splice', 'fiber'],
    );
    const splitterIds = budget.breakdown.filter((e) => e.type === 'splitter').map((e) => e.splitter_id);
    assert.deepEqual(splitterIds, ['SP2', 'SP1']);
    assert.equal(budget.total_loss_db, EXPECTED_TOTAL);
    assert.deepEqual(
      budget.breakdown.map((e) => e.running_db),
      [0.18, 0.48, 4.08, 14.58, 15.38, 15.5, 15.85],
    );
  });

  test('olt_type override changes the budget constant for this calculation', async () => {
    const budget = await buildLossBudget('PC1', { olt_type: 'xgs_pon' });
    assert.equal(budget.budget_db, 29);
    assert.equal(budget.margin_db, 13.15);
  });
});
