const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
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

const ASSISTANT_SYSTEM_PROMPT = `You are Fiberline, an operations assistant for a fiber network management application. Answer questions about the software, the network, customers, poles, boxes, cables, capacity, outages, approvals, and field operations.

Use the read-only tools when the answer depends on live network data. You may call more than one tool and may use a previous tool result to decide what to inspect next. For map-only requests such as “mark all boxes yellow”, “focus the map on box NAP-14”, “hide cables”, “show the whole network”, or “clear the highlights”, use control_map; it changes only the current browser display and is safe to do without confirmation. Never invent an asset, customer, outage, capacity number, account, or approval. If a tool returns an error or no match, say that clearly and ask for the missing identifier or location.

For questions that need a custom database lookup, use query_network_database with one simple PostgreSQL SELECT. Allowed tables are poles, enclosures, cables, customers, fiber_cores, splices, splitters, splitter_ports, headends, telemetry_status, and as_built_approvals. Common relationships are enclosures.pole_id = poles.id, cables.from_enclosure_id/to_enclosure_id = enclosures.id, fiber_cores.cable_id = cables.id, splices.enclosure_id = enclosures.id, splitters.enclosure_id = enclosures.id, splitter_ports.splitter_id = splitters.id, and customers.id = cables.customer_id. Use explicit columns and LIMIT 100. Never select passwords, tokens, sessions, snapshots, or any account credentials.

You can explain how to use Fiberline without a tool. The application supports map-based asset management, box documentation, splice and splitter wiring, fiber tracing, loss budgets, capacity planning, customer connection plans, outage impact analysis, telemetry, QR field worksheets, work orders, and admin approval/account workflows. The assistant may prepare a set_asset_status action when the user explicitly asks to change an asset status, but that tool only creates a confirmation preview. Never claim that a change happened. The server will execute it only after the authenticated user presses Confirm. Do not prepare actions for creates, deletes, approvals, password resets, or other mutations; tell the user to use the normal UI for those.

When answering a data question, cite the asset code/name and distinguish documented facts from assumptions. Keep the answer concise but useful. Do not mention internal tool names or implementation details unless asked.`;

