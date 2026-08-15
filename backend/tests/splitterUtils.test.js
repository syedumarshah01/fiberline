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
