#!/usr/bin/env bash
set -euo pipefail

BACKEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$BACKEND_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$BACKEND_ROOT/.env"
  set +a
fi
ASSET_ROOT="${FIBERLINE_ASSET_DIR:-$BACKEND_ROOT/.runtime-assets}"
SOURCE_DIR="$ASSET_ROOT/llama.cpp-src"
BUILD_DIR="$SOURCE_DIR/build"
REF="${LLAMA_CPP_REF:-master}"
JOBS="${BUILD_JOBS:-2}"
NATIVE="${LLAMA_GGML_NATIVE:-OFF}"

for tool in git cmake; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing build tool: $tool" >&2
    exit 1
  }
done

mkdir -p "$ASSET_ROOT"
if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone https://github.com/ggml-org/llama.cpp.git "$SOURCE_DIR"
fi

git -C "$SOURCE_DIR" fetch --tags --force origin
if git -C "$SOURCE_DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
  CHECKOUT_REF="refs/remotes/origin/$REF"
else
  CHECKOUT_REF="$REF"
fi
git -C "$SOURCE_DIR" checkout --detach "$CHECKOUT_REF"
LLAMA_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"

echo "Building llama.cpp commit $LLAMA_COMMIT for $(uname -s)/$(uname -m)"
echo "GGML_NATIVE=$NATIVE (leave OFF for portable CPU bundles; enable only for target-specific builds)"
cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE="$NATIVE" \
  -DGGML_OPENMP=ON \
  -DLLAMA_BUILD_SERVER=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF
cmake --build "$BUILD_DIR" --target llama-server --config Release --parallel "$JOBS"

SERVER_BIN="$BUILD_DIR/bin/llama-server"
if [[ ! -x "$SERVER_BIN" ]]; then
  echo "llama-server build completed but binary is missing at $SERVER_BIN" >&2
  exit 1
fi

echo "Built: $SERVER_BIN"
echo "Pinned source commit: $LLAMA_COMMIT"
ls -lh "$SERVER_BIN"
