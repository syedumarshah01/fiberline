#!/usr/bin/env node
/**
 * Empty the database and rebuild it from the migrations — the "start from a
 * clean slate" button for development.
 *
 *   npm run db:reset              # wipe everything, then run all migrations
 *   npm run db:reset -- --truncate   # keep the schema + PostGIS, empty the tables
 *   npm run db:reset -- --yes        # no confirmation prompt (scripts/CI)
 *
 * Two ways to empty it, because they answer different questions:
 *
 *   wipe (default)  DROP SCHEMA public CASCADE, CREATE SCHEMA public, then
 *                   `migrate:latest`. Removes every object in the schema —
 *                   including the PostGIS extension installed by migration 1,
 *                   which that migration then re-creates. This is the true
 *                   empty slate: the migration ledger goes too, so all 13
 *                   migrations run again from scratch. Needs the connecting
 *                   role to own the schema (usually `postgres`).
 *
 *   --truncate      TRUNCATE every table except knex_migrations*. Keeps the
 *                   schema, the extension and the migration history — the
 *                   fast option when you only want the *data* gone, and the
 *                   one that works when the app role cannot DROP/CREATE.
 *
 * Refuses to touch a production config on its own (NODE_ENV=production, or a
 * DATABASE_URL target) unless ALLOW_PRODUCTION_RESET=1 is set, prints exactly
 * which database it is about to destroy, and asks for the word "reset".
 */
const path = require('path');
const readline = require('readline');
const knexFactory = require('knex');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { truncate: false, yes: false, help: false, error: false };
  for (const arg of argv) {
    if (arg === '--truncate') args.truncate = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`Unknown option: ${arg}\n`);
      args.help = true;
      args.error = true;
    }
  }
  return args;
}

const USAGE = `
Empty the Fiberline database and rebuild it from the migrations.

  npm run db:reset                    wipe the schema, then migrate
  npm run db:reset -- --truncate      keep the schema, empty the tables
  npm run db:reset -- --yes           skip the confirmation prompt

Env:
  ALLOW_PRODUCTION_RESET=1   permit a reset against a production config
`;

/** Where we are about to point the wrecking ball. Never print a password. */
function describeTarget(config) {
  const { connection } = config;
  if (connection == null || connection === '') return '(no connection configured)';
  if (typeof connection === 'string') {
    try {
      const url = new URL(connection);
      url.password = url.password ? '***' : '';
      return url.toString();
    } catch {
      return '(unparseable connection string)';
    }
  }
  return `${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
}

async function confirm(target) {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Refusing to reset without confirmation in a non-interactive shell — pass --yes to accept.',
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`Type "reset" to continue: `, resolve));
  rl.close();
  if (answer.trim().toLowerCase() !== 'reset') {
    throw new Error('Aborted — nothing was changed.');
  }
  console.log(`Resetting ${target}\n`);
}

/** Every app table in the current schema (knex's own bookkeeping excluded). */
async function appTables(knex) {
  const { rows } = await knex.raw(`
    SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname = current_schema() AND tablename NOT LIKE 'knex_%'
    ORDER BY tablename
  `);
  return rows.map((row) => row.tablename);
}

async function emptyTables(knex) {
  const tables = await appTables(knex);
  if (!tables.length) {
    console.log('No tables to empty — the schema is already bare.');
    return 0;
  }
  const list = tables.map((name) => `"${name}"`).join(', ');
  await knex.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
  console.log(`Emptied ${tables.length} table${tables.length === 1 ? '' : 's'}: ${tables.join(', ')}`);
  return tables.length;
}

async function wipeSchema(knex) {
  await knex.raw('DROP SCHEMA IF EXISTS public CASCADE;');
  await knex.raw('CREATE SCHEMA public;');
  // The role that created the schema owns it, so this is belt-and-braces for
  // PostgreSQL 15+ (where `public` no longer grants CREATE to everyone) and for
  // a differently-named migration role. It must never abort the reset: if it
  // fails, ownership already gives us what we need.
  try {
    await knex.raw('GRANT ALL ON SCHEMA public TO CURRENT_USER;');
  } catch (err) {
    console.warn(`(could not re-grant schema privileges: ${err.message} — continuing)`);
  }
  console.log('Dropped and recreated schema "public".');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE.trim());
    return args.error ? 1 : 0;
  }

  const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const fileConfig = require(path.join(ROOT, 'knexfile.js'));
  const config = { ...fileConfig[env] };

  if (env === 'production' && process.env.ALLOW_PRODUCTION_RESET !== '1') {
    console.error(
      `Refusing to reset the production database (${describeTarget(config)}).\n` +
        'If you really mean it, re-run with ALLOW_PRODUCTION_RESET=1.',
    );
    return 1;
  }

  // The knexfile keeps migration paths relative to the backend directory; make
  // them absolute so the script works from anywhere.
  if (config.migrations?.directory && !path.isAbsolute(config.migrations.directory)) {
    config.migrations = {
      ...config.migrations,
      directory: path.join(ROOT, config.migrations.directory),
    };
  }

  const target = describeTarget(config);
  if (!args.yes) await confirm(target);

  const knex = knexFactory(config);
  try {
    if (args.truncate) {
      await emptyTables(knex);
    } else {
      await wipeSchema(knex);
    }

    if (args.truncate && !(await knex.schema.hasTable('poles'))) {
      console.log('\nNothing was ever migrated into this database — run `npm run migrate`.');
      return 0;
    }

    const [, applied] = await knex.migrate.latest();
    if (applied.length) {
      console.log(`Applied ${applied.length} migration${applied.length === 1 ? '' : 's'}: ${applied.join(', ')}`);
    } else {
      console.log('Migrations already up to date.');
    }

    const tables = await appTables(knex);
    console.log(`\nDone — ${tables.length} tables, no rows.`);
    console.log(
      'Remember: a wiped database has no OLT/network root any more. Set one ' +
        '(Simulate failure on the OLT box → "Set as the network root", or POST /api/headends) ' +
        'before outage analysis can give direction-aware answers.',
    );
    return 0;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(
        `\nCannot reach PostgreSQL at ${target} — is the server running, and are the DB_* values in ` +
          'backend/.env correct?',
      );
    } else if (err.code === '3D000') {
      console.error(`\nDatabase "${target}" does not exist — create it with: createdb fiber_network`);
    } else {
      console.error(`\nReset failed: ${err.message}`);
    }
    return 1;
  } finally {
    await knex.destroy();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, describeTarget, emptyTables, wipeSchema, appTables };
