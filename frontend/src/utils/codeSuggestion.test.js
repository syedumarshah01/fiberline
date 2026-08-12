/**
 * Unit tests for the inventory code auto-suggestion utility.
 * Run with: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCode, nearestWithCode, suggestCode } from './codeSuggestion.js';

describe('parseCode', () => {
  it('splits prefix and number', () => {
    assert.deepEqual(parseCode('POLE-0042'), { prefix: 'POLE-', num: 42, width: 4 });
    assert.deepEqual(parseCode('CBL-7'), { prefix: 'CBL-', num: 7, width: 1 });
  });

  it('returns null for codes without a trailing number', () => {
    assert.equal(parseCode('POLE-'), null);
    assert.equal(parseCode(''), null);
    assert.equal(parseCode(null), null);
  });
});

describe('nearestWithCode', () => {
  const items = [
    { code: 'POLE-0001', lat: 34.0, lng: 71.5 },
    { code: 'HUT-0002', lat: 34.001, lng: 71.501 }, // ~140 m from the point below
    { code: 'POLE-0003', lat: 34.2, lng: 71.7 },
  ];

  it('finds the closest item with a code', () => {
    const near = nearestWithCode(items, { lat: 34.0008, lng: 71.5008 });
    assert.equal(near.code, 'HUT-0002');
  });

  it('returns null without a point', () => {
    assert.equal(nearestWithCode(items, null), null);
  });
});

describe('suggestCode', () => {
  it('starts a fresh series when inventory is empty', () => {
    assert.equal(suggestCode([], 'POLE-'), 'POLE-0001');
  });

  it('continues the highest numbering family', () => {
    assert.equal(suggestCode(['POLE-0001', 'POLE-0009', 'POLE-0002'], 'POLE-'), 'POLE-0010');
  });

  it('keeps zero-padding of the existing series', () => {
    assert.equal(suggestCode(['CBL-0001'], 'CBL-'), 'CBL-0002');
    assert.equal(suggestCode(['CBL-7'], 'CBL-'), 'CBL-0008');
  });

  it('ignores codes that carry no number', () => {
    assert.equal(suggestCode(['MAIN-FEED'], 'CBL-'), 'CBL-0001');
  });

  it("prefers the nearby asset's numbering family", () => {
    const codes = ['POLE-0009', 'HUT-0002'];
    const near = { code: 'HUT-0002' };
    assert.equal(suggestCode(codes, 'POLE-', near), 'HUT-0003');
  });

  it('falls back to the highest family if the nearby code family is unused elsewhere', () => {
    const codes = ['POLE-0009'];
    const near = { code: 'ODD-0003' }; // family not present in the inventory list
    assert.equal(suggestCode(codes, 'POLE-', near), 'POLE-0010');
  });
});
