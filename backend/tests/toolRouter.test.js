const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TOOLS,
  DEFAULT_STRING_MAX_LENGTH,
  STRING_MAX_LENGTHS,
  TOOL_NAME_MAX_LENGTH,
  FEW_SHOT_EXAMPLES,
  buildOpenAITools,
  buildRouterInstruction,
  buildRouterPrompt,
  buildRouterResponseSchema,
  validateToolCall,
} = require('../src/ai/toolRouterSchema');
const { SELECTED_LOCAL_MODEL } = require('../src/ai/localModelConfig');
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
  const openAITools = buildOpenAITools();
  assert.deepEqual(openAITools.map((entry) => entry.function.name), TOOLS.map((tool) => tool.name));
  assert.equal(openAITools.find((entry) => entry.function.name === 'lookupDocs').function.parameters.additionalProperties, false);
});

test('router schema bounds every string field, including tool names and all argument schemas', () => {
  const schema = buildRouterResponseSchema();
  for (const branch of schema.oneOf) {
    const toolName = branch.properties.tool.enum[0];
    assert.equal(branch.properties.tool.maxLength, TOOL_NAME_MAX_LENGTH);
    const catalogTool = TOOLS.find((tool) => tool.name === toolName);
    for (const [name, parameter] of Object.entries(catalogTool.parameters || {})) {
      if (parameter.type !== 'string') continue;
      assert.equal(
        branch.properties.args.properties[name].maxLength,
        parameter.maxLength ?? STRING_MAX_LENGTHS[name] ?? DEFAULT_STRING_MAX_LENGTH,
        `${toolName}.${name} must carry its character bound`,
      );
    }
  }
  assert.equal(schema.oneOf.find((branch) => branch.properties.tool.enum[0] === 'locateCustomer')
    .properties.args.properties.address.maxLength, 200);
  assert.equal(schema.oneOf.find((branch) => branch.properties.tool.enum[0] === 'lookupDocs')
    .properties.args.properties.query.maxLength, 300);
});

test('few-shot prompt examples cover all eight tools without copying benchmark test prompts', () => {
  const benchmarkQueries = require('../../ai/benchmark-queries.json').map((item) => item.query);
  assert.equal(FEW_SHOT_EXAMPLES.length, TOOLS.length + 5);
  for (const tool of TOOLS) {
    const expectedCount = { checkServiceability: 2, lookupDocs: 3, locateCustomer: 2, traceCore: 2 }[tool.name] || 1;
    assert.equal(FEW_SHOT_EXAMPLES.filter((example) => example.result.tool === tool.name).length, expectedCount);
  }
  assert.deepEqual(
    [...new Set(FEW_SHOT_EXAMPLES.map((example) => example.result.tool))].sort(),
    TOOLS.map((tool) => tool.name).sort(),
  );
  for (const example of FEW_SHOT_EXAMPLES) {
    assert.ok(!benchmarkQueries.includes(example.query), `few-shot query duplicates a benchmark case: ${example.query}`);
    assert.deepEqual(Object.keys(example.result).sort(), ['args', 'tool']);
    assert.deepEqual(validateToolCall(example.result), example.result);
    const branch = buildRouterResponseSchema().oneOf.find((entry) =>
      entry.properties.tool.enum[0] === example.result.tool);
    assert.deepEqual(branch.required, ['tool', 'args']);
    assert.equal(branch.additionalProperties, false);
    const argsSchema = branch.properties.args;
    assert.equal(argsSchema.additionalProperties, false);
    for (const required of argsSchema.required || []) {
      assert.ok(Object.hasOwn(example.result.args, required), `${example.result.tool} requires ${required}`);
    }
    for (const [name, value] of Object.entries(example.result.args)) {
      const parameter = argsSchema.properties[name];
      assert.ok(parameter, `${example.result.tool}.${name} must be a schema property`);
      assert.equal(typeof value, parameter.type);
      if (parameter.maxLength !== undefined) assert.ok(value.length <= parameter.maxLength);
      if (parameter.minimum !== undefined) assert.ok(value >= parameter.minimum);
      if (parameter.maximum !== undefined) assert.ok(value <= parameter.maximum);
    }
  }
});

