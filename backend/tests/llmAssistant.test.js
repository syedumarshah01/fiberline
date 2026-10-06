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
    executeNetworkTool: async (name, args) => name === 'get_network_summary'
      ? { status: 'ok', poles: 3, enclosures: 7, cables: 4, customers: 12 }
      : ({ status: 'ok', name, args, counts: { poles: 3, enclosures: 2 } }),
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
    assert.equal(result.answer_text, 'The current network has 3 poles.');
    assert.equal(result.planner_source, 'llm-tools+validated-fallback');
    assert.equal(result.tool_calls[0].name, 'get_network_summary');
  });

  test('falls back to a validated summary tool when the small model answers without a tool call', async () => {
    const result = await askNetworkAssistant('How many boxes are in my network?', {
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: "I don't know." } }],
      }), { status: 200 }),
    });

    assert.match(result.answer_text, /7 boxes/);
    assert.equal(result.planner_source, 'llm-tools+validated-fallback');
    assert.equal(result.tool_calls[0].source, 'validated_fallback');
    assert.equal(result.assistant_trace.fallback, 'validated_read_tool');
  });

  test('sends Ollama native options with the configured computation thread count', async () => {
    const previousBase = process.env.LLM_BASE_URL;
    const previousThreads = process.env.OLLAMA_NUM_THREADS;
    process.env.LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
    process.env.OLLAMA_NUM_THREADS = '12';
    let request;
    try {
      const result = await askNetworkAssistant('Say hello.', {
        fetchImpl: async (url, options) => {
          request = { url, options };
          return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Hello.' } }), { status: 200 });
        },
      });
      assert.equal(result.answer_text, 'Hello.');
    } finally {
      if (previousBase === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = previousBase;
      if (previousThreads === undefined) delete process.env.OLLAMA_NUM_THREADS;
      else process.env.OLLAMA_NUM_THREADS = previousThreads;
    }
    assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(JSON.parse(request.options.body).options.num_thread, 12);
    assert.equal(JSON.parse(request.options.body).stream, false);
  });
});
