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
    // Not a broken feature: without the column the links are inferred from the
    // naming convention the insert route writes (utils/continuationLinks.js), so
    // this is a notice about how the links are known, not a warning that they
    // are missing. Callers can filter on `severity`.
    severity: 'notice',
    disabled:
      'mid-span links are inferred from cable naming (a downstream cable named "<upstream code>-B" ' +
      'starting where the upstream one ends) instead of being recorded',
    // What to do about it. Deliberately not "run npm run migrate": on a database
    // whose ledger already lists the migration, re-running it changes nothing,
    // and pointing at the diagnostic is the one instruction that is always right.
    remedy:
      'The API applies pending migrations and adds this column when it starts ' +
      '(src/utils/schemaBootstrap.js) — seeing this message means that pass could not do it: ' +
      'the database user may lack rights to ALTER the table, or SCHEMA_BOOTSTRAP is set to off. ' +
      'Run "npm run db:schema" in backend/ for the exact step for this database (the column comes ' +
      'from 20260101000014_cable_continuations.js).',
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
 * Read a Postgres array as a JS array, whether or not the driver parsed it.
 *
 * `information_schema.columns.column_name` is a domain over `name`
 * (`information_schema.sql_identifier`), and `array_agg` over a domain produces
 * `sql_identifier[]` — an array type with its own OID that node-postgres has no
 * parser for, so it hands back the raw literal, `"{continues_cable_id}"`. A Set
 * built from that string holds single characters, `has()` answers false, and the
 * app concludes a column that is right there does not exist: it infers links it
 * should have read, and warns about a missing column on every database that has
 * it. (Found exactly that way: `GET /api/cables` returned a recorded link with
 * `continuation_inferred: true`.)
 *
 * The SQL below now casts to text so the driver parses it; this function keeps
 * the answer honest for any other shape it might arrive in — a stub in a test,
 * an older driver, or a future column type doing the same thing.
 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  // Postgres array literal: {a,b}, with quoting/escaping for odd names.
  const body = value.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  if (!body.trim()) return [];
  return body
    .match(/"(?:[^"\\]|\\.)*"|[^,]+/g)
    ?.map((part) => part.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"')) ?? [];
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
             SELECT array_agg(column_name::text)
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
  const present = new Set(asArray(row?.columns));

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
      severity: 'warning',
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
        severity: known.severity || 'warning',
        message:
          known.severity === 'notice'
            ? `${known.feature}: this database has no ${known.table}.${known.column}, so ` +
              `${known.disabled}. ${known.remedy || ''}`.trim()
            : `${known.feature} are off: this database has no ` +
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
  asArray,
  connectionTarget,
  probe,
  schemaCapabilities,
  hasContinuationLinks,
  migrationWarning,
  resetSchemaCache,
};
