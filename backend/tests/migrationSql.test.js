/**
 * Migrations are SQL, and SQL that has never been executed is a guess.
 *
 * The first version of migration 14 used MIN(p.id) — Postgres has no min()/max()
 * aggregate for uuid — so `npm run migrate` died on any database that already
 * had cables. Nothing in the swap-the-db-for-a-stub suite could have noticed: the
 * bug is in the SQL itself, not in the JavaScript around it.
 *
 * So this file runs the real migration against a real database. Set
 * TEST_DATABASE_URL to a database you do not mind creating a scratch schema in
 * (the app's own database is fine — everything happens in a schema that is
 * dropped afterwards), and it will:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/fiber_network \
 *     npm run test:migrations
 *
 * Without that variable the file still runs its static checks and skips the
 * database ones, so the normal `npm test` is unaffected.
 *
 * It works with or without PostGIS: when PostGIS is present the migration's real
 * geography columns are used; when it is not (a bare Postgres), geometry and
 * geography are stubbed as domains over text and ST_DWithin/ST_StartPoint are
 * stubbed in SQL, so the same SQL still executes.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, '20260101000014_cable_continuations.js');
const REPAIR_PATH = path.join(MIGRATIONS_DIR, '20260101000015_repair_cable_continuations.js');
const SCHEMA = 'fiberline_migration_test';
const URL = process.env.TEST_DATABASE_URL;

// --- static checks: always run, no database needed ---------------------------

/** Drop // line comments and /* block comments *\/ so the scan sees code only. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the migration source', () => {
  test('no migration aggregates a uuid id', () => {
    // Every migration, not just this one: MIN/MAX exist for numbers and text,
    // not for uuid, and that is what broke `npm run migrate` (MIN(p.id)).
    // Comments talk about the bug on purpose, so scan code only.
    const offenders = [];
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))) {
      const source = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      for (const match of source.match(/\b(min|max)\s*\(\s*[\w.]*\bid\b\s*\)/gi) || []) {
        offenders.push(`${file}: ${match}`);
      }
    }
    assert.deepEqual(offenders, [], `uuid ids cannot be aggregated — ${offenders.join('; ')}`);
  });

  test('guards the backfill so a heuristic failure cannot block the column', () => {
    for (const [label, file] of [['14', MIGRATION_PATH], ['15', REPAIR_PATH]]) {
      const source = fs.readFileSync(file, 'utf8');
      assert.match(source, /knex\.transaction\(/, `${label}: the backfill runs in its own savepoint`);
      assert.match(source, /Could not link the mid-span splits/, `${label}: and reports its failure`);
    }
  });

  test('migrations 14 and 15 link on the same rule', () => {
    const rule = (file) => {
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      const update = source.match(/UPDATE cables AS child[\s\S]*?ST_DWithin\([\s\S]*?\)\s*\n\s*\)\s*\n\s*`/);
      if (!update) throw new Error(`no backfill UPDATE found in ${path.basename(file)}`);
      return update[0].replace(/\)\s*`$/, ')').replace(/\s+/g, ' ').trim();
    };
    assert.equal(
      rule(REPAIR_PATH),
      rule(MIGRATION_PATH),
      'the repair migration must link on exactly the rule it repairs',
    );
  });

  test('the repair migration verifies its own result', () => {
    const source = stripComments(fs.readFileSync(REPAIR_PATH, 'utf8'));
    assert.match(source, /is still missing after the repair migration ran/);
  });
});

// --- the repair migration, driven through knex's own migrate:latest ---------

describe(
  'migration 15 repairs a database whose ledger claims 14 already ran',
  { skip: URL ? false : 'set TEST_DATABASE_URL to run these (see the file header)' },
  () => {
    const SCHEMA = 'fiberline_repair_test';
    const MID = '22222222-2222-2222-2222-222222222222';
    let knex;
    let migrationsDir;

    /** A scratch schema holding just enough of the app's schema. */
    async function freshSchema() {
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
        );
        CREATE TABLE knex_migrations (
          id serial PRIMARY KEY,
          name varchar(255),
          batch integer,
          migration_time timestamptz
        );
      `);
    }

    const migrate = () =>
      knex.migrate.latest({
        directory: migrationsDir,
        tableName: 'knex_migrations',
        schemaName: SCHEMA,
      });

    before(async () => {
      const knexFactory = require('knex');
      knex = knexFactory({
        client: 'pg',
        connection: URL,
        pool: {
          min: 1,
          max: 1,
          afterCreate: (conn, done) => conn.query(`SET search_path = ${SCHEMA}, public`, (err) => done(err, conn)),
        },
      });

      // Only these two migrations, so the run is not asked to build the whole
      // app schema (no PostGIS here). They are copies of the shipped files, so
      // what runs is what ships.
      migrationsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fiberline-migrations-'));
      for (const file of ['20260101000014_cable_continuations.js', '20260101000015_repair_cable_continuations.js']) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(migrationsDir, file));
      }
    });

    after(async () => {
      if (!knex) return;
      try {
        await knex.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } finally {
        await knex.destroy();
        if (migrationsDir) fs.rmSync(migrationsDir, { recursive: true, force: true });
      }
    });

    test('applies 15 (14 is recorded, so it never runs again) and the column appears', async () => {
      await freshSchema();

      // The state the app reported: the ledger says 14 ran, the column is absent.
      await knex('knex_migrations').insert({
        name: '20260101000014_cable_continuations.js',
        batch: 1,
        migration_time: new Date(),
      });
      assert.equal(await knex.schema.hasColumn('cables', 'continues_cable_id'), false);

      // A split the old code made: two halves, nothing linking them.
      await knex('cables').insert([
        { code: 'CBL-F1', to_enclosure_id: MID, route: 'upstream' },
        { code: 'CBL-F1-B', from_enclosure_id: MID, route: 'upstream' },
      ]);

      const [, applied] = await migrate();
      assert.deepEqual(
        applied,
        ['20260101000015_repair_cable_continuations.js'],
        '14 is recorded, so only the repair migration may run',
      );

      assert.equal(await knex.schema.hasColumn('cables', 'continues_cable_id'), true, 'column added');

      const indexes = (await knex.raw(`SELECT indexname FROM pg_indexes
        WHERE schemaname = ? AND tablename = 'cables'`, [SCHEMA])).rows.map((r) => r.indexname);
      assert.ok(indexes.includes('cables_continues_cable_idx'), 'index added');

      const fk = (await knex.raw(`SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = ?::regclass AND c.contype = 'f' AND a.attname = 'continues_cable_id'`,
        [`${SCHEMA}.cables`])).rows;
      assert.equal(fk.length, 1, 'the foreign key is there');

      const child = await knex('cables').where({ code: 'CBL-F1-B' }).first();
      const parent = await knex('cables').where({ code: 'CBL-F1' }).first();
      assert.equal(child.continues_cable_id, parent.id, 'and the split is linked');
    });

    test('is a no-op when the column is already there', async () => {
      // Same schema, but 14 applied properly this time.
      await freshSchema();
      const migration14 = require(MIGRATION_PATH);
      await migration14.up(knex);
      await knex('cables').insert([
        { code: 'CBL-F2', to_enclosure_id: MID, route: 'upstream' },
        { code: 'CBL-F2-B', from_enclosure_id: MID, route: 'upstream' },
      ]);
      await knex('knex_migrations').insert([
        { name: '20260101000014_cable_continuations.js', batch: 1, migration_time: new Date() },
      ]);

      const [, applied] = await migrate();
      assert.deepEqual(applied, ['20260101000015_repair_cable_continuations.js']);

      const child = await knex('cables').where({ code: 'CBL-F2-B' }).first();
      const parent = await knex('cables').where({ code: 'CBL-F2' }).first();
      assert.equal(child.continues_cable_id, parent.id, 'the pair is linked exactly once');

      const [{ count }] = await knex('cables').where({ continues_cable_id: parent.id }).count();
      assert.equal(Number(count), 1, 'no fan-out from running the rule twice');
    });

    test('on a fresh database both migrations run in order', async () => {
      await freshSchema();
      await knex('cables').insert([
        { code: 'CBL-F3', to_enclosure_id: MID, route: 'upstream' },
        { code: 'CBL-F3-B', from_enclosure_id: MID, route: 'upstream' },
      ]);

      const [, applied] = await migrate();
      assert.deepEqual(applied, [
        '20260101000014_cable_continuations.js',
        '20260101000015_repair_cable_continuations.js',
      ]);
      assert.equal(await knex.schema.hasColumn('cables', 'continues_cable_id'), true);

      const child = await knex('cables').where({ code: 'CBL-F3-B' }).first();
      const parent = await knex('cables').where({ code: 'CBL-F3' }).first();
      assert.equal(child.continues_cable_id, parent.id);
    });
  },
);

// --- database checks: opt-in via TEST_DATABASE_URL ---------------------------

describe(
  'migration 14 against a real database',
  { skip: URL ? false : 'set TEST_DATABASE_URL to run these (see the file header)' },
  () => {
    let knex;
    const ids = {};
    const MID = '11111111-1111-1111-1111-111111111111';

    before(async () => {
      const knexFactory = require('knex');
      knex = knexFactory({
        client: 'pg',
        connection: URL,
        // One connection, with a fixed search_path, so everything this file
        // touches lives in the scratch schema.
        pool: {
          min: 1,
          max: 1,
          afterCreate: (conn, done) => conn.query(`SET search_path = ${SCHEMA}, public`, (err) => done(err, conn)),
        },
      });

      await knex.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await knex.raw(`CREATE SCHEMA ${SCHEMA}`);
      await knex.raw(`SET search_path = ${SCHEMA}, public`);

      const hasPostgis = (
        await knex.raw(`SELECT COUNT(*)::int AS n FROM pg_extension WHERE extname = 'postgis'`)
      ).rows[0].n;
      if (!hasPostgis) {
        // Enough of PostGIS to run the migration's SQL unchanged. The route
        // text drives the stub: anything containing 'far' is "too far apart".
        await knex.raw(`
          CREATE DOMAIN geometry AS text;
          CREATE DOMAIN geography AS text;
          CREATE FUNCTION st_startpoint(geometry) RETURNS text AS $$ SELECT $1 $$ LANGUAGE sql;
          CREATE FUNCTION st_dwithin(geography, geography, double precision) RETURNS boolean
            AS $$ SELECT NOT ($1 LIKE '%far%' OR $2 LIKE '%far%') $$ LANGUAGE sql;
        `);
      }

      // The world before migration 14: a cables table with no continues_cable_id.
      const routeType = hasPostgis ? 'geography(LineString, 4326)' : 'text';
      await knex.raw(`
        CREATE TABLE cables (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          code text UNIQUE NOT NULL,
          cable_type text NOT NULL DEFAULT 'feeder',
          core_count integer NOT NULL DEFAULT 12,
          from_enclosure_id uuid,
          to_enclosure_id uuid,
          route ${routeType}
        );
      `);

      const insert = async (code, extra = {}) => {
        const [row] = await knex('cables')
          .insert({
            code,
            from_enclosure_id: extra.from ?? null,
            to_enclosure_id: extra.to ?? null,
            route: hostRoute(extra.route, hasPostgis),
            cable_type: extra.cable_type ?? 'feeder',
          })
          .returning('id');
        return row.id;
      };

      ids.upstream = await insert('CBL-F1', { to: MID, route: 'upstream' });
      ids.split = await insert('CBL-F1-B', { from: MID, route: 'upstream' });
      ids.orphan = await insert('CBL-F2-B', { from: MID, route: 'upstream' });
      await insert('CBL-F3', { to: MID, route: 'upstream' });
      ids.farChild = await insert('CBL-F3-B', { from: MID, route: 'far-away' });
      ids.routelessParent = await insert('CBL-F4', { to: MID, route: null });
      ids.routelessChild = await insert('CBL-F4-B', { from: MID, route: 'upstream' });
      await insert('CBL-F5', { to: MID, route: 'upstream' });
      ids.dropChild = await insert('CBL-F5-B', { from: MID, route: 'upstream', cable_type: 'drop' });
      ids.decoy = await idSearch(knex, 'CBL-F3');
    });

    /** With PostGIS the route is a geography; the stub mode keeps the text. */
    function hostRoute(route, hasPostgis) {
      if (route == null) return null;
      if (!hasPostgis) return route;
      // A real LineString: two points a few metres apart for 'upstream', two
      // points a kilometre apart for 'far-away'. The migration compares the
      // parent's route against the child's start point.
      const coordinates = route.includes('far')
        ? [[71.4, 34.0], [71.414, 34.0]]
        : [[71.4, 34.0], [71.4001, 34.0]];
      return knex.raw('ST_SetSRID(ST_GeomFromGeoJSON(?), 4326)::geography', [
        JSON.stringify({ type: 'LineString', coordinates }),
      ]);
    }

    async function idSearch(client, code) {
      const row = await client('cables').where({ code }).first();
      return row?.id ?? null;
    }

    after(async () => {
      if (!knex) return;
      try {
        await knex.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } finally {
        await knex.destroy();
      }
    });

    test('runs, links the unambiguous split, and leaves everything else alone', async () => {
      const migration = require(MIGRATION_PATH);
      await migration.up(knex);

      const linkOf = async (id) => (await knex('cables').where({ id }).first()).continues_cable_id;

      assert.equal(await linkOf(ids.split), ids.upstream, 'the split links to its upstream half');
      assert.equal(await linkOf(ids.orphan), null, 'a cable with no matching parent stays unlinked');
      assert.equal(await linkOf(ids.farChild), null, 'halves too far apart stay unlinked');
      assert.equal(await linkOf(ids.routelessChild), ids.routelessParent, 'a route-less parent still links');
      assert.equal(await linkOf(ids.dropChild), null, 'a drop cable is never a split half');

      const [{ count }] = await knex('cables').where({ continues_cable_id: ids.upstream }).count();
      assert.equal(Number(count), 1, 'no fan-out: exactly one child links to the upstream cable');

      const columns = await knex.raw(
        `SELECT COUNT(*)::int AS n FROM information_schema.columns
         WHERE table_name = 'cables' AND column_name = 'continues_cable_id'`,
      );
      assert.equal(columns.rows[0].n, 1, 'the column exists');
    });

    test('is idempotent — a second run changes nothing', async () => {
      const migration = require(MIGRATION_PATH);
      const before = await knex('cables').select('id', 'continues_cable_id').orderBy('code');

      await knex('cables').where({ id: ids.split }).update({ continues_cable_id: ids.decoy });
      await migration.up(knex);

      const after = await knex('cables').select('id', 'continues_cable_id').orderBy('code');
      const changed = after.filter((row, i) => row.continues_cable_id !== before[i].continues_cable_id);
      assert.deepEqual(
        changed.map((row) => row.continues_cable_id),
        [ids.decoy],
        'the re-run must not overwrite an existing link (and must not add any)',
      );
    });

    test('down() removes the column', async () => {
      const migration = require(MIGRATION_PATH);
      await migration.down(knex);
      assert.equal(await knex.schema.hasColumn('cables', 'continues_cable_id'), false);
      // leave the schema in the migrated state for any later run in this file
      await migration.up(knex);
    });
  },
);
