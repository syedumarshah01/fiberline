const assert = require('node:assert/strict');
const test = require('node:test');
const networkQueryRouter = require('../src/routes/networkQuery');
const { createQueryHandler, MAX_QUERY_LENGTH, ROUTER_SOURCE } = networkQueryRouter;
const { routeToolCall } = require('../src/services/toolRouter');
const { executeToolCall } = require('../src/services/toolExecutor');
const { formatResponse } = require('../src/services/responseFormatter');

function fakeResponse() {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  return response;
}

function postRequest(query, { conversationId = 'conversation-1', user } = {}) {
  return {
    method: 'POST',
    body: { query, conversation_id: conversationId },
    query: {},
    user: user || { id: 'user-7', role: 'technician' },
  };
}

test('exports an Express router while exposing the handler factory for integration tests', () => {
  assert.equal(typeof networkQueryRouter.handle, 'function');
  assert.equal(typeof networkQueryRouter.post, 'function');
  assert.equal(typeof networkQueryRouter.createQueryHandler, 'function');
  assert.equal(typeof networkQueryRouter.requestCustomerLocation, 'function');
});

test('passes explicit customer coordinates through execution context without changing tool args', async () => {
  let executed;
  const handler = createQueryHandler({
    route: async () => ({ tool: 'findCoreRemediation', args: { enclosure_id: 'BOX-1' } }),
    execute: async (_toolCall, options) => {
      executed = options;
      return { success: true, result: { status: 'needs_input', candidates: [], reason: 'test' } };
    },
    format: async () => 'Needs a location.',
  });
  const req = postRequest('Find a spare core near this customer.');
  req.body.customer_location = { lat: 34.01, lng: 71.58 };
  const res = fakeResponse();

  await handler(req, res, () => {});

  assert.deepEqual(executed.context, {
    userId: 'user-7', userRole: 'technician', customer_location: { lat: 34.01, lng: 71.58 },
  });
  assert.deepEqual(res.body.tool_calls[0].args, { enclosure_id: 'BOX-1' });
});

test('rejects malformed optional customer coordinates before routing', async () => {
  let routed = false;
  const handler = createQueryHandler({
    route: async () => { routed = true; return { tool: 'traceCore', args: { core_id: 'x' } }; },
    execute: async () => ({ success: true, result: [] }),
    format: async () => 'No results.',
  });
  const req = postRequest('Trace core x.');
  req.body.customer_location = { lat: 91, lng: 71 };
  const res = fakeResponse();
  await handler(req, res, () => {});
  assert.equal(routed, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'INVALID_CUSTOMER_LOCATION');
});

test('active network-query handler routes, executes, formats, and returns a grounded docs result', async () => {
  const calls = [];
  const docs = {
    query: 'How does fiber tracing work?',
    answer: 'Fiber tracing follows recorded splices.',
    sources: [{ source: 'README.md', section: 'Network tracing', score: 0.82, excerpt: 'Tracing follows the recorded splice chain.' }],
    mode: 'generated',
  };
  const handler = createQueryHandler({
    route: async (query, options) => {
      calls.push({ stage: 'route', query, options });
      return { tool: 'lookupDocs', args: { query } };
    },
    execute: async (toolCall, options) => {
      calls.push({ stage: 'execute', toolCall, options });
      return { success: true, tool: toolCall.tool, result: docs };
    },
    format: async (value) => `formatted: ${value}`,
  });
  const res = fakeResponse();
  let nextError;

  await handler(postRequest('How does fiber tracing work?'), res, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-request-id'], res.body.request_id);
  assert.equal(res.body.conversation_id, 'conversation-1');
  assert.equal(res.body.planner_source, ROUTER_SOURCE);
  assert.equal(res.body.answer_text, 'formatted: Fiber tracing follows recorded splices.');
  assert.equal(res.body.tool_calls[0].tool, 'lookupDocs');
  assert.deepEqual(res.body.tool_calls[0].result.sources, docs.sources);
  assert.equal(calls[0].stage, 'route');
  assert.equal(calls[0].options.requestId, res.body.request_id);
  assert.deepEqual(calls[1].options.context, { userId: 'user-7', userRole: 'technician' });
});

test('active network-query handler passes network-tool results to the template formatter', async () => {
  const trace = [
    { core_id: 'core-a', core_number: 1, cable_code: 'CBL-1' },
    { splice_id: 'splice-1', splice_type: 'fusion' },
    { core_id: 'core-b', core_number: 1, cable_code: 'CBL-2' },
  ];
  let formatted;
  const handler = createQueryHandler({
    route: async () => ({ tool: 'traceCore', args: { core_id: 'core-a' } }),
    execute: async () => ({ success: true, result: { status: 'ok', core: { id: 'core-a' }, trace } }),
    format: async (value) => { formatted = value; return 'The trace is ready.'; },
  });
  const res = fakeResponse();

  await handler(postRequest('Trace core core-a.'), res, () => {});

  assert.deepEqual(formatted, trace);
  assert.equal(res.body.answer_text, 'The trace is ready.');
  assert.deepEqual(res.body.tool_calls[0].result.trace, trace);
});

test('router, executor, and formatter work together end to end without live model or database dependencies', async () => {
  const env = {
    AI_PROVIDER: 'cloud',
    CLOUD_LLM_API_KEY: 'integration-test-key',
    CLOUD_LLM_MODEL: 'stub-model',
  };
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice, 'required');
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              tool_calls: [{
                type: 'function',
                function: { name: 'traceCore', arguments: JSON.stringify({ core_id: 'core-123' }) },
              }],
            },
          }],
        };
      },
    };
  };
  const dbClient = (table) => ({
    where(criteria) {
      return {
        async first() {
          return table === 'fiber_cores' && criteria.id === 'core-123' ? { id: 'core-123' } : null;
        },
      };
    },
  });
  const trace = [
    { core_id: 'core-123', core_number: 4, cable_code: 'CAB-1' },
    { splice_id: 'splice-1', splice_type: 'fusion' },
    { core_id: 'core-456', core_number: 4, cable_code: 'CAB-2' },
  ];
  const handler = createQueryHandler({
    route: (query, options) => routeToolCall(query, { ...options, env, fetchImpl }),
    execute: (toolCall, options) => executeToolCall(toolCall, {
      ...options,
      dbClient,
      handlers: {
        traceCore: async ({ core_id }) => ({
          status: 'ok',
          core: { id: core_id, core_number: 4, status: 'spliced' },
          trace,
        }),
      },
    }),
    format: formatResponse,
  });
  const res = fakeResponse();

  await handler(postRequest('Trace fiber core core-123.'), res, () => {});

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tool_calls[0].tool, 'traceCore');
  assert.deepEqual(res.body.tool_calls[0].result.trace, trace);
  assert.equal(res.body.answer_text, 'The trace covers 2 core segments from CAB-1 core 4 to CAB-2 core 4 across 1 splice.');
});

