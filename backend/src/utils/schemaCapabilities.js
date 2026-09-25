/**
 * What this database can actually do.
 *
 * New code sometimes reads a column that older databases do not have yet (the
 * latest: `cables.continues_cable_id`, migration 20260101000014). Pulling the
 * branch without running `npm run migrate` used to 503 the failure simulation
 * with a bare Postgres `42703` — technically accurate, useless in practice, and
 * it takes down a feature that has nothing to do with mid-span closures.
 *
 * So ask first, once, and degrade instead: the handful of reads that need the
 * column drop it from their SELECT, the features behind it turn off with a
 * warning that names the migration, and everything else keeps working. When the
 * column is there, nothing is skipped.
 *
 * The answer is cached (and re-checked after CACHE_TTL_MS) so a server that is
 * still running when you apply the migration picks the feature up on its own.
 */
const db = require('../db');

/** Columns this build knows how to use, and what their absence disables. */
const KNOWN_COLUMNS = [
  {
    table: 'cables',
    column: 'continues_cable_id',
    migration: '20260101000014_cable_continuations.js',
    feature: 'Mid-span cable links',
    disabled: 'failure simulation stops at an inserted closure, and the fiber trace does not step across one',
  },
];

const CACHE_TTL_MS = 30_000;

let cache = null;

/** `host:port/database` for whoever is reading the message, password never. */
function connectionTarget() {
  const environment = process.env.NODE_ENV || 'development';
  let config = null;
  try {
    config = require('../../knexfile')[environment];
  } catch {
    return '(unknown)';
  }
  const connection = config?.connection;
  if (!connection) return '(unknown)';
  if (typeof connection === 'string') {
    try {
      const url = new URL(connection);
      return `${url.host}${url.pathname}`;
    } catch {
      return '(unparseable connection string)';
    }
  }
  return `${connection.host}:${connection.port}/${connection.database}`;
}

/**
 * Ask the database which of KNOWN_COLUMNS it has. Throws only if the database
 * itself is unreachable — a missing column is a normal, expected answer here.
 */
async function probe(executor = db) {
  const names = KNOWN_COLUMNS.map((c) => `'${c.column}'`).join(', ');
  const result = await executor.raw(`
    SELECT current_database() AS database,
           to_regclass('cables') IS NOT NULL AS has_cables,
           COALESCE((
             SELECT array_agg(column_name)
             FROM information_schema.columns
             WHERE table_schema = ANY (current_schemas(false))
               AND table_name = 'cables'
               AND column_name IN (${names})
           ), '{}') AS columns
  `);
  const row = result?.rows?.[0] ?? null;
  const database = row?.database ?? null;
  // No row at all is only possible in a test stub; assume the table is there.
  const hasCables = row?.has_cables !== false;
  const present = new Set(row?.columns ?? []);

  const columns = {};
  const gaps = [];

  if (!hasCables) {
    // Nothing has run here at all — a fresh database, or the API pointed at the
    // wrong one. Say that once, rather than listing every column separately.
    for (const known of KNOWN_COLUMNS) columns[known.column] = false;
    gaps.push({
      table: 'cables',
      column: KNOWN_COLUMNS[0].column,
      migration: KNOWN_COLUMNS[0].migration,
      feature: KNOWN_COLUMNS[0].feature,
      missing_table: true,
      message:
        'This database has no "cables" table — nothing has been migrated into it. ' +
        'Run "npm run migrate" in backend/, and check "npm run db:schema" if the API ' +
        'seems to be talking to a different database than you expect.',
    });
    return {
      database,
      target: connectionTarget(),
      has_cables: false,
      columns,
      gaps,
      checked_at: new Date().toISOString(),
    };
  }
  for (const known of KNOWN_COLUMNS) {
    const has = present.has(known.column);
    columns[known.column] = has;
    if (!has) {
      gaps.push({
        ...known,
        message:
          `${known.feature} are off: this database has no ` +
          `${known.table}.${known.column}, so ${known.disabled}. Run ` +
          `"npm run migrate" in backend/ to apply ${known.migration}, then restart the API.`,
      });
    }
  }

  return {
    database,
    target: connectionTarget(),
    has_cables: true,
    columns,
    gaps,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Cached capabilities. `refresh: true` re-checks now (used by the tests and by
 * anything that just applied a migration).
 */
async function schemaCapabilities({ refresh = false, executor = db, ttlMs = CACHE_TTL_MS } = {}) {
  const fresh =
    cache && !refresh && Date.now() - new Date(cache.checked_at).getTime() < ttlMs;
  if (fresh) return cache;
  cache = await probe(executor);
  return cache;
}

/** True when the two halves of a mid-span split can be linked. */
async function hasContinuationLinks(options) {
  const capabilities = await schemaCapabilities(options);
  return capabilities.columns.continues_cable_id === true;
}

/** The one-line warning for an absent column, or null when the schema is fine. */
async function migrationWarning(options) {
  const capabilities = await schemaCapabilities(options);
  return capabilities.gaps[0]?.message ?? null;
}

/** Tests: forget what was cached. */
function resetSchemaCache() {
  cache = null;
}

module.exports = {
  KNOWN_COLUMNS,
  connectionTarget,
  probe,
  schemaCapabilities,
  hasContinuationLinks,
  migrationWarning,
  resetSchemaCache,
};
