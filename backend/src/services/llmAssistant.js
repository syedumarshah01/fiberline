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

const LLM_TOOLS = TOOL_DECLARATIONS.map((tool) => ({
  type: 'function',
  function: tool,
}));

function assistantError(message, status = 502, code = 'LLM_REQUEST_FAILED', meta = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, meta);
  return error;
}

function visualizationForTool(name, result) {
  if (name === 'control_map' && result?.map_command) return result.map_command;
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

function summaryAnswer(query, summary) {
  const text = String(query || '').toLowerCase();
  const requested = [];
  const fields = [
    ['box', 'enclosures', 'boxes'],
    ['enclosure', 'enclosures', 'enclosures'],
    ['pole', 'poles', 'poles'],
    ['cable', 'cables', 'cables'],
    ['customer', 'customers', 'customers'],
    ['headend', 'headends', 'headends'],
  ];
  for (const [needle, field, label] of fields) {
    if (text.includes(needle) && !requested.some((item) => item.field === field)) requested.push({ field, label });
  }
  if (/\b(?:spare|available|free)\b/.test(text) && /\bbox|enclosure|cabinet|nap/.test(text)) {
    requested.push({ field: 'boxes_with_spare_capacity', label: 'boxes with spare capacity' });
  }
  if (!requested.length) {
    requested.push(
      { field: 'poles', label: 'poles' },
      { field: 'enclosures', label: 'boxes' },
      { field: 'cables', label: 'cables' },
      { field: 'customers', label: 'customers' },
    );
  }
  const facts = requested.map(({ field, label }) => `${summary?.[field] ?? 0} ${label}`);
  return `The current network has ${facts.join(', ')}.`;
}

async function validatedFallback(query, context) {
  const text = String(query || '').toLowerCase();
  const asksForCount = /\b(?:how many|number of|count|total)\b/.test(text);
  const asksAboutInventory = /\b(?:box|boxes|enclosure|enclosures|cabinet|cabinets|pole|poles|cable|cables|customer|customers|headend|headends|network)\b/.test(text);
  if (asksForCount && asksAboutInventory) {
    const result = await executeNetworkTool('get_network_summary', {}, context);
    if (!result?.error) return { name: 'get_network_summary', arguments: {}, result, answer_text: summaryAnswer(query, result) };
  }
  if (/\b(?:what can you do|what are your capabilities|your capabilities|available features)\b/.test(text)) {
    const result = await executeNetworkTool('get_application_capabilities', {}, context);
    if (!result?.error) return { name: 'get_application_capabilities', arguments: {}, result, answer_text: result.read_capabilities.join(' ') };
  }
  return null;
}

async function askNetworkAssistant(query, {
  fetchImpl = fetch,
  conversation_id = null,
  request_id = null,
  userId = 'anonymous',
  userRole = 'technician',
} = {}) {
  const settings = config();
  const trace = {
    request_id,
    model: settings.model,
    threads: settings.numThreads,
    rounds: 0,
    tool_calls: [],
  };
  if (!settings.apiKey || !settings.model) {
    throw assistantError(
      'The network assistant is not configured. Set LLM_API_KEY and an explicitly selected LLM_MODEL in backend/.env.',
      503,
      'LLM_NOT_CONFIGURED',
      {
        request_id,
        stage: 'configuration',
        assistant_trace: trace,
      },
    );
  }

  const now = Date.now();
  const id = conversation_id || randomUUID();
  const existing = conversations.get(id);
  if (existing && (now - existing.updatedAt > CONVERSATION_TTL_MS || existing.userId !== String(userId))) {
    conversations.delete(id);
  }
  const conversation = conversations.get(id);
  const messages = conversation
    ? conversation.messages.map((message) => ({
        ...message,
        ...(message.tool_calls
          ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) }
          : {}),
      }))
    : [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }];
  messages.push({ role: 'user', content: String(query) });

  const toolCalls = [];
  let visualization = conversation?.visualization || null;
  let pendingAction = conversation?.pending_action || null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    trace.rounds = round + 1;
    console.info(`[network-query:${request_id || 'unknown'}] sending model request round=${trace.rounds} model=${settings.model} threads=${settings.numThreads}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    let payload;
    try {
      const requestBody = {
        model: settings.model,
        messages,
        tools: LLM_TOOLS,
        ...(settings.isOllama
          ? {
              stream: false,
              options: { num_thread: settings.numThreads, temperature: 0.2 },
            }
          : {
              tool_choice: 'auto',
              temperature: 0.2,
            }),
      };
      const response = await fetchImpl(
        settings.isOllama ? settings.ollamaUrl : `${settings.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        },
      );
      payload = await response.json().catch(() => null);
      if (!response.ok) throw assistantError(payload?.error?.message || `LLM request failed with HTTP ${response.status}`);
    } catch (error) {
      const meta = { request_id, stage: 'model_request', assistant_trace: { ...trace, tool_calls: [...trace.tool_calls] } };
      if (error.name === 'AbortError') throw assistantError('The network assistant timed out. Check that the local model is loaded and increase LLM_TIMEOUT_MS if needed.', 504, 'LLM_TIMEOUT', meta);
      if (error.name === 'TypeError' && /fetch|connect|socket|network/i.test(error.message || '')) {
        throw assistantError(`Cannot reach the local LLM at ${settings.baseUrl}. Start Ollama with \'ollama serve\' and verify the model is installed.`, 503, 'LLM_UNREACHABLE', meta);
      }
      if (!error.request_id) Object.assign(error, meta);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const message = payload?.message || payload?.choices?.[0]?.message;
    if (!message) throw assistantError('The LLM returned an empty assistant response.', 502, 'LLM_EMPTY_RESPONSE');
    messages.push(message);
    const calls = message.tool_calls || [];
    console.info(`[network-query:${request_id || 'unknown'}] model response round=${trace.rounds} tool_calls=${calls.length}`);
    if (!calls.length) {
      const fallback = await validatedFallback(query, { userId, userRole });
      if (fallback) {
        trace.tool_calls.push(fallback.name);
        trace.fallback = 'validated_read_tool';
        toolCalls.push({ name: fallback.name, arguments: fallback.arguments, ok: true, source: 'validated_fallback' });
        console.info(`[network-query:${request_id || 'unknown'}] used validated fallback tool=${fallback.name}`);
        const fallbackTrace = { ...trace, tool_calls: [...trace.tool_calls] };
        conversations.set(id, {
          userId: String(userId),
          updatedAt: Date.now(),
          messages: messages.slice(-MAX_MESSAGES),
          visualization,
          pending_action: pendingAction,
        });
        return {
          status: 'ok',
          planner_source: 'llm-tools+validated-fallback',
          conversation_id: id,
          answer_text: fallback.answer_text,
          tool_calls: toolCalls,
          visualization,
          pending_action: pendingAction,
          assistant_trace: fallbackTrace,
        };
      }
      const answer = String(message.content || '').trim();
      if (!answer) throw assistantError('The LLM returned no readable assistant answer.', 502, 'LLM_EMPTY_RESPONSE');
      if (/\b(?:clear|hide|remove)\b.*\b(?:map|highlight|visual)/i.test(String(query))) visualization = null;
      conversations.set(id, {
        userId: String(userId),
        updatedAt: Date.now(),
        messages: messages.slice(-MAX_MESSAGES),
        visualization,
        pending_action: pendingAction,
      });
      return {
        status: 'ok',
        planner_source: 'llm-tools',
        conversation_id: id,
        answer_text: answer,
        tool_calls: toolCalls,
        visualization,
        pending_action: pendingAction,
        assistant_trace: { ...trace, tool_calls: [...trace.tool_calls] },
      };
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      trace.tool_calls.push(name || 'unknown');
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

  throw assistantError('The network assistant used too many graph lookups for one question.', 502, 'LLM_TOOL_LIMIT', {
    request_id,
    stage: 'tool_loop',
    assistant_trace: { ...trace, tool_calls: [...trace.tool_calls] },
  });
}

module.exports = { askNetworkAssistant, LLM_TOOLS };
