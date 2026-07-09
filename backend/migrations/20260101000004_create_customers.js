exports.up = async function (knex) {
  await knex.schema.createTable('customers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('customer_code').unique().notNullable(); // e.g. "CUST-10234"
    table.string('name').notNullable();
    table.string('phone');
    table.string('email');
    table.string('address');
    table.enu('status', ['prospect', 'active', 'suspended', 'cancelled']).defaultTo('prospect');
    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE customers ADD COLUMN location geography(Point, 4326);
  `);
  await knex.raw(`CREATE INDEX customers_location_gix ON customers USING GIST (location);`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customers');
};
