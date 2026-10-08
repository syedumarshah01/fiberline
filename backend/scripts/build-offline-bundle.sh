#!/usr/bin/env bash
set -euo pipefail

BACKEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$BACKEND_ROOT/.." && pwd)"
if [[ -f "$BACKEND_ROOT/.env" ]]; then
  set -a
  # .env is a standard KEY=value file; export its release/build options to tools.
  # shellcheck disable=SC1090
  source "$BACKEND_ROOT/.env"
  set +a
fi
ASSET_ROOT="${FIBERLINE_ASSET_DIR:-$BACKEND_ROOT/.runtime-assets}"
TRANSFORMERS_CACHE_DIR="${TRANSFORMERS_CACHE:-$ASSET_ROOT/transformers-cache}"
DOC_INDEX_PATH="$BACKEND_ROOT/data/docs.sqlite"
EMBEDDING_MODEL_ID="${DOC_EMBEDDING_MODEL_ID:-Xenova/all-MiniLM-L6-v2}"
# The source checkout defaults to the user-selected Qwen GGUF; explicit paths win.
GGUF_SOURCE="$(node -e 'console.log(require(process.argv[1]).localModelPath())' "$BACKEND_ROOT/src/ai/localModelConfig.js")"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$ASSET_ROOT/llama.cpp-src/build/bin/llama-server}"
BUNDLE_DIR="${FIBERLINE_BUNDLE_DIR:-$BACKEND_ROOT/dist/fiberline-offline}"
ARCHIVE_PATH="${FIBERLINE_BUNDLE_ARCHIVE:-$BACKEND_ROOT/dist/fiberline-offline.tar.gz}"

if [[ -z "$GGUF_SOURCE" || ! -f "$GGUF_SOURCE" ]]; then
  if [[ -n "${GGUF_MODEL_URL:-}" ]]; then
    mkdir -p "$ASSET_ROOT/models"
    GGUF_SOURCE="$ASSET_ROOT/models/$(basename "${GGUF_MODEL_URL%%\?*}")"
    echo "Downloading selected GGUF model to $GGUF_SOURCE"
    curl --fail --location --retry 3 --output "$GGUF_SOURCE" "$GGUF_MODEL_URL"
  else
    echo "Selected GGUF not found at $GGUF_SOURCE. Install it there or set LLAMA_MODEL_PATH (or FIBERLINE_GGUF_PATH/GGUF_MODEL_URL)." >&2
    exit 1
  fi
fi
if [[ ! -x "$LLAMA_SERVER_BIN" ]]; then
  echo "llama-server binary not found: $LLAMA_SERVER_BIN; run npm run llama:build first." >&2
  exit 1
fi
if [[ -n "${DOC_EMBEDDING_MODEL_PATH:-}" || "$EMBEDDING_MODEL_ID" != "Xenova/all-MiniLM-L6-v2" ]]; then
  echo "The offline pack currently pins Xenova/all-MiniLM-L6-v2; unset custom DOC_EMBEDDING_MODEL_PATH/ID before packaging." >&2
  exit 1
fi

MODEL_BYTES="$(wc -c < "$GGUF_SOURCE" | tr -d ' ')"
MODEL_MIB="$((MODEL_BYTES / 1024 / 1024))"
if (( MODEL_MIB < 800 || MODEL_MIB > 1300 )); then
  echo "Warning: model is ${MODEL_MIB} MiB; expected roughly 800–1300 MiB for Qwen2.5-1.5B Q4_K_M; verify the selected asset." >&2
fi
if [[ -n "${GGUF_MODEL_SHA256:-}" ]]; then
  ACTUAL_SHA="$(sha256sum "$GGUF_SOURCE" | awk '{print $1}')"
  if [[ "$ACTUAL_SHA" != "$GGUF_MODEL_SHA256" ]]; then
    echo "GGUF SHA-256 mismatch: expected $GGUF_MODEL_SHA256, got $ACTUAL_SHA" >&2
    exit 1
  fi
fi

mkdir -p "$TRANSFORMERS_CACHE_DIR" "$(dirname "$BUNDLE_DIR")"
(
  cd "$BACKEND_ROOT"
  DOC_INDEX_PATH="$DOC_INDEX_PATH" \
  DOC_EMBEDDING_MODEL_ID="$EMBEDDING_MODEL_ID" \
  TRANSFORMERS_CACHE="$TRANSFORMERS_CACHE_DIR" \
  DOC_EMBEDDING_OFFLINE=0 \
  npm run docs:index
)
[[ -s "$DOC_INDEX_PATH" ]] || { echo "Documentation index was not created: $DOC_INDEX_PATH" >&2; exit 1; }
[[ -d "$TRANSFORMERS_CACHE_DIR" ]] || { echo "Embedding model cache is missing: $TRANSFORMERS_CACHE_DIR" >&2; exit 1; }

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/app" "$BUNDLE_DIR/app/data" "$BUNDLE_DIR/bin" \
  "$BUNDLE_DIR/ai" "$BUNDLE_DIR/models/llm" "$BUNDLE_DIR/models/transformers-cache" "$BUNDLE_DIR/docs-source"
