const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RADIUS_M = 10000;

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'message', 'pole_identifier', 'location_text', 'latitude', 'longitude', 'radius_m'],
  properties: {
    intent: { type: 'string', enum: ['pole_outage', 'nearby_capacity', 'clarification'] },
    message: { type: 'string' },
    pole_identifier: { type: ['string', 'null'] },
    location_text: { type: ['string', 'null'] },
    latitude: { type: ['number', 'null'] },
    longitude: { type: ['number', 'null'] },
    radius_m: { type: ['number', 'null'] },
  },
};

// Gemini's native generateContent endpoint uses the same JSON Schema concepts,
// but spells schema types in its REST format. Keeping this separate from the
// OpenAI-compatible schema lets the provider be switched without weakening the
// structured-output contract.
const GEMINI_PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['pole_outage', 'nearby_capacity', 'clarification'] },
    message: { type: 'STRING' },
    pole_identifier: { type: ['STRING', 'NULL'] },
    location_text: { type: ['STRING', 'NULL'] },
    latitude: { type: ['NUMBER', 'NULL'] },
    longitude: { type: ['NUMBER', 'NULL'] },
    radius_m: { type: ['NUMBER', 'NULL'] },
  },
  required: ['intent', 'message', 'pole_identifier', 'location_text', 'latitude', 'longitude', 'radius_m'],
};

const SYSTEM_PROMPT = `You are Fiberline's network-query translator. Translate a user's natural-language question into the JSON plan below. Do not answer the question, do not write SQL, and do not invent network assets.

Supported intents:
1. pole_outage: the user asks which customers, boxes, or services are affected by a pole failing, going down, or being cut. Extract only the pole identifier as written, such as "42" or "POLE-0042".
2. nearby_capacity: the user asks for boxes, enclosures, cabinets, or NAPs within a distance of a location and asks for spare, free, or available capacity. Convert km to metres. Use location_text for a street address, asset name, or place. If the user supplies a latitude and longitude, use latitude and longitude instead.
3. clarification: anything else, or a request that is missing the information needed for one of the two operations.

Important:
- "this address" is not an address. Use clarification when no address or coordinates are present.
- Never turn a number in a radius into a pole identifier, and never guess a pole from a place name.
- radius_m must be in metres and between 1 and 10000 when present; leave it null when the question is not nearby_capacity.
- Keep message short and useful only for clarification. Return JSON matching the schema exactly.`;

function config() {
  const provider = String(
    process.env.LLM_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'openai'),
  ).toLowerCase();
  const gemini = provider === 'gemini';
  const apiKey = process.env.LLM_API_KEY ||
    (gemini ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY) || '';
  return {
    provider,
    apiKey,
    model: process.env.LLM_MODEL ||
      (gemini ? process.env.GEMINI_MODEL : process.env.OPENAI_MODEL) ||
      (gemini ? DEFAULT_MODEL : 'gpt-4o-mini'),
    baseUrl: (process.env.LLM_BASE_URL ||
      (gemini ? process.env.GEMINI_BASE_URL : process.env.OPENAI_BASE_URL) ||
      (gemini ? DEFAULT_GEMINI_BASE_URL : DEFAULT_BASE_URL)).replace(/\/+$/, ''),
    timeoutMs: Math.max(1000, Number(process.env.LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)),
  };
}

function llmConfigured() {
  return Boolean(config().apiKey);
}

function plannerMode() {
  return String(process.env.NETWORK_QUERY_PLANNER || 'llm').toLowerCase();
}

function configurationError() {
  const error = new Error(
    'Network-query LLM is not configured. Set GEMINI_API_KEY (or LLM_API_KEY) and GEMINI_MODEL in backend/.env, or explicitly set NETWORK_QUERY_PLANNER=deterministic.',
  );
  error.status = 503;
  error.code = 'LLM_NOT_CONFIGURED';
  return error;
}

function parseJsonContent(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('The LLM returned a non-JSON network-query plan.');
  }
}

