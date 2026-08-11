exports.up = async function (knex) {
  // Allow enclosures to be placed at customer locations (not just on poles)
  // Make pole_id nullable and add location column for customer enclosures
  // First drop the existing constraint, then modify the column
  await knex.schema.alterTable('enclosures', (table) => {
    table.geography('location', 'POINT', 4326);
  });
  // Drop the NOT NULL constraint on pole_id
  await knex.schema.alterTable('enclosures', (table) => {
    table.uuid('pole_id').nullable().alter();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('enclosures', (table) => {
    table.dropColumn('location');
  });
  // Re-add NOT NULL constraint (only if there are no customer enclosures)
  await knex.schema.alterTable('enclosures', (table) => {
    table.uuid('pole_id').notNullable().alter();
  });
};
