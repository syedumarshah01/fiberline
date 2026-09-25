/**
 * The schema probe (src/utils/schemaCapabilities.js) asks `db.raw` which newer
 * columns this database has. Test stubs that reject unknown SQL would otherwise
 * blow up on it, so they recognise it here instead of each re-spelling the
 * query — one place to keep in step with the probe.
 */
const PROBE = /information_schema\.columns/i;

/** The mid-span inference rule (utils/continuationLinks.js) asks this way. */
const INFERRED_PAIRS = /FROM cables AS child/i;

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

/**
 * Is this raw SQL the mid-span inference rule? Answer it with
 * `inferredPairs([{ child_id, parent_id }])` in the test's stub.
 */
function isInferenceQuery(sql) {
  return INFERRED_PAIRS.test(String(sql));
}

module.exports = {
  isSchemaProbe,
  isInferenceQuery,
  schemaProbeRows,
  emptyDatabaseProbeRows,
};
