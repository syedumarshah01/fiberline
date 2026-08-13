/**
 * Unit tests for the splice pairing helpers used by the visual documentation.
 * Run with: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PAIR_COLORS, pairTag, pairColor, splicePairsByCore } from './spliceWiring.js';

describe('pairTag', () => {
  it('is 1-based and stable', () => {
    assert.equal(pairTag(0), 'S1');
    assert.equal(pairTag(4), 'S5');
  });
});

describe('pairColor', () => {
  it('cycles through the palette', () => {
    assert.equal(pairColor(0), PAIR_COLORS[0]);
    assert.equal(pairColor(PAIR_COLORS.length), PAIR_COLORS[0]);
    assert.equal(pairColor(PAIR_COLORS.length + 2), PAIR_COLORS[2]);
  });
});

describe('splicePairsByCore', () => {
  it('maps both endpoint cores to the same tag and color', () => {
    const splices = [
      { id: 'x', core_a_id: 'a1', core_b_id: 'b1' },
      { id: 'y', core_a_id: 'a2', core_b_id: 'b2' },
    ];
    const m = splicePairsByCore(splices);
    assert.equal(m.get('a1').tag, 'S1');
    assert.equal(m.get('b1').tag, 'S1');
    assert.equal(m.get('a1').color, m.get('b1').color);
    assert.equal(m.get('a2').tag, 'S2');
    assert.notEqual(m.get('a1').color, m.get('a2').color);
  });

  it('keeps the first pair when a core is chained into several splices', () => {
    const splices = [
      { id: 'x', core_a_id: 'a1', core_b_id: 'b1' },
      { id: 'y', core_a_id: 'a1', core_b_id: 'b9' }, // branch off the same core
    ];
    const m = splicePairsByCore(splices);
    assert.equal(m.get('a1').tag, 'S1');
    assert.equal(m.get('b9').tag, 'S2');
  });

  it('handles empty and missing input', () => {
    assert.equal(splicePairsByCore([]).size, 0);
    assert.equal(splicePairsByCore(null).size, 0);
    assert.equal(splicePairsByCore(undefined).size, 0);
  });
});
