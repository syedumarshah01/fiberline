/**
 * Ensure the mid-span cable link exists — a repair pass for a database where
 * migration 20260101000014 did not take effect.
 *
 * 14 introduced `cables.continues_cable_id` plus the backfill that joins the two
 * halves of a split made before the link existed. Its first version failed on
 * real databases (it aggregated a uuid: `MIN(p.id)` → "function min(uuid) does
 * not exist"), and a database can end up with its ledger and its reality
 * disagreeing — `npm run db:schema` reports "the ledger says these are applied,
 * but the columns are missing", `npm run migrate` answers "Already up to date",
 * and the app keeps warning that the column is absent. A recorded migration
 * never runs again, so the migration system alone cannot get out of that state.
 *
 * This migration does the same work unconditionally, and every step checks
 * before it acts:
 *
 *   * add `cables.continues_cable_id` if it is not there (uuid, FK to cables.id,
 *     ON DELETE SET NULL — deleting one half must not delete the other);
 *   * create its index if it is not there;
 *   * add the foreign key if the column exists without one, clearing any
 *     dangling reference first so the constraint can be validated;
 *   * link the halves of any split that is still unlinked (the same rule as 14);
 *   * and verify the column really is there afterwards, so this can never report
 *     success while leaving the database as it found it.
 *
 * On a database where 14 applied cleanly, this migration changes nothing.
 */
const COLUMN = 'continues_cable_id';
const INDEX = 'cables_continues_cable_idx';

/** Is there any foreign key on cables.continues_cable_id already? */
async function foreignKeyOnColumn(knex) {
  const result = await knex.raw(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_attribute a
         ON a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'cables'::regclass
        AND c.contype = 'f'
        AND a.attname = ?`,
    [COLUMN],
  );
  return result?.rows?.[0]?.conname ?? null;
}

/**
 * The backfill. Identical rule — and identical SQL — to migration 14, kept in
 * step by tests/migrationSql.test.js ("the two migrations link on the same
 * rule"): the downstream half starts exactly where the upstream one ends, shares
 * its type and core count, and is named `<upstream code>-B`, with the split
 * points within 25 m when both routes have geometry. `cables.code` is UNIQUE, so
 * at most one parent can match and the UPDATE cannot fan out.
 *
 * Guarded in its own savepoint: if it ever fails on someone's data, the column
 * (the part the application needs) still lands, and the failure is reported.
 */
async function backfill(knex) {
  try {
    const linked = await knex.transaction(async (trx) =>
      trx.raw(`
        UPDATE cables AS child
        SET continues_cable_id = parent.id
        FROM cables AS parent
        WHERE parent.to_enclosure_id = child.from_enclosure_id
          AND parent.cable_type = child.cable_type
          AND parent.core_count = child.core_count
          AND parent.id <> child.id
          AND child.code = parent.code || '-B'
          AND child.cable_type <> 'drop'
          AND child.continues_cable_id IS NULL
          AND (
            parent.route IS NULL
            OR child.route IS NULL
            OR ST_DWithin(
                 parent.route,
                 ST_StartPoint(child.route::geometry)::geography,
                 25
               )
          )
      `),
    );
    const count = linked?.rowCount ?? 0;
    if (count) {
      console.log(`  linked ${count} mid-span split(s) to their upstream cable`);
    }
    return count;
  } catch (err) {
    console.warn('  ! Could not link the mid-span splits that already exist:');
    console.warn(`      ${err.message}`);
    console.warn('    The column is in place, so new splits record their link exactly.');
    console.warn('    For the ones already there: npm run db:link-splits -- --apply');
    return 0;
  }
}

exports.up = async function (knex) {
  // 1. The column itself.
  if (await knex.schema.hasColumn('cables', COLUMN)) {
    console.log(`  cables.${COLUMN} already exists — keeping it`);
  } else {
    await knex.schema.alterTable('cables', (table) => {
      table
        .uuid(COLUMN)
        // Deleting either half must not delete the other — the remaining half is
        // still a real cable, it just stops claiming a continuation.
        .references('id')
        .inTable('cables')
        .onDelete('SET NULL');
    });
    console.log(`  added cables.${COLUMN}`);
  }

  // 2. The index.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${INDEX} ON cables (${COLUMN});`);

  // 3. The foreign key, if the column somehow arrived without it.
  if (!(await foreignKeyOnColumn(knex))) {
    // A constraint cannot be added over rows that point at a cable that no
    // longer exists; those references are meaningless anyway, so clear them
    // rather than refusing to repair the column.
    const cleared = await knex.raw(`
      UPDATE cables
      SET ${COLUMN} = NULL
      WHERE ${COLUMN} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cables AS other WHERE other.id = cables.${COLUMN})
    `);
    const clearedCount = cleared?.rowCount ?? 0;
    if (clearedCount) {
      console.warn(
        `  ! cleared ${clearedCount} dangling ${COLUMN} reference(s) so the foreign key can be validated`,
      );
    }
    await knex.raw(
      `ALTER TABLE cables
         ADD CONSTRAINT cables_${COLUMN}_foreign
         FOREIGN KEY (${COLUMN}) REFERENCES cables(id) ON DELETE SET NULL;`,
    );
    console.log(`  added the foreign key on cables.${COLUMN}`);
  }

  // 4. Link what is still unlinked.
  await backfill(knex);

  // 5. Never report success without the thing this migration exists for.
  if (!(await knex.schema.hasColumn('cables', COLUMN))) {
    throw new Error(
      `cables.${COLUMN} is still missing after the repair migration ran — ` +
        'check the database user can ALTER this table.',
    );
  }
};

exports.down = async function (knex) {
  // The inverse of the schema this migration ensures — which 14 also owns, so a
  // one-step rollback of 15 alone leaves 14 recorded without its column. Roll
  // both back (knex migrate:rollback with two steps) rather than just this one.
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX};`);
  if (await knex.schema.hasColumn('cables', COLUMN)) {
    await knex.schema.alterTable('cables', (table) => {
      table.dropColumn(COLUMN);
    });
  }
};
