/**
 * Schema capabilities: the app asks the database what it has before using a
 * newer column, so pulling code without running the migration degrades one
 * feature instead of 503-ing it.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  probe,
  schemaCapabilities,
  asArray,
  hasContinuationLinks,
  migrationWarning,
  resetSchemaCache,
  connectionTarget,
} = require('../src/utils/schemaCapabilities');

/** A stub standing in for knex.raw. */
function stubExecutor({ rows, error = null, onQuery } = {}) {
  return {
    raw: async (sql) => {
      if (onQuery) onQuery(sql);
      if (error) throw error;
      return { rows };
    },
  };
}

const ROW_WITH_COLUMN = {
  database: 'fiber_network',
  has_cables: true,
  columns: ['continues_cable_id'],
};
const ROW_WITHOUT_COLUMN = { database: 'fiber_network', has_cables: true, columns: [] };
const ROW_UNMIGRATED = { database: 'fiber_network', has_cables: false, columns: [] };

beforeEach(() => resetSchemaCache());

describe('probe', () => {
  test('reports the column as present when the database has it', async () => {
    const result = await probe(stubExecutor({ rows: [ROW_WITH_COLUMN] }));
    assert.equal(result.columns.continues_cable_id, true);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.database, 'fiber_network');
  });

  test('reports the column as missing — as a notice, since the app works around it', async () => {
    const result = await probe(stubExecutor({ rows: [ROW_WITHOUT_COLUMN] }));
    assert.equal(result.columns.continues_cable_id, false);
    assert.equal(result.gaps.length, 1);

    const gap = result.gaps[0];
    // The feature is not off: the links are inferred from cable naming.
    assert.match(gap.message, /inferred from cable naming/);
    assert.equal(gap.severity, 'notice', 'a workaround, not a broken feature');
    // …and the advice works on a database whose ledger already lists migration
    // 14, where "run migrate" would do nothing. The diagnostic knows the ledger.
    assert.match(gap.message, /npm run db:schema/);
    // And it says why the API's own startup pass has not already fixed it, since
    // that pass is the first thing anyone would ask about.
    assert.match(gap.message, /applies pending migrations/);
    assert.match(gap.message, /SCHEMA_BOOTSTRAP/);
    assert.doesNotMatch(gap.message, /apply 20260101000014/);
  });

  test('the notice is not phrased as a failure', async () => {
    const result = await probe(stubExecutor({ rows: [ROW_WITHOUT_COLUMN] }));
    assert.doesNotMatch(result.gaps[0].message, /are off/);
    assert.doesNotMatch(result.gaps[0].message, /stops at an inserted closure/);
  });

  test('a database with no tables says "nothing has been migrated", not "column missing"', async () => {
    const result = await probe(stubExecutor({ rows: [ROW_UNMIGRATED] }));
    assert.equal(result.has_cables, false);
    assert.equal(result.columns.continues_cable_id, false);
    assert.match(result.gaps[0].message, /no "cables" table/);
    assert.match(result.gaps[0].message, /npm run migrate/);
    assert.equal(result.gaps.length, 1, 'one clear message, not one per column');
  });

  test('a database that has the table but not the column reports the migration', async () => {
    const result = await probe(stubExecutor({ rows: [ROW_WITHOUT_COLUMN] }));
    assert.equal(result.has_cables, true);
    assert.match(result.gaps[0].message, /20260101000014/);
  });

  test('a connection failure is raised, not mistaken for a missing column', async () => {
    await assert.rejects(
      () => probe(stubExecutor({ error: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })),
      /ECONNREFUSED/,
    );
  });

  test('asks once and caches until it is told to refresh', async () => {
    let queries = 0;
    const executor = stubExecutor({ rows: [ROW_WITH_COLUMN], onQuery: () => { queries += 1; } });

    await schemaCapabilities({ executor });
    await schemaCapabilities({ executor });
    assert.equal(queries, 1, 'the second call should use the cache');

    await schemaCapabilities({ executor, refresh: true });
    assert.equal(queries, 2);
  });

  test('re-checks after the cache TTL so a live server notices a migration', async () => {
    let queries = 0;
    const executor = stubExecutor({ rows: [ROW_WITH_COLUMN], onQuery: () => { queries += 1; } });

    await schemaCapabilities({ executor, ttlMs: 0 });
    await schemaCapabilities({ executor, ttlMs: 0 });
    assert.equal(queries, 2, 'ttl 0 means never serve a stale answer');
  });
});

describe('convenience helpers', () => {
  test('hasContinuationLinks mirrors the probe', async () => {
    assert.equal(await hasContinuationLinks({ executor: stubExecutor({ rows: [ROW_WITH_COLUMN] }) }), true);
    resetSchemaCache();
    assert.equal(await hasContinuationLinks({ executor: stubExecutor({ rows: [] }) }), false);
  });

  test('migrationWarning is null when there is nothing to warn about', async () => {
    assert.equal(await migrationWarning({ executor: stubExecutor({ rows: [ROW_WITH_COLUMN] }) }), null);
    resetSchemaCache();
    assert.match(await migrationWarning({ executor: stubExecutor({ rows: [] }) }), /continues_cable_id/);
  });
});

describe('connectionTarget', () => {
  test('never includes a password', () => {
    const previous = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgres://app:sup3rs3cret@db.internal:5432/fiber';
      // The knexfile is required lazily, but may already be in the cache with
      // the development config from another test — drop it so the environment
      // above is what it reads.
      delete require.cache[require.resolve('../knexfile')];
      const target = connectionTarget();
      assert.equal(target, 'db.internal:5432/fiber'.replace('/fiber', '/fiber'));
      assert.ok(!target.includes('sup3rs3cret'), 'the password must not leak into a log line');
    } finally {
      process.env = previous;
      delete require.cache[require.resolve('../knexfile')];
    }
  });
});

