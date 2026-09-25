#!/usr/bin/env node
/**
 * Which database am I actually talking to, and is it up to date?
 *
 * Written for the failure this exists to end: the API reports a missing
 * `cables.continues_cable_id`, you are *sure* you ran `npm run migrate` — and
 * the migrate went to a different database than the API connects to (a stale
 * .env, NODE_ENV=production with DATABASE_URL, a second Postgres on another
 * port). This prints both sides of that comparison:
 *
 *   npm run db:schema
 *
 * Exit code 0 when the schema is current, 1 when something is missing — usable
 * as a pre-flight check in CI. Read-only; it never touches your data.
 */
const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');

const ROOT = path.join(__dirname, '..');
const { describeTarget } = require('./resetDb');
const { KNOWN_COLUMNS } = require('../src/utils/schemaCapabilities');

function migrationFiles(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort();
}

/**
 * Migration names as knex records them. Its FsMigrations source returns
 * `migration.file` — the name *with* the `.js` extension — so that is what the
 * ledger holds. Comparing the two by exact string was a bug: every migration
 * looked pending on a real database. Both sides are normalised instead, so a
 * ledger holding either spelling still matches.
 */
function normalized(name) {
  return String(name).replace(/\.js$/, '');
}

/** Files not yet applied, in file order. */
function pendingMigrations(files, appliedNames) {
  const applied = new Set(appliedNames.map(normalized));
  return files.filter((file) => !applied.has(normalized(file)));
}

