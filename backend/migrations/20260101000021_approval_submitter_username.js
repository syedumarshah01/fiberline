exports.up = async function (knex) {
  await knex.schema.alterTable('as_built_approvals', (table) => {
    table.string('submitted_by_username', 120);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('as_built_approvals', (table) => {
    table.dropColumn('submitted_by_username');
  });
};
