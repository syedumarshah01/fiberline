const assert = require('node:assert/strict');
const test = require('node:test');
const knex = require('knex');
const { executeToolCall } = require('../src/services/toolExecutor');

// Optional real PostgreSQL regression. Uses session-local temporary tables;
// never reads or changes the application's enclosures/fiber_cores tables.
test('PostgreSQL UUID columns accept resolved box codes and reject no raw labels', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL });
  const boxId = '3c651534-b5f8-4c8b-91d0-64578cb6c1a2';
  const otherId = '5252ae96-a1b9-4bf9-8971-ae44c58a36e2';
  try {
    await db.transaction(async (trx) => {
      await trx.raw('CREATE TEMP TABLE fiberline_test_enclosures (id uuid PRIMARY KEY, code text UNIQUE NOT NULL) ON COMMIT DROP');
      const records = () => trx('fiberline_test_enclosures').withSchema('pg_temp');
      await records().insert({ id: boxId, code: 'BOX-0002' });
      const dbClient = (table) => {
        assert.equal(table, 'enclosures');
        return records();
      };
      const run = (identifier) => executeToolCall({ tool: 'simulateFailure', args: { enclosure_id: identifier } }, {
        dbClient,
        handlers: { simulateFailure: async ({ enclosure_id }) => {
          // Mimic a real downstream UUID lookup, which also must not throw.
          const row = await records().where({ id: enclosure_id }).first('id');
          return { enclosure_id: row.id };
        } },
      });
      for (const identifier of ['box-0002', ' BOX-0002 ', boxId.toUpperCase()]) {
        const result = await run(identifier);
        assert.equal(result.success, true);
        assert.equal(result.result.enclosure_id, boxId);
      }
      assert.equal((await run('BOX-%')).error, 'ENTITY_NOT_FOUND');
      assert.equal((await run("' OR 1=1 --")).error, 'ENTITY_NOT_FOUND');
      await records().insert({ id: otherId, code: 'box-0002' });
      assert.equal((await run('box-0002')).error, 'AMBIGUOUS_ENTITY');
    });
  } finally {
    await db.destroy();
  }
});
