/**
 * Mid-span cable links, with or without the column.
 *
 * Inserting a closure mid-span cuts one cable row into two; the halves are one
 * fiber, and migration 20260101000014 records that in
 * `cables.continues_cable_id`. But a database can be without that column — the
 * migration not applied yet, or the role not allowed to ALTER the table — and
 * the fiber is still one fiber. So the app asks for the links and gets them
 * either way:
 *
 *   * column present → the recorded links, exactly (never guessed);
 *   * column absent  → links inferred from the same rule migration 14's
 *     backfill uses: a downstream cable named `<upstream code>-B` that starts
 *     where the upstream one ends, same cable type and core count, not a drop,
 *     and — when both routes have geometry — split points within 25 m. Since
 *     `cables.code` is unique, at most one upstream cable can match.
 *
 * Inference is a fallback, not a guess about the customer's intent: it applies
 * the convention the insert-enclosure route itself writes, and callers report
 * it (`inferred: true` plus a count) so an outage report can say that the link
 * was inferred rather than recorded. `npm run db:schema` says how to record them
 * explicitly; nothing else changes.
 */
const { schemaCapabilities } = require('./schemaCapabilities');

const CABLE_FIELDS = [
  'id', 'code', 'cable_type', 'core_count',
  'from_enclosure_id', 'to_enclosure_id',
];

/**
 * The inference rule as SQL, returning the pairs that would be linked.
 *
 * `childStillUnlinked` adds `WHERE child.continues_cable_id IS NULL` — only
 * meaningful on a database that has the column (scripts/linkSplits.js uses it to
 * list what is left to link). Without the column the clause is omitted, because
 * referencing it would be the very error this module exists to avoid.
 */
function inferredPairsSql({ childStillUnlinked = false } = {}) {
  return `
    SELECT child.id  AS child_id,
           child.code AS child_code,
           parent.id  AS parent_id,
           parent.code AS parent_code
    FROM cables AS child
    JOIN cables AS parent
      ON parent.to_enclosure_id = child.from_enclosure_id
     AND parent.cable_type = child.cable_type
     AND parent.core_count = child.core_count
     AND parent.id <> child.id
     AND child.code = parent.code || '-B'
    WHERE child.cable_type <> 'drop'
      ${childStillUnlinked ? 'AND child.continues_cable_id IS NULL' : ''}
      AND (
        parent.route IS NULL
        OR child.route IS NULL
        OR ST_DWithin(
             parent.route,
             ST_StartPoint(child.route::geometry)::geography,
             25
           )
      )
  `;
}

/** The pairs the inference rule finds, as rows. */
async function loadInferredPairs(executor, { childStillUnlinked = false } = {}) {
  const result = await executor.raw(inferredPairsSql({ childStillUnlinked }));
  return result?.rows ?? [];
}

/**
 * Every mid-span continuation in the network.
 *
 * Returns maps keyed by cable id, plus the cable rows they refer to (the callers
 * need the codes and boxes to describe a step across a closure):
 *
 *   { byId, childToParent, parentToChild, inferred, pairs }
 *
 * `cables` may be passed in when the caller has already loaded the rows —
 * `CABLE_FIELDS` must be present on them.
 */
async function loadContinuationLinks({ executor = null, capabilities = null, cables = null } = {}) {
  const db = executor || require('../db');
  const caps = capabilities || (await schemaCapabilities({ executor: db }));

  // Nothing to link on a database with no schema at all; caller reports that.
  const empty = { byId: new Map(), childToParent: new Map(), parentToChild: new Map(), inferred: false, pairs: [] };
  if (caps.has_cables === false) return empty;

  const rows = cables || (await db('cables').select(...CABLE_FIELDS));
  const byId = new Map(rows.map((cable) => [cable.id, cable]));

  const hasColumn = caps.columns.continues_cable_id === true;
  let pairs = [];
  let inferred = false;

  if (hasColumn) {
    // Recorded links only — an explicit NULL means "not a continuation".
    const linked = cables
      ? rows.filter((cable) => cable.continues_cable_id)
      : await db('cables').select('id', 'continues_cable_id').whereNotNull('continues_cable_id');
    pairs = linked.map((cable) => ({ child_id: cable.id, parent_id: cable.continues_cable_id }));
  } else {
    pairs = await loadInferredPairs(db);
    inferred = true;
  }

  const childToParent = new Map();
  const parentToChild = new Map();
  for (const pair of pairs) {
    if (!pair.child_id || !pair.parent_id || pair.child_id === pair.parent_id) continue;
    // A child has one upstream half; a parent has one downstream half (unique
    // codes make both true, this is belt and braces).
    if (childToParent.has(pair.child_id)) continue;
    childToParent.set(pair.child_id, pair.parent_id);
    if (!parentToChild.has(pair.parent_id)) parentToChild.set(pair.parent_id, pair.child_id);
  }

  return { byId, childToParent, parentToChild, inferred, pairs };
}

module.exports = {
  CABLE_FIELDS,
  inferredPairsSql,
  loadInferredPairs,
  loadContinuationLinks,
};
