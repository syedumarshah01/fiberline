exports.up = async function (knex) {
  await knex.schema.createTable('cables', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('code').unique().notNullable(); // e.g. "CBL-0001"
    table.string('name');
    table
      .enu('cable_type', ['feeder', 'distribution', 'drop'])
      .notNullable();
    table.integer('core_count').notNullable(); // e.g. 12, 24, 48, 96, or 1-2 for drops

    // A cable connects two enclosures (feeder/distribution), OR one enclosure to
    // one customer premise (drop cable) — to_enclosure_id is null in that case.
    table
      .uuid('from_enclosure_id')
      .references('id')
      .inTable('enclosures')
      .onDelete('RESTRICT')
      .notNullable();
    table
      .uuid('to_enclosure_id')
      .references('id')
      .inTable('enclosures')
      .onDelete('RESTRICT'); // nullable for drop cables

    // Only populated for drop cables (cable_type = 'drop')
    table.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    table.string('customer_label'); // physical label printed at the box/NAP, e.g. "CUST-10234"

    table.enu('status', ['planned', 'active', 'inactive', 'damaged']).defaultTo('active');
    table.decimal('length_m', 10, 2);
    table.text('notes');
    table.timestamps(true, true);
  });

  // Route geometry as a LineString so the map can draw the actual cable path.
  await knex.raw(`
    ALTER TABLE cables ADD COLUMN route geography(LineString, 4326);
  `);
  await knex.raw(`CREATE INDEX cables_route_gix ON cables USING GIST (route);`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('cables');
};
