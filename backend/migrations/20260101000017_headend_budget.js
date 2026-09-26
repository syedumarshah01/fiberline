exports.up = async function (knex) {
  // A headend could already say WHERE the light starts (root_enclosure_id) but
  // not WHAT it costs: the optical budget was one project-wide number
  // (project_settings.budget_db / olt_type, migration 20260101000012). That is
  // correct for a single-OLT network and wrong for the next one — a site with a
  // GPON Class B+ OLT and an XGS-PON OLT beside it needs 28 dB on one side of
  // the patch panel and 29 dB on the other, and a remediation answer that
  // compares a customer against the wrong one is worse than no answer.
  //
  // So a headend may now carry its own transport type and budget. Both are
  // overrides, not requirements: NULL means "this headend is not special" and
  // resolution falls back to project_settings, then to the planning constant for
  // the type. Networks that never set either column behave exactly as before.
  await knex.schema.alterTable('headends', (table) => {
    table.enu('olt_type', ['gpon', 'xgs_pon', 'p2p']).nullable();
    table.decimal('budget_db', 5, 2).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('headends', (table) => {
    table.dropColumn('olt_type');
    table.dropColumn('budget_db');
  });
};
