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
    assert.match(gap.message, /Everything works/);
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
