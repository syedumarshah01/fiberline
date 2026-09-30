const { randomUUID } = require('node:crypto');
const {
  buildRouterPrompt,
  buildRouterResponseSchema,
  validateToolCall,
} = require('../ai/toolRouterSchema');

const DEFAULT_MODEL = 'llama3.2:1b';
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_NUM_THREADS = 8;

function routerError(message, status, code, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, details);
  return error;
}

function config(env = process.env) {
  const configuredBase = String(env.LLM_BASE_URL || env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const ollamaBase = configuredBase.replace(/\/v1$/i, '');
  return {
    model: env.TOOL_ROUTER_MODEL || env.LLM_MODEL || DEFAULT_MODEL,
    url: `${ollamaBase}/api/chat`,
    timeoutMs: Math.max(1000, Number(env.LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)),
    numThreads: Math.max(1, Math.round(Number(env.OLLAMA_NUM_THREADS || env.LLM_NUM_THREADS || DEFAULT_NUM_THREADS))),
  };
}

function extractContent(payload) {
  const content = payload?.message?.content ?? payload?.choices?.[0]?.message?.content;
  if (content && typeof content === 'object') return content;
  if (typeof content !== 'string' || !content.trim()) {
    throw routerError('Ollama returned no router JSON.', 502, 'TOOL_ROUTER_EMPTY_RESPONSE');
  }
  try {
    return JSON.parse(content);
  } catch {
    throw routerError('Ollama returned invalid router JSON.', 502, 'TOOL_ROUTER_INVALID_JSON');
  }
}

async function inferToolCall(query, {
  fetchImpl = fetch,
  env = process.env,
  requestId = randomUUID(),
} = {}) {
  const text = String(query ?? '').trim();
  if (!text) throw routerError('A natural-language query is required.', 400, 'TOOL_ROUTER_EMPTY_QUERY');
  const settings = config(env);
  const started = Date.now();
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
        messages: [{ role: 'user', content: buildRouterPrompt(text) }],
        stream: false,
        // Ollama forwards this JSON Schema to llama.cpp's constrained decoder.
        // The schema is generated from ai/tools.json; no second grammar file can drift.
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
      throw routerError('The local tool router timed out.', 504, 'TOOL_ROUTER_TIMEOUT', { request_id: requestId });
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

  const route = validateToolCall(extractContent(payload));
  return {
    ...route,
    model: settings.model,
    latency_ms: Date.now() - started,
    request_id: requestId,
  };
}

async function routeToolCall(query, options = {}) {
  const result = await inferToolCall(query, options);
  return { tool: result.tool, args: result.args };
}

module.exports = {
  config,
  extractContent,
  inferToolCall,
  routeToolCall,
};
