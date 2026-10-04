#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const BACKEND_ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });
const ASSET_ROOT = process.env.FIBERLINE_ASSET_DIR || path.join(BACKEND_ROOT, '.runtime-assets');
const serverBin = path.resolve(process.env.LLAMA_SERVER_BIN || path.join(ASSET_ROOT, 'llama.cpp-src', 'build', 'bin', 'llama-server'));
const modelPath = path.resolve(process.env.LLAMA_MODEL_PATH || path.join(ASSET_ROOT, 'models', 'fiberline.gguf'));
const port = Number.parseInt(process.env.LLAMA_PORT || '8090', 10);
const startupTimeoutMs = Number(process.env.LLAMA_STARTUP_TIMEOUT_MS) || 180000;
const healthUrl = `http://127.0.0.1:${port}/health`;
const apiUrl = `http://127.0.0.1:${port}/v1/chat/completions`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(child, logs) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`llama-server exited early.\n${logs.join('')}`);
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return;
    } catch {
      // Expected until llama.cpp has loaded the GGUF model and bound its port.
    }
    await delay(250);
  }
  throw new Error(`llama-server did not become healthy within ${startupTimeoutMs} ms.\n${logs.join('')}`);
}

async function main() {
  if (!fs.existsSync(serverBin)) throw new Error(`llama-server not found: ${serverBin}; run npm run llama:build first.`);
  if (!fs.existsSync(modelPath)) throw new Error(`GGUF model not found: ${modelPath}; set LLAMA_MODEL_PATH.`);

  const modelBytes = fs.statSync(modelPath).size;
  const cpu = os.cpus()[0]?.model || 'unknown CPU';
  const threads = String(process.env.LLAMA_THREADS || '2');
  const ctxSize = String(process.env.LLAMA_CTX_SIZE || '4096');
  const logs = [];
  const args = [
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--threads', threads,
    '--ctx-size', ctxSize,
    '--n-gpu-layers', '0',
  ];
  const startTime = performance.now();
  const child = spawn(serverBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  child.on('error', (error) => logs.push(`${error.message}\n`));

  try {
    await waitForHealth(child, logs);
    const modelLoadMs = Math.round(performance.now() - startTime);
    const inferenceStart = performance.now();
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.LOCAL_LLM_MODEL || 'local-model',
        messages: [{ role: 'user', content: 'Reply with the single word ready.' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(Number(process.env.LLAMA_INFERENCE_TIMEOUT_MS) || 120000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`First inference failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);

    const report = {
      target: process.env.BENCHMARK_TARGET || 'unlabelled host',
      platform: `${process.platform}/${process.arch}`,
      cpu,
      cpuCores: os.cpus().length,
      modelPath,
      modelBytes,
      modelMiB: Number((modelBytes / 1024 / 1024).toFixed(1)),
      llamaServerLoadMs: modelLoadMs,
      firstCompletionMs: Math.round(performance.now() - inferenceStart),
      configuredThreads: Number(threads),
      configuredContextTokens: Number(ctxSize),
      response: payload.choices?.[0]?.message?.content || '',
      measuredAt: new Date().toISOString(),
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const outputPath = process.env.BENCHMARK_OUTPUT_PATH;
    if (outputPath) {
      const destination = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, json);
    }
    process.stdout.write(json);

    const budget = Number(process.env.LLAMA_STARTUP_BUDGET_MS);
    if (process.argv.includes('--assert-startup-budget') && budget && modelLoadMs > budget) {
      process.exitCode = 2;
    }
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(5000).then(() => child.kill('SIGKILL')),
    ]);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
