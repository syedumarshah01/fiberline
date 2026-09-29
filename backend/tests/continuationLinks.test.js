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
  continuationFields,
  decorateCables,
  loadBoxCodes,
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

describe('continuationFields / decorateCables', () => {
  const links = ({ inferred, pairs }) => {
    const childToParent = new Map();
    const parentToChild = new Map();
    for (const pair of pairs) {
      childToParent.set(pair.child_id, pair.parent_id);
      parentToChild.set(pair.parent_id, pair.child_id);
    }
    return { byId: new Map(CABLES.map((c) => [c.id, c])), childToParent, parentToChild, inferred, pairs };
  };
  const boxCodes = new Map([['mid', 'BOX-MID']]);

  test('a downstream half says what it continues, and where they meet', () => {
    const [f1, f1b] = decorateCables(
      CABLES,
      links({ inferred: false, pairs: [{ child_id: 'f1b', parent_id: 'f1' }] }),
      { boxCodes },
    );
    assert.equal(f1b.continues_cable_id, 'f1');
    assert.equal(f1b.continues_cable_code, 'CBL-F1');
    assert.equal(f1b.continues_at_box_id, 'mid');
    assert.equal(f1b.continues_at_box_code, 'BOX-MID');
    assert.equal(f1b.continuation_inferred, false);
    assert.deepEqual(f1b.continued_by, [], 'nothing continues the downstream half either');
    // The upstream half carries the same field set, all null: a client can read
    // the field without asking whether this cable is the end of a chain.
    assert.equal(f1.continues_cable_id, null);
    assert.equal(f1.continues_cable_code, null);
    assert.equal(f1.continues_at_box_code, null);
    // …and the other direction is a list, because a span can be split twice.
    assert.deepEqual(f1.continued_by, [
      { id: 'f1b', code: 'CBL-F1-B', at_box_id: 'mid', at_box_code: 'BOX-MID' },
    ]);
  });

  test('the same fields come back when the link was inferred, flagged as such', () => {
    const [, f1b] = decorateCables(
      CABLES,
      links({ inferred: true, pairs: [{ child_id: 'f1b', parent_id: 'f1' }] }),
      { boxCodes },
    );
    assert.equal(f1b.continues_cable_id, 'f1');
    assert.equal(f1b.continues_cable_code, 'CBL-F1');
    assert.equal(f1b.continuation_inferred, true, 'the client can tell it is not recorded');
  });

  test('every cable carries the field set — no link reads as null, not as absent', () => {
    const [f1] = decorateCables(CABLES, links({ inferred: true, pairs: [] }), { boxCodes });
    for (const field of [
      'continues_cable_id',
      'continues_cable_code',
      'continues_at_box_id',
      'continues_at_box_code',
      'continuation_inferred',
      'continued_by',
    ]) {
      assert.ok(field in f1, `${field} is always present`);
    }
    assert.equal(f1.continuation_inferred, false, 'nothing to infer is not an inference');
    assert.deepEqual(f1.continued_by, []);
  });

  test('the box id comes back even without the codes map', () => {
    const [, f1b] = decorateCables(
      CABLES,
      links({ inferred: false, pairs: [{ child_id: 'f1b', parent_id: 'f1' }] }),
    );
    assert.equal(f1b.continues_at_box_id, 'mid');
    assert.equal(f1b.continues_at_box_code, null);
  });

  test('a parent present in the pairs but not in the row set yields the id, no code', () => {
    const [f1b] = decorateCables(
      [CABLES[1]],
      links({ inferred: false, pairs: [{ child_id: 'f1b', parent_id: 'f1' }] }),
      { boxCodes },
    );
    // The caller only loaded one cable, so the other half's code is unknown —
    // the id is still there, and nothing throws.
    assert.equal(f1b.continues_cable_id, 'f1');
  });

  test('loadBoxCodes reads the enclosures table', async () => {
    const db = () => ({
      select: async () => [{ id: 'mid', code: 'BOX-MID' }, { id: 'nap', code: 'BOX-NAP' }],
    });
    const codes = await loadBoxCodes(db);
    assert.equal(codes.get('mid'), 'BOX-MID');
  });
});

describe('continued_by — the other direction', () => {
  const links = (pairs, inferred = false) => {
    const childToParent = new Map(pairs.map((p) => [p.child_id, p.parent_id]));
    return {
      byId: new Map(CABLES.map((c) => [c.id, c])),
      childToParent,
      parentToChild: new Map(pairs.map((p) => [p.parent_id, p.child_id])),
      inferred,
      pairs,
    };
  };
  const boxCodes = new Map([['mid', 'BOX-MID'], ['mid2', 'BOX-MID-2']]);

  test('a cable split in two places lists both halves, each with its box', () => {
    // The same span cut twice: CBL-F1-B and CBL-F1-C both continue CBL-F1.
    const rows = [
      ...CABLES,
      { id: 'f1c', code: 'CBL-F1-C', cable_type: 'feeder', core_count: 12, from_enclosure_id: 'mid2', to_enclosure_id: 'nap' },
    ];
    const withLinks = links([
      { child_id: 'f1b', parent_id: 'f1' },
      { child_id: 'f1c', parent_id: 'f1' },
    ]);
    withLinks.byId.set('f1c', rows[2]);
    const [f1] = decorateCables([rows[0]], withLinks, { boxCodes });
    assert.deepEqual(f1.continued_by, [
      { id: 'f1b', code: 'CBL-F1-B', at_box_id: 'mid', at_box_code: 'BOX-MID' },
      { id: 'f1c', code: 'CBL-F1-C', at_box_id: 'mid2', at_box_code: 'BOX-MID-2' },
    ]);
    assert.equal(f1.continuation_inferred, false);
  });

  test('an inferred link flags the parent side too', () => {
    const withLinks = links([{ child_id: 'f1b', parent_id: 'f1' }], true);
    const [f1] = decorateCables([CABLES[0]], withLinks, { boxCodes });
    assert.equal(f1.continuation_inferred, true, 'the list is inferred as well');
  });

  test('a cable with no links anywhere carries an empty list, not null', () => {
    const [f1] = decorateCables([CABLES[0]], links([]), { boxCodes });
    assert.deepEqual(f1.continued_by, []);
  });
});
