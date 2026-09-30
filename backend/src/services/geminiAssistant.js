const {
  config,
  SYSTEM_PROMPT,
  ASSISTANT_SYSTEM_PROMPT,
  TOOL_DECLARATIONS,
} = require('./llmQueryPlanner');
const { executeNetworkTool } = require('./networkTools');

const MAX_TOOL_ROUNDS = 4;

function assistantError(message, status = 502, code = 'LLM_REQUEST_FAILED') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function responseParts(payload) {
  return payload?.candidates?.[0]?.content?.parts || [];
}

async function askGeminiNetwork(query, { fetchImpl = fetch } = {}) {
  const settings = config();
  if (settings.provider !== 'gemini') {
    throw assistantError('The network assistant is configured for Gemini only.', 503, 'GEMINI_NOT_SELECTED');
  }
  if (!settings.apiKey) {
    throw assistantError('Gemini is not configured. Set GEMINI_API_KEY in backend/.env.', 503, 'LLM_NOT_CONFIGURED');
  }

  const contents = [{ role: 'user', parts: [{ text: String(query) }] }];
  const toolCalls = [];
  const timerController = () => new AbortController();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const controller = timerController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    let payload;
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
            systemInstruction: { parts: [{ text: ASSISTANT_SYSTEM_PROMPT }] },
            contents,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            generationConfig: { temperature: 0.2 },
          }),
          signal: controller.signal,
        },
      );
      payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw assistantError(payload?.error?.message || `Gemini request failed with HTTP ${response.status}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') throw assistantError('The network assistant timed out.', 504, 'LLM_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const parts = responseParts(payload);
    if (!parts.length) throw assistantError('Gemini returned an empty network-assistant response.', 502, 'LLM_EMPTY_RESPONSE');

    // Preserve the model turn verbatim. Gemini expects this model content to be
    // followed by the function responses in the same conversation.
    contents.push({ role: 'model', parts });
    const calls = parts.filter((part) => part.functionCall?.name);
    if (!calls.length) {
      const answer = parts.map((part) => part.text || '').join('').trim();
      if (!answer) throw assistantError('Gemini returned no readable network-assistant answer.', 502, 'LLM_EMPTY_RESPONSE');
      return {
        status: 'ok',
        planner_source: 'gemini-tools',
        answer_text: answer,
        tool_calls: toolCalls,
      };
    }

    const functionResponses = [];
    for (const part of calls) {
      const name = part.functionCall.name;
      let args = part.functionCall.args || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const result = await executeNetworkTool(name, args);
      toolCalls.push({ name, arguments: args, ok: !result?.error });
      functionResponses.push({ functionResponse: { name, response: result } });
    }
    contents.push({ role: 'user', parts: functionResponses });
  }

  throw assistantError('The network assistant used too many graph lookups for one question.', 502, 'LLM_TOOL_LIMIT');
}

module.exports = { askGeminiNetwork };
