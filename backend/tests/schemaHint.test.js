/**
 * Migration hints: a missing column must read as "run npm run migrate", not as
 * a bare Postgres undefined_column error, and nothing else may be swallowed.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { migrationHint } = require('../src/utils/schemaHint');

const HINT = {
  column: 'continues_cable_id',
  migration: 'migration 20260101000014_cable_continuations.js',
  feature: 'Failure simulation',
};

describe('migrationHint', () => {
  test('rewrites a missing-column error into instructions', () => {
    const err = Object.assign(new Error('column c.continues_cable_id does not exist'), {
      code: '42703',
    });
    const hinted = migrationHint(err, HINT);

    assert.notEqual(hinted, err);
    assert.match(hinted.message, /Failure simulation needs the continues_cable_id column/);
    assert.match(hinted.message, /npm run migrate/);
    assert.match(hinted.message, /20260101000014/);
    assert.equal(hinted.status, 503); // the schema is behind, the app is fine
    assert.equal(hinted.cause, err); // the original is kept for the log
  });

  test('works without a driver error code (text match when the driver is silent)', () => {
    const hinted = migrationHint(
      new Error('ERROR: column continues_cable_id does not exist'),
      HINT,
    );
    assert.match(hinted.message, /npm run migrate/);
  });

  test('leaves every other database error exactly as it was', () => {
    const cases = [
      Object.assign(new Error('relation "cables" does not exist'), { code: '42P01' }),
      new Error('invalid input syntax for type uuid: "abc"'),
      new Error('connection terminated unexpectedly'),
      new Error('column c.code does not exist'),
    ];
    for (const err of cases) {
      assert.equal(migrationHint(err, HINT), err, err.message);
    }
    assert.equal(migrationHint(null, HINT), null);
  });
});
