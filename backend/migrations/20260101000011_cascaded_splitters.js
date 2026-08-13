exports.up = async function (knex) {
  // Cascading splitters: a splitter's input can be the OUTPUT PORT of another
  // splitter (1:4 feeding a 1:2, typical PON distribution tree). The port gets
  // an output_splitter_id link, and the child splitter's input_core_id becomes
  // nullable (it has no fiber core input — its input is the parent's port).
  await knex.schema.alterTable('splitters', (table) => {
    table.uuid('input_core_id').nullable().alter();
  });

  await knex.schema.alterTable('splitter_ports', (table) => {
    table
      .uuid('output_splitter_id')
      .references('id')
      .inTable('splitters')
      .onDelete('SET NULL') // deleting the child splitter frees the parent port
      .nullable();
  });

  await knex.raw(`CREATE INDEX splitter_ports_child_splitter_idx ON splitter_ports (output_splitter_id);`);
};

exports.down = async function (knex) {
  // Detach any cascaded splitters first so the NOT NULL restore can't fail
  // mid-rollback on existing rows.
  await knex('splitter_ports').whereNotNull('output_splitter_id').update({ output_splitter_id: null });
  await knex('splitters').whereNull('input_core_id').del();

  await knex.schema.alterTable('splitter_ports', (table) => {
    table.dropColumn('output_splitter_id');
  });
  await knex.schema.alterTable('splitters', (table) => {
    table.uuid('input_core_id').notNullable().alter();
  });
};
