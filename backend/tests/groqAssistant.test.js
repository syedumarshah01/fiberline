const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const toolsPath = require.resolve('../src/services/networkTools');
const assistantPath = require.resolve('../src/services/groqAssistant');
const oldEnvironment = {
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_MODEL: process.env.GROQ_MODEL,
  GROQ_BASE_URL: process.env.GROQ_BASE_URL,
};
process.env.LLM_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'test-key';
process.env.GROQ_MODEL = 'openai/gpt-oss-20b';
process.env.GROQ_BASE_URL = 'https://groq.test/openai/v1';

require.cache[toolsPath] = {
  id: toolsPath,
  filename: toolsPath,
  loaded: true,
  exports: {
    executeNetworkTool: async () => ({ poles: 4, boxes_with_spare_capacity: 1 }),
  },
};
delete require.cache[assistantPath];
const { askGroqNetwork } = require('../src/services/groqAssistant');

describe('Groq network assistant tool loop', () => {
  test('uses the supplied Groq model through the OpenAI-compatible API', async () => {
    const requests = [];
    const result = await askGroqNetwork('How many poles are in the network?', {
      fetchImpl: async (url, options) => {
        requests.push({ url, options: JSON.parse(options.body), headers: options.headers });
        if (requests.length === 1) {
          return new Response(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
              id: 'groq-call-1', type: 'function', function: { name: 'get_network_summary', arguments: '{}' },
            }] } }],
          }), { status: 200 });
        }
        assert.equal(requests[1].options.messages[3].role, 'tool');
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'The network has 4 poles.' } }],
        }), { status: 200 });
      },
    });

    assert.equal(requests[0].url, 'https://groq.test/openai/v1/chat/completions');
    assert.equal(requests[0].headers.Authorization, 'Bearer test-key');
    assert.equal(requests[0].options.model, 'openai/gpt-oss-20b');
    assert.equal(result.planner_source, 'groq-tools');
    assert.match(result.answer_text, /4 poles/);
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
