const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PENDING,
  APPROVED,
  REJECTED,
  actorFromRequest,
  requireAdmin,
  revisionForSnapshot,
} = require('../src/services/asBuiltApproval');

describe('as-built approval policy', () => {
  test('field submissions default to a technician identity', () => {
    const actor = actorFromRequest({ get: () => undefined, body: {} });
    assert.deepEqual(actor, { id: 'field-tech', role: 'technician' });
  });

  test('uses authenticated/header identity when supplied', () => {
    const actor = actorFromRequest({
      user: { id: 'tech-7', role: 'technician' },
      get: () => undefined,
      body: {},
    });
    assert.deepEqual(actor, { id: 'tech-7', role: 'technician' });
  });

  test('only an admin reviewer can approve or reject', () => {
    assert.equal(requireAdmin({ get: (name) => name === 'x-user-role' ? 'ADMIN' : 'reviewer-1' }).role, 'admin');
    assert.throws(
      () => requireAdmin({ get: () => 'technician' }),
      (error) => error.status === 403 && error.code === 'APPROVAL_ADMIN_REQUIRED',
    );
  });

  test('approval status names and snapshot revisions are stable', () => {
    assert.deepEqual([PENDING, APPROVED, REJECTED], ['pending', 'approved', 'rejected']);
    const snapshot = {
      enclosure: { id: 'box-1', updated_at: '2026-09-30T08:00:00Z' },
      cables: [], cores: [], splices: [], splitters: [], ports: [],
    };
    assert.equal(revisionForSnapshot(snapshot), revisionForSnapshot(JSON.parse(JSON.stringify(snapshot))));
  });
});
