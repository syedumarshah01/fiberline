const CORE_STATUSES = ['spare', 'in_use', 'reserved', 'damaged', 'unknown'];

exports.up = async function (knex) {
  // A core may only be selected as spare when its explicit state and its
  // relationships agree. Keep customer terminations as first-class rows so a
  // connected, non-serving fiber can be distinguished from a live customer.
  await knex.schema.createTable('terminations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('core_id')
      .references('id')
      .inTable('fiber_cores')
      .onDelete('CASCADE')
      .notNullable()
      .unique();
    table.uuid('cable_id').references('id').inTable('cables').onDelete('SET NULL');
    table.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    table.string('customer_label');
    table.timestamps(true, true);
  });

  // Preserve the existing explicit "terminated" signal before consolidating
  // the core enum to spare / in_use / reserved / damaged / unknown.
  await knex.raw(`
    INSERT INTO terminations (core_id, cable_id, customer_id, customer_label)
    SELECT fc.id, fc.cable_id, c.customer_id, c.customer_label
    FROM fiber_cores AS fc
    JOIN cables AS c ON c.id = fc.cable_id
    WHERE fc.status::text = 'terminated'
    ON CONFLICT (core_id) DO NOTHING
  `);

  // Knex's PostgreSQL enum emulation is a CHECK constraint. Remove any old
  // status constraint before mapping the old values, then install the exact
  // production vocabulary. Unknown legacy values fail closed as unknown.
  await knex.raw(`
    DO $$
    DECLARE constraint_row record;
    BEGIN
      FOR constraint_row IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'fiber_cores'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format('ALTER TABLE fiber_cores DROP CONSTRAINT %I', constraint_row.conname);
      END LOOP;
    END $$;
  `);
  await knex.raw(`
    UPDATE fiber_cores
    SET status = CASE status::text
      WHEN 'available' THEN 'spare'
      WHEN 'spare' THEN 'spare'
      WHEN 'spliced' THEN 'in_use'
      WHEN 'terminated' THEN 'in_use'
      WHEN 'in_use' THEN 'in_use'
      WHEN 'reserved' THEN 'reserved'
      WHEN 'damaged' THEN 'damaged'
      WHEN 'faulty' THEN 'damaged'
      WHEN 'unknown' THEN 'unknown'
      ELSE 'unknown'
    END
  `);
  await knex.raw(`ALTER TABLE fiber_cores ALTER COLUMN status SET DEFAULT 'unknown'`);
  await knex.raw(`
    ALTER TABLE fiber_cores
      ADD CONSTRAINT fiber_cores_status_check
      CHECK (status IN (${CORE_STATUSES.map((status) => `'${status}'`).join(', ')}))
  `);

  await knex.schema.alterTable('enclosures', (table) => {
    table.uuid('headend_id').references('id').inTable('headends').onDelete('SET NULL');
  });

  // Root boxes can be linked without guesswork. Do not choose when multiple
  // headends claim the same root enclosure.
  await knex.raw(`
    UPDATE enclosures AS e
    SET headend_id = h.id
    FROM headends AS h
    WHERE h.root_enclosure_id = e.id
      AND e.headend_id IS NULL
      AND (SELECT COUNT(*) FROM headends AS same_root
           WHERE same_root.root_enclosure_id = e.id) = 1
  `);

  await knex.schema.alterTable('splitter_ports', (table) => {
    table.boolean('disabled').notNullable().defaultTo(false);
  });
  // Existing inactive/damaged port states are an explicit administrative
  // exclusion; preserve that fact in the new availability field.
  await knex('splitter_ports').whereIn('status', ['inactive', 'damaged']).update({ disabled: true });

  await knex.schema.alterTable('splitters', (table) => {
    table.decimal('insertion_loss_db', 5, 2).nullable();
    table.boolean('disabled').notNullable().defaultTo(false);
  });
  // Existing recorded splitter loss values remain valid insertion-loss
  // measurements and are copied into the dedicated field without deleting the
  // legacy value used by existing documentation screens.
  await knex('splitters').whereNotNull('loss_db').update({ insertion_loss_db: knex.ref('loss_db') });
};

exports.down = async function (knex) {
  await knex.raw(`
    UPDATE fiber_cores AS fc
    SET status = CASE
      WHEN EXISTS (SELECT 1 FROM terminations AS t WHERE t.core_id = fc.id) THEN 'terminated'
      WHEN fc.status = 'spare' THEN 'available'
      WHEN fc.status = 'in_use' THEN 'spliced'
      WHEN fc.status = 'reserved' THEN 'reserved'
      WHEN fc.status = 'damaged' THEN 'damaged'
      ELSE 'available'
    END
  `);
  await knex.raw(`ALTER TABLE fiber_cores DROP CONSTRAINT IF EXISTS fiber_cores_status_check`);
  await knex.raw(`
    ALTER TABLE fiber_cores
      ADD CONSTRAINT fiber_cores_status_check
      CHECK (status IN ('available', 'spliced', 'terminated', 'reserved', 'damaged'))
  `);
  await knex.raw(`ALTER TABLE fiber_cores ALTER COLUMN status SET DEFAULT 'available'`);

  await knex.schema.dropTableIfExists('terminations');
  await knex.schema.alterTable('enclosures', (table) => table.dropColumn('headend_id'));
  await knex.schema.alterTable('splitter_ports', (table) => table.dropColumn('disabled'));
  await knex.schema.alterTable('splitters', (table) => {
    table.dropColumn('insertion_loss_db');
    table.dropColumn('disabled');
  });
};
