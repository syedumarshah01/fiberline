const fs = require('node:fs');
const path = require('node:path');

const TOOLS_PATH = path.resolve(__dirname, '../../../ai/tools.json');

function loadToolCatalog() {
  const catalog = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
  if (!catalog || !Array.isArray(catalog.tools) || catalog.tools.length === 0) {
    throw new Error('The AI tool catalog must contain at least one tool.');
  }
  return catalog;
}

const CATALOG = loadToolCatalog();
const TOOLS = CATALOG.tools;
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const DEFAULT_STRING_MAX_LENGTH = 64;
const STRING_MAX_LENGTHS = Object.freeze({
  address: 200,
  query: 300,
});
const TOOL_NAME_MAX_LENGTH = Math.max(...TOOLS.map((tool) => tool.name.length));

function maxLengthForString(propertyName, parameter = {}) {
  if (Number.isSafeInteger(parameter.maxLength) && parameter.maxLength > 0) return parameter.maxLength;
  return STRING_MAX_LENGTHS[propertyName] || DEFAULT_STRING_MAX_LENGTH;
}

function applyStringMaxLengths(schema, propertyName, maxLength) {
  const bounded = { ...schema };
  if (bounded.type === 'string') bounded.maxLength = bounded.maxLength ?? maxLength;
  if (bounded.items && typeof bounded.items === 'object') {
    bounded.items = applyStringMaxLengths(bounded.items, propertyName, maxLength);
  }
  if (bounded.properties && typeof bounded.properties === 'object') {
    bounded.properties = Object.fromEntries(Object.entries(bounded.properties).map(([name, child]) => [
      name,
      applyStringMaxLengths(child, name, maxLengthForString(name)),
    ]));
  }
  return bounded;
}

function parameterSchema(parameter, propertyName) {
  const schema = { type: parameter.type };
  if (parameter.description) schema.description = parameter.description;
  if (parameter.enum) schema.enum = [...parameter.enum];
  if (parameter.minimum !== undefined) schema.minimum = parameter.minimum;
  if (parameter.maximum !== undefined) schema.maximum = parameter.maximum;
  if (parameter.maxLength !== undefined) schema.maxLength = parameter.maxLength;
  if (parameter.items) schema.items = parameter.items;
  if (parameter.default !== undefined) schema.default = parameter.default;
  return applyStringMaxLengths(schema, propertyName, maxLengthForString(propertyName, parameter));
}

function argsSchema(tool) {
  const properties = {};
  const required = [];
  for (const [name, parameter] of Object.entries(tool.parameters || {})) {
    properties[name] = parameterSchema(parameter, name);
    if (parameter.required) required.push(name);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

/** Build OpenAI-compatible function definitions from the exact same catalog. */
function buildOpenAITools() {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: argsSchema(tool),
    },
  }));
}

/**
 * JSON Schema accepted by Ollama's `format` option. The `oneOf` branches tie
 * each tool name to its own argument object, so a constrained decoder cannot
 * legally emit arguments belonging to another tool.
 */
function buildRouterResponseSchema() {
  return {
    title: 'FiberlineToolRoute',
    type: 'object',
    oneOf: TOOLS.map((tool) => ({
      type: 'object',
      additionalProperties: false,
      properties: {
        tool: { type: 'string', enum: [tool.name], maxLength: TOOL_NAME_MAX_LENGTH },
        args: argsSchema(tool),
      },
      required: ['tool', 'args'],
    })),
  };
}

function compactParameterList(tool) {
  const entries = Object.entries(tool.parameters || {});
  if (!entries.length) return 'no arguments';
  return entries.map(([name, parameter]) => {
    const required = parameter.required ? 'required' : 'optional';
    return `${name} (${parameter.type}, ${required})`;
  }).join(', ');
}

const FEW_SHOT_EXAMPLES = [
  {
    query: 'Check whether enclosure POP-31 can serve a site at latitude 33.6844 and longitude 73.0479.',
    result: { tool: 'checkServiceability', args: { enclosure_id: 'POP-31', lat: 33.6844, lng: 73.0479 } },
  },
  {
    query: 'Can enclosure CAB-57 serve this customer?',
    result: { tool: 'checkServiceability', args: { enclosure_id: 'CAB-57' } },
  },
  {
    query: 'Enclosure NAP-22 has no unoccupied splitter output; what deterministic port remedy is available?',
    result: { tool: 'findPortRemediation', args: { enclosure_id: 'NAP-22' } },
  },
  {
    query: 'For general design reference, what insertion loss does the specification assume for a 1:32 splitter?',
    result: { tool: 'lookupDocs', args: { query: 'specification assumed insertion loss for 1:32 splitter' } },
  },
  {
    query: 'For fiber core FBR-81, evaluate ways to improve its optical margin near enclosure CAB-8.',
    result: { tool: 'findPowerRemediation', args: { core_id: 'FBR-81', enclosure_id: 'CAB-8' } },
  },
  {
    query: 'Find the nearest box with unused fiber capacity for enclosure CAB-29, without using CAB-29 itself.',
    result: { tool: 'findCoreRemediation', args: { enclosure_id: 'CAB-29', exclude_self: true } },
  },
  {
    query: 'Show me the documented route taken by fiber CORE-23.',
    result: { tool: 'traceCore', args: { core_id: 'CORE-23' } },
  },
  {
    query: 'How does the fiber tracing feature work in general?',
    result: { tool: 'lookupDocs', args: { query: 'how the fiber tracing feature works' } },
  },
  {
    query: 'Trace fiber core FBR-62 through the network.',
    result: { tool: 'traceCore', args: { core_id: 'FBR-62' } },
  },
  {
    query: 'What downstream service would be disrupted if enclosure NAP-44 were out of service?',
    result: { tool: 'simulateFailure', args: { enclosure_id: 'NAP-44' } },
  },
  {
    query: 'Plan a connection for the customer at 45 Park Road; search 800 metres and include a street route.',
    result: { tool: 'locateCustomer', args: { address: '45 Park Road', radius_m: 800, route: true } },
  },
  {
    query: 'Plan a connection for the customer at latitude 34.0156 and longitude 71.5251.',
    result: { tool: 'locateCustomer', args: { lat: 34.0156, lng: 71.5251 } },
  },
  {
    query: 'According to the project documentation, when is an optical-power warning raised?',
    result: { tool: 'lookupDocs', args: { query: 'when is an optical-power warning raised' } },
  },
];