test('splitter examples contrast general documentation with live enclosure port remediation', () => {
  const docsIndex = FEW_SHOT_EXAMPLES.findIndex((example) =>
    example.result.tool === 'lookupDocs' && example.query.includes('1:32 splitter'));
  assert.ok(docsIndex >= 0);
  const docs = FEW_SHOT_EXAMPLES[docsIndex];
  assert.match(docs.query, /general design reference.*insertion loss.*specification assume/);
  assert.deepEqual(docs.result, {
    tool: 'lookupDocs',
    args: { query: 'specification assumed insertion loss for 1:32 splitter' },
  });
  const remediation = FEW_SHOT_EXAMPLES[docsIndex - 1];
  assert.match(remediation.query, /NAP-22.*no unoccupied splitter output.*deterministic port remedy/);
  assert.deepEqual(remediation.result, { tool: 'findPortRemediation', args: { enclosure_id: 'NAP-22' } });
  assert.ok(FEW_SHOT_EXAMPLES.some((example) =>
    example.query === 'According to the project documentation, when is an optical-power warning raised?' &&
    example.result.tool === 'lookupDocs' &&
    example.result.args.query === 'when is an optical-power warning raised'));

  const instruction = buildRouterInstruction();
  assert.ok(instruction.includes(
    `User: ${remediation.query}\nJSON: ${JSON.stringify(remediation.result)}\n` +
    `User: ${docs.query}\nJSON: ${JSON.stringify(docs.result)}`,
  ));
});

test('serviceability examples omit location fields unless the query supplies coordinates', () => {
  const examples = FEW_SHOT_EXAMPLES.filter((example) => example.result.tool === 'checkServiceability');
  assert.equal(examples.length, 2);
  const noLocation = examples.find((example) => example.query === 'Can enclosure CAB-57 serve this customer?');
  assert.ok(noLocation);
  assert.deepEqual(noLocation.result, { tool: 'checkServiceability', args: { enclosure_id: 'CAB-57' } });
  for (const name of ['lat', 'lng', 'address']) {
    assert.equal(Object.hasOwn(noLocation.result.args, name), false, `${name} must be absent, not guessed or zero`);
  }
  const withLocation = examples.find((example) => Object.hasOwn(example.result.args, 'lat'));
  assert.ok(withLocation);
  assert.match(withLocation.query, /latitude 33\.6844 and longitude 73\.0479/);
  assert.deepEqual(withLocation.result.args, { enclosure_id: 'POP-31', lat: 33.6844, lng: 73.0479 });

  const rules = buildRouterInstruction().split('Tools:')[0];
  assert.match(rules, /Populate optional location parameters only when explicitly supplied in the user query/);
  assert.match(rules, /otherwise omit them entirely, never guess or substitute zero/);
});

test('trace examples contrast general feature documentation with tracing a specific core', () => {
  const docsIndex = FEW_SHOT_EXAMPLES.findIndex((example) =>
    example.query === 'How does the fiber tracing feature work in general?');
  assert.ok(docsIndex >= 0);
  const docs = FEW_SHOT_EXAMPLES[docsIndex];
  assert.deepEqual(docs.result, { tool: 'lookupDocs', args: { query: 'how the fiber tracing feature works' } });
  assert.doesNotMatch(docs.query, /\b[A-Z]+-\d+\b/);
  const trace = FEW_SHOT_EXAMPLES[docsIndex + 1];
  assert.equal(trace.query, 'Trace fiber core FBR-62 through the network.');
  assert.deepEqual(trace.result, { tool: 'traceCore', args: { core_id: 'FBR-62' } });

  const instruction = buildRouterInstruction();
  assert.ok(instruction.includes(
    `User: ${docs.query}\nJSON: ${JSON.stringify(docs.result)}\n` +
    `User: ${trace.query}\nJSON: ${JSON.stringify(trace.result)}`,
  ));
  const rules = instruction.split('Tools:')[0];
  assert.match(rules, /general question about how a feature works, with no specific core\/cable\/enclosure ID, is a lookupDocs request/);
  assert.match(rules, /even when its wording matches a tool name/);
  assert.match(rules, /A request to trace a named core uses traceCore/);
});

