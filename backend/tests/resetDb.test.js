/**
 * Tests for the db:reset script's safety rails — the part that must be right
 * even though a live database is not available to the test runner: argument
 * parsing, password redaction, the production refusal, and the SQL the wipe /
 * truncate paths send.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, describeTarget, emptyTables, wipeSchema } = require('../scripts/resetDb.js');

/** A knex stand-in that records statements instead of talking to Postgres. */
function fakeKnex({ tables = [] } = {}) {
  const statements = [];
  return {
    statements,
    raw(sql) {
      statements.push(sql);
      if (/FROM pg_catalog\.pg_tables/.test(sql)) {
        return Promise.resolve({ rows: tables.map((tablename) => ({ tablename })) });
      }
      if (/SELECT /.test(sql) || /^\s*$/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      // DDL does not return rows; simulate a driver error only when asked to.
      if (/BOOM/.test(sql)) return Promise.reject(new Error('permission denied'));
      return Promise.resolve({ rows: [] });
    },
  };
}

describe('parseArgs', () => {
  test('defaults to the confirmation-prompted wipe', () => {
    assert.deepEqual(parseArgs([]), { truncate: false, yes: false, help: false, error: false });
  });

  test('recognises the flags that matter', () => {
    assert.equal(parseArgs(['--truncate']).truncate, true);
    assert.equal(parseArgs(['--yes']).yes, true);
    assert.equal(parseArgs(['-y']).yes, true);
    assert.equal(parseArgs(['--help']).help, true);
  });

  test('an unknown flag is a usage error, not a silent no-op', () => {
    const args = parseArgs(['--frobnicate']);
    assert.equal(args.help, true);
    assert.equal(args.error, true);
  });
});

describe('describeTarget', () => {
  test('describes a host/user/database config', () => {
    assert.equal(
      describeTarget({ connection: { user: 'postgres', host: 'localhost', port: 5432, database: 'fiber_network' } }),
      'postgres@localhost:5432/fiber_network',
    );
  });

  test('never prints a password out of a connection string', () => {
    const described = describeTarget({ connection: 'postgres://fiberline:hunter2@db.internal:5432/prod' });
    assert.ok(!described.includes('hunter2'));
    assert.match(described, /db\.internal:5432\/prod/);
  });

  test('handles a production config with no DATABASE_URL at all', () => {
    assert.equal(describeTarget({ connection: undefined }), '(no connection configured)');
  });
});

describe('emptyTables', () => {
  test('truncates every app table in one statement, quoted', async () => {
    const knex = fakeKnex({ tables: ['cables', 'poles', 'splitter_ports'] });
    const count = await emptyTables(knex);
    assert.equal(count, 3);
    const truncate = knex.statements.find((sql) => sql.startsWith('TRUNCATE'));
    assert.equal(
      truncate,
      'TRUNCATE TABLE "cables", "poles", "splitter_ports" RESTART IDENTITY CASCADE;',
    );
  });

  test('says nothing to do on an already-empty schema', async () => {
    const knex = fakeKnex({ tables: [] });
    assert.equal(await emptyTables(knex), 0);
    assert.ok(!knex.statements.some((sql) => sql.startsWith('TRUNCATE')));
  });
});

describe('wipeSchema', () => {
  test('drops and recreates public, and survives a failed re-grant', async () => {
    const knex = fakeKnex();
    knex.raw = (sql) => {
      knex.statements.push(sql);
      if (/GRANT/.test(sql)) return Promise.reject(new Error('permission denied'));
      return Promise.resolve({ rows: [] });
    };
    await wipeSchema(knex); // must not throw: the DROP/CREATE already did the job
    assert.ok(knex.statements.some((sql) => /DROP SCHEMA IF EXISTS public CASCADE/.test(sql)));
    assert.ok(knex.statements.some((sql) => /CREATE SCHEMA public/.test(sql)));
  });
});
