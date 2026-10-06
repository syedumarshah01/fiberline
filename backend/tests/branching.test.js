const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { canBranchFromCore } = require('../src/utils/branching');

describe('canBranchFromCore', () => {
  test('allows only an explicitly spare IN core to start a new branch', () => {
    assert.equal(canBranchFromCore({ id: 'free', status: 'spare' }), true);
    assert.equal(canBranchFromCore({ id: 'reserved', status: 'reserved' }), false);
    assert.equal(canBranchFromCore({ id: 'unknown', status: 'unknown' }), false);
  });

  test('allows an in-use core when it is coming into this enclosure from upstream', () => {
    assert.equal(
      canBranchFromCore(
        { id: 'used-in', status: 'in_use' },
        { cable: { from_enclosure_id: 'upstream', to_enclosure_id: 'joint' }, enclosureId: 'joint' },
      ),
      true,
    );
  });

  test('does not allow a second branch from the same core in this box', () => {
    assert.equal(
      canBranchFromCore(
        { id: 'used-twice', status: 'in_use' },
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
        { id: 'used-out', status: 'in_use' },
        { cable: { from_enclosure_id: 'joint', to_enclosure_id: 'downstream' }, enclosureId: 'joint' },
      ),
      false,
    );
    assert.equal(
      canBranchFromCore(
        { id: 'used-elsewhere', status: 'in_use' },
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