test('Python benchmark export matches the current application prompt and schema without inference', () => {
  const exported = require('../../ai/router-benchmark-config.json');
  assert.equal(exported.system_prompt, buildRouterInstruction());
  assert.deepEqual(exported.schema, buildRouterResponseSchema());
});

test('locateCustomer examples use mutually exclusive address-only and numeric coordinates-only inputs', () => {
  const examples = FEW_SHOT_EXAMPLES.filter((example) => example.result.tool === 'locateCustomer');
  assert.equal(examples.length, 2);
  const addressExample = examples.find((example) => Object.hasOwn(example.result.args, 'address'));
  const coordinatesExample = examples.find((example) => Object.hasOwn(example.result.args, 'lat'));
  assert.ok(addressExample);
  assert.ok(coordinatesExample);
  assert.match(addressExample.query, /45 Park Road/);
  assert.doesNotMatch(addressExample.query, /latitude|longitude|34\.0156|71\.5251/);
  assert.deepEqual(addressExample.result.args, { address: '45 Park Road', radius_m: 800, route: true });
  assert.match(coordinatesExample.query, /latitude 34\.0156 and longitude 71\.5251/);
  assert.doesNotMatch(coordinatesExample.query, /address|Park Road/);
  assert.deepEqual(coordinatesExample.result.args, { lat: 34.0156, lng: 71.5251 });
  for (const example of examples) {
    const { args } = example.result;
    const hasAddress = Object.hasOwn(args, 'address');
    const hasLat = Object.hasOwn(args, 'lat');
    const hasLng = Object.hasOwn(args, 'lng');
    assert.equal(hasLat, hasLng, 'coordinates must be a complete pair');
    assert.notEqual(hasAddress, hasLat, 'use exactly one location alternative');
    assert.deepEqual(validateToolCall(example.result), example.result);
  }
});

test('system instruction prioritizes supplied coordinates and renders every example as exact JSON', () => {
  const instruction = buildRouterInstruction();
  const systemRules = instruction.split('Tools:')[0];
  assert.match(systemRules, /For locateCustomer, use address only when coordinates are not supplied;/);
  assert.match(systemRules, /when latitude and longitude are supplied, use that pair and omit address/);
  const renderedExamples = instruction.split('\n').filter((line) => line.startsWith('JSON: '))
    .map((line) => JSON.parse(line.slice('JSON: '.length)));
  assert.deepEqual(renderedExamples, FEW_SHOT_EXAMPLES.map((example) => example.result));
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

test('defense-in-depth validation enforces the same string bounds as the constrained schema', () => {
  assert.throws(
    () => validateToolCall({ tool: 'traceCore', args: { core_id: 'x'.repeat(65) } }),
    /traceCore.core_id must be 64 characters or fewer/,
  );
  assert.throws(
    () => validateToolCall({ tool: 'locateCustomer', args: { address: 'x'.repeat(201) } }),
    /locateCustomer.address must be 200 characters or fewer/,
  );
  assert.throws(
    () => validateToolCall({ tool: 'lookupDocs', args: { query: 'x'.repeat(301) } }),
    /lookupDocs.query must be 300 characters or fewer/,
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
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /Show me the documented route taken by fiber CORE-23/);
  assert.deepEqual(body.messages[1], { role: 'user', content: 'Trace core core-123.' });
});

test('local OpenAI-compatible inference uses catalog-constrained JSON and preserves the { tool, args } contract', async () => {
  const calls = [];
  const result = await routeToolCall('Trace core core-456.', {
    env: {
      AI_PROVIDER: 'local',
      LOCAL_LLM_BASE_URL: 'http://llama.test:8080/v1',
      LOCAL_LLM_MODEL: 'offline-small',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({
        choices: [{ message: { content: JSON.stringify({ tool: 'traceCore', args: { core_id: 'core-456' } }) } }],
      });
    },
  });

  assert.deepEqual(result, { tool: 'traceCore', args: { core_id: 'core-456' } });
  assert.equal(calls[0].url, 'http://llama.test:8080/v1/chat/completions');
  assert.equal(calls[0].body.model, 'offline-small');
  assert.equal(calls[0].body.response_format.type, 'json_schema');
  assert.equal(calls[0].body.response_format.json_schema.schema.oneOf.length, TOOLS.length);
  assert.equal(calls[0].body.tools, undefined);
});

test('cloud inference uses the same catalog as required OpenAI-compatible function tools', async () => {
  const calls = [];
  const result = await routeToolCall('What does the documentation say about splitter loss?', {
    env: {
      AI_PROVIDER: 'cloud',
      CLOUD_LLM_API_KEY: 'test-key',
      CLOUD_LLM_MODEL: 'small-cloud-model',
      CLOUD_LLM_BASE_URL: 'https://cloud.test/v1',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response({
        choices: [{
          message: {
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'lookupDocs', arguments: JSON.stringify({ query: 'splitter loss' }) },
            }],
          },
        }],
      });
    },
  });

  assert.deepEqual(result, { tool: 'lookupDocs', args: { query: 'splitter loss' } });
  assert.equal(calls[0].url, 'https://cloud.test/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key');
  assert.equal(calls[0].body.tool_choice, 'required');
  assert.deepEqual(calls[0].body.tools, buildOpenAITools());
  assert.deepEqual(calls[0].body.tools.map((tool) => tool.function.name), TOOLS.map((tool) => tool.name));
});

