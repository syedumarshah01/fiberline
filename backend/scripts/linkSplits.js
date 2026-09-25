#!/usr/bin/env node
/**
 * Find (and optionally link) mid-span cable splits that were never joined.
 *
 * Before migration 14 nothing recorded that the two halves of a split are one
 * fiber, so a closure you inserted back then has an upstream and a downstream
 * cable that the app cannot connect. The migration backfills those pairs, but
 * only when it can be sure — and if your downstream cable was renamed, or its
 * geometry drifted more than 25 m from the parent's end, the backfill leaves it
 * alone and the failure simulation still stops at that box.
 *
 * This is the same rule, run on demand, so you can see exactly what is still
 * unlinked and fix it:
 *
 *   npm run db:link-splits              # list the pairs (read-only)
 *   npm run db:link-splits -- --apply   # link them
 *
 * The rule is deliberately strict — the child must start exactly where the
 * parent ends, with the same cable type and core count, and be named
 * `<parent code>-B` (the name the insert form fills in) — because a wrong link
 * would make the failure simulation walk down a fiber that is not there. A pair
 * that does not match it by name or geometry is reported by hand instead: set
 * `cables.continues_cable_id` on the downstream row yourself.
 */
const path = require('path');
const knexFactory = require('knex');

const ROOT = path.join(__dirname, '..');

/**
 * Pairs that match the naming + topology rule but are not linked yet.
 * Read-only: identifies the child and the parent it would be joined to, with
 * the enclosures for context.
 */
async function candidatePairs(knex) {
  const result = await knex.raw(`
    SELECT child.id            AS child_id,
           child.code          AS child_code,
           parent.id           AS parent_id,
           parent.code         AS parent_code,
           child.core_count    AS core_count,
           child.cable_type    AS cable_type,
           e.code              AS at_box_code
    FROM cables AS child
    JOIN cables AS parent
      ON parent.to_enclosure_id = child.from_enclosure_id
     AND parent.cable_type = child.cable_type
     AND parent.core_count = child.core_count
     AND parent.id <> child.id
     AND child.code = parent.code || '-B'
    LEFT JOIN enclosures AS e ON e.id = child.from_enclosure_id
    WHERE child.cable_type <> 'drop'
      AND child.continues_cable_id IS NULL
    ORDER BY child.code
  `);
  return result?.rows ?? [];
}

/** Write the links. Returns how many rows changed. */
async function linkPairs(knex, pairs) {
  let linked = 0;
  for (const pair of pairs) {
    const updated = await knex('cables')
      .where({ id: pair.child_id })
      // guard against a link appearing between the listing and the write
      .whereNull('continues_cable_id')
      .update({ continues_cable_id: pair.parent_id });
    linked += updated;
  }
  return linked;
}

/** How many cables already carry a link (0 when the column is not there yet). */
async function linkedCount(knex) {
  const hasColumn = await knex.schema.hasColumn('cables', 'continues_cable_id');
  if (!hasColumn) return null;
  const [{ count }] = await knex('cables').whereNotNull('continues_cable_id').count();
  return Number(count);
}

function parseArgs(argv) {
  const args = { apply: false, help: false, error: false, child: null, parent: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--child') args.child = argv[++i] ?? null;
    else if (arg === '--parent') args.parent = argv[++i] ?? null;
    else {
      console.error(`Unknown option: ${arg}\n`);
      args.help = true;
      args.error = true;
    }
  }
  if ((args.child && !args.parent) || (args.parent && !args.child)) {
    console.error('--child and --parent go together.\n');
    args.help = true;
    args.error = true;
  }
  return args;
}

/**
 * The one pair a rule cannot find: a downstream cable someone renamed. Looks
 * both codes up, refuses a pair that is already linked, and refuses to link a
 * cable to itself.
 */
async function linkByName(knex, { childCode, parentCode }) {
  const child = await knex('cables').where({ code: childCode }).first();
  const parent = await knex('cables').where({ code: parentCode }).first();
  if (!child) throw new Error(`No cable with code "${childCode}"`);
  if (!parent) throw new Error(`No cable with code "${parentCode}"`);
  if (child.id === parent.id) throw new Error(`"${childCode}" and "${parentCode}" are the same cable`);
  if (child.continues_cable_id) {
    throw new Error(
      `"${childCode}" already continues another cable — unlink it first ` +
        '(UPDATE cables SET continues_cable_id = NULL WHERE code = \'…\')',
    );
  }

  const updated = await knex('cables')
    .where({ id: child.id })
    .whereNull('continues_cable_id')
    .update({ continues_cable_id: parent.id });
  return { updated, child, parent };
}

const USAGE = `
Find mid-span cable splits whose two halves were never linked.

  npm run db:link-splits                        list the pairs (read-only)
  npm run db:link-splits -- --apply             link them
  npm run db:link-splits -- \
      --child CBL-F9-B --parent CBL-F9          link one pair by name

A pair is reported when the downstream cable starts where the upstream one ends,
has the same cable type and core count, and is named "<upstream code>-B". When
the downstream cable was renamed, no rule can find it — name the two halves
explicitly with --child/--parent.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE.trim());
    return args.error ? 1 : 0;
  }

  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const config = { ...require(path.join(ROOT, 'knexfile.js'))[environment] };
  const knex = knexFactory(config);

  try {
    const hasColumn = await knex.schema.hasColumn('cables', 'continues_cable_id');
    if (!hasColumn) {  // nothing can be linked without migration 14
      console.error(
        'This database has no cables.continues_cable_id column yet — nothing can be linked.\n' +
          'Run "npm run migrate" first (migration 20260101000014 adds it and backfills).',
      );
      return 1;
    }

    // An explicit pair, for the cases no rule can infer.
    if (args.child) {
      const { updated, child, parent } = await linkByName(knex, {
        childCode: args.child,
        parentCode: args.parent,
      });
      if (!updated) {
        console.error(`Nothing changed — "${args.child}" was linked in the meantime.`);
        return 1;
      }
      console.log(
        `Linked ${child.code} (core #n → core #n) to ${parent.code}.` +
          '\nRestart the API (or wait 30 s) so the failure simulation picks it up.',
      );
      return 0;
    }

    const linked = await linkedCount(knex);
    const pairs = await candidatePairs(knex);

    console.log(`Already linked: ${linked} cable${linked === 1 ? '' : 's'} continues another.`);
    if (!pairs.length) {
      console.log('No unlinked split pairs found — nothing to do.');
      return 0;
    }

    console.log(`\n${pairs.length} unlinked pair${pairs.length === 1 ? '' : 's'} — ` +
      'these look like a mid-span split the app cannot walk across:');
    for (const pair of pairs) {
      console.log(
        `  ${pair.child_code} (${pair.cable_type}, ${pair.core_count} cores` +
          `${pair.at_box_code ? `, from ${pair.at_box_code}` : ''})` +
          `  ←  ${pair.parent_code}`,
      );
    }

    if (!args.apply) {
      console.log('\nNothing changed (dry run). Re-run with --apply to link them:');
      console.log('  npm run db:link-splits -- --apply');
      return 0;
    }

    const updated = await linkPairs(knex, pairs);
    console.log(`\nLinked ${updated} cable${updated === 1 ? '' : 's'}.`);
    console.log('Restart the API (or wait 30 s) so the failure simulation picks it up.');
    return 0;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('Cannot reach the database — is Postgres running?');
    } else if (err.code === '42P01') {
      console.error('The cables table does not exist — run "npm run migrate" first.');
    } else {
      console.error(`Failed: ${err.message}`);
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

module.exports = { candidatePairs, linkPairs, linkByName, linkedCount, parseArgs };
