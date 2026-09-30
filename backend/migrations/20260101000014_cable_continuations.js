/**
 * Record the physical continuation between the two halves of a mid-span split.
 *
 * Inserting a closure mid-span (`POST /cables/:id/insert-enclosure`) cuts one
 * cable row into two: the upstream half keeps its cores and now ends at the new
 * box, and a downstream half is created from that box onward. Nothing linked
 * the two rows, so every trace that walks joints — the fiber trace, the loss
 * budget, and outage analysis — stopped dead at the inserted box even though
 * the fiber inside it plainly continues. (The route auto-splices *live* cores
 * at insert time, so only paths that were already lit kept working; anything
 * documented later stopped.)
 *
 * `continues_cable_id` is that missing link: "this cable is the downstream half
 * of that one, core #n continuing as core #n". Cores pair by core_number, which
 * is how the insert route creates them.
 */
exports.up = async function (knex) {
  // Idempotent on purpose: a run that was interrupted, or a hand-applied
  // column, must not make `npm run migrate` fail with "column already exists".
  const hasColumn = await knex.schema.hasColumn('cables', 'continues_cable_id');
  if (hasColumn) {
    console.log('  cables.continues_cable_id already exists — keeping it');
  } else {
    await knex.schema.alterTable('cables', (table) => {
      table
        .uuid('continues_cable_id')
        .references('id')
        .inTable('cables')
        // Deleting either half must not delete the other — the remaining half is
        // still a real cable, it just stops claiming a continuation.
        .onDelete('SET NULL');
    });
  }

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS cables_continues_cable_idx ON cables (continues_cable_id);`,
  );

  // Backfill the splits that already exist. There is no foreign key to the
  // parent in the old rows, so this is a heuristic — deliberately narrow, and
  // only applied where it is unambiguous:
  //
  //   * the child starts exactly where the parent ends,
  //   * same cable type and core count (the insert copies both),
  //   * the child was left with the name the insert route gives it by default
  //     (`<parent code>-B`),
  //   * exactly one parent can match at all — cables.code is UNIQUE, and the
  //     candidate's code must be exactly `<child code>` minus the `-B`, so
  //     there is no second candidate to choose between,
  //   * if both routes have geometry, the split points are within 25 m of each
  //     other — the two halves really are the same span.
  //
  // Because cables.code is UNIQUE and the parent's code must be exactly
  // `<child code>` minus `-B`, at most one parent row can match: the UPDATE
  // cannot fan out, so no COUNT/MIN "exactly one candidate" guard is needed.
  // (The first version of this migration used COUNT(*) = 1 with MIN(p.id), and
  // Postgres has no min()/max() aggregate for uuid — `npm run migrate` died with
  // "function min(uuid) does not exist" on every database that already had
  // cables. The guard was unnecessary machinery; it is gone.)
  //
  // A cable whose downstream code was chosen by hand cannot be recovered this
  // way; re-inserting it, or setting cables.continues_cable_id by hand, is the
  // fix. Splits made from now on are recorded exactly, not guessed.
  //
  // The backfill is also deliberately subordinate to the column itself: it runs
  // inside a savepoint, so if this heuristic ever fails on someone's data, the
  // column and index still land (the part the code actually needs) and the
  // failure is reported as a warning instead of a broken upgrade.
  let count = 0;
  try {
    const linked = await knex.transaction(async (trx) => {
      return trx.raw(`
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
      `);
    });
    count = linked?.rowCount ?? 0;
  } catch (err) {
    console.warn('');
    console.warn('  ! Could not link the mid-span splits that already exist:');
    console.warn(`      ${err.message}`);
    console.warn('    The column was added, so any new split records its link exactly.');
    console.warn('    To retry this backfill, re-run just this migration:');
    console.warn('      npx knex migrate:down 20260101000014_cable_continuations.js');
    console.warn('      npm run migrate');
    console.warn('    (it only touches cables.continues_cable_id IS NULL), or set the');
    console.warn('    links by hand.');
    console.warn('');
  }

  if (count) {
    // Visible in the migrate output so a silent heuristic is never assumed.
    console.log(`  linked ${count} mid-span split(s) to their upstream cable`);
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS cables_continues_cable_idx;');
  if (await knex.schema.hasColumn('cables', 'continues_cable_id')) {
    await knex.schema.alterTable('cables', (table) => {
      table.dropColumn('continues_cable_id');
    });
  }
};
