/**
 * Mid-span links with and without the column.
 *
 * The point of this module: a database that never got migration 14 must still
 * walk across a closure someone inserted mid-span. Recorded links win when the
 * column is there; otherwise the same rule the migration's backfill uses is
 * applied at read time, and the caller is told the links were inferred.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CABLE_FIELDS,
  inferredPairsSql,
  loadInferredPairs,
  loadContinuationLinks,
} = require('../src/utils/continuationLinks');

const CABLES = [
  { id: 'f1', code: 'CBL-F1', cable_type: 'feeder', core_count: 12, from_enclosure_id: 'olt', to_enclosure_id: 'mid' },
  { id: 'f1b', code: 'CBL-F1-B', cable_type: 'feeder', core_count: 12, from_enclosure_id: 'mid', to_enclosure_id: 'nap' },
];

function capabilities({ column = true, hasCables = true } = {}) {
  return { has_cables: hasCables, columns: { continues_cable_id: column }, gaps: [] };
}

/** Records the SQL and answers it. */
function executor(rows = [], onQuery = () => {}) {
  return {
    raw: async (sql) => {
      onQuery(sql);
      return { rows };
    },
    // knex table builder: db('cables').select(...).whereNotNull(...)
    __table: () => {
      const state = { columns: [], whereNotNull: null };
      const builder = {
        select(...columns) { state.columns.push(...columns); return builder; },
        whereNotNull(column) { state.whereNotNull = column; return builder; },
        then(resolve, reject) {
          const filtered = state.whereNotNull
            ? rows.filter((row) => row[state.whereNotNull] != null)
            : rows;
          return Promise.resolve(filtered).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

describe('inferredPairsSql', () => {
  const sql = inferredPairsSql();

  test('pairs a downstream half with its upstream by naming and topology', () => {
    assert.match(sql, /child\.code = parent\.code \|\| '-B'/);
    assert.match(sql, /parent\.to_enclosure_id = child\.from_enclosure_id/);
    assert.match(sql, /parent\.cable_type = child\.cable_type/);
    assert.match(sql, /parent\.core_count = child\.core_count/);
    assert.match(sql, /parent\.id <> child\.id/);
  });

  test('never treats a drop as a split half', () => {
    assert.match(sql, /child\.cable_type <> 'drop'/);
  });

  test('checks the geometry when both routes are known (25 m, like the migration)', () => {
    assert.match(sql, /ST_DWithin\(/);
    assert.match(sql, /ST_StartPoint\(child\.route::geometry\)::geography/);
    assert.match(sql, /parent\.route IS NULL/);
    assert.match(sql, /child\.route IS NULL/);
    assert.match(sql, /25/);
  });

  test('does NOT mention continues_cable_id — the whole point is to survive without it', () => {
    assert.doesNotMatch(sql, /continues_cable_id/);
  });

  test('can be narrowed to the pairs still unlinked (for the listing script)', () => {
    assert.match(inferredPairsSql({ childStillUnlinked: true }), /child\.continues_cable_id IS NULL/);
    assert.doesNotMatch(inferredPairsSql(), /continues_cable_id/);
  });
});

describe('loadInferredPairs', () => {
  test('runs the rule and returns its rows', async () => {
    let seen = null;
    const pairs = [{ child_id: 'f1b', parent_id: 'f1' }];
    const rows = await loadInferredPairs(executor(pairs, (sql) => { seen = sql; }));
    assert.deepEqual(rows, pairs);
    assert.match(seen, /FROM cables AS child/);
  });
});

describe('loadContinuationLinks', () => {
  test('with the column: uses the recorded links, and says they were not inferred', async () => {
    const cables = [{ ...CABLES[0] }, { ...CABLES[1], continues_cable_id: 'f1' }];
    const links = await loadContinuationLinks({
      executor: executor(),
      capabilities: capabilities({ column: true }),
      cables,
    });

    assert.equal(links.inferred, false);
    assert.equal(links.childToParent.get('f1b'), 'f1');
    assert.equal(links.parentToChild.get('f1'), 'f1b');
    assert.equal(links.byId.get('f1').code, 'CBL-F1');
  });

  test('with the column: a NULL link is respected, never guessed', async () => {
    // Both halves exist and match the naming rule, but the column is present and
    // empty — an explicit "not a continuation" that inference must not override.
    const cables = [{ ...CABLES[0] }, { ...CABLES[1], continues_cable_id: null }];
    const links = await loadContinuationLinks({
      executor: executor([{ child_id: 'f1b', parent_id: 'f1' }]),
      capabilities: capabilities({ column: true }),
      cables,
    });

    assert.equal(links.inferred, false);
    assert.equal(links.childToParent.size, 0, 'no link was recorded, so there is none');
  });

  test('without the column: infers the links from the rule and flags them', async () => {
    const cables = CABLES.map((cable) => ({ ...cable })); // no continues_cable_id at all
    const links = await loadContinuationLinks({
      executor: executor([{ child_id: 'f1b', parent_id: 'f1' }]),
      capabilities: capabilities({ column: false }),
      cables,
    });

    assert.equal(links.inferred, true);
    assert.equal(links.childToParent.get('f1b'), 'f1');
    assert.equal(links.parentToChild.get('f1'), 'f1b');
  });

  test('without the column: no matching pair means no links (nothing invented)', async () => {
    const links = await loadContinuationLinks({
      executor: executor([]),
      capabilities: capabilities({ column: false }),
      cables: CABLES.map((cable) => ({ ...cable })),
    });
    assert.equal(links.inferred, true);
    assert.equal(links.childToParent.size, 0);
    assert.equal(links.parentToChild.size, 0);
  });

  test('a database with no schema at all yields nothing, and does not run the rule', async () => {
    let ran = false;
    const links = await loadContinuationLinks({
      executor: executor([], () => { ran = true; }),
      capabilities: capabilities({ column: false, hasCables: false }),
      cables: [],
    });
    assert.equal(links.inferred, false, 'nothing to infer from — not an inference result');
    assert.equal(ran, false);
    assert.equal(links.childToParent.size, 0);
  });

  test('a cable is never linked to itself', async () => {
    const links = await loadContinuationLinks({
      executor: executor([{ child_id: 'f1', parent_id: 'f1' }]),
      capabilities: capabilities({ column: false }),
      cables: CABLES.map((cable) => ({ ...cable })),
    });
    assert.equal(links.childToParent.size, 0);
  });

  test('loads its own cable rows when the caller has none (what the trace does)', async () => {
    const rows = [
      { ...CABLES[0] },
      { ...CABLES[1], continues_cable_id: 'f1' },
    ];
    const exec = executor([]);
    exec.__table = () => {
      const builder = {
        select() { return builder; },
        whereNotNull() { return builder; },
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      };
      return builder;
    };
    const db = () => exec.__table();

    const links = await loadContinuationLinks({ executor: db, capabilities: capabilities({ column: true }) });
    assert.equal(links.inferred, false);
    assert.equal(links.childToParent.get('f1b'), 'f1');
    assert.ok(CABLE_FIELDS.every((field) => field in links.byId.get('f1')));
  });
});
