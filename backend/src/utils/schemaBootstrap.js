/**
 * Bring the database up to this build, when the API starts.
 *
 * Written for the loop this ends: the code needs a column, the database does not
 * have it, the app prints a warning telling you to run `npm run migrate` — and
 * nothing makes that happen. The API is the piece that always starts, so it is
 * the piece that checks, applies the migrations that are pending, and repairs the
 * column itself when the ledger lies about them.
 *
 * Three steps, in this order:
 *
 *   1. `knex.migrate.latest()` — every migration the ledger has not recorded.
 *      On an up-to-date database this reads one table and does nothing, and if a
 *      migration is half-applied (its batch never committed) knex rolls it back
 *      and applies it again. That is exactly how a database whose migration 14
 *      "did not take" is recovered.
 *   2. The mid-span column, read like a capability rather than checked against a
 *      ledger: if `cables.continues_cable_id` is missing, apply the repair
 *      migration (its `ensure`, the same function `up` is) and link the halves of
 *      any split still unlinked. This covers the case migrations cannot: the
 *      ledger records 14 **and** 15, and the column is absent anyway.
 *   3. Link the remaining halves — splits whose code was chosen by hand, which no
 *      naming rule can recover, are left alone and only counted.
 *
 * It is deliberately forgiving. A database that is not running yet, or that the
 * user cannot ALTER, must not stop the API: the failure is reported as a warning
 * and the app keeps working the way it did (mid-span links are inferred from
 * cable naming — see utils/continuationLinks.js, which stays as the fallback it
 * has always been). What it will not do is report success without checking: both
 * the migration run and the column are read back from the database afterwards.
 *
 * Switch it off with `SCHEMA_BOOTSTRAP=off` (or `false`/`0`) — for a deploy where
 * something else owns the schema, where the user has no DDL rights, or where a
 * migration is being debugged and the API must not interfere.
 */
const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const fileConfig = require('../../knexfile');

const OFF_VALUES = new Set(['off', 'false', '0', 'no']);

/** Is the automatic pass switched off in this environment? */
function bootstrapEnabled(env = process.env) {
  return !OFF_VALUES.has(String(env.SCHEMA_BOOTSTRAP ?? '').trim().toLowerCase());
}

/**
 * The migrations directory as an absolute path against this file, not against
 * the process working directory — the same trap `scripts/schemaStatus.js` fixed,
 * and the reason a `npm run migrate` "from the wrong directory" reports success
 * and changes nothing.
 */
function migrationsDirectory(config = fileConfig) {
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const dir = config[environment]?.migrations?.directory ?? './migrations';
  return path.isAbsolute(dir) ? dir : path.join(__dirname, '..', '..', dir);
}

/** The migration files on disk that the ledger does not list, in file order. */
async function pendingMigrations(knex, directory) {
  if (!(await knex.schema.hasTable('knex_migrations'))) {
    return filesOnDisk(directory);
  }
  const applied = (await knex('knex_migrations').select('name')).map((row) =>
    String(row.name).replace(/\.js$/, ''),
  );
  const recorded = new Set(applied);
  return filesOnDisk(directory).filter((file) => !recorded.has(file.replace(/\.js$/, '')));
}

function filesOnDisk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort();
}

/**
 * The knex config with migrations pointed at this package's directory. Only the
 * migrations are touched — the connection comes from the same knexfile the app
 * uses, so this can only ever act on the database the app is about to use.
 */
function migrationConfig(knex, directory) {
  const config = knex?.client?.config ?? {};
  // Everything the app connects with — ssl, searchPath, statement timeouts — with
  // only the pool and the migrations directory changed. A startup pass that
  // connects differently from the app is a startup pass that can migrate a
  // different database.
  return {
    ...config,
    pool: { ...(config.pool ?? {}), min: 1, max: 1 },
    migrations: { ...(config.migrations ?? {}), directory },
  };
}

/**
 * Apply everything outstanding. Returns a description of what happened, so the
 * caller can decide how loudly to say it.
 */