function normalizePlan(plan) {
  if (!plan || !['pole_outage', 'nearby_capacity', 'clarification'].includes(plan.intent)) {
    throw new Error('The LLM returned an invalid network-query intent.');
  }
  const latitude = Number(plan.latitude);
  const longitude = Number(plan.longitude);
  const hasCoordinates =
    plan.latitude != null && plan.longitude != null &&
    Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  const requestedRadius = Number(plan.radius_m);
  const radius = plan.radius_m == null || !Number.isFinite(requestedRadius)
    ? null
    : Math.min(MAX_RADIUS_M, Math.max(1, Math.round(requestedRadius)));
  const normalized = {
    intent: plan.intent,
    message: typeof plan.message === 'string' ? plan.message.slice(0, 500) : '',
    target: plan.pole_identifier == null ? null : { kind: 'pole', text: String(plan.pole_identifier).trim() },
    location: {
      coordinates: hasCoordinates
        ? { lat: latitude, lng: longitude, label: `${latitude}, ${longitude}`, source: 'coordinates' }
        : null,
      text: plan.location_text == null ? null : String(plan.location_text).trim() || null,
    },
    radius_m: radius,
    require_spare_capacity: plan.intent === 'nearby_capacity',
  };

  if (normalized.intent === 'pole_outage' && !normalized.target?.text) {
    normalized.intent = 'clarification';
    normalized.message ||= 'Which pole should I analyze?';
  }
  if (normalized.intent === 'nearby_capacity' && !normalized.location.coordinates && !normalized.location.text) {
    normalized.intent = 'clarification';
    normalized.message ||= 'Which address or coordinates should I search around?';
  }
  if (normalized.intent === 'nearby_capacity' && normalized.radius_m == null) normalized.radius_m = 500;
  return normalized;
}

async function requestGeminiPlan(query, { fetchImpl = fetch, ...overrides } = {}) {
  const settings = { ...config(), ...overrides, provider: 'gemini' };
  if (!settings.apiKey) throw configurationError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await fetchImpl(
      `${settings.baseUrl}/models/${encodeURIComponent(settings.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': settings.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: String(query) }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_PLAN_SCHEMA,
          },
        }),
        signal: controller.signal,
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Gemini request failed with HTTP ${response.status}`);
      error.status = 502;
      error.code = 'LLM_REQUEST_FAILED';
      throw error;
    }
    const content = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
    if (!content) {
      const error = new Error('Gemini returned no network-query plan.');
      error.status = 502;
      error.code = 'LLM_EMPTY_RESPONSE';
      throw error;
    }
    return normalizePlan(parseJsonContent(content));
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('The network-query LLM timed out.');
      timeout.status = 504;
      timeout.code = 'LLM_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestPlan(query, { fetchImpl = fetch, ...overrides } = {}) {
  const settings = { ...config(), ...overrides };
  if (settings.provider === 'gemini') return requestGeminiPlan(query, { fetchImpl, ...settings });
  if (!settings.apiKey) throw configurationError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: String(query) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'fiberline_network_query', strict: true, schema: PLAN_SCHEMA },
        },
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `LLM request failed with HTTP ${response.status}`);
      error.status = 502;
      error.code = 'LLM_REQUEST_FAILED';
      throw error;
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      const error = new Error('The LLM returned no network-query plan.');
      error.status = 502;
      error.code = 'LLM_EMPTY_RESPONSE';
      throw error;
    }
    return normalizePlan(parseJsonContent(content));
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('The network-query LLM timed out.');
      timeout.status = 504;
      timeout.code = 'LLM_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function planNetworkQuery(query, options = {}) {
  const mode = options.mode || plannerMode();
  if (mode === 'deterministic' || mode === 'off') return null;
  return requestPlan(query, options);
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_GEMINI_BASE_URL,
  PLAN_SCHEMA,
  GEMINI_PLAN_SCHEMA,
  SYSTEM_PROMPT,
  config,
  llmConfigured,
  plannerMode,
  configurationError,
  normalizePlan,
  requestPlan,
  requestGeminiPlan,
  planNetworkQuery,
};
