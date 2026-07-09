exports.up = async function (knex) {
  await knex.schema.createTable('poles', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('code').unique().notNullable(); // e.g. "POLE-0001", human-readable label
    table.string('name');
    table.enu('status', ['planned', 'active', 'inactive', 'damaged']).defaultTo('active');
    table.string('pole_type'); // wooden, concrete, existing-utility, etc.
    table.decimal('height_m', 5, 2);
    table.text('notes');
    table.timestamps(true, true);
  });

  // Add a PostGIS geography point column (lat/lng). Using geography(Point,4326) so
  // we get correct real-world distance calculations (ST_DWithin, ST_Distance) in meters.
  await knex.raw(`
    ALTER TABLE poles ADD COLUMN location geography(Point, 4326) NOT NULL;
  `);
  await knex.raw(`CREATE INDEX poles_location_gix ON poles USING GIST (location);`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('poles');
};
