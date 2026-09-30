const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { validateReadOnlySql, runReadOnlyQuery } = require('../src/services/readOnlyQuery');

describe('read-only database assistant queries', () => {
  test('accepts a network SELECT and adds a safe row limit', () => {
    const query = validateReadOnlySql(`SELECT p.code, p.status FROM poles p WHERE p.status = 'active'`);
    assert.deepEqual(query.tables, ['poles']);
    assert.match(query.sql, /LIMIT 100$/i);
  });

  test('clamps a model-requested limit', () => {
    assert.match(validateReadOnlySql('SELECT code FROM poles LIMIT 5000').sql, /LIMIT 100$/i);
  });

  test('rejects writes, unknown tables, comments, and sensitive fields', () => {
    for (const sql of [
      'UPDATE poles SET status = \'down\'',
      'SELECT * FROM pg_catalog.pg_tables',
      'SELECT code FROM poles; DELETE FROM poles',
      'SELECT password_hash FROM users',
    ]) {
      assert.throws(() => validateReadOnlySql(sql), /not allowed|forbidden|only one|SELECT/i);
    }
  });

  test('executes through a read-only transaction and returns rows', async () => {
    const calls = [];
    const transaction = {
      raw: async (sql) => {
        calls.push(sql);
        return sql.startsWith('SELECT') ? { rows: [{ code: 'POLE-0042' }] } : { rows: [] };
      },
      commit: async () => calls.push('commit'),
      rollback: async () => calls.push('rollback'),
    };
    const executor = { transaction: async () => transaction };
    const result = await runReadOnlyQuery('SELECT code FROM poles', { executor });
    assert.deepEqual(result.rows, [{ code: 'POLE-0042' }]);
    assert.equal(result.row_count, 1);
    assert.equal(calls.at(-1), 'commit');
    assert.match(calls[2], /LIMIT 100/);
  });
});
