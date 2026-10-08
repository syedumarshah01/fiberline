const { randomUUID } = require('node:crypto');
const {
  buildOpenAITools,
  buildRouterInstruction,
  buildRouterResponseSchema,
  validateToolCall,
} = require('../ai/toolRouterSchema');
const { createModelProviderFromEnv } = require('./modelProvider');

const { DEFAULT_LOCAL_BASE_URL: DEFAULT_BASE_URL, localModelName } = require('../ai/localModelConfig');
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_NUM_THREADS = 4;
const MAX_QUERY_LENGTH = 4000;

function routerError(message, status, code, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, details);
  return error;
}

function providerName(env = process.env) {
  return String(env.AI_PROVIDER || 'local').trim().toLowerCase();
}

function config(env = process.env) {
  const configuredBase = String(
    env.LOCAL_LLM_BASE_URL || env.LLM_BASE_URL || env.OLLAMA_BASE_URL || DEFAULT_BASE_URL,
  ).replace(/\/+$/, '');
  const ollamaBase = configuredBase.replace(/\/v1$/i, '');
  const timeout = Number(env.LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const threadCount = Number(env.OLLAMA_NUM_THREADS || env.LLM_NUM_THREADS || DEFAULT_NUM_THREADS);
  return {
    // GGUF selection applies to llama.cpp. An Ollama installation still needs
    // its own explicit installed-model tag, not a GGUF filename alias.
    model: usesOllamaTransport(env)
      ? (env.TOOL_ROUTER_MODEL || env.LOCAL_LLM_MODEL || env.LLM_MODEL || '')
      : localModelName(env),
    url: `${ollamaBase}/api/chat`,
    timeoutMs: Number.isFinite(timeout) ? Math.max(1000, timeout) : DEFAULT_TIMEOUT_MS,
    numThreads: Number.isFinite(threadCount) ? Math.max(1, Math.round(threadCount)) : DEFAULT_NUM_THREADS,
  };
}

/**
 * Ollama's native API accepts the catalog union directly as `format`. Other
 * local runtimes use the shared OpenAI-compatible provider, while cloud
 * providers use function calling. TOOL_ROUTER_TRANSPORT can explicitly select
 * `ollama` or `openai` for compatible self-hosted endpoints.
 */
function usesOllamaTransport(env = process.env) {
  if (providerName(env) !== 'local') return false;
  const transport = String(env.TOOL_ROUTER_TRANSPORT || '').trim().toLowerCase();
  if (transport === 'ollama') return true;
  if (transport === 'openai') return false;

  if (env.OLLAMA_BASE_URL && !env.LOCAL_LLM_BASE_URL && !env.LLM_BASE_URL) return true;
  const configuredBase = env.LOCAL_LLM_BASE_URL || env.LLM_BASE_URL || env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
  try {
    const url = new URL(configuredBase);
    return url.port === '11434' || /(^|[.-])ollama([.-]|$)/i.test(url.hostname);
  } catch {
    return false;
  }
}

function extractContent(payload) {
  const content = payload?.message?.content ?? payload?.choices?.[0]?.message?.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  if (typeof content !== 'string' || !content.trim()) {
    throw routerError('The model returned no tool-router JSON.', 502, 'TOOL_ROUTER_EMPTY_RESPONSE');
  }
  try {
    return JSON.parse(content);
  } catch {
    throw routerError('The model returned invalid tool-router JSON.', 502, 'TOOL_ROUTER_INVALID_JSON');
  }
}

function parseFunctionArguments(rawArgs, name) {
  if (typeof rawArgs === 'string') {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch {
      throw routerError(`The model returned invalid JSON arguments for ${name}.`, 502, 'TOOL_ROUTER_INVALID_JSON');
    }
  }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw routerError(`Arguments for ${name} must be a JSON object.`, 502, 'TOOL_ROUTER_INVALID_JSON');
  }
  return rawArgs;
}

function parseCompatibleResponse(payload) {
  const message = payload?.choices?.[0]?.message;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (calls.length > 1) {
    throw routerError('The model returned more than one tool call; exactly one is allowed.', 502, 'TOOL_ROUTER_MULTIPLE_CALLS');
  }
  const call = calls[0];
  const functionCall = call?.function || message?.function_call;

  if (!functionCall) {
    // A local llama.cpp endpoint may return constrained JSON in message.content
    // rather than function metadata. It is still accepted only after the same
    // catalog validation as native Ollama output.
    return validateToolCall(extractContent(payload));
  }

  const name = functionCall.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw routerError('The model tool call is missing a function name.', 502, 'TOOL_ROUTER_INVALID_RESPONSE');
  }
  const args = parseFunctionArguments(functionCall.arguments ?? {}, name);
  return validateToolCall({ tool: name, args });
}

