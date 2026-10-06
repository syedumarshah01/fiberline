const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_MODEL_DIRECTORY,
  MODEL_SPECS,
  identifyCandidate,
  isQ4KmFilename,
  resolveModelCandidates,
  validateModelCandidates,
} = require('../scripts/benchmarkToolRouter');

function withTempDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberline-gguf-benchmark-'));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('GGUF benchmark model discovery', () => {
  test('defaults to the backend/models/gguf directory and three Phase 2 candidates', () => {
    assert.equal(DEFAULT_MODEL_DIRECTORY, path.resolve(__dirname, '../models/gguf'));
    assert.equal(MODEL_SPECS.length, 3);
    assert.deepEqual(MODEL_SPECS.map((candidate) => candidate.filename), [
      'qwen2.5-0.5b-instruct-q4_k_m.gguf',
      'qwen2.5-1.5b-instruct-q4_k_m.gguf',
      'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    ]);
  });

  test('identifies candidate families across filename casing and Q4_K_M separators', () => {
    assert.equal(identifyCandidate('QWEN-2.5-0.5B-Instruct-Q4-K-M.gguf').family, 'qwen-0.5b');
    assert.equal(identifyCandidate('qwen2.5-1.5b-instruct-q4_k_m.gguf').family, 'qwen-1.5b');
    assert.equal(identifyCandidate('Llama-3.2-1B-Instruct-Q4_K_M.gguf').family, 'llama-1b');
    assert.equal(isQ4KmFilename('model-Q4-K-M.gguf'), true);
    assert.equal(isQ4KmFilename('model-Q5_K_M.gguf'), false);
  });

  test('discovers the three matching local files and reports their actual filenames', () => {
    withTempDirectory((directory) => {
      const filenames = [
        'qwen2.5-0.5b-instruct-Q4_K_M.gguf',
        'qwen2.5-1.5b-instruct-q4_k_m.gguf',
        'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
      ];
      for (const filename of filenames) fs.writeFileSync(path.join(directory, filename), Buffer.alloc(256));

      const candidates = resolveModelCandidates({ modelDirectory: directory, modelList: '' });
      assert.deepEqual(candidates.map((candidate) => candidate.filename), filenames);
      const validated = validateModelCandidates(candidates);
      assert.equal(validated.candidates.length, 3);
      assert.ok(validated.candidates.every((candidate) => candidate.exists && candidate.sizeBytes === 256));
      assert.equal(validated.warnings.length, 3, 'small fixture files are flagged as suspiciously small');
    });
  });

  test('fails clearly when a required candidate file is missing', () => {
    withTempDirectory((directory) => {
      const candidates = resolveModelCandidates({ modelDirectory: directory, modelList: '' });
      assert.throws(
        () => validateModelCandidates(candidates),
        /GGUF benchmark inputs are not ready:[\s\S]*file not found/i,
      );
    });
  });

  test('rejects a local file whose name does not identify Q4_K_M', () => {
    withTempDirectory((directory) => {
      const filename = 'qwen2.5-0.5b-instruct-q5_k_m.gguf';
      fs.writeFileSync(path.join(directory, filename), Buffer.alloc(256));
      const candidates = resolveModelCandidates({ modelDirectory: directory, modelList: filename });
      assert.throws(
        () => validateModelCandidates(candidates),
        /does not identify Q4_K_M quantization/i,
      );
    });
  });
});