describe('how the probe reads the column list', () => {
  // The bug this exists for: `array_agg(column_name)` over
  // information_schema.sql_identifier (a domain over name) comes back from
  // node-postgres as the *string* '{continues_cable_id}' — its array type has no
  // parser. `new Set('{continues_cable_id}')` is a set of characters, so
  // has('continues_cable_id') was false and the app decided a column that
  // existed did not. It inferred links it should have read, and warned about a
  // missing column on every database that had one.
  test('a Postgres array literal is read as a list, not as its characters', () => {
    assert.deepEqual(asArray('{continues_cable_id}'), ['continues_cable_id']);
    assert.equal(new Set(asArray('{continues_cable_id}')).has('continues_cable_id'), true);
  });

  test('an already-parsed array passes through', () => {
    assert.deepEqual(asArray(['a', 'b']), ['a', 'b']);
  });

  test('the empty literal, an empty array, and nothing at all are all empty', () => {
    assert.deepEqual(asArray('{}'), []);
    assert.deepEqual(asArray('{ }'), []);
    assert.deepEqual(asArray([]), []);
    assert.deepEqual(asArray(null), []);
    assert.deepEqual(asArray(undefined), []);
    assert.deepEqual(asArray(42), []);
  });

  test('quoted and escaped names survive', () => {
    assert.deepEqual(asArray('{"odd name","quote\\"d","plain"}'), ['odd name', 'quote"d', 'plain']);
  });

  test('a probe answer that arrives as the literal still counts as present', async () => {
    // The exact row a real database produced before the SQL was cast: the column
    // is there, spelled as Postgres spells arrays.
    const capabilities = await schemaCapabilities({
      refresh: true,
      executor: stubExecutor({
        rows: [{ database: 'fiber_network', has_cables: true, columns: '{continues_cable_id}' }],
      }),
    });
    assert.equal(capabilities.columns.continues_cable_id, true);
    assert.deepEqual(capabilities.gaps, []);
  });

  test('and the SQL asks for text, so the driver parses it in the first place', async () => {
    let sql = null;
    await schemaCapabilities({
      refresh: true,
      executor: stubExecutor({ rows: [ROW_WITH_COLUMN], onQuery: (q) => { sql = q; } }),
    });
    assert.match(sql, /array_agg\(column_name::text\)/);
  });
});

// --- against a real driver --------------------------------------------------

/**
 * The stub above cannot catch this class of bug: the whole failure was in what
 * node-postgres hands back for a domain-typed array. `TEST_DATABASE_URL` turns
 * these on (same variable as tests/migrationSql.test.js, which explains it);
 * they create and drop a scratch schema of their own.
 */
const URL = process.env.TEST_DATABASE_URL;
describe(
  'the probe against a real Postgres',
  { skip: URL ? false : 'set TEST_DATABASE_URL to run these' },
  () => {
    const SCHEMA = 'fiberline_caps_test';
    let knex;

    before(async () => {
      knex = require('knex')({
        client: 'pg',
        connection: URL,
        pool: {
          min: 1,
          max: 1,
          afterCreate: (conn, done) =>
            conn.query(`SET search_path = ${SCHEMA}, public`, (err) => done(err, conn)),
        },
      });
      await knex.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await knex.raw(`CREATE SCHEMA ${SCHEMA}`);
      await knex.raw(`SET search_path = ${SCHEMA}, public`);
      await knex.raw(`CREATE TABLE cables (id uuid PRIMARY KEY, continues_cable_id uuid)`);
    });

    after(async () => {
      if (!knex) return;
      try {
        await knex.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } finally {
        await knex.destroy();
      }
    });

    test('the column list arrives as a list, so a column that exists is seen', async () => {
      resetSchemaCache();
      const capabilities = await schemaCapabilities({ refresh: true, executor: knex });
      assert.equal(
        capabilities.columns.continues_cable_id,
        true,
        'information_schema.sql_identifier arrays need the ::text cast to be parsed',
      );
      assert.deepEqual(capabilities.gaps, []);
    });

    test('without the cast the driver hands back a literal, which is the bug', async () => {
      // Kept as a witness: this is what made the app report a present column as
      // missing, and it will catch a future edit that drops the cast.
      const parsed = (
        await knex.raw(`SELECT array_agg(column_name) AS columns FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false)) AND table_name = 'cables'
            AND column_name = 'continues_cable_id'`)
      ).rows[0].columns;
      const cast = (
        await knex.raw(`SELECT array_agg(column_name::text) AS columns FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false)) AND table_name = 'cables'
            AND column_name = 'continues_cable_id'`)
      ).rows[0].columns;
      assert.equal(typeof parsed, 'string', 'unparsed domain array — the reason for ::text');
      assert.deepEqual(cast, ['continues_cable_id']);
      assert.deepEqual(asArray(parsed), ['continues_cable_id'], 'and the reader copes with it anyway');
    });

    test('a database with no cables table is still reported as unmigrated', async () => {
      await knex.raw(`SET search_path = ${SCHEMA}, public`);
      await knex.raw('DROP TABLE cables');
      resetSchemaCache();
      const capabilities = await schemaCapabilities({ refresh: true, executor: knex });
      assert.equal(capabilities.has_cables, false);
      assert.equal(capabilities.gaps[0].missing_table, true);
      await knex.raw(`CREATE TABLE cables (id uuid PRIMARY KEY, continues_cable_id uuid)`);
    });
  },
);
