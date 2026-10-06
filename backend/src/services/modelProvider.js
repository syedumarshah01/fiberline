const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:8080/v1';
const DEFAULT_CLOUD_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

class ModelProviderError extends Error {
  constructor(message, { statusCode = 502, cause } = {}) {
    super(message);
    this.name = 'ModelProviderError';
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function messageContentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

class OpenAICompatibleProvider {
  constructor({ baseUrl, model, apiKey = '', timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = String(model || '').trim();
    this.apiKey = String(apiKey || '').trim();
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
    this.fetchImpl = fetchImpl;

    if (!this.baseUrl) throw new TypeError('Model provider baseUrl is required');
    if (!this.model) throw new TypeError('Model provider model is required');
    if (typeof this.fetchImpl !== 'function') throw new TypeError('This Node.js runtime must provide fetch');
  }

  async chatCompletion({
    messages,
    tools,
    toolChoice,
    responseFormat,
    maxTokens = 128,
    temperature = 0.2,
  } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TypeError('chatCompletion requires at least one message');
    }
    const max_tokens = Math.max(1, Math.min(512, Number.parseInt(maxTokens, 10) || 128));
    const body = {
      model: this.model,
      messages,
      max_tokens,
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
    };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (responseFormat !== undefined) body.response_format = responseFormat;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new ModelProviderError('Model endpoint returned invalid JSON', { cause: error });
      }
      if (!response.ok) {
        const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
        throw new ModelProviderError(`Model endpoint error: ${detail}`, {
          statusCode: response.status >= 500 ? 502 : response.status,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      const message = error?.name === 'AbortError'
        ? `Model request exceeded ${this.timeoutMs} ms`
        : 'Unable to reach the configured model endpoint';
      throw new ModelProviderError(message, { statusCode: 503, cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateText({ systemPrompt, userPrompt, maxTokens = 60 } = {}) {
    if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string') {
      throw new TypeError('generateText requires systemPrompt and userPrompt strings');
    }
    const response = await this.chatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      maxTokens,
      temperature: 0.1,
    });
    return messageContentToText(response?.choices?.[0]?.message?.content);
  }
}

function createModelProviderFromEnv(env = process.env, options = {}) {
  const provider = String(env.AI_PROVIDER || 'local').trim().toLowerCase();
  const timeoutMs = Number(env.AI_REQUEST_TIMEOUT_MS || env.LLM_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS;

  if (provider === 'local') {
    const model = env.LOCAL_LLM_MODEL || env.LLM_MODEL || '';
    if (!model) {
      throw new ModelProviderError(
        'AI_PROVIDER=local requires a model selected after reviewing the Phase 2 benchmark',
        { statusCode: 503 },
      );
    }
    return new OpenAICompatibleProvider({
      baseUrl: env.LOCAL_LLM_BASE_URL || env.LLM_BASE_URL || DEFAULT_LOCAL_BASE_URL,
      model,
      apiKey: env.LOCAL_LLM_API_KEY || env.LLM_API_KEY || '',
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }

  if (provider === 'cloud') {
    const apiKey = env.CLOUD_LLM_API_KEY || '';
    const model = env.CLOUD_LLM_MODEL || '';
    if (!apiKey) {
      throw new ModelProviderError('AI_PROVIDER=cloud requires CLOUD_LLM_API_KEY', { statusCode: 503 });
    }
    if (!model) {
      throw new ModelProviderError('AI_PROVIDER=cloud requires CLOUD_LLM_MODEL', { statusCode: 503 });
    }
    return new OpenAICompatibleProvider({
      baseUrl: env.CLOUD_LLM_BASE_URL || DEFAULT_CLOUD_BASE_URL,
      model,
      apiKey,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }

  throw new ModelProviderError(`Unsupported AI_PROVIDER: ${provider}; use local or cloud`, { statusCode: 503 });
}

module.exports = {
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ModelProviderError,
  OpenAICompatibleProvider,
  createModelProviderFromEnv,
  messageContentToText,
};
