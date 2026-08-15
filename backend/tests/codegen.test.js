const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { nextCode, normalizeEditableCode } = require('../src/utils/codegen');

describe('nextCode (anonymous pole codes)', () => {
  it('starts the series when no poles exist', () => {
    assert.equal(nextCode([], 'POLE-'), 'POLE-0001');
    assert.equal(nextCode(null, 'POLE-'), 'POLE-0001');
  });

  it('continues past the highest existing number', () => {
    assert.equal(nextCode(['POLE-0001', 'POLE-0009', 'POLE-0002'], 'POLE-'), 'POLE-0010');
  });

  it('ignores codes from other families', () => {
    assert.equal(nextCode(['BOX-0042', 'CUST-BOX-0007', 'POLE-0003'], 'POLE-'), 'POLE-0004');
  });

  it('ignores codes without a trailing number', () => {
    assert.equal(nextCode(['MAIN-FEED'], 'POLE-'), 'POLE-0001');
  });
});

describe('normalizeEditableCode (user-typed cable/box codes)', () => {
  it('trims surrounding whitespace', () => {
    assert.equal(normalizeEditableCode('  CBL-0007 '), 'CBL-0007');
  });

  it('rejects empty and whitespace-only strings', () => {
    assert.equal(normalizeEditableCode(''), null);
    assert.equal(normalizeEditableCode('   '), null);
  });

  it('rejects non-strings', () => {
    assert.equal(normalizeEditableCode(42), null);
    assert.equal(normalizeEditableCode(null), null);
    assert.equal(normalizeEditableCode(undefined), null);
    assert.equal(normalizeEditableCode({}), null);
  });
});
