#!/usr/bin/env node

// Product-startup diagnostic, NOT the model comparison benchmark. Start a fresh
// llama-server (one slot, selected GGUF) first. Uses the same warm-up as server.js
// followed by one inference-only user query. No tools or result files are used.
const path = require('node:path');
const { createRouterWarmup } = require('../src/services/routerWarmup');
const { inferToolCall } = require('../src/services/toolRouter');

const FIRST_QUERY = 'For general design reference, what insertion loss does the specification assume for a 1:32 splitter?';

async function checkRouterStartup({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (String(env.AI_PROVIDER || 'local').trim().toLowerCase() !== 'local') {
    throw new Error('This diagnostic is local-only; no paid cloud request will be made.');
  }
  const warmup = createRouterWarmup({ env, fetchImpl });
  const ready = await warmup.start();
  const first = await inferToolCall(FIRST_QUERY, { env, fetchImpl, requestId: 'first-user-inference-check' });
  return {
    model: first.model,
    warmup_ms: ready.warmup_ms,
    first_user_inference_ms: first.latency_ms,
    reference_warm_range_ms: [2700, 4000],
    within_reference_range: first.latency_ms >= 2700 && first.latency_ms <= 4000,
    note: 'Router inference only, not total HTTP/tool execution time. Run after restarting the model server; no tool was executed and no file was written.',
  };
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  checkRouterStartup().then((report) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { FIRST_QUERY, checkRouterStartup };
