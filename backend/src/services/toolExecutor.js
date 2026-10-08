const db = require('../db');
const {
  TOOL_BY_NAME,
  validateToolCall,
} = require('../ai/toolRouterSchema');
const { lookupDocs } = require('./docsLookupRuntime');
const { checkServiceability } = require('./serviceability');
const {
  findCoreRemediation,
  findPortRemediation,
  findPowerRemediationForCore,
} = require('./remediation');
const {
  traceCore,
  analyzeOutage,
  customerConnectionPlan,
} = require('./networkTools');

const ENTITY_CHECKS = Object.freeze({
  enclosure_id: { table: 'enclosures', label: 'enclosure', codeColumn: 'code' },
  core_id: { table: 'fiber_cores', label: 'fiber core' },
});

function executionError(code, message, details = {}) {
  return { success: false, error: code, message, ...details };
}

/**
 * Explicit allowlist. The model supplies only a tool name and arguments; it
 * never supplies a module path or a function name to require(). Serviceability
 * and remediation are deterministic read-only services; documentation lookup
 * uses the offline RAG runtime and never touches the network database.
 */
const DEFAULT_HANDLERS = Object.freeze({
  checkServiceability: async (args, context = {}) => {
    const location = context.customer_location;
    const effectiveArgs = args.lat !== undefined || args.lng !== undefined || !location
      ? args
      : { ...args, lat: location.lat, lng: location.lng };
    return checkServiceability(effectiveArgs);
  },
  findPortRemediation: async (args, context = {}) =>
    findPortRemediation(args.enclosure_id, args.customer_location || context.customer_location),
  findPowerRemediation: async (args, context = {}) =>
    findPowerRemediationForCore({ ...args, customer_location: args.customer_location || context.customer_location }),
  findCoreRemediation: async (args, context = {}) =>
    findCoreRemediation(args.enclosure_id, args.customer_location || context.customer_location, {
      excludeSelf: args.exclude_self !== false,
    }),
  traceCore: async (args) => traceCore({ core_id: args.core_id }),
  simulateFailure: async ({ enclosure_id }) =>
    analyzeOutage({ kind: 'enclosure', identifier: enclosure_id }),
  locateCustomer: async (args) => customerConnectionPlan(args),
  lookupDocs,
});

// PostgreSQL UUID columns cannot accept display codes such as BOX-0002.
// Check syntax before any UUID predicate; do not restrict UUID version bits.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

async function entityExists(dbClient, table, id) {
  if (!isUuid(id)) return false;
  const row = await dbClient(table).where({ id }).first('id');
  return Boolean(row);
}

/** Resolve user-facing identifiers without changing the model's route object.
 * UUIDs are looked up as IDs. Enclosure codes use exact case-insensitive text
 * equality, not LIKE/fuzzy/name matching. Only DB-backed IDs reach handlers.
 */
async function resolveEntityArguments(args, dbClient) {
  const resolvedArgs = { ...args };
  for (const [argumentName, check] of Object.entries(ENTITY_CHECKS)) {
    if (!Object.prototype.hasOwnProperty.call(args, argumentName)) continue;
    const value = args[argumentName];
    const identifier = typeof value === 'string' ? value.trim() : '';
    if (!identifier) {
      return executionError(
        'INVALID_ARGUMENT',
        `${argumentName} must be a non-empty existing identifier.`,
        { param: argumentName },
      );
    }

    let row;
    if (isUuid(identifier)) {
      row = await dbClient(check.table).where({ id: identifier }).first('id');
    } else if (check.codeColumn) {
      // Column/table names come only from ENTITY_CHECKS; values stay bound.
      // Two matches suffice to detect case variants allowed by code's unique
      // constraint. Never choose an arbitrary enclosure from an ambiguous code.
      const matches = await dbClient(check.table)
        .whereRaw('lower(??) = lower(?)', [check.codeColumn, identifier])
        .select('id', check.codeColumn)
        .limit(2);
      if (matches.length > 1) {
        return executionError(
          'AMBIGUOUS_ENTITY',
          `More than one ${check.label} matches code "${identifier}". Use its UUID to choose a specific record.`,
          { param: argumentName, identifier, status_code: 400 },
        );
      }
      [row] = matches;
    } else {
      // fiber_cores has cable_id + core_number, but no standalone display code.
      // Never guess a core from a number or silently fabricate an ID mapping.
      return executionError(
        'INVALID_ARGUMENT',
        `${argumentName} must be an existing ${check.label} UUID. A core number or label alone does not uniquely identify a fiber core.`,
        { param: argumentName, identifier },
      );
    }

    if (!row) {
      const hint = check.codeColumn ? 'Use an existing enclosure code or UUID.' : 'Check the fiber-core UUID in the network inventory.';
      return executionError(
        'ENTITY_NOT_FOUND',
        `No ${check.label} matched "${identifier}". ${hint}`,
        { param: argumentName, identifier },
      );
    }
    resolvedArgs[argumentName] = row.id;
  }
  return { success: true, args: resolvedArgs };
}

