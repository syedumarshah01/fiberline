/**
 * scripts/linkSplits.js — the on-demand version of migration 14's backfill.
 *
 * It exists for splits created before the link was recorded: the migration
 * backfills them, but only where it can be sure, and a pair it skipped (renamed
 * downstream cable, geometry drifted) otherwise stays invisible. These tests pin
 * the rule — and that the dry run never writes.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { candidatePairs, linkPairs, linkedCount, parseArgs } = require('../scripts/linkSplits');

// --- a knex-shaped stub -------------------------------------------------------

function stubKnex({ rows = [], hasColumn = true, updateCount = 1 } = {}) {
  const updates = [];
  let lastQuery = null;
  const raw = async (sql) => {
    lastQuery = sql;
    return { rows };
  };
  const knex = (tableName) => {
    const state = { where: {}, whereNull: [] };
    const builder = {
      where(arg) { Object.assign(state.where, arg); return builder; },
      whereNull(column) { state.whereNull.push(column); return builder; },
      whereNotNull(column) { state.whereNotNull = column; return builder; },
      async update(patch) {
        updates.push({ table: tableName, where: state.where, whereNull: state.whereNull, patch });
        return updateCount;
      },
      async count() {
        return [{ count: String(rows.filter((row) => row.continues_cable_id).length) }];
      },
      then(resolve, reject) {
        const filtered = rows.filter(
          (row) =>
            Object.entries(state.where).every(([k, v]) => row[k] === v) &&
            state.whereNull.every((c) => row[c] == null) &&
            (state.whereNotNull ? row[state.whereNotNull] != null : true),
        );
        return Promise.resolve(filtered).then(resolve, reject);
      },
    };
    return builder;
  };
  knex.raw = raw;
  knex.schema = { hasColumn: async () => hasColumn };
  knex.__updates = updates;
  knex.__lastQuery = () => lastQuery;
  return knex;
}

const PAIR = {
  child_id: 'child-1',
  child_code: 'CBL-F1-B',
  parent_id: 'parent-1',
  parent_code: 'CBL-F1',
  core_count: 12,
  cable_type: 'feeder',
  at_box_code: 'BOX-MID',
};

describe('candidatePairs', () => {
  test('asks for pairs matching the naming + topology rule, and never for drops', async () => {
    const knex = stubKnex({ rows: [PAIR] });
    const pairs = await candidatePairs(knex);

    const sql = knex.__lastQuery();
    assert.match(sql, /child\.code = parent\.code \|\| '-B'/);
    assert.match(sql, /parent\.to_enclosure_id = child\.from_enclosure_id/);
    assert.match(sql, /parent\.cable_type = child\.cable_type/);
    assert.match(sql, /parent\.core_count = child\.core_count/);
    assert.match(sql, /child\.continues_cable_id IS NULL/);
    assert.match(sql, /child\.cable_type <> 'drop'/);
    // read-only: no UPDATE anywhere in the listing path
    assert.equal(knex.__updates.length, 0);
    assert.deepEqual(pairs, [PAIR]);
  });

  test('no candidates → an empty list, not an error', async () => {
    assert.deepEqual(await candidatePairs(stubKnex({ rows: [] })), []);
  });
});

describe('linkPairs', () => {
  test('writes the parent id onto the child, guarded against a link appearing meanwhile', async () => {
    const knex = stubKnex({ updateCount: 1 });
    const linked = await linkPairs(knex, [PAIR]);

    assert.equal(linked, 1);
    assert.equal(knex.__updates.length, 1);
    assert.deepEqual(knex.__updates[0].where, { id: 'child-1' });
    assert.deepEqual(knex.__updates[0].whereNull, ['continues_cable_id']);
    assert.deepEqual(knex.__updates[0].patch, { continues_cable_id: 'parent-1' });
  });

  test('counts only the rows it actually changed', async () => {
    const knex = stubKnex({ updateCount: 0 });
    assert.equal(await linkPairs(knex, [PAIR, PAIR]), 0);
  });
});

describe('linkByName', () => {
  const CABLE_ROWS = [
    { id: 'c-1', code: 'CBL-F9-B', continues_cable_id: null },
    { id: 'p-1', code: 'CBL-F9', continues_cable_id: null },
  ];

  test('links the named pair', async () => {
    const knex = stubKnex();
    // the where({ code }) lookups resolve against this fixture
    knex.__rows = CABLE_ROWS;
    const original = knex;
    const builder = (rows) => ({
      where(arg) {
        this.__where = arg;
        return this;
      },
      whereNull() { return this; },
      async first() {
        const [key, value] = Object.entries(this.__where)[0];
        return rows.find((row) => row[key] === value) || null;
      },
      async update(patch) {
        original.__updates.push({ patch, where: this.__where });
        return 1;
      },
    });
    const scoped = (table) => (table === 'cables' ? builder(CABLE_ROWS) : original(table));
    scoped.schema = original.schema;

    const { linkByName } = require('../scripts/linkSplits');
    const result = await linkByName(scoped, { childCode: 'CBL-F9-B', parentCode: 'CBL-F9' });
    assert.equal(result.updated, 1);
    assert.deepEqual(original.__updates.at(-1).patch, { continues_cable_id: 'p-1' });
  });

  test('refuses a cable that is already linked', async () => {
    const { linkByName } = require('../scripts/linkSplits');
    const knex = (table) => ({
      where(arg) {
        return {
          first: async () =>
            arg.code === 'CBL-F9-B'
              ? { id: 'c-1', code: 'CBL-F9-B', continues_cable_id: 'someone-else' }
              : { id: 'p-1', code: 'CBL-F9', continues_cable_id: null },
          whereNull() { return this; },
          update: async () => 1,
        };
      },
    });
    await assert.rejects(
      () => linkByName(knex, { childCode: 'CBL-F9-B', parentCode: 'CBL-F9' }),
      /already continues another cable/,
    );
  });

  test('refuses a cable it cannot find, and a cable linked to itself', async () => {
    const { linkByName } = require('../scripts/linkSplits');
    const knex = () => ({
      where(arg) {
        return {
          first: async () => (arg.code === 'NOPE' ? null : { id: 'same', code: arg.code, continues_cable_id: null }),
          whereNull() { return this; },
          update: async () => 1,
        };
      },
    });
    await assert.rejects(() => linkByName(knex, { childCode: 'NOPE', parentCode: 'CBL-F9' }), /No cable with code "NOPE"/);
    await assert.rejects(() => linkByName(knex, { childCode: 'X', parentCode: 'X' }), /are the same cable/);
  });
});

describe('linkedCount', () => {
  test('counts linked cables when the column exists', async () => {
    const knex = stubKnex({
      rows: [
        { id: 'a', continues_cable_id: 'p' },
        { id: 'b', continues_cable_id: null },
      ],
    });
    assert.equal(await linkedCount(knex), 1);
  });

  test('returns null when the database has not been migrated (the column is absent)', async () => {
    assert.equal(await linkedCount(stubKnex({ hasColumn: false })), null);
  });
});

describe('parseArgs', () => {
  test('defaults to a dry run', () => {
    assert.deepEqual(parseArgs([]), {
      apply: false, help: false, error: false, child: null, parent: null,
    });
  });

  test('--child/--parent name one pair explicitly', () => {
    const args = parseArgs(['--child', 'CBL-F9-B', '--parent', 'CBL-F9']);
    assert.equal(args.child, 'CBL-F9-B');
    assert.equal(args.parent, 'CBL-F9');
    assert.equal(args.error, false);
  });

  test('half a pair is refused (it would link to nothing)', () => {
    assert.equal(parseArgs(['--child', 'CBL-F9-B']).error, true);
    assert.equal(parseArgs(['--parent', 'CBL-F9']).error, true);
  });

  test('--apply is the only way to write', () => {
    assert.equal(parseArgs(['--apply']).apply, true);
  });

  test('an unknown flag is an error, and shows the usage', () => {
    const args = parseArgs(['--wat']);
    assert.equal(args.error, true);
    assert.equal(args.help, true);
    assert.equal(args.apply, false, 'the unknown flag must not be taken as consent to write');
  });
});
