const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { SELECTED_LOCAL_MODEL, localModelName, localModelPath } = require('../src/ai/localModelConfig');

test('selected Qwen GGUF name and source path are explicit and independent of cwd', () => {
  assert.equal(SELECTED_LOCAL_MODEL, 'qwen2.5-1.5b-instruct-q4_k_m.gguf');
  assert.equal(localModelName({}), SELECTED_LOCAL_MODEL);
  assert.equal(localModelPath({}), path.resolve(__dirname, '../models/gguf', SELECTED_LOCAL_MODEL));
});

test('explicit model and asset overrides remain available for comparison/fallback', () => {
  assert.equal(localModelName({ LOCAL_LLM_MODEL: 'other' }), 'other');
  assert.equal(localModelName({ LLM_MODEL: 'legacy' }), 'legacy');
  assert.equal(localModelName({ TOOL_ROUTER_MODEL: 'router', LOCAL_LLM_MODEL: 'other' }), 'router');
  const root = path.resolve(__dirname, '../fixtures');
  assert.equal(localModelPath({ LLAMA_MODEL_PATH: 'alternate.gguf' }, root), path.join(root, 'alternate.gguf'));
  assert.equal(localModelPath({ FIBERLINE_GGUF_PATH: 'fallback.gguf' }, root), path.join(root, 'fallback.gguf'));
  assert.equal(localModelPath({ LLAMA_MODEL_PATH: 'first.gguf', FIBERLINE_GGUF_PATH: 'second.gguf' }, root), path.join(root, 'first.gguf'));
});