test('user-facing docs query runs through the catalog executor and retains retrieved citations', async () => {
  const docs = {
    query: 'How is optical loss calculated?',
    answer: 'The budget sums cable attenuation, splice loss, and splitter insertion loss.',
    sources: [{ id: 'doc-1', source: 'fiberline-reference.md', section: 'Optical loss budget', score: 0.91, excerpt: 'Cable, splice, and splitter losses contribute to the path budget.' }],
    mode: 'generated',
  };
  const env = {
    AI_PROVIDER: 'cloud',
    CLOUD_LLM_API_KEY: 'integration-test-key',
    CLOUD_LLM_MODEL: 'stub-model',
  };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        choices: [{
          message: {
            tool_calls: [{
              type: 'function',
              function: { name: 'lookupDocs', arguments: JSON.stringify({ query: docs.query, top_k: 2 }) },
            }],
          },
        }],
      };
    },
  });
  const handler = createQueryHandler({
    route: (query, options) => routeToolCall(query, { ...options, env, fetchImpl }),
    execute: (toolCall, options) => executeToolCall(toolCall, {
      ...options,
      handlers: { lookupDocs: async () => docs },
    }),
    format: formatResponse,
  });
  const res = fakeResponse();

  await handler(postRequest(docs.query), res, () => {});

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tool_calls[0].tool, 'lookupDocs');
  assert.equal(res.body.answer_text, docs.answer);
  assert.deepEqual(res.body.tool_calls[0].result.sources, docs.sources);
});

test('unavailable deterministic handlers return an explicit 503 rather than a fabricated answer', async () => {
  const handler = createQueryHandler({
    route: async () => ({ tool: 'checkServiceability', args: { enclosure_id: 'box-1', lat: 34, lng: 71 } }),
    execute: async () => ({
      success: false,
      error: 'TOOL_HANDLER_UNAVAILABLE',
      message: 'The deterministic handler for checkServiceability is not available in this build.',
    }),
    format: async ({ error }) => `The operation failed: ${error}.`,
  });
  const res = fakeResponse();

  await handler(postRequest('Can box-1 serve this location?'), res, () => {});

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.error, 'TOOL_HANDLER_UNAVAILABLE');
  assert.match(res.body.answer_text, /handler for checkServiceability/);
  assert.equal(res.body.tool_calls[0].success, false);
});

test('empty and oversized prompts are rejected before inference', async () => {
  let routed = false;
  const handler = createQueryHandler({
    route: async () => { routed = true; return {}; },
    execute: async () => ({ success: true, result: {} }),
    format: async () => 'unused',
  });

  const empty = fakeResponse();
  await handler(postRequest('   '), empty, () => {});
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.body.error, 'INVALID_QUERY');

  const long = fakeResponse();
  await handler(postRequest('x'.repeat(MAX_QUERY_LENGTH + 1)), long, () => {});
  assert.equal(long.statusCode, 400);
  assert.equal(long.body.error, 'QUERY_TOO_LONG');
  assert.equal(routed, false);
});

test('router errors are forwarded to the application error handler with a request id', async () => {
  const failure = new Error('model endpoint is unavailable');
  failure.status = 503;
  failure.code = 'TOOL_ROUTER_UNREACHABLE';
  const handler = createQueryHandler({
    route: async () => { throw failure; },
    execute: async () => ({ success: true, result: {} }),
    format: async () => 'unused',
  });
  const res = fakeResponse();
  let nextError;

  await handler(postRequest('Trace a core.'), res, (error) => { nextError = error; });

  assert.equal(nextError, failure);
  assert.equal(failure.request_id, res.headers['x-request-id']);
});
