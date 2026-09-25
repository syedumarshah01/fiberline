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
  await knex.schema.alterTable('cables', (table) => {
    table
      .uuid('continues_cable_id')
      .references('id')
      .inTable('cables')
      // Deleting either half must not delete the other — the remaining half is
      // still a real cable, it just stops claiming a continuation.
      .onDelete('SET NULL');
  });

  await knex.raw(
    `CREATE INDEX cables_continues_cable_idx ON cables (continues_cable_id);`,
  );

  // Backfill the splits that already exist. There is no foreign key to the
  // parent in the old rows, so this is a heuristic — deliberately narrow, and
  // only applied where it is unambiguous:
  //
  //   * the child starts exactly where the parent ends,
  //   * same cable type and core count (the insert copies both),
  //   * the child was left with the name the insert route gives it by default
  //     (`<parent code>-B`),
  //   * exactly ONE parent candidate matches (no guessing between two),
  //   * if both routes have geometry, the split points are within 25 m of each
  //     other — the two halves really are the same span.
  //
  // A cable whose downstream code was chosen by hand cannot be recovered this
  // way; re-inserting it, or setting cables.continues_cable_id by hand, is the
  // fix. Splits made from now on are recorded exactly, not guessed.
  const linked = await knex.raw(`
    UPDATE cables AS child
    SET continues_cable_id = m.parent_id
    FROM (
      SELECT c.id AS child_id, MIN(p.id) AS parent_id, COUNT(*) AS candidates
      FROM cables c
      JOIN cables p
        ON p.to_enclosure_id = c.from_enclosure_id
       AND p.cable_type = c.cable_type
       AND p.core_count = c.core_count
       AND p.id <> c.id
       AND c.code = p.code || '-B'
       AND (
         p.route IS NULL
         OR c.route IS NULL
         OR ST_DWithin(
              p.route,
              ST_StartPoint(c.route::geometry)::geography,
              25
            )
       )
      WHERE c.cable_type <> 'drop'
        AND c.continues_cable_id IS NULL
      GROUP BY c.id
      HAVING COUNT(*) = 1
    ) AS m
    WHERE child.id = m.child_id
  `);

  const count = linked?.rowCount ?? 0;
  if (count) {
    // Visible in the migrate output so a silent heuristic is never assumed.
    console.log(`  linked ${count} mid-span split(s) to their upstream cable`);
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('cables', (table) => {
    table.dropColumn('continues_cable_id');
  });
};
