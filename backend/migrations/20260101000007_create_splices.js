exports.up = async function (knex) {
  await knex.schema.createTable('splices', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('enclosure_id')
      .references('id')
      .inTable('enclosures')
      .onDelete('CASCADE')
      .notNullable();

    // The two fiber cores being joined together inside this enclosure.
    // core_a = the core coming IN, core_b = the core going OUT (documentation of
    // requirement #3: "which core fiber enters the box and which leaves it").
    table
      .uuid('core_a_id')
      .references('id')
      .inTable('fiber_cores')
      .onDelete('RESTRICT')
      .notNullable();
    table
      .uuid('core_b_id')
      .references('id')
      .inTable('fiber_cores')
      .onDelete('RESTRICT')
      .notNullable();

    table.enu('splice_type', ['fusion', 'mechanical']).defaultTo('fusion');
    table.string('tray_number');
    table.string('tray_position');
    table.decimal('loss_db', 5, 2); // splice loss reading, standard OSP documentation
    table.string('technician');
    table.date('splice_date').defaultTo(knex.fn.now());
    table.text('notes');
    table.timestamps(true, true);

    table.unique(['core_a_id', 'core_b_id']);
  });

  await knex.raw(`CREATE INDEX splices_enclosure_idx ON splices (enclosure_id);`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('splices');
};