// Preserve the validation-only helper for callers that do not execute a tool.
async function validateEntityArguments(args, dbClient) {
  const resolution = await resolveEntityArguments(args, dbClient);
  return resolution.success ? null : resolution;
}

async function executeToolCall(toolCallResult, {
  dbClient = db,
  handlers = DEFAULT_HANDLERS,
  context = {},
} = {}) {
  if (!toolCallResult || typeof toolCallResult !== 'object' || Array.isArray(toolCallResult)) {
    return executionError('INVALID_TOOL_CALL', 'The tool router result must be an object containing tool and args.', {
      raw: toolCallResult,
    });
  }

  const tool = TOOL_BY_NAME.get(toolCallResult.tool);
  if (!tool) {
    return executionError('UNKNOWN_TOOL', `Unknown tool: ${String(toolCallResult.tool)}.`, {
      raw: toolCallResult,
    });
  }

  let route;
  try {
    route = validateToolCall(toolCallResult);
  } catch (error) {
    return executionError('INVALID_TOOL_CALL', error.message, { tool: tool.name });
  }

  if (tool.read_only !== true && context.confirmed !== true) {
    return executionError(
      'CONFIRMATION_REQUIRED',
      `${tool.name} is not read-only and requires an explicit authenticated confirmation before execution.`,
      { tool: tool.name },
    );
  }

  let resolution;
  try {
    resolution = await resolveEntityArguments(route.args, dbClient);
  } catch (error) {
    // Database failures are not missing entities and must not leak raw SQL,
    // bindings or connection details into the assistant's user-facing response.
    console.warn(`[tool-executor] entity lookup failed tool=${tool.name} code=${error.code || 'UNKNOWN'}`);
    return executionError('ENTITY_LOOKUP_FAILED',
      'The network inventory could not be checked. Please try again or ask an administrator to check the database.',
      { tool: tool.name, status_code: 503 });
  }
  if (!resolution.success) return { ...resolution, tool: tool.name };

  const handler = handlers[tool.name];
  if (typeof handler !== 'function') {
    return executionError('TOOL_HANDLER_UNAVAILABLE', `No deterministic handler is registered for ${tool.name}.`, {
      tool: tool.name,
      handler: tool.handler,
    });
  }

  try {
    const result = await handler(resolution.args, context);
    if (result && result.success === false && result.error) {
      return { ...result, tool: tool.name };
    }
    return { success: true, tool: tool.name, result };
  } catch (error) {
    const safeStatusCode = Number(error.statusCode);
    return executionError(
      error.code === 'DOC_INDEX_MISSING' ? 'DOC_INDEX_MISSING' : 'TOOL_EXECUTION_FAILED',
      error.message || `The ${tool.name} handler failed.`,
      {
        tool: tool.name,
        ...(Number.isInteger(safeStatusCode) ? { status_code: safeStatusCode } : {}),
      },
    );
  }
}

module.exports = {
  DEFAULT_HANDLERS,
  ENTITY_CHECKS,
  entityExists,
  isUuid,
  resolveEntityArguments,
  executeToolCall,
  validateEntityArguments,
};
