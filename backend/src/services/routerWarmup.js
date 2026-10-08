const { performance } = require('node:perf_hooks');
const { inferToolCall, config } = require('./toolRouter');

// Warm the actual shared system prefix and constrained decoder, not an unrelated
// "say ready" prompt. The selected operation is NEVER dispatched to a handler.
const WARMUP_QUERY = 'How does the fiber tracing feature work in general?';

function createRouterWarmup({
  env = process.env,
  infer = inferToolCall,
  fetchImpl = globalThis.fetch,
  clock = () => performance.now(),
} = {}) {
  const settings = { ...env };
  let pending;
  let state = { status: 'pending', warmup_ms: null };

  async function run() {
    const provider = String(settings.AI_PROVIDER || 'local').trim().toLowerCase();
    if (provider === 'cloud') {
      // Do not make a paid/cloud request on application launch.
      state = { status: 'skipped', reason: 'cloud_provider', warmup_ms: 0 };
      return { ...state };
    }
    const started = clock();
    state = { status: 'warming', warmup_ms: null };
    try {
      if (provider !== 'local') throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
      // inferToolCall performs bounded inference + validation only. Do not
      // import toolExecutor, call /api/network/query, or retain its output.
      await infer(WARMUP_QUERY, { env: settings, fetchImpl, requestId: 'startup-warmup' });
      state = {
        status: 'ready',
        model: config(settings).model,
        warmup_ms: Math.round(clock() - started),
      };
      return { ...state };
    } catch (cause) {
      state = { status: 'failed', warmup_ms: Math.round(clock() - started) };
      const error = new Error(`Tool-router startup warm-up failed: ${cause.message}. Start/verify the local model service, then restart the application.`, { cause });
      error.code = 'TOOL_ROUTER_WARMUP_FAILED';
      throw error;
    }
  }

  return {
    start() {
      // Concurrent/repeated callers share exactly one inference, including a
      // failed attempt. Do not silently retry or warm up on a real user query.
      if (!pending) pending = run();
      return pending;
    },
    status() { return { ...state }; },
  };
}

async function listenAfterRouterWarmup({
  listen,
  warmup = createRouterWarmup(),
  log = console.info,
} = {}) {
  if (typeof listen !== 'function') throw new TypeError('listen must be a function');
  log('[router-startup] warming local router before accepting requests');
  const result = await warmup.start();
  log(`[router-startup] status=${result.status} warmup_ms=${result.warmup_ms}`);
  return listen();
}

module.exports = { WARMUP_QUERY, createRouterWarmup, listenAfterRouterWarmup };