async function main() {
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const fileConfig = require(path.join(ROOT, 'knexfile.js'));
  const config = { ...fileConfig[environment] };

  if (config.migrations?.directory && !path.isAbsolute(config.migrations.directory)) {
    config.migrations = {
      ...config.migrations,
      directory: path.join(ROOT, config.migrations.directory),
    };
  }

  console.log(`Fiberline schema check (${environment})`);
  console.log(`  target: ${describeTarget(config)}`);

  const knex = knexFactory(config);
  try {
    const [{ database, usr }] = (
      await knex.raw('SELECT current_database() AS database, current_user AS usr')
    ).rows;
    console.log(`  database: ${database} (as ${usr})`);

    // The migration ledger: what has actually been applied here. Read directly
    // rather than through knex.migrate.list() so the output does not depend on
    // the knex version.
    const hasLedger = await knex.schema.hasTable('knex_migrations');
    const applied = hasLedger
      ? (await knex('knex_migrations').select('name')).map((row) => row.name)
      : [];
    const files = migrationFiles(config.migrations?.directory);
    const pending = pendingMigrations(files, applied);

    console.log(
      `  migrations: ${applied.length} applied` +
        (pending.length ? `, ${pending.length} pending` : ', up to date') +
        (hasLedger ? '' : ' (no migration ledger — this database was never migrated)'),
    );
    for (const name of pending) console.log(`    pending: ${name}`);

    // And the columns the running code expects. A column can be missing even
    // when the ledger claims the migration ran — which is exactly why this is
    // checked separately from the ledger.
    const columns = (await knex('information_schema.columns')
      .where({ table_name: 'cables' })
      .whereIn(
        'column_name',
        KNOWN_COLUMNS.map((c) => c.column),
      )
      .select('column_name')).map((row) => row.column_name);

    const missing = KNOWN_COLUMNS.filter((known) => !columns.includes(known.column));
    // A column the app can work around (severity 'notice') must not read like a
    // broken schema — mid-span links are inferred from cable naming when
    // cables.continues_cable_id is absent (src/utils/continuationLinks.js).
    const optional = (known) => known.severity === 'notice';
    const blockingMissing = missing.filter((known) => !optional(known));
    for (const known of KNOWN_COLUMNS) {
      const present = columns.includes(known.column);
      const state = present ? 'present' : optional(known) ? 'absent (optional)' : 'MISSING';
      console.log(`  column: ${known.table}.${known.column} — ${state}`);
    }
    for (const known of missing.filter(optional)) {
      console.log(`    note: ${known.disabled} — everything that walks a fiber uses them.`);
    }

    // Mid-span links: with the column in place, say how many splits are joined
    // and list any pair that still looks unlinked — that is the difference
    // between "the migration ran" and "my inserted closure is walkable".
    let unlinkedPairs = [];
    let linkedCount = 0;
    if (columns.includes('continues_cable_id') && (await knex.schema.hasTable('cables'))) {
      try {
        const { candidatePairs, linkedCount: countLinks } = require('./linkSplits');
        linkedCount = (await countLinks(knex)) ?? 0;
        unlinkedPairs = await candidatePairs(knex);
        console.log(`  mid-span links: ${linkedCount} cable(s) continue another`);
        if (unlinkedPairs.length) {
          console.log(`  ! ${unlinkedPairs.length} pair(s) look like an unlinked split:`);
          for (const pair of unlinkedPairs.slice(0, 10)) {
            console.log(`      ${pair.child_code}  ←  ${pair.parent_code}`);
          }
          if (unlinkedPairs.length > 10) {
            console.log(`      … and ${unlinkedPairs.length - 10} more`);
          }
        }
      } catch (err) {
        console.log(`  mid-span links: unavailable (${err.message})`);
      }
    }

    // Order matters for the exit code: a pending migration is a ledger fact worth
    // exiting 1 for, even when the only thing missing is the optional column.
    if (pending.length) {
      console.log('\nFix: run "npm run migrate" in backend/, then restart the API.');
      console.log(
        '     If you already ran it, check that it used this same target ' +
          `(${describeTarget(config)}) — a different .env or NODE_ENV points at a different database.`,
      );
      return 1;
    }

    if (blockingMissing.length) {
      // The ledger says applied but the column is not there: the migration was
      // recorded without its effect landing (an interrupted run, a restored
      // dump, or a hand-edited ledger). A recorded migration never runs again,
      // so the fix is a repair migration — 15 exists for exactly this.
      const repairFile = '20260101000015_repair_cable_continuations.js';
      const repairPending = pendingMigrations([repairFile], applied).length === 1;
      console.log(
        '\nThe migration ledger says these are applied, but the columns are missing.',
      );
      if (repairPending) {
        console.log(
          'Run "npm run migrate": the repair migration (20260101000015) is pending and' +
            '\nfixes exactly this — a recorded migration never runs again, which is why' +
            '\nre-running the original one changes nothing.',
        );
      } else {
        const migrations = blockingMissing.map((m) => m.migration).join(', ');
        console.log(
          `Re-apply the effect by hand, or drop the column and run "npm run migrate" again ` +
            `(${migrations}).`,
        );
      }
      return 1;
    }

    if (unlinkedPairs.length) {
      // The schema is fine; the *data* still has splits that do not line up.
      console.log(
        '\nThe schema is up to date, but some cable halves still do not line up as one fiber.',
      );
      console.log('Run "npm run db:link-splits" to see them, then add --apply to link them.');
      return 1;
    }

    if (missing.length) {
      // Only optional columns are absent, and nothing is pending — so the ledger
      // claims the migration that adds the column already ran. The app infers
      // what it needs (src/utils/continuationLinks.js), which is why this is a
      // note and not a non-zero exit; but re-running "npm run migrate" cannot
      // help here, so it says what actually would.
      console.log(
        '\nSchema is current — nothing to do. One optional column is absent, and the app' +
          '\nworks without it:',
      );
      for (const known of missing) {
        console.log(`  ${known.table}.${known.column} — ${known.disabled}.`);
      }
      console.log(
        '\nThe ledger says the migration that adds it ran, so "npm run migrate" would change' +
          '\nnothing. To record the links by hand, add the column and link the halves:',
      );
      console.log(
        '  ALTER TABLE cables ADD COLUMN IF NOT EXISTS continues_cable_id uuid' +
          '\n    REFERENCES cables(id) ON DELETE SET NULL;',
      );
      console.log('  npm run db:link-splits -- --apply');
      return 0;
    }

    console.log('\nSchema is current — nothing to do.');
    return 0;

    return 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\nCannot connect to ${describeTarget(config)} — is Postgres running?`);
    } else if (err.code === '3D000') {
      console.error(`\nThe database does not exist yet — create it, then run "npm run migrate".`);
    } else {
      console.error(`\nSchema check failed: ${err.message}`);
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
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}

module.exports = { main, migrationFiles, pendingMigrations, normalized };
