const { TOOL_DEFINITIONS, getToolSchema } = require('./toolSchema');

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((definition) => definition.function.name));

class ToolRouterError extends Error {
  constructor(message, statusCode = 400, code = 'TOOL_ROUTER_ERROR') {
    super(message);
    this.name = 'ToolRouterError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseModelToolCall(toolCall) {
  const functionCall = toolCall?.function || toolCall?.function_call;
  const name = functionCall?.name || toolCall?.name;
  const rawArgs = functionCall?.arguments ?? toolCall?.args ?? {};
  if (typeof name !== 'string' || !name) throw new ToolRouterError('Model tool call is missing a tool name');

  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      throw new ToolRouterError(`Model returned invalid JSON arguments for ${name}`);
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolRouterError(`Arguments for ${name} must be a JSON object`);
  }
  return { tool: name, args };
}

async function executeModelToolSelection({ provider, toolRouter, messages, toolChoice = 'auto', maxTokens = 96 } = {}) {
  if (!provider || typeof provider.chatCompletion !== 'function') {
    throw new ToolRouterError('A chat-completion model provider is required', 503, 'MODEL_PROVIDER_UNAVAILABLE');
  }
  if (!toolRouter || typeof toolRouter.executeModelToolCall !== 'function') {
    throw new ToolRouterError('A tool router is required', 500, 'TOOL_ROUTER_MISSING');
  }
  const completion = await provider.chatCompletion({
    messages,
    tools: toolRouter.getToolSchema(),
    toolChoice,
    maxTokens,
    temperature: 0,
  });
  const message = completion?.choices?.[0]?.message;
  const call = message?.tool_calls?.[0] || (message?.function_call ? { function: message.function_call } : null);
  if (!call) {
    throw new ToolRouterError('Model did not return a tool call; no parametric answer was used', 502, 'MODEL_NO_TOOL_CALL');
  }
  return toolRouter.executeModelToolCall(call);
}

function createToolRouter(handlers = {}) {
  const availableHandlers = new Map(Object.entries(handlers));

  async function execute(invocation) {
    if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) {
      throw new ToolRouterError('Tool invocation must be an object with { tool, args }');
    }
    const { tool, args } = invocation;
    if (typeof tool !== 'string' || !TOOL_NAMES.has(tool)) {
      throw new ToolRouterError(`Unknown tool: ${String(tool ?? '')}`, 404, 'TOOL_NOT_FOUND');
    }
    const handler = availableHandlers.get(tool);
    if (typeof handler !== 'function') {
      throw new ToolRouterError(`Tool handler is not configured: ${tool}`, 503, 'TOOL_UNAVAILABLE');
    }
    return handler(args);
  }

  return Object.freeze({
    getToolSchema,
    execute,
    executeModelToolCall: (toolCall) => execute(parseModelToolCall(toolCall)),
  });
}

module.exports = {
  ToolRouterError,
  parseModelToolCall,
  executeModelToolSelection,
  createToolRouter,
};
