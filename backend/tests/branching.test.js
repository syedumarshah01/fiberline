const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { canBranchFromCore } = require('../src/utils/branching');

describe('canBranchFromCore', () => {
  test('allows a free or reserved IN core to start one branch', () => {
    assert.equal(canBranchFromCore({ id: 'free', status: 'available' }), true);
    assert.equal(canBranchFromCore({ id: 'reserved', status: 'reserved' }), true);
  });

  test('allows a spliced core when it is coming into this enclosure from upstream', () => {
    assert.equal(
      canBranchFromCore(
        { id: 'used-in', status: 'spliced' },
        { cable: { from_enclosure_id: 'upstream', to_enclosure_id: 'joint' }, enclosureId: 'joint' },
      ),
      true,
    );
  });

  test('does not allow a second branch from the same core in this box', () => {
    assert.equal(
      canBranchFromCore(
        { id: 'used-twice', status: 'spliced' },
        {
          cable: { from_enclosure_id: 'upstream', to_enclosure_id: 'joint' },
          enclosureId: 'joint',
          alreadyBranched: true,
        },
      ),
      false,
    );
  });

  test('does not allow a spliced OUT core or a spliced core from another box', () => {
    assert.equal(
      canBranchFromCore(
        { id: 'used-out', status: 'spliced' },
        { cable: { from_enclosure_id: 'joint', to_enclosure_id: 'downstream' }, enclosureId: 'joint' },
      ),
      false,
    );
    assert.equal(
      canBranchFromCore(
        { id: 'used-elsewhere', status: 'spliced' },
        { cable: { from_enclosure_id: 'upstream', to_enclosure_id: 'other-joint' }, enclosureId: 'joint' },
      ),
      false,
    );
  });

  test('does not treat missing or damaged cores as branchable', () => {
    assert.equal(canBranchFromCore(null), false);
    assert.equal(canBranchFromCore({ id: 'damaged', status: 'damaged' }), false);
  });
});