async function inferOllamaToolCall(query, { settings, fetchImpl, requestId }) {
  if (!settings.model) {
    throw routerError(
      'Set LLM_MODEL to an installed Ollama model tag; the selected GGUF default is for llama.cpp.',
      503,
      'TOOL_ROUTER_MODEL_NOT_CONFIGURED',
      { request_id: requestId },
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  let response;
  let payload;
  try {
    response = await fetchImpl(settings.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: buildRouterInstruction() },
          { role: 'user', content: query },
        ],
        stream: false,
        // The schema is generated from ai/tools.json; no separately maintained
        // grammar can drift from the execution catalog.
        format: buildRouterResponseSchema(),
        options: {
          num_thread: settings.numThreads,
          temperature: 0,
          top_p: 0.1,
        },
      }),
      signal: controller.signal,
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw routerError('The local Ollama tool router timed out.', 504, 'TOOL_ROUTER_TIMEOUT', { request_id: requestId });
    }
    throw routerError(
      `Cannot reach the local Ollama tool router at ${settings.url}. Start Ollama and verify the model is installed.`,
      503,
      'TOOL_ROUTER_UNREACHABLE',
      { request_id: requestId, cause: error.message },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw routerError(
      payload?.error?.message || `Ollama tool-router request failed with HTTP ${response.status}.`,
      502,
      'TOOL_ROUTER_REQUEST_FAILED',
      { request_id: requestId, http_status: response.status },
    );
  }
  return validateToolCall(extractContent(payload));
}

async function inferCompatibleToolCall(query, {
  env,
  fetchImpl,
  provider: suppliedProvider,
  requestId,
} = {}) {
  const selectedProvider = providerName(env);
  let provider = suppliedProvider;
  try {
    if (!provider) {
      const providerEnv = selectedProvider === 'local'
        ? { ...env, LOCAL_LLM_MODEL: localModelName(env) }
        : env;
      provider = createModelProviderFromEnv(providerEnv, { fetchImpl });
    }
  } catch (error) {
    throw routerError(
      error.message || 'The configured model provider is unavailable.',
      error.statusCode || 503,
      'TOOL_ROUTER_PROVIDER_UNAVAILABLE',
      { request_id: requestId },
    );
  }

  const messages = [
    { role: 'system', content: buildRouterInstruction() },
    { role: 'user', content: query },
  ];
  const request = selectedProvider === 'cloud'
    ? {
        messages,
        tools: buildOpenAITools(),
        toolChoice: 'required',
        maxTokens: 128,
        temperature: 0,
      }
    : {
        messages,
        // llama.cpp's OpenAI-compatible server accepts JSON Schema constrained
        // output. The same union and post-validation are used as with Ollama.
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'fiberline_tool_route',
            schema: buildRouterResponseSchema(),
            strict: false,
          },
        },
        maxTokens: 128,
        temperature: 0,
      };

  try {
    const completion = await provider.chatCompletion(request);
    return parseCompatibleResponse(completion);
  } catch (error) {
    if (error.code?.startsWith('TOOL_ROUTER_')) {
      error.status ||= 502;
      error.request_id ||= requestId;
      throw error;
    }
    const status = Number(error.statusCode || error.status);
    const mappedStatus = Number.isFinite(status) && status >= 400 ? status : 502;
    const code = mappedStatus === 503 ? 'TOOL_ROUTER_UNREACHABLE' : 'TOOL_ROUTER_REQUEST_FAILED';
    const providerLabel = selectedProvider === 'cloud' ? 'configured cloud' : 'configured local';
    throw routerError(
      `${providerLabel} tool router failed: ${error.message || 'model request failed'}`,
      mappedStatus,
      code,
      { request_id: requestId },
    );
  }
}

async function inferToolCall(query, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  provider,
  requestId = randomUUID(),
} = {}) {
  const text = String(query ?? '').trim();
  if (!text) throw routerError('A natural-language query is required.', 400, 'TOOL_ROUTER_EMPTY_QUERY');
  if (text.length > MAX_QUERY_LENGTH) {
    throw routerError(`Queries must be ${MAX_QUERY_LENGTH} characters or fewer.`, 400, 'TOOL_ROUTER_QUERY_TOO_LONG');
  }

  const settings = config(env);
  const started = Date.now();
  const route = usesOllamaTransport(env)
    ? await inferOllamaToolCall(text, { settings, fetchImpl, requestId })
    : await inferCompatibleToolCall(text, { env, fetchImpl, provider, requestId });
  const selectedProvider = providerName(env);
  return {
    ...route,
    model: selectedProvider === 'cloud' ? (env.CLOUD_LLM_MODEL || settings.model) : settings.model,
    provider: selectedProvider,
    latency_ms: Date.now() - started,
    request_id: requestId,
  };
}

/** Keep inference output transport-neutral for every downstream caller. */
async function routeToolCall(query, options = {}) {
  const result = await inferToolCall(query, options);
  return { tool: result.tool, args: result.args };
}

module.exports = {
  MAX_QUERY_LENGTH,
  config,
  usesOllamaTransport,
  extractContent,
  parseCompatibleResponse,
  inferToolCall,
  routeToolCall,
};
