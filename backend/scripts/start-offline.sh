#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA_BIN="${LLAMA_SERVER_BIN:-$BUNDLE_ROOT/bin/llama-server}"
MODEL_PATH="${LLAMA_MODEL_PATH:-$BUNDLE_ROOT/models/llm/model.gguf}"
PORT="${LLAMA_PORT:-8080}"
STARTUP_TIMEOUT="${LLAMA_STARTUP_TIMEOUT_MS:-180000}"
LOG_DIR="${FIBERLINE_LOG_DIR:-$BUNDLE_ROOT/logs}"

[[ -x "$LLAMA_BIN" ]] || { echo "llama-server binary not found: $LLAMA_BIN" >&2; exit 1; }
[[ -f "$MODEL_PATH" ]] || { echo "GGUF model not found: $MODEL_PATH" >&2; exit 1; }

export AI_PROVIDER=local
export LOCAL_LLM_BASE_URL="${LOCAL_LLM_BASE_URL:-http://127.0.0.1:$PORT/v1}"
export LOCAL_LLM_MODEL="${LOCAL_LLM_MODEL:-local-model}"
export DOC_INDEX_PATH="${DOC_INDEX_PATH:-$BUNDLE_ROOT/app/data/docs.sqlite}"
export DOC_EMBEDDING_MODEL_ID="${DOC_EMBEDDING_MODEL_ID:-Xenova/all-MiniLM-L6-v2}"
export DOC_EMBEDDING_OFFLINE=1
export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$BUNDLE_ROOT/models/transformers-cache}"

mkdir -p "$LOG_DIR"
"$LLAMA_BIN" \
  --model "$MODEL_PATH" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --threads "${LLAMA_THREADS:-2}" \
  --ctx-size "${LLAMA_CTX_SIZE:-4096}" \
  --n-gpu-layers 0 \
  >"$LOG_DIR/llama-server.log" 2>&1 &
LLAMA_PID=$!
cleanup() {
  kill "$LLAMA_PID" 2>/dev/null || true
  wait "$LLAMA_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

node - "$PORT" "$STARTUP_TIMEOUT" <<'NODE'
const port = process.argv[2];
const timeoutMs = Number(process.argv[3]) || 180000;
const deadline = Date.now() + timeoutMs;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
      if (response.ok) process.exit(0);
    } catch {}
    await pause(250);
  }
  console.error(`llama-server did not load the model within ${timeoutMs} ms`);
  process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
NODE

cd "$BUNDLE_ROOT/app"
node src/server.js
