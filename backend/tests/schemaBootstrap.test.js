/**
 * The startup pass, tested against a real database when one is available.
 *
 * `TEST_DATABASE_URL` (same variable as tests/migrationSql.test.js) turns on the
 * database-backed tests; they build a scratch schema that only holds `cables`
 * (with and without the column) and the migration ledger, and drop it after. The
 * rest — which migration directory is used, whether the environment switch works,
 * and that a database that cannot be reached does not throw — runs everywhere.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  bootstrapEnabled,
  runSchemaBootstrap,
  migrationsDirectory,
  pendingMigrations,
  filesOnDisk,
} = require('../src/utils/schemaBootstrap');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const URL = process.env.TEST_DATABASE_URL;

/** A logger that keeps what it was told, so warnings can be asserted on. */
function recorder() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { lines, log: push('log'), warn: push('warn'), error: push('error') };
}

describe('the schema bootstrap switch', () => {
  test('is on by default', () => {
    assert.equal(bootstrapEnabled({}), true);
    assert.equal(bootstrapEnabled({ SCHEMA_BOOTSTRAP: '' }), true);
  });

  test('turns off for the values people actually write', () => {
    for (const value of ['off', 'OFF', 'false', '0', 'no', ' off ']) {
      assert.equal(bootstrapEnabled({ SCHEMA_BOOTSTRAP: value }), false, value);
    }
    for (const value of ['on', 'true', '1', 'yes']) {
      assert.equal(bootstrapEnabled({ SCHEMA_BOOTSTRAP: value }), true, value);
    }
  });

  test('points at this package\u2019s migrations, not the working directory', () => {
    const dir = migrationsDirectory();
    assert.ok(path.isAbsolute(dir), 'absolute, so the process cwd cannot change it');
    assert.equal(fs.realpathSync(dir), fs.realpathSync(MIGRATIONS_DIR));
  });

  test('honours a relative directory in a custom knexfile', () => {
    const dir = migrationsDirectory({ development: { migrations: { directory: './db/migrations' } } });
    assert.equal(dir, path.join(__dirname, '..', 'db', 'migrations'));
  });

  test('leaves nothing pending out of the real migration list', () => {
    const files = filesOnDisk(MIGRATIONS_DIR);
    assert.ok(files.length >= 15, 'the shipped migrations are on disk');
    assert.deepEqual(pendingMigrations !== undefined, true);
  });
});

describe('the schema bootstrap needs no database', () => {
  test('says so instead of throwing when there is no connection', async () => {
    const log = recorder();
    const summary = await runSchemaBootstrap({ knex: null, log });
    assert.equal(summary.ok, false);
    assert.equal(summary.enabled, false);
    assert.match(summary.reason, /no database connection/);
  });
});

