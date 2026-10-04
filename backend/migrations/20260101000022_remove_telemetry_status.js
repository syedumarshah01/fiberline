/**
 * Remove the external telemetry snapshot table after the telemetry feature was
 * retired. The operation is idempotent so it is safe for databases that never
 * installed the earlier telemetry migration.
 */
exports.up = async function up(knex) {
  await knex.schema.dropTableIfExists('telemetry_status');
};

exports.down = async function down() {
  // Telemetry storage was intentionally retired and is not recreated on rollback.
};
