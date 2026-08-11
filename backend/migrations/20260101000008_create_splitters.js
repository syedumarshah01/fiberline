exports.up = async function (knex) {
  // Splitters: passive optical devices that take 1 core in and split to N cores out
  await knex.schema.createTable('splitters', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('enclosure_id')
      .references('id')
      .inTable('enclosures')
      .onDelete('CASCADE')
      .notNullable();
    table.string('name'); // e.g. "1:4 splitter tray #1"
    table.integer('split_count').notNullable().defaultTo(4); // 2, 4, or 8
    table
      .enu('splice_type', ['fusion', 'mechanical'])
      .defaultTo('fusion');
    table
      .uuid('input_core_id')
      .references('id')
      .inTable('fiber_cores')
      .onDelete('RESTRICT')
      .notNullable();
    table.decimal('loss_db', 5, 2);
    table.string('technician');
    table.date('splice_date').defaultTo(knex.fn.now());
    table.text('notes');
    table.timestamps(true, true);
  });

  await knex.raw(`CREATE INDEX splitters_enclosure_idx ON splitters (enclosure_id);`);

  // Splitter ports: the individual output cores from a splitter
  await knex.schema.createTable('splitter_ports', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('splitter_id')
      .references('id')
      .inTable('splitters')
      .onDelete('CASCADE')
      .notNullable();
    table
      .uuid('output_core_id')
      .references('id')
      .inTable('fiber_cores')
      .onDelete('RESTRICT')
      .nullable(); // Can be null when port is created but not yet assigned a core
    table.integer('port_number').notNullable(); // 1-based output port
    table.enu('status', ['active', 'inactive', 'damaged']).defaultTo('active');
    table.text('notes');
    table.timestamps(true, true);

    table.unique(['splitter_id', 'port_number']);
  });

  await knex.raw(`CREATE INDEX splitter_ports_splitter_idx ON splitter_ports (splitter_id);`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('splitter_ports');
  await knex.schema.dropTableIfExists('splitters');
};