exports.up = async function (knex) {
  await knex.schema.createTable('fiber_cores', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('cable_id')
      .references('id')
      .inTable('cables')
      .onDelete('CASCADE')
      .notNullable();
    table.integer('core_number').notNullable(); // 1-based position within the cable
    table.string('buffer_tube_color'); // standard fiber color code
    table.string('core_color');
    // available: unused, ready to splice
    // spliced: fusion/mechanically spliced to another core somewhere
    // terminated: connected to a customer / equipment (end of the line)
    // reserved: earmarked for a planned install, not yet spliced
    // damaged: physically broken, unusable
    table
      .enu('status', ['available', 'spliced', 'terminated', 'reserved', 'damaged'])
      .defaultTo('available')
      .notNullable();
    table.text('notes');
    table.timestamps(true, true);

    table.unique(['cable_id', 'core_number']);
  });

  await knex.raw(`CREATE INDEX fiber_cores_status_idx ON fiber_cores (status);`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('fiber_cores');
};