test('router rejects multiple provider tool calls instead of silently executing one', async () => {
  await assert.rejects(
    () => routeToolCall('Trace core core-1 and core-2.', {
      env: {
        AI_PROVIDER: 'cloud',
        CLOUD_LLM_API_KEY: 'test-key',
        CLOUD_LLM_MODEL: 'small-cloud-model',
      },
      fetchImpl: async () => response({
        choices: [{ message: { tool_calls: [
          { function: { name: 'traceCore', arguments: '{"core_id":"core-1"}' } },
          { function: { name: 'traceCore', arguments: '{"core_id":"core-2"}' } },
        ] } }],
      }),
    }),
    (error) => error.code === 'TOOL_ROUTER_MULTIPLE_CALLS' && /more than one tool call/.test(error.message),
  );
});

test('router reports a clear local-service error when Ollama is unavailable', async () => {
  await assert.rejects(
    () => inferToolCall('Trace core core-123.', {
      env: {
        LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
        LLM_MODEL: 'test-model',
      },
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
      requestId: 'request-2',
    }),
    (error) => error.code === 'TOOL_ROUTER_UNREACHABLE' && /local Ollama/.test(error.message),
  );
});

test('router defaults to selected Qwen GGUF and uses the Phase 6 core-count ceiling', () => {
  assert.deepEqual(config({}), {
    model: SELECTED_LOCAL_MODEL,
    url: 'http://127.0.0.1:8080/api/chat',
    timeoutMs: 180000,
    numThreads: 4,
  });
});

test('native Ollama still requires an explicit installed-model tag', async () => {
  let requested = false;
  await assert.rejects(
    () => inferToolCall('Trace core core-123.', {
      env: { TOOL_ROUTER_TRANSPORT: 'ollama' },
      requestId: 'no-model',
      fetchImpl: async () => {
        requested = true;
        return response({ message: { content: '{}' } });
      },
    }),
    (error) => error.code === 'TOOL_ROUTER_MODEL_NOT_CONFIGURED' && /installed Ollama model tag/.test(error.message),
  );
  assert.equal(requested, false, 'no provider request is sent with an implicit model');
});


test('unconfigured local router sends the selected model to llama.cpp, not Ollama', async () => {
  let request;
  const route = await routeToolCall('Trace core core-123.', {
    env: {},
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return response({ choices: [{ message: { content: '{"tool":"traceCore","args":{"core_id":"core-123"}}' } }] });
    },
  });
  assert.deepEqual(route, { tool: 'traceCore', args: { core_id: 'core-123' } });
  assert.equal(request.url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(request.body.model, SELECTED_LOCAL_MODEL);
  assert.deepEqual(request.body.response_format.json_schema.schema, buildRouterResponseSchema());
});
