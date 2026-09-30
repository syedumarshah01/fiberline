const db = require('../db');

const MAX_SQL_LENGTH = 5000;
const MAX_ROWS = 100;
const STATEMENT_TIMEOUT_MS = 5000;

// These are the network data tables exposed to the assistant. Authentication,
// sessions, password hashes, and secrets are deliberately not in this list.
const ALLOWED_TABLES = new Set([
  'poles',
  'enclosures',
  'cables',
  'customers',
  'fiber_cores',
  'splices',
  'splitters',
  'splitter_ports',
  'headends',
  'telemetry_status',
  'as_built_approvals',
]);

const FORBIDDEN = /(?:^|\W)(?:insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|vacuum|analyze|refresh|listen|notify|set|reset|pg_sleep|dblink|lo_import|lo_export)(?:\W|$)/i;
const SENSITIVE = /(?:password|passwd|secret|token|session|credential|password_hash|submitted_snapshot)/i;

function queryError(message, code = 'READ_QUERY_REJECTED') {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function referencedTables(sql) {
  return [...sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?/gi)]
    .map((match) => match[1].toLowerCase());
}

function clampLimit(sql) {
  if (!/\blimit\b/i.test(sql)) return `${sql} LIMIT ${MAX_ROWS}`;
  return sql.replace(/\blimit\s+(\d+)/i, (_match, value) => `LIMIT ${Math.min(MAX_ROWS, Math.max(1, Number(value)))}`);
}

function validateReadOnlySql(input) {
  let sql = String(input ?? '').trim();
  if (!sql) throw queryError('A SQL query is required.');
  if (sql.length > MAX_SQL_LENGTH) throw queryError(`Query is too long; keep it under ${MAX_SQL_LENGTH} characters.`);
  if (/[;]|--|\/\*|\*\//.test(sql)) throw queryError('Only one comment-free read query is allowed.');
  if (!/^select\b/i.test(sql)) throw queryError('The database assistant may only run SELECT queries.');
  if (FORBIDDEN.test(sql) || SENSITIVE.test(sql)) throw queryError('That query contains a forbidden operation or sensitive field.');
  if (/\bunion\b|\binto\b|\bfor\s+(?:update|share)\b/i.test(sql)) throw queryError('Set operations and locking clauses are not allowed.');

  const tables = referencedTables(sql);
  if (!tables.length) throw queryError('The query must read a documented network table.');
  const unknown = [...new Set(tables.filter((table) => !ALLOWED_TABLES.has(table)))];
  if (unknown.length) throw queryError(`Table access is not allowed: ${unknown.join(', ')}.`);

  return {
    sql: clampLimit(sql),
    tables: [...new Set(tables)],
    max_rows: MAX_ROWS,
  };
}

async function runReadOnlyQuery(input, { executor = db } = {}) {
  const validated = validateReadOnlySql(input);
  const transaction = await executor.transaction();
  try {
    await transaction.raw('SET TRANSACTION READ ONLY');
    await transaction.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const result = await transaction.raw(validated.sql);
    await transaction.commit();
    const rows = (result.rows || []).slice(0, MAX_ROWS);
    return {
      tables: validated.tables,
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows,
      row_count: rows.length,
      truncated: (result.rows || []).length > MAX_ROWS,
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    const wrapped = new Error(`Read-only database query failed: ${error.message}`);
    wrapped.status = 400;
    wrapped.code = 'READ_QUERY_FAILED';
    throw wrapped;
  }
}

module.exports = {
  ALLOWED_TABLES,
  MAX_ROWS,
  validateReadOnlySql,
  runReadOnlyQuery,
};
