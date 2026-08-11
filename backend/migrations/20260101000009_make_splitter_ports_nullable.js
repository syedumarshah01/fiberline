exports.up = async function (knex) {
  // Allow output_core_id to be null so splitter ports can be created
  // before a core is assigned (for later splicing to customer drops)
  await knex.schema.alterTable('splitter_ports', (table) => {
    table.uuid('output_core_id').nullable().alter();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('splitter_ports', (table) => {
    table.uuid('output_core_id').notNullable().alter();
  });
};