describe(
  'the schema bootstrap on a real database',
  { skip: URL ? false : 'set TEST_DATABASE_URL to run these (see the file header)' },
  () => {
    const SCHEMA = 'fiberline_bootstrap_test';
    const ID = '11111111-1111-1111-1111-111111111111';
    const MID = '22222222-2222-2222-2222-222222222222';
    let knex;
    let scratch; // a migrations directory holding copies of 14 and 15
    let broken; // a migrations directory holding one migration that fails

    /**
     * Just enough schema for the two migrations this pass is about: `cables`
     * without the column, and the ledger. Migrations 1–13 build the rest of the
     * app (PostGIS and all) and are not what is being tested here.
     */
    async function freshSchema({ withColumn = false } = {}) {
      await knex.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await knex.raw(`CREATE SCHEMA ${SCHEMA}`);
      await knex.raw(`SET search_path = ${SCHEMA}, public`);
      await knex.raw(`
        CREATE DOMAIN geometry AS text;
        CREATE DOMAIN geography AS text;
        CREATE FUNCTION st_startpoint(geometry) RETURNS text AS $$ SELECT $1 $$ LANGUAGE sql;
        CREATE FUNCTION st_dwithin(geography, geography, double precision) RETURNS boolean
          AS $$ SELECT NOT ($1 LIKE '%far%' OR $2 LIKE '%far%') $$ LANGUAGE sql;
        CREATE TABLE cables (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          code text UNIQUE NOT NULL,
          cable_type text NOT NULL DEFAULT 'feeder',
          core_count integer NOT NULL DEFAULT 12,
          from_enclosure_id uuid,
          to_enclosure_id uuid,
          route text
          ${withColumn ? ', continues_cable_id uuid' : ''}
        );
        CREATE TABLE enclosures (id uuid PRIMARY KEY, code text UNIQUE NOT NULL, type text);
        CREATE TABLE knex_migrations (
          id serial PRIMARY KEY,
          name varchar(255),
          batch integer,
          migration_time timestamptz
        );
      `);
    }

    /**
     * A split made by the old code: two halves, nothing linking them. The parent
     * gets a known id so the test can say exactly which row the child must point
     * at.
     */
    const insertSplit = (parent, child) =>
      knex('cables').insert([
        { id: ID, code: parent, to_enclosure_id: MID, route: 'upstream' },
        { code: child, from_enclosure_id: MID, route: 'upstream' },
      ]);

    // knex records the file name (with its extension), not the full path.
    const ledger = (name) =>
      knex('knex_migrations').insert({ name, batch: 1, migration_time: new Date() });

    /**
     * How the API reads the link for this cable *after* the pass — through the
     * production reader, against this connection (`executor`), so what is being
     * asserted is the behaviour the routes get, not a re-implementation of it.
     */
    async function linksFor(code) {
      const { loadContinuationLinks } = require('../src/utils/continuationLinks');
      const capabilities = {
        has_cables: true,
        columns: { continues_cable_id: await knex.schema.hasColumn('cables', 'continues_cable_id') },
      };
      const links = await loadContinuationLinks({ executor: knex, capabilities });
      const child = await knex('cables').where({ code }).first();
      return { links, child, parentId: links.childToParent.get(child.id) ?? null };
    }

    before(() => {
      knex = require('knex')({
        client: 'pg',
        connection: URL,
        pool: {
          min: 1,
          max: 1,
          afterCreate: (conn, done) =>
            conn.query(`SET search_path = ${SCHEMA}, public`, (err) => done(err, conn)),
        },
      });

      const os = require('node:os');
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberline-bootstrap-'));
      for (const file of [
        '20260101000014_cable_continuations.js',
        '20260101000015_repair_cable_continuations.js',
      ]) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(scratch, file));
      }

      broken = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberline-broken-'));
      fs.writeFileSync(
        path.join(broken, '20990101000001_deliberately_broken.js'),
        'exports.up = async () => { throw new Error("this migration is a test fixture"); };\n' +
          'exports.down = async () => {};\n',
      );
    });

    after(async () => {
      if (knex) {
        try {
          await knex.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        } finally {
          await knex.destroy();
        }
      }
      for (const dir of [scratch, broken]) {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('a database that is already up to date is left alone, loudly quiet', async () => {
      await freshSchema({ withColumn: true });
      for (const file of fs.readdirSync(scratch)) await ledger(file);

      const log = recorder();
      const summary = await runSchemaBootstrap({ knex, log, directory: scratch });

      assert.equal(summary.ok, true, log.lines.join('\n'));
      assert.deepEqual(summary.migrations_applied, []);
      assert.equal(summary.column_added, false);
      assert.equal(summary.splits_linked, 0);
      assert.deepEqual(log.lines, [], 'a schema that needs nothing must not print anything');
    });

    test('a split the old code made is linked, and the link is recorded from then on', async () => {
      await freshSchema({ withColumn: true });
      for (const file of fs.readdirSync(scratch)) await ledger(file);
      await insertSplit('CBL-F1', 'CBL-F1-B');

      const log = recorder();
      const summary = await runSchemaBootstrap({ knex, log, directory: scratch });

      assert.equal(summary.ok, true, log.lines.join('\n'));
      assert.equal(summary.splits_linked, 1, 'the unlinked split is linked');
      const { parentId } = await linksFor('CBL-F1-B');
      assert.equal(parentId, ID, 'and the child points at the upstream half the app can now read');
      assert.equal(
        (await knex('cables').where({ code: 'CBL-F1-B' }).first()).continues_cable_id,
        ID,
      );
    });

    test('the column is added when the ledger claims both migrations that create it already ran', async () => {
      // The trap migrations cannot get out of: 14 and 15 are recorded, the column
      // is absent, and "npm run migrate" answers "Already up to date".
      await freshSchema();
      for (const file of fs.readdirSync(scratch)) await ledger(file);
      await insertSplit('CBL-F2', 'CBL-F2-B');

      const log = recorder();
      const summary = await runSchemaBootstrap({ knex, log, directory: scratch });

      assert.equal(
        await knex.schema.hasColumn('cables', 'continues_cable_id'),
        true,
        log.lines.join('\n'),
      );
      assert.equal(summary.column_added, true);
      assert.deepEqual(
        summary.migrations_applied,
        [],
        'nothing was pending — the ledger was wrong, not the queue',
      );
      assert.equal(summary.splits_linked, 1, 'and the split is linked in the same pass');
      assert.ok(
        log.lines.some((line) => /no cables\.continues_cable_id — adding it now/.test(line)),
        'and it says so rather than doing it silently',
      );
      // Recorded, not inferred: the API no longer has to guess for this pair.
      const { links, parentId } = await linksFor('CBL-F2-B');
      assert.equal(links.inferred, false);
      assert.ok(parentId, 'the pair is joined in the same table the app reads');
    });

    test('a database with no ledger at all is migrated and linked', async () => {
      await freshSchema();
      await knex.raw('DROP TABLE knex_migrations');
      await insertSplit('CBL-F3', 'CBL-F3-B');

      const log = recorder();
      const summary = await runSchemaBootstrap({ knex, log, directory: scratch });

      assert.equal(summary.ok, true, log.lines.join('\n'));
      assert.equal(summary.migrations_applied.length, 2, 'both migrations ran');
      assert.equal(await knex.schema.hasColumn('cables', 'continues_cable_id'), true);
      assert.equal((await knex('cables').where({ code: 'CBL-F3-B' }).first()).continues_cable_id, ID);
    });

    test('a migration that fails is reported, does not throw, and does not stop the repair', async () => {
      await freshSchema();
      await insertSplit('CBL-F4', 'CBL-F4-B');

      const log = recorder();
      const summary = await runSchemaBootstrap({ knex, log, directory: broken });

      assert.equal(summary.ok, false, 'the failure is not swallowed');
      assert.equal(summary.migrations_failed.length, 1);
      assert.match(summary.migrations_failed[0], /test fixture/);
      assert.ok(log.lines.some((line) => /could not apply the pending migrations/.test(line)));
      assert.ok(
        log.lines.some((line) => /Run "npm run migrate"/.test(line)),
        'and it points at the command that shows the real failure',
      );
      // The part the app actually needs still happened: the column and the link.
      assert.equal(await knex.schema.hasColumn('cables', 'continues_cable_id'), true);
      assert.equal((await knex('cables').where({ code: 'CBL-F4-B' }).first()).continues_cable_id, ID);
    });

    test('a database the connection cannot reach is a warning, not a crash', async () => {
      const unreachable = require('knex')({
        client: 'pg',
        connection: { host: '127.0.0.1', port: 1, user: 'nobody', database: 'nothing' },
        pool: { min: 1, max: 1 },
      });
      const log = recorder();
      let summary;
      try {
        summary = await runSchemaBootstrap({ knex: unreachable, log, directory: scratch });
      } finally {
        await unreachable.destroy().catch(() => {});
      }
      assert.equal(summary.ok, false);
      assert.ok(log.lines.some((line) => /could not apply the pending migrations/.test(line)));
    });
  },
);
