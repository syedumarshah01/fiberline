exports.up = async function (knex) {
  await knex.schema.alterTable('enclosures', (table) => {
    // NULL means the enclosure has not been surveyed. Never translate missing
    // inventory into zero connectors during a loss-budget calculation.
    table.integer('connector_count_in').nullable();
    table.integer('connector_count_out').nullable();
  });
  await knex.raw(`
    ALTER TABLE enclosures
      ADD CONSTRAINT enclosures_connector_count_in_check
        CHECK (connector_count_in IS NULL OR connector_count_in >= 0),
      ADD CONSTRAINT enclosures_connector_count_out_check
        CHECK (connector_count_out IS NULL OR connector_count_out >= 0)
  `);
  await knex.raw(`
    COMMENT ON COLUMN enclosures.connector_count_in IS
      'Documented connector count on the incoming side; NULL means unknown, not zero.';
    COMMENT ON COLUMN enclosures.connector_count_out IS
      'Documented connector count on the outgoing side; NULL means unknown, not zero.';
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE enclosures
      DROP CONSTRAINT IF EXISTS enclosures_connector_count_in_check,
      DROP CONSTRAINT IF EXISTS enclosures_connector_count_out_check
  `);
  await knex.schema.alterTable('enclosures', (table) => {
    table.dropColumn('connector_count_in');
    table.dropColumn('connector_count_out');
  });
};
