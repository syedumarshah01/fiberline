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

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '20260101000014_cable_continuations.js');
const SCHEMA = 'fiberline_migration_test';
const URL = process.env.TEST_DATABASE_URL;

// --- static checks: always run, no database needed ---------------------------

/** Drop // line comments and /* block comments *\/ so the scan sees code only. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the migration source', () => {
  test('uses no aggregate that Postgres does not have for uuid', () => {
    // Comments talk about the bug on purpose, so scan code only.
    const source = stripComments(fs.readFileSync(MIGRATION_PATH, 'utf8'));
    // min()/max() exist for numbers and text, not for uuid. COUNT(*) is fine.
    const suspicious = source.match(/\b(min|max)\s*\([^)]*\)/gi) || [];
    assert.deepEqual(
      suspicious,
      [],
      `uuid ids cannot be aggregated — found ${suspicious.join(', ')}. ` +
        'This is the exact bug that broke `npm run migrate` (MIN(p.id)).',
    );
  });

  test('guards the backfill so a heuristic failure cannot block the column', () => {
    const source = fs.readFileSync(MIGRATION_PATH, 'utf8');
    assert.match(source, /knex\.transaction\(/, 'the backfill runs in its own savepoint');
    assert.match(source, /Could not link the mid-span splits/, 'and reports its failure loudly');
  });
});

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
