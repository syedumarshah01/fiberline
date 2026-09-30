const { randomUUID } = require('node:crypto');
const {
  config,
  ASSISTANT_SYSTEM_PROMPT,
  TOOL_DECLARATIONS,
} = require('./llmQueryPlanner');
const { executeNetworkTool } = require('./networkTools');

const MAX_TOOL_ROUNDS = 4;
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGES = 30;
const conversations = new Map();

const OPENROUTER_TOOLS = TOOL_DECLARATIONS.map((tool) => ({
  type: 'function',
  function: tool,
}));

function providerError(message, status = 502, code = 'LLM_REQUEST_FAILED') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function visualizationForTool(name, result) {
  if (name === 'find_nearby_boxes' && result?.center && Array.isArray(result.boxes)) {
    return {
      type: 'nearby_boxes',
      center: result.center,
      radius_m: result.radius_m,
      box_ids: result.boxes.map((box) => box.id).filter(Boolean),
    };
  }
  if (name === 'analyze_outage' && result?.status === 'ok') {
    return {
      type: 'asset_boxes',
      box_ids: (result.mounted_boxes || result.affected?.boxes || []).map((box) => box.id).filter(Boolean),
      center: result.pole?.lat != null ? { lat: Number(result.pole.lat), lng: Number(result.pole.lng) } : null,
    };
  }
  return null;
}

async function askOpenRouterNetwork(query, { fetchImpl = fetch, conversation_id = null, userId = 'anonymous', userRole = 'technician' } = {}) {
  const settings = config();
  if (settings.provider !== 'openrouter') {
    throw providerError('The network assistant is not configured for OpenRouter.', 503, 'OPENROUTER_NOT_SELECTED');
  }
  if (!settings.apiKey) {
    throw providerError('OpenRouter is not configured. Set OPENROUTER_API_KEY in backend/.env.', 503, 'LLM_NOT_CONFIGURED');
  }

  const now = Date.now();
  let id = conversation_id || randomUUID();
  const existing = conversations.get(id);
  if (existing && (now - existing.updatedAt > CONVERSATION_TTL_MS || existing.userId !== String(userId))) {
    conversations.delete(id);
  }
  const conversation = conversations.get(id);
  const messages = conversation
    ? conversation.messages.map((message) => ({ ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) } : {}) }))
    : [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }];
  messages.push({ role: 'user', content: String(query) });

  const toolCalls = [];
  let visualization = conversation?.visualization || null;
  let pendingAction = conversation?.pending_action || null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    let payload;
    try {
      const response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
          ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
          ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {}),
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          tools: OPENROUTER_TOOLS,
          tool_choice: 'auto',
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      payload = await response.json().catch(() => null);
      if (!response.ok) throw providerError(payload?.error?.message || `OpenRouter request failed with HTTP ${response.status}`);
    } catch (error) {
      if (error.name === 'AbortError') throw providerError('The OpenRouter assistant timed out.', 504, 'LLM_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const message = payload?.choices?.[0]?.message;
    if (!message) throw providerError('OpenRouter returned an empty assistant response.', 502, 'LLM_EMPTY_RESPONSE');
    messages.push(message);
    const calls = message.tool_calls || [];
    if (!calls.length) {
      const answer = String(message.content || '').trim();
      if (!answer) throw providerError('OpenRouter returned no readable assistant answer.', 502, 'LLM_EMPTY_RESPONSE');
      if (/\b(?:clear|hide|remove)\b.*\b(?:map|highlight|visual)/i.test(String(query))) visualization = null;
      conversations.set(id, { userId: String(userId), updatedAt: Date.now(), messages: messages.slice(-MAX_MESSAGES), visualization, pending_action: pendingAction });
      return {
        status: 'ok',
        planner_source: 'openrouter-tools',
        conversation_id: id,
        answer_text: answer,
        tool_calls: toolCalls,
        visualization,
        pending_action: pendingAction,
      };
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const result = await executeNetworkTool(name, args, { userId, userRole });
      visualization = visualizationForTool(name, result) || visualization;
      if (result?.pending_action) pendingAction = result.pending_action;
      toolCalls.push({ name, arguments: args, ok: !result?.error });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: JSON.stringify(result),
      });
    }
  }
  throw providerError('The OpenRouter assistant used too many graph lookups for one question.', 502, 'LLM_TOOL_LIMIT');
}

module.exports = { askOpenRouterNetwork, OPENROUTER_TOOLS };
