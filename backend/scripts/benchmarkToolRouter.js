const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config, inferToolCall } = require('../src/services/toolRouter');

const QUERIES_PATH = path.resolve(__dirname, '../../ai/benchmark-queries.json');
const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf8'));
const models = String(process.env.TOOL_ROUTER_MODELS || 'llama3.2:1b,qwen2.5:1.5b,qwen2.5:0.5b')
  .split(',').map((model) => model.trim()).filter(Boolean);
const runs = Math.max(1, Number.parseInt(process.env.TOOL_ROUTER_RUNS || '1', 10));
const timeoutMs = Math.max(1000, Number.parseInt(process.env.TOOL_ROUTER_TIMEOUT_MS || '3000', 10));
const baseUrl = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1';

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
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

async function inspectModel(model) {
  const endpoint = `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/api/show`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) return { available: false, error: payload?.error || `HTTP ${response.status}` };
    return {
      available: true,
      format: payload?.details?.format || payload?.details?.families?.join(', ') || null,
      parameter_size: payload?.details?.parameter_size || null,
      quantization: payload?.details?.quantization_level || null,
    };
  } catch (error) {
    return { available: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function runModel(model) {
  const env = {
    ...process.env,
    LLM_MODEL: model,
    LLM_TIMEOUT_MS: String(timeoutMs),
  };
  const modelInfo = await inspectModel(model);
  const rows = [];
  for (const query of queries) {
    for (let run = 0; run < runs; run += 1) {
      const started = Date.now();
      try {
        const route = await inferToolCall(query.query, { env, requestId: `benchmark-${model}-${query.id}-${run}` });
        rows.push({
          id: query.id,
          valid: true,
          correct: isCorrect(route, query.expected),
          latency_ms: route.latency_ms ?? Date.now() - started,
          tool: route.tool,
        });
      } catch (error) {
        rows.push({
          id: query.id,
          valid: false,
          correct: false,
          latency_ms: Date.now() - started,
          error: `${error.code || 'ERROR'}: ${error.message}`,
        });
      }
    }
  }
  const latencies = rows.filter((row) => row.valid).map((row) => row.latency_ms);
  return {
    model,
    model_info: modelInfo,
    total: rows.length,
    valid: rows.filter((row) => row.valid).length,
    correct: rows.filter((row) => row.correct).length,
    accuracy: rows.length ? rows.filter((row) => row.correct).length / rows.length : 0,
    valid_rate: rows.length ? rows.filter((row) => row.valid).length / rows.length : 0,
    latency_ms: {
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      min: latencies.length ? Math.min(...latencies) : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
    errors: [...new Set(rows.filter((row) => row.error).map((row) => row.error))].slice(0, 5),
    failures: rows.filter((row) => !row.correct).map((row) => ({ id: row.id, error: row.error || `selected ${row.tool}` })).slice(0, 12),
  };
}

function markdownReport(results) {
  const cpu = os.cpus()[0]?.model || 'unknown CPU';
  const lines = [
    '# Tool-router benchmark',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Host CPU: ${cpu}`,
    `- Logical CPUs: ${os.cpus().length}`,
    `- Queries: ${queries.length} varied cases (${runs} run${runs === 1 ? '' : 's'} each)`,
    `- Endpoint: ${baseUrl}`,
    '- Decoder: Ollama `format` JSON Schema generated from `ai/tools.json`, temperature 0',
    '',
    '| Model | Installed/available | Valid JSON rate | Correct route + args | Median ms | P95 ms | Quantization |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const result of results) {
    const info = result.model_info;
    lines.push(`| ${result.model} | ${info.available ? 'yes' : 'no'} | ${Math.round(result.valid_rate * 100)}% (${result.valid}/${result.total}) | ${Math.round(result.accuracy * 100)}% (${result.correct}/${result.total}) | ${result.latency_ms.median ?? '—'} | ${result.latency_ms.p95 ?? '—'} | ${info.quantization || '—'} |`);
  }
  lines.push('', '## Notes', '');
  const unavailable = results.filter((result) => !result.model_info.available);
  if (unavailable.length) {
    lines.push('The benchmark could not run because the local Ollama service or candidate models were unavailable. No cloud endpoint was used and no model choice is being claimed. Start Ollama, pull the candidates, then rerun:');
    lines.push('', '```bash', 'cd backend', 'TOOL_ROUTER_RUNS=1 npm run benchmark:router', '```', '');
    for (const result of unavailable) lines.push(`- ${result.model}: ${result.model_info.error || 'unavailable'}`);
  } else {
    lines.push('All candidate models were available. Correctness requires the exact tool and the exact extracted parameter keys/values for each case.');
  }
  return `${lines.join('\n')}\n`;
}

(async () => {
  const results = [];
  for (const model of models) results.push(await runModel(model));
  const report = markdownReport(results);
  const output = process.env.TOOL_ROUTER_BENCHMARK_OUTPUT;
  if (output) fs.writeFileSync(path.resolve(output), report);
  process.stdout.write(report);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
