const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const assistantPath = require.resolve('../src/services/llmAssistant');
const toolsPath = require.resolve('../src/services/networkTools');
const originalToolsModule = require.cache[toolsPath];
require.cache[toolsPath] = {
  id: toolsPath,
  filename: toolsPath,
  loaded: true,
  exports: {
    executeNetworkTool: async (name, args) => ({
      status: 'ok',
      name,
      args,
      counts: { poles: 3, enclosures: 2 },
    }),
  },
};

process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';
process.env.LLM_BASE_URL = 'https://llm.test/v1';

const { askNetworkAssistant } = require('../src/services/llmAssistant');

after(() => {
  delete require.cache[assistantPath];
  if (originalToolsModule) require.cache[toolsPath] = originalToolsModule;
  else delete require.cache[toolsPath];
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
});

describe('generic network assistant tool loop', () => {
  test('uses the configured OpenAI-compatible endpoint and executes validated tools', async () => {
    const requests = [];
    const result = await askNetworkAssistant('How many poles are in the network?', {
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (requests.length === 1) {
          return new Response(JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'get_network_summary', arguments: '{}' },
                }],
              },
            }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'There are 3 poles.' } }],
        }), { status: 200 });
      },
    });

    assert.equal(requests[0].url, 'https://llm.test/v1/chat/completions');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(requests[0].options.body).model, 'test-model');
    assert.equal(result.answer_text, 'There are 3 poles.');
    assert.equal(result.planner_source, 'llm-tools');
    assert.equal(result.tool_calls[0].name, 'get_network_summary');
  });
});
