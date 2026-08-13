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
