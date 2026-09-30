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

function parameterSchema(parameter) {
  const schema = { type: parameter.type };
  if (parameter.description) schema.description = parameter.description;
  if (parameter.enum) schema.enum = [...parameter.enum];
  if (parameter.minimum !== undefined) schema.minimum = parameter.minimum;
  if (parameter.maximum !== undefined) schema.maximum = parameter.maximum;
  if (parameter.items) schema.items = parameter.items;
  if (parameter.default !== undefined) schema.default = parameter.default;
  return schema;
}

function argsSchema(tool) {
  const properties = {};
  const required = [];
  for (const [name, parameter] of Object.entries(tool.parameters || {})) {
    properties[name] = parameterSchema(parameter);
    if (parameter.required) required.push(name);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
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
        tool: { type: 'string', enum: [tool.name] },
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
    query: 'Can BOX-001 serve a customer at latitude 34.010 and longitude 71.575?',
    result: { tool: 'checkServiceability', args: { enclosure_id: 'BOX-001', lat: 34.01, lng: 71.575 } },
  },
  {
    query: 'Trace fiber core fc-123 from end to end.',
    result: { tool: 'traceCore', args: { core_id: 'fc-123' } },
  },
  {
    query: 'What is the default loss for a 1:32 splitter?',
    result: { tool: 'lookupDocs', args: { query: 'default loss for a 1:32 splitter' } },
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
  FEW_SHOT_EXAMPLES,
  argsSchema,
  buildRouterInstruction,
  buildRouterPrompt,
  buildRouterResponseSchema,
  validateToolCall,
};
