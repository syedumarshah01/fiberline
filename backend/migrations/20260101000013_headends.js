exports.up = async function (knex) {
  // The network root: the OLT / CO / PoP site where light enters a segment.
  //
  // Every other view in the app is directionless — a splice is just an edge
  // between two cores, so "where does this fiber go" can be answered from
  // either end. Outage analysis can't: it has to know which side of a failure
  // is customer-ward, otherwise it reports every branch that happens to be
  // electrically connected as affected. A headend gives the graph a top.
  //
  // `root_enclosure_id` is the box the headend's first feeder lands in —
  // everything leaving that box (by splice or splitter port) is downstream of
  // the light source. One headend per network segment; a network with several
  // OLTs gets one row each.
  await knex.schema.createTable('headends', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('code').unique().notNullable(); // e.g. "OLT-01"
    table.string('name');
    table.enu('site_type', ['olt', 'co', 'pop', 'other']).notNullable().defaultTo('olt');
    table
      .uuid('root_enclosure_id')
      .references('id')
      .inTable('enclosures')
      .onDelete('SET NULL'); // deleting the box leaves the headend, just unrooted
    table.text('notes');
    table.timestamps(true, true);
  });

  // Where the OLT physically sits (optional, informational — the direction
  // anchor is root_enclosure_id, not this point).
  await knex.raw(`ALTER TABLE headends ADD COLUMN location geography(Point, 4326);`);

  await knex.raw(
    `CREATE INDEX headends_root_enclosure_idx ON headends (root_enclosure_id);`,
  );
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('headends');
};
