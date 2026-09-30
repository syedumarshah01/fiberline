const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const toolsPath = require.resolve('../src/services/networkTools');
const assistantPath = require.resolve('../src/services/geminiAssistant');
const plannerPath = require.resolve('../src/services/llmQueryPlanner');

const oldEnvironment = {
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
};

process.env.LLM_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'gemini-test';
process.env.GEMINI_BASE_URL = 'https://gemini.test/v1beta';

require.cache[toolsPath] = {
  id: toolsPath,
  filename: toolsPath,
  loaded: true,
  exports: {
    executeNetworkTool: async (name, args) => ({ name, args, poles: 3, boxes_with_spare_capacity: 2 }),
  },
};
delete require.cache[assistantPath];
const { askGeminiNetwork } = require('../src/services/geminiAssistant');

describe('Gemini network assistant tool loop', () => {
  test('executes a tool call and returns the final natural-language answer', async () => {
    const requests = [];
    const result = await askGeminiNetwork('How many poles and boxes are in the network?', {
      fetchImpl: async (url, options) => {
        requests.push({ url, options: JSON.parse(options.body) });
        if (requests.length === 1) {
          return new Response(JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_network_summary', args: {} } }] } }],
          }), { status: 200 });
        }
        const responseParts = requests[1].options.contents[2].parts;
        assert.equal(responseParts[0].functionResponse.name, 'get_network_summary');
        return new Response(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'The network has 3 poles and 2 boxes with spare capacity.' }] } }],
        }), { status: 200 });
      },
    });

    assert.equal(requests.length, 2);
    assert.equal(result.planner_source, 'gemini-tools');
    assert.match(result.answer_text, /3 poles/);
    assert.deepEqual(result.tool_calls[0], { name: 'get_network_summary', arguments: {}, ok: true });
  });
});

after(() => {
  for (const [key, value] of Object.entries(oldEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[assistantPath];
  delete require.cache[toolsPath];
  delete require.cache[plannerPath];
});
