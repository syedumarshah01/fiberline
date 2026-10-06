exports.up = async function (knex) {
  await knex.schema.createTable('as_built_approvals', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('enclosure_id')
      .references('id')
      .inTable('enclosures')
      .onDelete('CASCADE')
      .notNullable();
    table.string('change_type').notNullable();
    table.text('summary').notNullable();
    table.string('submitted_by').notNullable();
    table.string('submitted_role').notNullable().defaultTo('technician');
    table.string('status').notNullable().defaultTo('pending');
    table.jsonb('before_snapshot').notNullable();
    table.jsonb('submitted_snapshot').notNullable();
    table.string('before_revision').notNullable();
    table.string('after_revision').notNullable();
    table.string('reviewed_by');
    table.text('review_comment');
    table.timestamp('reviewed_at', { useTz: true });
    table.timestamps(true, true);

    table.index(['enclosure_id', 'status']);
    table.index(['status', 'created_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('as_built_approvals');
};
