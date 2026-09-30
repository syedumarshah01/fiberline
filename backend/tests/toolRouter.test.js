const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TOOLS,
  buildRouterPrompt,
  buildRouterResponseSchema,
  validateToolCall,
} = require('../src/ai/toolRouterSchema');
const {
  config,
  inferToolCall,
  routeToolCall,
} = require('../src/services/toolRouter');

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('tool catalog stays deliberately small and builds one schema branch per tool', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    'checkServiceability',
    'findPortRemediation',
    'findPowerRemediation',
    'findCoreRemediation',
    'traceCore',
    'simulateFailure',
    'locateCustomer',
    'lookupDocs',
  ]);
  const schema = buildRouterResponseSchema();
  assert.equal(schema.oneOf.length, TOOLS.length);
  assert.deepEqual(schema.oneOf.map((branch) => branch.properties.tool.enum[0]), TOOLS.map((tool) => tool.name));
  assert.equal(schema.oneOf[0].properties.args.properties.enclosure_id.type, 'string');
  assert.deepEqual(schema.oneOf[0].properties.args.required, ['enclosure_id']);
});

test('router prompt contains the complete short contract, examples, and actual query', () => {
  const prompt = buildRouterPrompt('Which core should serve the customer at BOX-7?');
  for (const tool of TOOLS) assert.match(prompt, new RegExp(`- ${tool.name}:`));
  assert.match(prompt, /Examples:/);
  assert.match(prompt, /Which core should serve the customer at BOX-7/);
  // Keep the prompt bounded before any live context is added.
  assert.ok(prompt.length < 8000, `prompt was ${prompt.length} characters`);
});

test('defense-in-depth validation accepts valid routes and rejects malformed routes', () => {
  assert.deepEqual(validateToolCall({
    tool: 'traceCore',
    args: { core_id: 'core-123' },
  }), { tool: 'traceCore', args: { core_id: 'core-123' } });
  assert.deepEqual(validateToolCall({
    tool: 'locateCustomer',
    args: { lat: 34, lng: 71, radius_m: 500 },
  }).tool, 'locateCustomer');
  assert.throws(
    () => validateToolCall({ tool: 'traceCore', args: {} }),
    /missing required argument: core_id/,
  );
  assert.throws(
    () => validateToolCall({ tool: 'not-a-tool', args: {} }),
    /unknown tool/,
  );
  assert.throws(
    () => validateToolCall({ tool: 'checkServiceability', args: { enclosure_id: 'box', made_up: 1 } }),
    /unknown argument: made_up/,
  );
  assert.throws(
    () => validateToolCall({ tool: 'locateCustomer', args: { lat: 34 } }),
    /latitude and longitude must be provided together/i,
  );
  assert.throws(
    () => validateToolCall({ tool: 'locateCustomer', args: { address: '' } }),
    /requires an address or a latitude\/longitude pair/,
  );
});

test('router uses Ollama structured output and returns only tool plus args', async () => {
  const calls = [];
  const result = await routeToolCall('Trace core core-123.', {
    env: {
      LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
      LLM_MODEL: 'llama3.2:1b',
      LLM_TIMEOUT_MS: '12000',
      OLLAMA_NUM_THREADS: '8',
    },
    requestId: 'request-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ message: { content: JSON.stringify({ tool: 'traceCore', args: { core_id: 'core-123' } }) } });
    },
  });
  assert.deepEqual(result, { tool: 'traceCore', args: { core_id: 'core-123' } });
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'llama3.2:1b');
  assert.equal(body.stream, false);
  assert.equal(body.options.num_thread, 8);
  assert.equal(body.options.temperature, 0);
  assert.deepEqual(body.format, buildRouterResponseSchema());
  assert.match(body.messages[0].content, /Trace core core-123/);
});

test('router reports a clear local-service error when Ollama is unavailable', async () => {
  await assert.rejects(
    () => inferToolCall('Trace core core-123.', {
      env: { LLM_BASE_URL: 'http://127.0.0.1:11434/v1' },
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
      requestId: 'request-2',
    }),
    (error) => error.code === 'TOOL_ROUTER_UNREACHABLE' && /local Ollama/.test(error.message),
  );
});

test('router config defaults to the required local model and computation settings', () => {
  assert.deepEqual(config({}), {
    model: 'llama3.2:1b',
    url: 'http://127.0.0.1:11434/api/chat',
    timeoutMs: 180000,
    numThreads: 8,
  });
});
