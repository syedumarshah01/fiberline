const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { WARMUP_QUERY, createRouterWarmup, listenAfterRouterWarmup } = require('../src/services/routerWarmup');
const { inferToolCall } = require('../src/services/toolRouter');
const { buildRouterInstruction, buildRouterResponseSchema } = require('../src/ai/toolRouterSchema');
const { checkRouterStartup } = require('../scripts/check-router-startup');

const route = { tool: 'lookupDocs', args: { query: 'how fiber tracing works' } };
function response(content = route) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('concurrent and repeated starts share one bounded inference and discard its output', async () => {
  const gate = deferred();
  let calls = 0;
  let now = 0;
  const warmup = createRouterWarmup({ env: {}, clock: () => now, infer: async (query, options) => {
    calls += 1;
    assert.equal(query, WARMUP_QUERY);
    assert.equal(options.requestId, 'startup-warmup');
    return gate.promise;
  } });
  assert.equal(warmup.status().status, 'pending');
  const first = warmup.start();
  assert.strictEqual(warmup.start(), first);
  assert.equal(warmup.status().status, 'warming');
  now = 13850;
  gate.resolve({ ...route, content: 'discard this output' });
  const result = await first;
  assert.equal(result.status, 'ready');
  assert.equal(result.warmup_ms, 13850);
  assert.equal(result.tool, undefined);
  assert.equal(result.content, undefined);
  result.status = 'tampered';
  assert.equal(warmup.status().status, 'ready');
  await warmup.start();
  assert.equal(calls, 1);
});

test('actual inference adapter uses the same prefix, model, schema and prompt-cache option for warm-up and user query', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), signal: options.signal });
    return response();
  };
  const env = { LOCAL_LLM_MODEL: 'selected-fixture', LOCAL_LLM_BASE_URL: 'http://model.test/v1' };
  const warmup = createRouterWarmup({ env, fetchImpl });
  await warmup.start();
  assert.equal(requests.length, 1);
  await inferToolCall('Explain the optical loss budget.', { env, fetchImpl });
  assert.equal(requests.length, 2);
  for (const { url, body, signal } of requests) {
    assert.equal(url, 'http://model.test/v1/chat/completions');
    assert.equal(body.model, 'selected-fixture');
    assert.equal(body.max_tokens, 128);
    assert.equal(body.temperature, 0);
    assert.equal(body.cache_prompt, true);
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(body.messages[0], { role: 'system', content: buildRouterInstruction() });
    assert.deepEqual(body.response_format.json_schema.schema, buildRouterResponseSchema());
  }
  assert.equal(requests[0].body.messages[1].content, WARMUP_QUERY);
  assert.notEqual(requests[0].body.messages[1].content, requests[1].body.messages[1].content);
  // Neither the startup service nor the inference adapter loads any executor.
  assert.equal(require.cache[require.resolve('../src/services/toolExecutor')], undefined);
});

test('failure is terminal for this startup and never opens the listener', async () => {
  let inferences = 0;
  let listeners = 0;
  const warmup = createRouterWarmup({ env: {}, infer: async () => {
    inferences += 1;
    throw new Error('model unavailable');
  } });
  await assert.rejects(listenAfterRouterWarmup({
    warmup, log() {}, listen: () => { listeners += 1; },
  }), (error) => error.code === 'TOOL_ROUTER_WARMUP_FAILED' && /model unavailable/.test(error.message));
  await assert.rejects(warmup.start(), /model unavailable/);
  assert.equal(inferences, 1);
  assert.equal(listeners, 0);
  assert.equal(warmup.status().status, 'failed');
});

test('invalid JSON and request timeout fail startup instead of marking the model ready', async () => {
  for (const fetchImpl of [
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not JSON' } }] }) }),
    async () => { const error = new Error('timed out'); error.name = 'AbortError'; throw error; },
  ]) {
    const warmup = createRouterWarmup({ env: {}, fetchImpl });
    await assert.rejects(warmup.start(), { code: 'TOOL_ROUTER_WARMUP_FAILED' });
    assert.equal(warmup.status().status, 'failed');
  }
});

test('cloud startup skips warm-up without any local or paid cloud inference', async () => {
  let listens = 0;
  const warmup = createRouterWarmup({ env: { AI_PROVIDER: 'cloud' }, infer: async () => assert.fail('no inference allowed') });
  await listenAfterRouterWarmup({ warmup, log() {}, listen: () => { listens += 1; } });
  assert.equal(listens, 1);
  assert.deepEqual(warmup.status(), { status: 'skipped', reason: 'cloud_provider', warmup_ms: 0 });
});

test('native Ollama startup uses the existing constrained transport, not tool execution', async () => {
  let request;
  const warmup = createRouterWarmup({
    env: { LLM_MODEL: 'installed-tag', LLM_BASE_URL: 'http://127.0.0.1:11434/v1' },
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(route) } }) };
    },
  });
  await warmup.start();
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(request.body.format, buildRouterResponseSchema());
  assert.equal(warmup.status().status, 'ready');
});

test('generic local APIs can omit the llama.cpp prompt-cache extension', async () => {
  let body;
  await createRouterWarmup({
    env: { TOOL_ROUTER_CACHE_PROMPT: '0' },
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response(); },
  }).start();
  assert.equal(body.cache_prompt, undefined);
});

test('startup diagnostic sends exactly warm-up plus one first-user inference, with no files or tools', async () => {
  let calls = 0;
  const result = await checkRouterStartup({ env: {}, fetchImpl: async () => { calls += 1; return response(); } });
  assert.equal(calls, 2);
  assert.equal(typeof result.warmup_ms, 'number');
  assert.equal(typeof result.first_user_inference_ms, 'number');
  assert.equal(result.tool, undefined);
  await assert.rejects(checkRouterStartup({ env: { AI_PROVIDER: 'cloud' }, fetchImpl: async () => assert.fail() }), /local-only/);
});

// Exercise the real server.js startup wiring without importing Express/DB
// dependencies or opening an actual socket. Route middleware is irrelevant here.
function runServerWithWarmup(warmup) {
  const listeners = [];
  const app = { set() {}, use() {}, get() {}, listen(...args) { listeners.push(args); } };
  const express = Object.assign(() => app, { json: () => () => {} });
  const fakeProcess = { env: {}, exitCode: 0 };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/server.js'), 'utf8'), {
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'express') return express;
      if (name === 'cors') return () => () => {};
      if (name === './services/routerWarmup') return {
        listenAfterRouterWarmup: (options) => listenAfterRouterWarmup({ ...options, warmup, log() {} }),
      };
      return {};
    },
    process: fakeProcess,
    console: { log() {}, error() {}, warn() {} },
  });
  return { listeners, fakeProcess };
}

test('real server startup does not bind its HTTP port until warm-up succeeds', async () => {
  const gate = deferred();
  const warmup = createRouterWarmup({ env: {}, infer: () => gate.promise });
  const { listeners } = runServerWithWarmup(warmup);
  assert.equal(listeners.length, 0);
  gate.resolve(route);
  await new Promise(setImmediate);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 4000);
  assert.equal(listeners[0][1], '0.0.0.0');
});

test('real server startup signals failure and never accepts requests when warm-up fails', async () => {
  const warmup = createRouterWarmup({ env: {}, infer: async () => { throw new Error('unavailable'); } });
  const { listeners, fakeProcess } = runServerWithWarmup(warmup);
  await new Promise(setImmediate);
  assert.equal(listeners.length, 0);
  assert.equal(fakeProcess.exitCode, 1);
});
