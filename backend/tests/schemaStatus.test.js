/**
 * scripts/schemaStatus.js — the migration-name comparison.
 *
 * This exists because of a real bug: knex's FsMigrations names a migration
 * `migration.file`, i.e. WITH the `.js` extension, while the script compared the
 * two sides after stripping it from the files only. On a real database that made
 * every migration look pending — the exact "the check says everything is wrong"
 * noise this script is supposed to remove.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { migrationFiles, pendingMigrations, normalized } = require('../scripts/schemaStatus');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const ALL = migrationFiles(MIGRATIONS_DIR);

describe('migrationFiles', () => {
  test('lists the shipped migrations, names as knex knows them (with .js)', () => {
    assert.ok(ALL.length >= 15, `expected the shipped migrations, got ${ALL.length}`);
    assert.ok(ALL.every((name) => name.endsWith('.js')));
    assert.ok(ALL.includes('20260101000014_cable_continuations.js'));
    assert.ok(ALL.includes('20260101000015_repair_cable_continuations.js'));
  });

  test('is sorted, so "pending" reads in the order knex will run them', () => {
    assert.deepEqual(ALL, [...ALL].sort());
  });

  test('a missing directory is not an error', () => {
    assert.deepEqual(migrationFiles('/nonexistent-directory-for-tests'), []);
    assert.deepEqual(migrationFiles(null), []);
  });
});

describe('pendingMigrations', () => {
  const files = ['a.js', 'b.js', 'c.js'];

  test('whatever is not in the ledger is pending', () => {
    assert.deepEqual(pendingMigrations(files, ['a.js']), ['b.js', 'c.js']);
  });

  test('a ledger written with the extension matches (what knex writes)', () => {
    assert.deepEqual(pendingMigrations(files, ['a.js', 'b.js', 'c.js']), []);
  });

  test('a ledger written without the extension matches too (hand-edited, older)', () => {
    assert.deepEqual(pendingMigrations(files, ['a', 'b', 'c']), []);
  });

  test('an unrelated ledger row neither hides nor invents work', () => {
    assert.deepEqual(pendingMigrations(files, ['a.js', 'zzz.js']), ['b.js', 'c.js']);
  });

  test('an empty ledger means everything is pending', () => {
    assert.deepEqual(pendingMigrations(files, []), files);
  });
});

describe('normalized', () => {
  test('strips one extension, and tolerates a name without one', () => {
    assert.equal(normalized('20260101000014_cable_continuations.js'), '20260101000014_cable_continuations');
    assert.equal(normalized('20260101000014_cable_continuations'), '20260101000014_cable_continuations');
  });
});

/**
 * What the script actually prints. `main()` builds its knex instance at require
 * time, so the `knex` module is stubbed before the script is loaded — the same
 * pattern the other suites use for their db.
 */
function fakeKnex({ columns, ledger, pairs = [], links = 0 }) {
  const instance = (table) => {
    const builder = {
      where: () => builder,
      whereIn: () => builder,
      select: async () =>
        table === 'knex_migrations'
          ? ledger.map((name) => ({ name }))
          : columns.map((column_name) => ({ column_name })),
      whereNotNull: () => builder,
      count: async () => [{ count: String(links) }],
      first: async () => ({ count: String(links) }),
    };
    return builder;
  };
  instance.raw = async (sql) => {
    if (/current_database/i.test(sql)) return { rows: [{ database: 'fiber', usr: 'me' }] };
    return { rows: pairs };
  };
  instance.schema = {
    hasTable: async () => true,
    hasColumn: async (table, column) => table === 'cables' && columns.includes(column),
  };
  instance.destroy = async () => {};
  return instance;
}

async function runSchemaStatus(fixture) {
  const knexPath = require.resolve('knex');
  const scriptPath = require.resolve('../scripts/schemaStatus');
  const realKnex = require.cache[knexPath];
  delete require.cache[scriptPath];
  require.cache[knexPath] = {
    id: knexPath,
    filename: knexPath,
    loaded: true,
    exports: () => fakeKnex(fixture),
  };

  const lines = [];
  const write = (stream) => (line) => lines.push(String(line));
  const out = console.log;
  const err = console.error;
  console.log = write('out');
  console.error = write('err');
  try {
    const { main } = require(scriptPath);
    const code = await main();
    return { code, output: lines.join('\n') };
  } finally {
    console.log = out;
    console.error = err;
    require.cache[knexPath] = realKnex;
    delete require.cache[scriptPath];
  }
}

describe('db:schema on a database that has not run migration 14', () => {
  test('does not call the app broken, and exits 0 (the links are inferred)', async () => {
    const { code, output } = await runSchemaStatus({
      columns: [], // no cables.continues_cable_id
      ledger: migrationFiles(MIGRATIONS_DIR), // all recorded — the user's state
    });
    assert.equal(code, 0, output);
    assert.match(output, /cables\.continues_cable_id — absent \(optional\)/);
    assert.match(output, /inferred from cable naming/);
    assert.doesNotMatch(output, /are off/);
    assert.doesNotMatch(output, /MISSING/);
    assert.doesNotMatch(output, /Fix: run/);
    // Nothing is pending here, so the advice has to be the fix that actually works.
    assert.match(output, /"npm run migrate" would change/);
    assert.match(output, /ADD COLUMN IF NOT EXISTS continues_cable_id/);
    assert.match(output, /db:link-splits -- --apply/);
  });

  test('still exits 1 when a migration really is pending', async () => {
    const files = migrationFiles(MIGRATIONS_DIR);
    const { code, output } = await runSchemaStatus({
      columns: [],
      ledger: files.slice(0, -1), // the last one has not run
    });
    assert.equal(code, 1);
    assert.match(output, /1 pending/);
    assert.match(output, /npm run migrate/);
  });
});
