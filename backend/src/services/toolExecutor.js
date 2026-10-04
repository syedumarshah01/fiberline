const db = require('../db');
const {
  TOOL_BY_NAME,
  validateToolCall,
} = require('../ai/toolRouterSchema');
const { findNearestSource } = require('./capacityGraph');
const { lookupDocs } = require('./docsLookupRuntime');
const {
  traceCore,
  analyzeOutage,
  customerConnectionPlan,
} = require('./networkTools');

const ENTITY_CHECKS = Object.freeze({
  enclosure_id: { table: 'enclosures', label: 'enclosure' },
  core_id: { table: 'fiber_cores', label: 'fiber core' },
});

function executionError(code, message, details = {}) {
  return { success: false, error: code, message, ...details };
}

function unavailableHandler(name) {
  return async () => executionError(
    'TOOL_HANDLER_UNAVAILABLE',
    `The deterministic handler for ${name} is not available in this build.`,
  );
}

/**
 * Explicit allowlist. The model supplies only a tool name and arguments; it
 * never supplies a module path or a function name to require().
 *
 * Serviceability and remediation remain explicit unavailable handlers until
 * their domain services exist. Documentation lookup is wired to the offline
 * RAG runtime and never touches the network database.
 */
const DEFAULT_HANDLERS = Object.freeze({
  checkServiceability: unavailableHandler('checkServiceability'),
  findPortRemediation: unavailableHandler('findPortRemediation'),
  findPowerRemediation: unavailableHandler('findPowerRemediation'),
  findCoreRemediation: async ({ enclosure_id, exclude_self = true }) =>
    findNearestSource(enclosure_id, { excludeSelf: exclude_self }),
  traceCore: async (args) => traceCore({ core_id: args.core_id }),
  simulateFailure: async ({ enclosure_id }) =>
    analyzeOutage({ kind: 'enclosure', identifier: enclosure_id }),
  locateCustomer: async (args) => customerConnectionPlan(args),
  lookupDocs,
});

async function entityExists(dbClient, table, id) {
  const row = await dbClient(table).where({ id }).first('id');
  return Boolean(row);
}

async function validateEntityArguments(args, dbClient) {
  for (const [argumentName, check] of Object.entries(ENTITY_CHECKS)) {
    if (!Object.prototype.hasOwnProperty.call(args, argumentName)) continue;
    const identifier = args[argumentName];
    if (typeof identifier !== 'string' || !identifier.trim()) {
      return executionError(
        'INVALID_ARGUMENT',
        `${argumentName} must be a non-empty existing identifier.`,
        { param: argumentName },
      );
    }
    if (!(await entityExists(dbClient, check.table, identifier))) {
      return executionError(
        'ENTITY_NOT_FOUND',
        `${check.label} ${identifier} was not found. It may be hallucinated; ask the user to confirm the identifier or location.`,
        { param: argumentName, identifier },
      );
    }
  }
  return null;
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

  const entityError = await validateEntityArguments(route.args, dbClient);
  if (entityError) return { ...entityError, tool: tool.name };

  const handler = handlers[tool.name];
  if (typeof handler !== 'function') {
    return executionError('TOOL_HANDLER_UNAVAILABLE', `No deterministic handler is registered for ${tool.name}.`, {
      tool: tool.name,
      handler: tool.handler,
    });
  }

  try {
    const result = await handler(route.args, context);
    if (result && result.success === false && result.error) {
      return { ...result, tool: tool.name };
    }
    return { success: true, tool: tool.name, result };
  } catch (error) {
    return executionError('TOOL_EXECUTION_FAILED', error.message || `The ${tool.name} handler failed.`, {
      tool: tool.name,
    });
  }
}

module.exports = {
  DEFAULT_HANDLERS,
  ENTITY_CHECKS,
  entityExists,
  executeToolCall,
  validateEntityArguments,
};
