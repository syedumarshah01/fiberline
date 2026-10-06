const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const enclosuresRouter = require('../src/routes/enclosures');

const parseConnectorCounts = enclosuresRouter.parseConnectorCounts;

describe('enclosure connector inventory input', () => {
  test('leaves omitted fields untouched and preserves explicit NULL as unknown', () => {
    assert.deepEqual(parseConnectorCounts({}), { values: {} });
    assert.deepEqual(
      parseConnectorCounts({ connector_count_in: null, connector_count_out: '4' }),
      { values: { connector_count_in: null, connector_count_out: 4 } },
    );
  });

  test('accepts only non-negative safe integer counts within PostgreSQL integer range', () => {
    for (const badValue of [-1, 1.5, true, '', '  ', '1.2', 2147483648, Number.MAX_SAFE_INTEGER + 1]) {
      const result = parseConnectorCounts({ connector_count_in: badValue });
      assert.match(result.error, /connector_count_in must be a non-negative integer or null/);
    }
    assert.deepEqual(
      parseConnectorCounts({ connector_count_in: 0, connector_count_out: 2147483647 }),
      { values: { connector_count_in: 0, connector_count_out: 2147483647 } },
    );
  });
});