function buildRouterInstruction() {
  const toolLines = TOOLS.map((tool) => {
    const description = tool.description.replace(/\s+/g, ' ').trim();
    return `- ${tool.name}: ${description} Args: ${compactParameterList(tool)}.`;
  }).join('\n');
  const examples = FEW_SHOT_EXAMPLES.map((example) =>
    `User: ${example.query}\nJSON: ${JSON.stringify(example.result)}`,
  ).join('\n');

  return [
    'You are a strict Fiberline intent router. Select exactly one listed tool and extract only values explicitly present in the user request. Return only JSON matching the supplied response schema; never answer, query a database, or invent an ID.',
    'Populate optional location parameters only when explicitly supplied in the user query; otherwise omit them entirely, never guess or substitute zero.',
    'A general question about how a feature works, with no specific core/cable/enclosure ID, is a lookupDocs request, even when its wording matches a tool name. A request to trace a named core uses traceCore.',
    'For locateCustomer, use address only when coordinates are not supplied; when latitude and longitude are supplied, use that pair and omit address.',
    '',
    'Tools:',
    toolLines,
    '',
    'Examples:',
    examples,
  ].join('\n');
}

function buildRouterPrompt(query) {
  return `${buildRouterInstruction()}\n\nUser query: ${String(query ?? '').trim()}`;
}

function typeMatches(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return false;
}

function routeError(message, code = 'TOOL_ROUTER_INVALID_RESPONSE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Defense-in-depth validation after constrained decoding. Grammar/schema
 * prevents most failures, but this check also protects callers when a test
 * double, older Ollama, or a proxy returns unconstrained JSON.
 */
function validateToolCall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw routeError('The router response must be a JSON object.');
  }
  const tool = TOOL_BY_NAME.get(value.tool);
  if (!tool) throw routeError(`The router selected an unknown tool: ${String(value.tool)}.`);
  if (!value.args || typeof value.args !== 'object' || Array.isArray(value.args)) {
    throw routeError(`The ${tool.name} route must contain an args object.`);
  }

  const parameterNames = new Set(Object.keys(tool.parameters || {}));
  for (const name of Object.keys(value.args)) {
    if (!parameterNames.has(name)) throw routeError(`The ${tool.name} route contains unknown argument: ${name}.`);
  }
  for (const [name, parameter] of Object.entries(tool.parameters || {})) {
    const present = Object.prototype.hasOwnProperty.call(value.args, name);
    if (parameter.required && !present) throw routeError(`The ${tool.name} route is missing required argument: ${name}.`);
    if (!present) continue;
    const argument = value.args[name];
    if (!typeMatches(argument, parameter.type)) {
      throw routeError(`${tool.name}.${name} must be a ${parameter.type}.`);
    }
    if (parameter.type === 'string' && argument.length > maxLengthForString(name, parameter)) {
      throw routeError(`${tool.name}.${name} must be ${maxLengthForString(name, parameter)} characters or fewer.`);
    }
    if (parameter.enum && !parameter.enum.includes(argument)) {
      throw routeError(`${tool.name}.${name} is not an allowed value.`);
    }
    if (parameter.minimum !== undefined && argument < parameter.minimum) {
      throw routeError(`${tool.name}.${name} is below the allowed minimum.`);
    }
    if (parameter.maximum !== undefined && argument > parameter.maximum) {
      throw routeError(`${tool.name}.${name} is above the allowed maximum.`);
    }
  }

  const args = value.args;
  if ((Object.prototype.hasOwnProperty.call(args, 'lat') && !Object.prototype.hasOwnProperty.call(args, 'lng')) ||
      (Object.prototype.hasOwnProperty.call(args, 'lng') && !Object.prototype.hasOwnProperty.call(args, 'lat'))) {
    throw routeError('Latitude and longitude must be provided together.');
  }
  if (tool.name === 'locateCustomer' && !args.address && !(args.lat !== undefined && args.lng !== undefined)) {
    throw routeError('locateCustomer requires an address or a latitude/longitude pair.');
  }

  return { tool: tool.name, args };
}

module.exports = {
  CATALOG,
  TOOLS,
  TOOL_BY_NAME,
  DEFAULT_STRING_MAX_LENGTH,
  STRING_MAX_LENGTHS,
  TOOL_NAME_MAX_LENGTH,
  FEW_SHOT_EXAMPLES,
  argsSchema,
  buildOpenAITools,
  buildRouterInstruction,
  buildRouterPrompt,
  buildRouterResponseSchema,
  validateToolCall,
};
