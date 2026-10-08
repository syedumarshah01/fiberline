const assert = require('node:assert/strict');

// Mimic the PostgreSQL UUID boundary, not an unconstrained string-keyed map.
// This deliberately fails if a display label is ever compared with an id column.
function fakeEntityDb(rowsByTable = {}) {
  const calls = [];
  const db = (table) => ({
    where(criteria) {
      calls.push({ table, criteria });
      assert.match(criteria.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'non-UUID must never reach a UUID-column predicate');
      return {
        async first() {
          return (rowsByTable[table] || []).find((row) => row.id.toLowerCase() === criteria.id.toLowerCase()) || null;
        },
      };
    },
    whereRaw(sql, bindings) {
      calls.push({ table, sql, bindings });
      assert.equal(sql, 'lower(??) = lower(?)');
      assert.equal(table, 'enclosures');
      assert.equal(bindings[0], 'code');
      return {
        select(...columns) {
          assert.deepEqual(columns, ['id', 'code']);
          return {
            async limit(count) {
              assert.equal(count, 2, 'lookup must be bounded and detect ambiguity');
              return (rowsByTable[table] || [])
                .filter((row) => row.code.toLowerCase() === bindings[1].toLowerCase())
                .slice(0, count);
            },
          };
        },
      };
    },
  });
  db.calls = calls;
  return db;
}

module.exports = { fakeEntityDb };
