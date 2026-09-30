const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const toolsPath = require.resolve('../src/services/networkTools');
const assistantPath = require.resolve('../src/services/openRouterAssistant');
const oldEnvironment = {
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
};
process.env.LLM_PROVIDER = 'openrouter';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_MODEL = 'openai/gpt-4o';
process.env.OPENROUTER_BASE_URL = 'https://openrouter.test/api/v1';

require.cache[toolsPath] = {
  id: toolsPath,
  filename: toolsPath,
  loaded: true,
  exports: {
    executeNetworkTool: async () => ({ poles: 3, boxes_with_spare_capacity: 2 }),
  },
};
delete require.cache[assistantPath];
const { askOpenRouterNetwork } = require('../src/services/openRouterAssistant');

describe('OpenRouter network assistant tool loop', () => {
  test('uses OpenAI-compatible tool calls and returns a final answer', async () => {
    const requests = [];
    const result = await askOpenRouterNetwork('How many poles are in the network?', {
      fetchImpl: async (url, options) => {
        requests.push({ url, options: JSON.parse(options.body) });
        if (requests.length === 1) {
          return new Response(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
              id: 'call-1', type: 'function', function: { name: 'get_network_summary', arguments: '{}' },
            }] } }],
          }), { status: 200 });
        }
        assert.equal(requests[1].options.messages[3].role, 'tool');
        assert.equal(requests[1].options.messages[3].tool_call_id, 'call-1');
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'The network has 3 poles.' } }],
        }), { status: 200 });
      },
    });

    assert.equal(requests[0].url, 'https://openrouter.test/api/v1/chat/completions');
    assert.equal(result.planner_source, 'openrouter-tools');
    assert.match(result.answer_text, /3 poles/);
    assert.equal(result.tool_calls[0].name, 'get_network_summary');
  });
});

after(() => {
  for (const [key, value] of Object.entries(oldEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[assistantPath];
  delete require.cache[toolsPath];
});
