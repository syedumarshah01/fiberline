const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { makeBoxRevision, stableStringify } = require('../src/services/boxRevision');

describe('box documentation revisions', () => {
  const base = {
    enclosure: { id: 'box-1', updated_at: '2026-09-29T10:00:00Z' },
    cables: [{ id: 'cable-1', updated_at: '2026-09-29T10:00:00Z' }],
    cores: [{ id: 'core-1', cable_id: 'cable-1', core_number: 1, status: 'available', updated_at: '2026-09-29T10:00:00Z' }],
    splices: [],
    splitters: [],
    ports: [],
  };

  test('is deterministic when object key order changes', () => {
    const a = makeBoxRevision(base);
    const b = makeBoxRevision({
      ...base,
      enclosure: { updated_at: '2026-09-29T10:00:00Z', id: 'box-1' },
    });
    assert.equal(a, b);
    assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
    assert.notEqual(stableStringify(new Date('2026-09-29T10:00:00Z')), stableStringify(new Date('2026-09-29T10:01:00Z')));
  });

  test('changes when another technician edits a documented record', () => {
    const before = makeBoxRevision(base);
    const after = makeBoxRevision({
      ...base,
      cores: [{ ...base.cores[0], status: 'spliced', updated_at: '2026-09-29T10:01:00Z' }],
    });
    assert.notEqual(before, after);
  });

  test('connector inventory changes are included in the documentation revision', () => {
    const before = makeBoxRevision({ ...base, enclosure: { ...base.enclosure, connector_count_in: null, connector_count_out: null } });
    const after = makeBoxRevision({ ...base, enclosure: { ...base.enclosure, connector_count_in: 2, connector_count_out: null } });
    assert.notEqual(before, after);
  });

  test('changes when a splice or splitter port is added', () => {
    const before = makeBoxRevision(base);
    const afterSplice = makeBoxRevision({
      ...base,
      splices: [{ id: 'splice-1', core_a_id: 'core-1', core_b_id: 'core-2', updated_at: '2026-09-29T10:01:00Z' }],
    });
    const afterPort = makeBoxRevision({
      ...base,
      splitters: [{ id: 'splitter-1', input_core_id: 'core-1', updated_at: '2026-09-29T10:01:00Z' }],
      ports: [{ id: 'port-1', splitter_id: 'splitter-1', port_number: 1, status: 'active', updated_at: '2026-09-29T10:01:00Z' }],
    });
    assert.notEqual(before, afterSplice);
    assert.notEqual(before, afterPort);
  });
});