async function runSchemaBootstrap({ knex, log = console, directory = migrationsDirectory() } = {}) {
  const summary = {
    enabled: true,
    migrations_applied: [],
    migrations_failed: [],
    column_added: false,
    splits_linked: 0,
    ok: true,
  };
  if (!knex) return { ...summary, enabled: false, ok: false, reason: 'no database connection' };

  // 1. What the ledger does not know about yet.
  try {
    const [batch, applied] = (await knex.migrate.latest({ directory })) || [];
    if (applied?.length) {
      summary.migrations_applied = applied;
      log.log(`Schema bootstrap: applied ${applied.length} migration(s) (batch ${batch})`);
      for (const name of applied) log.log(`  · ${name}`);
    }
  } catch (err) {
    summary.ok = false;
    summary.migrations_failed.push(err.message);
    log.warn('Schema bootstrap: could not apply the pending migrations:');
    log.warn(`  ${err.message}`);
    log.warn('  Run "npm run migrate" in backend/ to see the failure with the full output.');
  }

  // 2. The mid-span link, which is why this pass exists.
  try {
    const hasColumn = await knex.schema.hasColumn('cables', 'continues_cable_id');
    if (!hasColumn && (await knex.schema.hasTable('cables'))) {
      log.warn('Schema bootstrap: this database has no cables.continues_cable_id — adding it now.');
      // The repair migration's own work, called by name rather than through the
      // ledger: a recorded migration never runs again, and a column can go
      // missing while both migrations that create it are recorded.
      const repair = require('../../migrations/20260101000015_repair_cable_continuations');
      summary.splits_linked += (await repair.ensure(knex, { log })) ?? 0;
      summary.column_added = true;
      if (await knex.schema.hasColumn('cables', 'continues_cable_id')) {
        log.log('Schema bootstrap: cables.continues_cable_id is now recorded.');
      } else {
        summary.ok = false;
        log.warn('Schema bootstrap: cables.continues_cable_id is still absent after the repair.');
      }
    }

    // 3. Splits nothing links yet. Only with the column in place — the rule is
    //    written in terms of it, and without it there is nowhere to record a link.
    const canLink = await knex.schema.hasColumn('cables', 'continues_cable_id');
    if (canLink) {
      const { candidatePairs, linkPairs } = require('../../scripts/linkSplits');
      const pairs = await candidatePairs(knex);
      if (pairs.length) {
        const linked = await linkPairs(knex, pairs);
        summary.splits_linked += linked;
        summary.unlinked_splits = pairs.length - linked;
        log.log(
          `Schema bootstrap: linked ${linked} mid-span split(s) that had no link` +
            (linked < pairs.length
              ? ` — ${pairs.length - linked} could not be linked here, run "npm run db:link-splits" to see why`
              : ''),
        );
      } else {
        summary.unlinked_splits = 0;
      }
    }
  } catch (err) {
    summary.ok = false;
    log.warn(`Schema bootstrap: could not finish the mid-span link pass: ${err.message}`);
  }

  return summary;
}

/**
 * Called by the server once it is listening. Never throws: the API being up is
 * worth more than this pass being finished.
 */
async function bootstrapSchemaNow({ log = console } = {}) {
  if (!bootstrapEnabled()) {
    log.log('Schema bootstrap: skipped (SCHEMA_BOOTSTRAP is off)');
    return { enabled: false };
  }
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const directory = migrationsDirectory();
  const config = migrationConfig(require('../db'), directory);

  // Its own short-lived connection, deliberately: DDL on a pool the request
  // handlers are already using is how a startup pass locks a table under load.
  let knex;
  try {
    knex = knexFactory(config);
    return await runSchemaBootstrap({ knex, log, directory });
  } catch (err) {
    // No database yet, wrong credentials, no DDL rights — all reported, none
    // fatal. The app carries on and says what it could not do.
    log.warn(`Schema bootstrap skipped: ${err.message || err.name || 'unknown error'}`);
    return { enabled: true, ok: false, reason: err.message };
  } finally {
    if (knex) await knex.destroy().catch(() => {});
  }
}

module.exports = {
  bootstrapEnabled,
  bootstrapSchemaNow,
  runSchemaBootstrap,
  migrationsDirectory,
  pendingMigrations,
  filesOnDisk,
};