cp "$BACKEND_ROOT/package.json" "$BACKEND_ROOT/package-lock.json" "$BACKEND_ROOT/knexfile.js" "$BACKEND_ROOT/.env.example" "$BACKEND_ROOT/README.md" "$BUNDLE_DIR/app/"
cp -a "$BACKEND_ROOT/src" "$BACKEND_ROOT/migrations" "$BUNDLE_DIR/app/"
cp "$DOC_INDEX_PATH" "$BUNDLE_DIR/app/data/docs.sqlite"
# toolRouterSchema resolves the shared catalog three levels above app/src/ai.
cp "$REPO_ROOT/ai/tools.json" "$BUNDLE_DIR/ai/tools.json"
cp -a "$TRANSFORMERS_CACHE_DIR/." "$BUNDLE_DIR/models/transformers-cache/"
cp "$GGUF_SOURCE" "$BUNDLE_DIR/models/llm/model.gguf"
cp "$LLAMA_SERVER_BIN" "$BUNDLE_DIR/bin/llama-server"
chmod +x "$BUNDLE_DIR/bin/llama-server"
cp "$BACKEND_ROOT/scripts/start-offline.sh" "$BUNDLE_DIR/start-offline.sh"
chmod +x "$BUNDLE_DIR/start-offline.sh"
# Keep the inference-only startup diagnostic available in the installed app.
mkdir -p "$BUNDLE_DIR/app/scripts"
cp "$BACKEND_ROOT/scripts/check-router-startup.js" "$BUNDLE_DIR/app/scripts/"
mkdir -p "$BUNDLE_DIR/docs-source/specs"
cp "$REPO_ROOT/docs/specs/serviceability-remediation-rules.md" \
  "$REPO_ROOT/docs/specs/failure-simulation-algorithm.md" \
  "$REPO_ROOT/docs/specs/capacity-remediation-feature-spec.md" \
  "$BUNDLE_DIR/docs-source/specs/"

npm ci --omit=dev --prefix "$BUNDLE_DIR/app"
if [[ ! -d "$BUNDLE_DIR/app/node_modules/@huggingface/transformers" ]]; then
  echo "The optional @huggingface/transformers dependency was not installed; cannot make an offline RAG bundle." >&2
  exit 1
fi

MODEL_SHA="$(sha256sum "$GGUF_SOURCE" | awk '{print $1}')"
LLAMA_COMMIT="$(git -C "$ASSET_ROOT/llama.cpp-src" rev-parse HEAD 2>/dev/null || echo 'externally-provided-binary')"
export BUNDLE_DIR MODEL_BYTES MODEL_SHA LLAMA_COMMIT EMBEDDING_MODEL_ID
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const bundle = process.env.BUNDLE_DIR;
const manifest = {
  package: 'fiberline-offline',
  built_at: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  gguf: {
    path: 'models/llm/model.gguf',
    bytes: Number(process.env.MODEL_BYTES),
    sha256: process.env.MODEL_SHA,
  },
  embedding_model: process.env.EMBEDDING_MODEL_ID,
  doc_index: 'app/data/docs.sqlite',
  llama_cpp_commit: process.env.LLAMA_COMMIT,
};
fs.writeFileSync(path.join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
NODE

mkdir -p "$(dirname "$ARCHIVE_PATH")"
rm -f "$ARCHIVE_PATH"
tar -czf "$ARCHIVE_PATH" -C "$(dirname "$BUNDLE_DIR")" "$(basename "$BUNDLE_DIR")"

size_bytes() { wc -c < "$1" | tr -d ' '; }
BUNDLE_BYTES="$(du -sb "$BUNDLE_DIR" | awk '{print $1}')"
ARCHIVE_BYTES="$(size_bytes "$ARCHIVE_PATH")"
CACHE_BYTES="$(du -sb "$BUNDLE_DIR/models/transformers-cache" | awk '{print $1}')"
INDEX_BYTES="$(size_bytes "$BUNDLE_DIR/app/data/docs.sqlite")"
LLAMA_BYTES="$(size_bytes "$BUNDLE_DIR/bin/llama-server")"
cat <<SUMMARY

Offline package assembled:
  GGUF model:       ${MODEL_MIB} MiB ($MODEL_BYTES bytes)
  Embedding cache:  $((CACHE_BYTES / 1024 / 1024)) MiB ($CACHE_BYTES bytes)
  SQLite index:     $((INDEX_BYTES / 1024)) KiB ($INDEX_BYTES bytes)
  llama-server:     $((LLAMA_BYTES / 1024 / 1024)) MiB ($LLAMA_BYTES bytes)
  App + node_modules: included in total below
  Uncompressed:     $((BUNDLE_BYTES / 1024 / 1024)) MiB ($BUNDLE_BYTES bytes)
  Compressed:       $((ARCHIVE_BYTES / 1024 / 1024)) MiB ($ARCHIVE_BYTES bytes)
  Bundle dir:       $BUNDLE_DIR
  Archive:          $ARCHIVE_PATH

Run on the target machine with: ./start-offline.sh
After starting a fresh model server, measure application warm-up and the first inference using:
  cd "$BUNDLE_DIR/app" && npm run check:router-startup
SUMMARY
