/**
 * Current OLT/ONT telemetry state. The table is intentionally a snapshot,
 * rather than an unbounded event log: external systems may POST repeated
 * status events and the map only needs the latest state for each device.
 * `payload` keeps the original event for audit/debugging without making the
 * renderer depend on vendor-specific fields.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('telemetry_status', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('source').notNullable().defaultTo('external');
    table.string('external_id').notNullable();
    table.string('device_type').notNullable().defaultTo('ont');
    table.string('status').notNullable().defaultTo('unknown');
    table.decimal('signal_dbm', 8, 3);
    table.decimal('signal_threshold_dbm', 8, 3);
    table.timestamp('reported_at', { useTz: true }).notNullable();
    table.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Resolved network references. They are nullable because an event can be
    // useful before the inventory has been fully tagged.
    table.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    table.uuid('enclosure_id').references('id').inTable('enclosures').onDelete('SET NULL');
    table.uuid('cable_id').references('id').inTable('cables').onDelete('SET NULL');
    table.uuid('core_id').references('id').inTable('fiber_cores').onDelete('SET NULL');
    table.string('customer_identifier');
    table.string('enclosure_identifier');
    table.string('cable_identifier');
    table.string('core_identifier');
    table.decimal('lat', 10, 7);
    table.decimal('lng', 10, 7);
    table.jsonb('payload').notNullable().defaultTo('{}');

    table.unique(['source', 'external_id']);
    table.index(['status']);
    table.index(['reported_at']);
    table.index(['enclosure_id']);
    table.index(['cable_id']);
    table.index(['customer_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('telemetry_status');
};
