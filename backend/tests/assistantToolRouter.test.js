const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { getToolSchema } = require('../src/tools/toolSchema');
const {
  ToolRouterError,
  parseModelToolCall,
  executeModelToolSelection,
  createToolRouter,
} = require('../src/tools/toolRouter');

describe('lookupDocs tool schema and routing', () => {
  test('publishes a strict lookupDocs JSON schema for model tool calls', () => {
    const schema = getToolSchema();
    assert.equal(schema.length, 1);
    assert.equal(schema[0].type, 'function');
    assert.equal(schema[0].function.name, 'lookupDocs');
    assert.deepEqual(schema[0].function.parameters.required, ['query']);
    assert.equal(schema[0].function.parameters.additionalProperties, false);
    assert.equal(schema[0].function.parameters.properties.query.maxLength, 1000);
  });

  test('routes the provider-agnostic {tool,args} invocation', async () => {
    const router = createToolRouter({ lookupDocs: async (args) => ({ answer: `Doc answer for ${args.query}` }) });
    assert.deepEqual(await router.execute({ tool: 'lookupDocs', args: { query: 'trace behavior' } }), {
      answer: 'Doc answer for trace behavior',
    });
  });

  test('normalizes OpenAI-compatible model tool calls to {tool,args}', async () => {
    const router = createToolRouter({ lookupDocs: async ({ query }) => query });
    assert.deepEqual(parseModelToolCall({
      id: 'call-1',
      function: { name: 'lookupDocs', arguments: '{"query":"splitter loss"}' },
    }), { tool: 'lookupDocs', args: { query: 'splitter loss' } });
    assert.equal(await router.executeModelToolCall({
      function: { name: 'lookupDocs', arguments: '{"query":"splitter loss"}' },
    }), 'splitter loss');
  });

  test('uses either model provider with the same schema and {tool,args} dispatch', async () => {
    const router = createToolRouter({ lookupDocs: async ({ query }) => ({ answer: query }) });
    let request;
    const result = await executeModelToolSelection({
      provider: {
        chatCompletion: async (payload) => {
          request = payload;
          return {
            choices: [{ message: { tool_calls: [{ function: { name: 'lookupDocs', arguments: '{\"query\":\"trace behavior\"}' } }] } }],
          };
        },
      },
      toolRouter: router,
      messages: [{ role: 'user', content: 'trace behavior' }],
      toolChoice: 'required',
      maxTokens: 80,
    });
    assert.deepEqual(result, { answer: 'trace behavior' });
    assert.deepEqual(request.tools, getToolSchema());
    assert.equal(request.toolChoice, 'required');
    assert.equal(request.maxTokens, 80);
  });

  test('rejects invalid, unknown, and unconfigured tool calls', async () => {
    const router = createToolRouter({});
    await assert.rejects(router.execute(null), ToolRouterError);
    await assert.rejects(router.execute({ tool: 'unknown', args: {} }), { statusCode: 404 });
    await assert.rejects(router.execute({ tool: 'lookupDocs', args: {} }), { statusCode: 503 });
    assert.throws(() => parseModelToolCall({ function: { name: 'lookupDocs', arguments: '{no-json' } }), /invalid JSON/i);
  });
});
