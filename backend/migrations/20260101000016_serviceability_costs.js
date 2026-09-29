exports.up = async function (knex) {
  // The drop-cost model behind GET /api/serviceability/check. Same shape as the
  // loss-budget settings already on this table: every column is NULL-able, and
  // NULL means "use the planning default" (src/utils/dropCost.js), so changing a
  // default later moves every project that never pinned a rate — and an operator
  // who quotes different money only has to set the numbers they disagree with.
  //
  // These are *rates*, not measurements: a CSR quoting a customer needs a price
  // band, and the honest thing to show is which numbers produced it.
  await knex.schema.alterTable('project_settings', (table) => {
    table.string('currency', 8); // NULL → PKR
    table.decimal('drop_cable_cost_per_m', 10, 2); // per metre of drop cable laid
    table.decimal('labour_cost_per_drop', 10, 2); // one crew's drop installation
    table.decimal('splice_cost', 10, 2); // one fusion splice at the box
    table.decimal('splitter_cost', 10, 2); // a splitter installed or replaced
    table.decimal('extension_cost_per_m', 10, 2); // aerial build, per metre
    table.decimal('slack_pct', 5, 2); // cable consumed over measured length, %
    table.integer('max_drop_m'); // a standard drop: beyond it, it is a build
    table.integer('max_extension_m'); // beyond it, not a sales answer at all
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('project_settings', (table) => {
    table.dropColumn('currency');
    table.dropColumn('drop_cable_cost_per_m');
    table.dropColumn('labour_cost_per_drop');
    table.dropColumn('splice_cost');
    table.dropColumn('splitter_cost');
    table.dropColumn('extension_cost_per_m');
    table.dropColumn('slack_pct');
    table.dropColumn('max_drop_m');
    table.dropColumn('max_extension_m');
  });
};
