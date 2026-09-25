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
