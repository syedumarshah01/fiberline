#!/usr/bin/env node

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const BACKEND_ROOT = path.resolve(__dirname, '..');
try {
  require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const { inferToolCall } = require('../src/services/toolRouter');

const QUERIES_PATH = path.resolve(__dirname, '../../ai/benchmark-queries.json');
const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf8'));
const DEFAULT_MODEL_DIRECTORY = path.join(BACKEND_ROOT, 'models', 'gguf');
const DEFAULT_ASSET_ROOT = path.resolve(process.env.FIBERLINE_ASSET_DIR || path.join(BACKEND_ROOT, '.runtime-assets'));
const DEFAULT_LLAMA_SERVER = path.join(DEFAULT_ASSET_ROOT, 'llama.cpp-src', 'build', 'bin', 'llama-server');
const MIB = 1024 * 1024;

// These are benchmark candidates only; this list does not select a runtime default.
const MODEL_SPECS = Object.freeze([
  {
    id: 'qwen2.5-0.5b-instruct-q4-k-m',
    label: 'Qwen2.5-0.5B-Instruct Q4_K_M',
    filename: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    family: 'qwen-0.5b',
  },
  {
    id: 'qwen2.5-1.5b-instruct-q4-k-m',
    label: 'Qwen2.5-1.5B-Instruct Q4_K_M',
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    family: 'qwen-1.5b',
  },
  {
    id: 'llama-3.2-1b-instruct-q4-k-m',
    label: 'Llama-3.2-1B-Instruct Q4_K_M',
    filename: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
    family: 'llama-1b',
  },
]);

function normalizeModelName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isQ4KmFilename(filename) {
  return normalizeModelName(filename).includes('q4km');
}

function identifyCandidate(filename) {
  const normalized = normalizeModelName(filename);
  if (normalized.includes('qwen25') && normalized.includes('05b')) {
    return MODEL_SPECS[0];
  }
  if (normalized.includes('qwen25') && normalized.includes('15b')) {
    return MODEL_SPECS[1];
  }
  if (normalized.includes('llama32') && normalized.includes('1b')) {
    return MODEL_SPECS[2];
  }
  return null;
}

function resolveModelDirectory(value = process.env.TOOL_ROUTER_MODEL_DIR) {
  return path.resolve(BACKEND_ROOT, value || 'models/gguf');
}

function listGgufFiles(modelDirectory) {
  try {
    return fs.readdirSync(modelDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function resolveExplicitModelPath(entry, modelDirectory) {
  if (path.isAbsolute(entry)) return path.resolve(entry);
  const fromBackend = path.resolve(BACKEND_ROOT, entry);
  if (fs.existsSync(fromBackend)) return fromBackend;
  const fromModelDirectory = path.resolve(modelDirectory, entry);
  if (fs.existsSync(fromModelDirectory)) return fromModelDirectory;
  return fromModelDirectory;
}

function makeCandidate(spec, modelPath, { exists = fs.existsSync(modelPath), ambiguous = [] } = {}) {
  const filename = path.basename(modelPath);
  const inferredSpec = identifyCandidate(filename) || spec;
  const candidateSpec = inferredSpec || {
    id: normalizeModelName(path.basename(filename, path.extname(filename))) || 'local-gguf',
    label: path.basename(filename, path.extname(filename)),
    filename,
    repo: 'Not recorded for this local file',
    family: 'custom',
  };
  const stats = exists ? fs.statSync(modelPath) : null;
  return {
    ...candidateSpec,
    filename,
    path: path.resolve(modelPath),
    exists: Boolean(exists && stats?.isFile()),
    sizeBytes: stats?.isFile() ? stats.size : null,
    ambiguous,
    apiModel: `fiberline-${candidateSpec.id}`,
    quantizationHint: isQ4KmFilename(filename) ? 'Q4_K_M (filename)' : 'not identifiable from filename',
  };
}

function resolveDefaultCandidates(modelDirectory) {
  const files = listGgufFiles(modelDirectory);
  return MODEL_SPECS.map((spec) => {
    const familyFiles = files.filter((filename) => identifyCandidate(filename)?.id === spec.id);
    const q4Files = familyFiles.filter(isQ4KmFilename);
    const choices = q4Files.length ? q4Files : familyFiles;
    const exact = choices.find((filename) => filename.toLowerCase() === spec.filename.toLowerCase());
    const selected = exact || (choices.length === 1 ? choices[0] : null);
    const ambiguous = !selected && choices.length > 1 ? choices : [];
    const filename = selected || spec.filename;
    return makeCandidate(spec, path.join(modelDirectory, filename), {
      exists: Boolean(selected),
      ambiguous,
    });
  });
}

function resolveExplicitCandidates(modelDirectory, modelList) {
  const entries = String(modelList).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error('TOOL_ROUTER_MODELS was set but did not contain any model filenames.');
  return entries.map((entry) => {
    const modelPath = resolveExplicitModelPath(entry, modelDirectory);
    const spec = identifyCandidate(path.basename(modelPath));
    return makeCandidate(spec, modelPath);
  });
}

function resolveModelCandidates({
  modelDirectory = resolveModelDirectory(),
  modelList = process.env.TOOL_ROUTER_MODELS,
} = {}) {
  const absoluteDirectory = path.resolve(modelDirectory);
  return modelList?.trim()
    ? resolveExplicitCandidates(absoluteDirectory, modelList)
    : resolveDefaultCandidates(absoluteDirectory);
}

function validateModelCandidates(candidates) {
  const errors = [];
  const warnings = [];
  const seenPaths = new Set();
  const validated = candidates.map((candidate) => {
    if (candidate.ambiguous?.length) {
      errors.push(`${candidate.label}: multiple matching Q4_K_M files found (${candidate.ambiguous.join(', ')}); set TOOL_ROUTER_MODELS to the exact filenames.`);
      return candidate;
    }
    if (!candidate.filename.toLowerCase().endsWith('.gguf')) {
      errors.push(`${candidate.filename}: model candidates must be local .gguf files, not Ollama tags.`);
      return candidate;
    }
    if (!candidate.exists || !fs.existsSync(candidate.path)) {
      errors.push(`${candidate.filename}: file not found at ${candidate.path}`);
      return candidate;
    }
    const stats = fs.statSync(candidate.path);
    if (!stats.isFile()) {
      errors.push(`${candidate.path}: expected a regular GGUF file.`);
      return candidate;
    }
    if (!isQ4KmFilename(candidate.filename)) {
      errors.push(`${candidate.filename}: filename does not identify Q4_K_M quantization; refusing a potentially unfair comparison.`);
      return candidate;
    }
    if (seenPaths.has(candidate.path)) {
      errors.push(`${candidate.path}: the same GGUF was listed more than once.`);
      return candidate;
    }
    seenPaths.add(candidate.path);
    if (stats.size < 100 * MIB) {
      warnings.push(`${candidate.filename} is only ${(stats.size / MIB).toFixed(1)} MiB; verify it is not a truncated or incorrect model.`);
    }
    return { ...candidate, sizeBytes: stats.size, exists: true };
  });
  if (!validated.length) errors.push('No GGUF model candidates were found.');
  if (errors.length) {
    const error = new Error(`GGUF benchmark inputs are not ready:\n${errors.map((item) => `- ${item}`).join('\n')}`);
    error.code = 'GGUF_BENCHMARK_INPUTS_INVALID';
    error.details = errors;
    throw error;
  }
  return { candidates: validated, warnings };
}

function cleanString(value) {
  return String(value).trim().toLowerCase().replace(/[?.]+$/, '').replace(/\s+/g, ' ');
}

function sameValue(actual, expected) {
  if (typeof expected === 'number') return typeof actual === 'number' && Math.abs(actual - expected) < 1e-9;
  if (typeof expected === 'string') return cleanString(actual) === cleanString(expected);
  return actual === expected;
}

function isCorrect(route, expected) {
  if (route?.tool !== expected.tool) return false;
  const actualKeys = Object.keys(route.args || {}).sort();
  const expectedKeys = Object.keys(expected.args || {}).sort();
  if (actualKeys.join('|') !== expectedKeys.join('|')) return false;
  return expectedKeys.every((key) => sameValue(route.args[key], expected.args[key]));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

function parseInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function createSettings(env = process.env) {
  const assetRoot = path.resolve(env.FIBERLINE_ASSET_DIR || path.join(BACKEND_ROOT, '.runtime-assets'));
  const serverBin = path.resolve(env.LLAMA_SERVER_BIN || path.join(assetRoot, 'llama.cpp-src', 'build', 'bin', 'llama-server'));
  return {
    serverBin,
    startupTimeoutMs: parseInteger(env.TOOL_ROUTER_STARTUP_TIMEOUT_MS || env.LLAMA_STARTUP_TIMEOUT_MS, 180000, 1000),
    timeoutMs: parseInteger(env.TOOL_ROUTER_TIMEOUT_MS || env.LLM_TIMEOUT_MS, 120000, 1000),
    threads: parseInteger(env.TOOL_ROUTER_THREADS || env.LLAMA_THREADS, 2),
    contextTokens: parseInteger(env.TOOL_ROUTER_CTX_SIZE || env.LLAMA_CTX_SIZE, 4096, 512),
    runs: parseInteger(env.TOOL_ROUTER_RUNS, 1),
  };
}

function captureProcessOutput(child) {
  let text = '';
  const append = (chunk) => {
    text = `${text}${chunk.toString()}`.slice(-200_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return () => text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function stopChild(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      child.removeListener('error', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, timeoutMs);
    child.once('exit', finish);
    child.once('error', finish);
    child.kill('SIGTERM');
  });
}

async function waitForHealth(child, childError, healthUrl, timeoutMs, getLogs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (childError.error) throw new Error(`Unable to start llama-server: ${childError.error.message}`);
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited before becoming healthy (exit ${child.exitCode}).\n${getLogs()}`);
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return;
      lastError = `health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(250);
  }
  throw new Error(`llama-server did not become healthy within ${timeoutMs} ms (${lastError}).\n${getLogs()}`);
}

async function withModelServer(candidate, settings, callback) {
  const port = await findFreePort();
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const args = [
    '--model', candidate.path,
    '--alias', candidate.apiModel,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--threads', String(settings.threads),
    '--threads-batch', String(settings.threads),
    '--ctx-size', String(settings.contextTokens),
    '--n-gpu-layers', '0',
  ];
  const child = spawn(settings.serverBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const getLogs = captureProcessOutput(child);
  const childError = { error: null };
  child.on('error', (error) => { childError.error = error; });
  const started = performance.now();
  try {
    await waitForHealth(child, childError, healthUrl, settings.startupTimeoutMs, getLogs);
    const serverLoadMs = Math.round(performance.now() - started);
    const result = await callback({ baseUrl, port, serverLoadMs, getLogs });
    return { ...result, serverLoadMs, serverLog: getLogs() };
  } finally {
    await stopChild(child);
  }
}

async function postChatCompletion(baseUrl, body, timeoutMs) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
  }
  return payload;
}

function responseContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('').trim();
  return '';
}

async function smokeTest(candidate, baseUrl, timeoutMs) {
  const started = performance.now();
  const payload = await postChatCompletion(baseUrl, {
    model: candidate.apiModel,
    messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
    max_tokens: 12,
    temperature: 0,
    stream: false,
  }, timeoutMs);
  const content = responseContent(payload);
  if (!content) throw new Error('Smoke inference returned an empty response.');
  return {
    latencyMs: Math.round(performance.now() - started),
    response: content.slice(0, 160),
  };
}

async function runModel(candidate, baseUrl, { timeoutMs, runs }) {
  const env = {
    ...process.env,
    AI_PROVIDER: 'local',
    TOOL_ROUTER_TRANSPORT: 'openai',
    TOOL_ROUTER_MODEL: candidate.apiModel,
    LOCAL_LLM_MODEL: candidate.apiModel,
    LOCAL_LLM_BASE_URL: baseUrl,
    LLM_TIMEOUT_MS: String(timeoutMs),
    AI_REQUEST_TIMEOUT_MS: String(timeoutMs),
  };
  const rows = [];
  for (const query of queries) {
    for (let run = 0; run < runs; run += 1) {
      const started = performance.now();
      try {
        const route = await inferToolCall(query.query, {
          env,
          requestId: `benchmark-${candidate.id}-${query.id}-${run}`,
        });
        rows.push({
          id: query.id,
          valid: true,
          correct: isCorrect(route, query.expected),
          latency_ms: route.latency_ms ?? Math.round(performance.now() - started),
          tool: route.tool,
        });
      } catch (error) {
        rows.push({
          id: query.id,
          valid: false,
          correct: false,
          latency_ms: Math.round(performance.now() - started),
          error: `${error.code || 'ERROR'}: ${error.message}`,
        });
      }
    }
  }
  const latencies = rows.filter((row) => row.valid).map((row) => row.latency_ms);
  return {
    total: rows.length,
    valid: rows.filter((row) => row.valid).length,
    correct: rows.filter((row) => row.correct).length,
    accuracy: rows.length ? rows.filter((row) => row.correct).length / rows.length : 0,
    validRate: rows.length ? rows.filter((row) => row.valid).length / rows.length : 0,
    latencyMs: {
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      min: latencies.length ? Math.min(...latencies) : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
    errors: [...new Set(rows.filter((row) => row.error).map((row) => row.error))].slice(0, 5),
    failures: rows.filter((row) => !row.correct)
      .map((row) => ({ id: row.id, error: row.error || `selected ${row.tool}` }))
      .slice(0, 12),
  };
}

function observedQuantization(log, filename) {
  const match = String(log || '').match(/file type\s*=\s*([^\r\n]+)/i);
  return match?.[1]?.trim() || (isQ4KmFilename(filename) ? 'Q4_K_M (filename; GGUF log did not report type)' : 'unknown');
}

function formatMiB(bytes) {
  return Number((bytes / MIB).toFixed(1));
}

function markdownReport({ candidates, preflights, results, settings, warnings = [], modelDirectory }) {
  const cpu = os.cpus()[0]?.model || 'unknown CPU';
  const lines = [
    '# Local GGUF tool-router benchmark',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Host CPU: ${cpu}`,
    `- Logical CPUs: ${os.cpus().length}`,
    `- Candidate directory: ${modelDirectory}`,
    `- llama-server: ${settings.serverBin}`,
    `- Decoder: llama.cpp OpenAI-compatible JSON Schema, temperature 0`,
    `- Threads / context: ${settings.threads} / ${settings.contextTokens} tokens`,
    `- Cases: ${queries.length} varied queries (${settings.runs} run${settings.runs === 1 ? '' : 's'} per query)`,
    '',
    '| Candidate | Expected HF repo | Local file | Size (MiB) | Quantization reported | Smoke preflight | Valid JSON | Correct route + args | Median ms | P95 ms |',
    '| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: |',
  ];
  const preflightById = new Map(preflights.map((item) => [item.candidate.id, item]));
  const resultById = new Map((results || []).map((item) => [item.candidate.id, item]));
  for (const candidate of candidates) {
    const preflight = preflightById.get(candidate.id);
    const result = resultById.get(candidate.id);
    const quantization = result?.quantization || preflight?.quantization || candidate.quantizationHint;
    const smoke = preflight?.available
      ? `pass (${preflight.serverLoadMs} ms load, ${preflight.smokeLatencyMs} ms inference)`
      : (preflight?.error || 'not run');
    const valid = result
      ? `${Math.round(result.validRate * 100)}% (${result.valid}/${result.total})`
      : '—';
    const correct = result
      ? `${Math.round(result.accuracy * 100)}% (${result.correct}/${result.total})`
      : '—';
    lines.push(`| ${candidate.label} | ${candidate.repo} | \`${candidate.filename}\` | ${formatMiB(candidate.sizeBytes || 0)} | ${quantization} | ${smoke} | ${valid} | ${correct} | ${result?.latencyMs.median ?? '—'} | ${result?.latencyMs.p95 ?? '—'} |`);
  }
  lines.push('', '## File manifest', '');
  let totalBytes = 0;
  for (const candidate of candidates) {
    totalBytes += candidate.sizeBytes || 0;
    lines.push(`- ${candidate.repo}: \`${candidate.filename}\` — ${candidate.sizeBytes || 0} bytes (${formatMiB(candidate.sizeBytes || 0)} MiB)`);
  }
  lines.push(`- **Total local GGUF footprint:** ${totalBytes} bytes (${formatMiB(totalBytes)} MiB)`);
  lines.push('', '## Notes', '');
  if (warnings.length) for (const warning of warnings) lines.push(`- Warning: ${warning}`);
  if (preflights.some((item) => !item.available)) {
    lines.push('- At least one model failed the load/inference preflight, so the 24-case comparison was not started.');
  } else if (results?.length) {
    lines.push('- All candidates passed a separate load-and-inference smoke test before the tool-routing cases ran.');
    lines.push('- Correctness requires valid catalog JSON plus the exact expected tool and argument keys/values for each case.');
    lines.push('- The candidate list is for comparison only. No runtime default or preferred model is selected.');
  } else {
    lines.push('- All GGUF paths and quantization-like filenames are listed; smoke tests and the full comparison have not run yet.');
  }
  for (const item of preflights.filter((entry) => !entry.available)) {
    lines.push(`- Smoke failure for ${item.candidate.label}: ${item.error}`);
  }
  for (const result of (results || []).filter((entry) => entry.errors?.length || entry.benchmarkError)) {
    const issues = result.errors?.length ? result.errors : [result.benchmarkError].filter(Boolean);
    lines.push(`- Benchmark issue for ${result.candidate.label}: ${issues.join('; ')}`);
  }
  lines.push('- The repo column records the expected source repo for each candidate; local files are not cryptographically verified against Hugging Face. Quantization is taken from llama.cpp load logs when available, otherwise identified from the filename.');
  return `${lines.join('\n')}\n`;
}

function writeReport(report) {
  const output = process.env.TOOL_ROUTER_BENCHMARK_OUTPUT;
  if (output) {
    const destination = path.resolve(output);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, report);
  }
  process.stdout.write(report);
}

async function smokeCandidates(candidates, settings) {
  const preflights = [];
  for (const candidate of candidates) {
    process.stdout.write(`Smoke-testing ${candidate.label} from ${candidate.filename}...\n`);
    try {
      const result = await withModelServer(candidate, settings, async ({ baseUrl, serverLoadMs, getLogs }) => {
        const smoke = await smokeTest(candidate, baseUrl, settings.timeoutMs);
        return {
          available: true,
          serverLoadMs,
          smokeLatencyMs: smoke.latencyMs,
          smokeResponse: smoke.response,
          quantization: observedQuantization(getLogs(), candidate.filename),
        };
      });
      preflights.push({ candidate, ...result });
    } catch (error) {
      preflights.push({
        candidate,
        available: false,
        error: error.message.split('\n')[0],
        quantization: candidate.quantizationHint,
        detail: error.message,
      });
    }
  }
  return preflights;
}

async function benchmarkCandidates(candidates, settings, preflights) {
  const results = [];
  for (const candidate of candidates) {
    process.stdout.write(`Benchmarking ${candidate.label} (${queries.length * settings.runs} tool-router requests)...\n`);
    try {
      const result = await withModelServer(candidate, settings, async ({ baseUrl, getLogs }) => ({
        ...await runModel(candidate, baseUrl, settings),
        quantization: observedQuantization(getLogs(), candidate.filename),
      }));
      results.push({ candidate, ...result });
    } catch (error) {
      results.push({
        candidate,
        total: queries.length * settings.runs,
        valid: 0,
        correct: 0,
        validRate: 0,
        accuracy: 0,
        latencyMs: { median: null, p95: null, min: null, max: null },
        quantization: preflights.find((item) => item.candidate.id === candidate.id)?.quantization || candidate.quantizationHint,
        errors: [error.message.split('\n')[0]],
        failures: [],
        benchmarkError: error.message,
      });
    }
  }
  return results;
}

async function main() {
  const modelDirectory = resolveModelDirectory();
  const candidates = resolveModelCandidates({ modelDirectory });
  const { candidates: readyCandidates, warnings } = validateModelCandidates(candidates);
  const settings = createSettings();
  if (!fs.existsSync(settings.serverBin)) {
    throw new Error(`llama-server not found at ${settings.serverBin}. Build it with npm run llama:build or set LLAMA_SERVER_BIN.`);
  }
  if (!queries.length) throw new Error(`No benchmark queries found in ${QUERIES_PATH}.`);

  const totalBytes = readyCandidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
  process.stdout.write(`Found ${readyCandidates.length} local Q4_K_M GGUF candidates (${formatMiB(totalBytes)} MiB total) in ${modelDirectory}.\n`);
  const preflights = await smokeCandidates(readyCandidates, settings);
  if (preflights.some((item) => !item.available)) {
    writeReport(markdownReport({
      candidates: readyCandidates,
      preflights,
      results: null,
      settings,
      warnings,
      modelDirectory,
    }));
    process.exitCode = 1;
    return;
  }

  const results = await benchmarkCandidates(readyCandidates, settings, preflights);
  writeReport(markdownReport({
    candidates: readyCandidates,
    preflights,
    results,
    settings,
    warnings,
    modelDirectory,
  }));
  if (results.some((result) => result.benchmarkError)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_MODEL_DIRECTORY,
  MODEL_SPECS,
  identifyCandidate,
  isQ4KmFilename,
  resolveModelDirectory,
  resolveModelCandidates,
  validateModelCandidates,
  isCorrect,
  percentile,
  createSettings,
};
