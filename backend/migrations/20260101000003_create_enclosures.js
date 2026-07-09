exports.up = async function (knex) {
  await knex.schema.createTable('enclosures', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('code').unique().notNullable(); // e.g. "BOX-0001"
    table.string('name');
    table
      .uuid('pole_id')
      .references('id')
      .inTable('poles')
      .onDelete('CASCADE')
      .notNullable();
    table
      .enu('type', ['splice_closure', 'cabinet', 'nap', 'handhole', 'terminal'])
      .notNullable();
    // Total physical splice tray / port capacity of this box (informational; real
    // availability is derived from fiber_cores/splices, not this number).
    table.integer('capacity').notNullable().defaultTo(0);
    table.enu('status', ['planned', 'active', 'inactive', 'full']).defaultTo('active');
    table.string('mounting'); // pole-mounted, pedestal, underground
    table.text('notes');
    table.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('enclosures');
};
