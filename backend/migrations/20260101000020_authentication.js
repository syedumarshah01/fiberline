exports.up = async function (knex) {
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('username', 120).notNullable().unique();
    table.text('password_hash').notNullable();
    table.string('role', 32).notNullable().defaultTo('technician');
    table.boolean('active').notNullable().defaultTo(true);
    table.timestamp('last_login_at', { useTz: true });
    table.timestamps(true, true);
    table.index(['active', 'role']);
  });

  await knex.schema.createTable('auth_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('user_id')
      .references('id')
      .inTable('users')
      .onDelete('CASCADE')
      .notNullable();
    table.string('token_hash', 128).notNullable().unique();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('last_seen_at', { useTz: true }).notNullable();
    table.string('ip_address', 64);
    table.text('user_agent');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['user_id', 'expires_at']);
    table.index('expires_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('auth_sessions');
  await knex.schema.dropTableIfExists('users');
};
