const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { canBranchFromCore } = require('../src/utils/branching');

describe('canBranchFromCore', () => {
  test('allows a free or reserved IN core to start one branch', () => {
    assert.equal(canBranchFromCore({ id: 'free', status: 'available' }), true);
    assert.equal(canBranchFromCore({ id: 'reserved', status: 'reserved' }), true);
  });

  test('does not allow an already-spliced IN core to start another branch', () => {
    assert.equal(canBranchFromCore({ id: 'used', status: 'spliced' }), false);
  });

  test('does not treat missing or damaged cores as branchable', () => {
    assert.equal(canBranchFromCore(null), false);
    assert.equal(canBranchFromCore({ id: 'damaged', status: 'damaged' }), false);
  });
});
