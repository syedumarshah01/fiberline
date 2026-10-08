const path = require('node:path');

// Selected by the user after the final constrained-decoding comparison.
// The API alias and the on-disk GGUF path are different kinds of configuration.
const SELECTED_LOCAL_MODEL = 'qwen2.5-1.5b-instruct-q4_k_m.gguf';
const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:8080/v1';

function localModelName(env = process.env) {
  return env.TOOL_ROUTER_MODEL || env.LOCAL_LLM_MODEL || env.LLM_MODEL || SELECTED_LOCAL_MODEL;
}

function localModelPath(env = process.env, backendRoot = path.resolve(__dirname, '../..')) {
  return path.resolve(backendRoot, env.LLAMA_MODEL_PATH || env.FIBERLINE_GGUF_PATH ||
    path.join('models', 'gguf', SELECTED_LOCAL_MODEL));
}

module.exports = { SELECTED_LOCAL_MODEL, DEFAULT_LOCAL_BASE_URL, localModelName, localModelPath };
