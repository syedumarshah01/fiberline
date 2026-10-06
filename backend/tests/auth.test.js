const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateUsername,
  passwordPolicy,
  hashPassword,
  verifyPassword,
  requireAuth,
  requireAdmin,
} = require('../src/services/auth');

describe('authentication policy', () => {
  test('normalizes and validates account names', () => {
    assert.equal(validateUsername('  Field.Tech '), 'field.tech');
    assert.equal(validateUsername('ab'), null);
    assert.equal(validateUsername('not valid'), null);
  });

  test('requires a strong enough password without imposing a composition guess', () => {
    assert.match(passwordPolicy('short') || '', /12/);
    assert.equal(passwordPolicy('correct horse battery staple'), null);
  });

  test('hashes passwords with a salted verifier and rejects wrong passwords', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    assert.match(encoded, /^scrypt\$/);
    assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
    assert.equal(await verifyPassword('wrong password entirely', encoded), false);
  });

  test('requires a logged-in user and specifically an admin for review', () => {
    const response = () => {
      const result = {};
      return {
        status(code) { result.status = code; return this; },
        json(body) { result.body = body; return result; },
        result,
      };
    };
    const unauthenticated = response();
    requireAuth({}, unauthenticated);
    assert.equal(unauthenticated.result.status, 401);

    const technician = response();
    requireAdmin({ user: { role: 'technician' } }, technician);
    assert.equal(technician.result.status, 403);

    let called = false;
    requireAdmin({ user: { id: 'admin-1', role: 'admin' } }, technician, () => { called = true; });
    assert.equal(called, true);
  });
});