const TOOL_DECLARATIONS = [
  {
    name: 'control_map',
    description: 'Interact with the current map only. Use for highlighting/filtering assets, focusing the map on an asset or address, showing/hiding layers, fitting the network, or clearing map state. This never changes database data.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['highlight', 'focus_asset', 'focus_location', 'set_visibility', 'fit_network', 'clear'] },
        kind: { type: 'string', enum: ['enclosure', 'pole', 'cable'] },
        identifier: { type: 'string', description: 'Asset code, ID, or name for focus_asset.' },
        address: { type: 'string', description: 'Address for focus_location.' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        radius_m: { type: 'number' },
        scope: { type: 'string', enum: ['all', 'selected'] },
        color: { type: 'string', enum: ['yellow', 'red', 'green', 'blue', 'orange', 'teal', 'purple'] },
        ids: { type: 'array', items: { type: 'string' } },
        layer: { type: 'string', enum: ['poles', 'boxes', 'cables', 'telemetry', 'labels'] },
        visible: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    name: 'request_agent_action',
    description: 'Prepare a safe software change for explicit user confirmation. Never use this tool for a read question, and never claim the change happened; it only creates a preview.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set_asset_status'] },
        kind: { type: 'string', enum: ['pole', 'enclosure', 'cable', 'customer', 'splitter'] },
        identifier: { type: 'string', description: 'Asset code, database ID, or exact name.' },
        status: { type: 'string', description: 'The requested valid status for the selected asset.' },
        reason: { type: 'string', description: 'Short reason to show in the confirmation preview.' },
      },
      required: ['action', 'kind', 'identifier', 'status'],
    },
  },
  {
    name: 'search_network',
    description: 'Search documented network assets by code, name, address, or customer identifier. Use this to resolve an asset before asking for details.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Asset code, name, customer name, address, or search phrase.' },
        kind: { type: 'string', enum: ['all', 'pole', 'enclosure', 'cable', 'customer', 'headend'] },
        limit: { type: 'integer', description: 'Maximum number of results, at most 50.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_network_summary',
    description: 'Return current high-level counts for poles, boxes, cables, customers, fiber-core statuses, and boxes with spare capacity.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_nearby_boxes',
    description: 'Find boxes near latitude and longitude, optionally filtering to boxes with at least one available fiber core.',
    parameters: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Latitude from -90 to 90, when coordinates are available.' },
        longitude: { type: 'number', description: 'Longitude from -180 to 180, when coordinates are available.' },
        address: { type: 'string', description: 'Street address or known place when coordinates are not available.' },
        radius_m: { type: 'number', description: 'Search radius in metres, maximum 10000.' },
        spare_only: { type: 'boolean', description: 'Only return boxes with available cores.' },
        limit: { type: 'integer', description: 'Maximum number of results, at most 50.' },
      },
    },
  },
  {
    name: 'analyze_outage',
    description: 'Analyze downstream customer impact for a documented pole or enclosure failure. This is simulation only and does not change network data.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['pole', 'enclosure'] },
        identifier: { type: 'string', description: 'Pole/box ID, code, or name.' },
      },
      required: ['kind', 'identifier'],
    },
  },
  {
    name: 'get_asset_details',
    description: 'Look up matching documented assets and their stored details. Use after search when the user asks about a particular asset.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['all', 'pole', 'enclosure', 'cable', 'customer', 'headend'] },
        identifier: { type: 'string', description: 'Asset code, database ID, name, customer code, or address.' },
      },
      required: ['kind', 'identifier'],
    },
  },
  {
    name: 'get_box_documentation',
    description: 'Return the full documented contents of a box/enclosure: landing cables and cores, splices, splitters, ports, and QC flags.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Box/enclosure ID, code, or name.' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'trace_fiber_core',
    description: 'Trace a documented fiber core through cables, splices, splitters, and customer termination. Read-only.',
    parameters: {
      type: 'object',
      properties: { core_id: { type: 'string', description: 'Fiber core database ID. Resolve a code first with search_network if needed.' } },
      required: ['core_id'],
    },
  },
  {
    name: 'get_loss_budget',
    description: 'Calculate the optical loss budget for a documented fiber core using the configured project settings.',
    parameters: {
      type: 'object',
      properties: {
        core_id: { type: 'string', description: 'Fiber core database ID.' },
        olt_type: { type: 'string', description: 'Optional OLT type override from project settings.' },
      },
      required: ['core_id'],
    },
  },
  {
    name: 'query_network_database',
    description: 'Run one safe, read-only SELECT against the documented network database when the specialized tools cannot answer the question. Use explicit columns, joins, filters, and a LIMIT of 100 or less. Never query credentials, sessions, password fields, or write anything.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single PostgreSQL SELECT over the documented Fiberline network tables. No comments, semicolons, writes, sensitive fields, or system tables.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'list_approvals',
    description: 'List as-built approval records, including the employee account that submitted them. Use for review/status questions only.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        limit: { type: 'integer', description: 'Maximum number of records, at most 50.' },
      },
    },
  },
];

function config() {
  return {
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.LLM_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
    baseUrl: (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
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
    'Network-query LLM is not configured. Set LLM_API_KEY and LLM_MODEL in backend/.env, or explicitly set NETWORK_QUERY_PLANNER=deterministic.',
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

async function requestPlan(query, { fetchImpl = fetch, ...overrides } = {}) {
  const settings = { ...config(), ...overrides };
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
  PLAN_SCHEMA,
  SYSTEM_PROMPT,
  ASSISTANT_SYSTEM_PROMPT,
  TOOL_DECLARATIONS,
  config,
  llmConfigured,
  plannerMode,
  configurationError,
  normalizePlan,
  requestPlan,
  planNetworkQuery,
};
