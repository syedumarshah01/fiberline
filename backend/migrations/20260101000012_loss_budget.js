exports.up = async function (knex) {
  // Fiber attenuation for loss-budget math (cable length × dB/km). NULL means
  // "use the project default" (0.35 dB/km — G.652 singlemode @ 1310 nm), so a
  // future change to the planning default propagates to every cable that was
  // never given an explicit override.
  await knex.schema.alterTable('cables', (table) => {
    table.decimal('attenuation_db_per_km', 5, 2).nullable();
  });

  // Single-row project settings for the loss budget: which OLT/transport type
  // this network runs (drives the optical budget constant) plus optional
  // per-project overrides of the budget and the safety margin. The row is
  // created lazily by the backend — no seed step needed.
  await knex.schema.createTable('project_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.enu('olt_type', ['gpon', 'xgs_pon', 'p2p']).notNullable().defaultTo('gpon');
    table.decimal('budget_db', 5, 2); // NULL → OLT_BUDGETS_DB[olt_type]
    table.decimal('safety_margin_db', 4, 2); // NULL → DEFAULT_SAFETY_MARGIN_DB
    table.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('project_settings');
  await knex.schema.alterTable('cables', (table) => {
    table.dropColumn('attenuation_db_per_km');
  });
};
