/**
 * The schema probe (src/utils/schemaCapabilities.js) asks `db.raw` which newer
 * columns this database has. Test stubs that reject unknown SQL would otherwise
 * blow up on it, so they recognise it here instead of each re-spelling the
 * query — one place to keep in step with the probe.
 */
const PROBE = /information_schema\.columns/i;

/** Is this raw SQL the schema probe? */
function isSchemaProbe(sql) {
  return PROBE.test(String(sql));
}

/** What the probe gets back: the mid-span column present (default) or absent. */
function schemaProbeRows(hasContinuationColumn = true) {
  return {
    rows: [
      {
        database: 'fiber_network',
        has_cables: true,
        columns: hasContinuationColumn ? ['continues_cable_id'] : [],
      },
    ],
  };
}

/** The same probe, but against a database nothing was ever migrated into. */
function emptyDatabaseProbeRows() {
  return {
    rows: [{ database: 'fiber_network', has_cables: false, columns: [] }],
  };
}

module.exports = { isSchemaProbe, schemaProbeRows, emptyDatabaseProbeRows };
