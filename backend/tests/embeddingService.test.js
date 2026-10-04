const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_EMBEDDING_MODEL,
  resolveEmbeddingConfig,
  createEmbeddingService,
} = require('../src/services/embeddingService');

describe('embeddingService', () => {
  test('defaults to all-MiniLM-L6-v2 and a local model cache', () => {
    const config = resolveEmbeddingConfig({});
    assert.equal(config.modelId, DEFAULT_EMBEDDING_MODEL);
    assert.match(config.cacheDir, /transformers-cache/);
    assert.equal(config.threads, 1);
  });

  test('embeds batches with mean pooling and normalized vectors, loading once', async () => {
    let loaded = 0;
    let options;
    const service = createEmbeddingService({
      config: { modelId: DEFAULT_EMBEDDING_MODEL, modelPath: null, cacheDir: '/tmp/models', offline: false, threads: 1 },
      loadPipeline: async () => {
        loaded += 1;
        return async (texts, pipelineOptions) => {
          options = pipelineOptions;
          return {
            dims: [texts.length, 3],
            data: Float32Array.from(texts.flatMap((text) => [text.length, 0.5, 1])),
          };
        };
      },
    });

    assert.deepEqual(await service.embedBatch(['first', 'second']), [[5, 0.5, 1], [6, 0.5, 1]]);
    assert.deepEqual(await service.embed('query'), [5, 0.5, 1]);
    assert.equal(loaded, 1);
    assert.deepEqual(options, { pooling: 'mean', normalize: true });
  });

  test('does not ask the pipeline to embed an empty batch and rejects blank inputs', async () => {
    let loaded = false;
    const service = createEmbeddingService({
      config: { modelId: 'test', cacheDir: '/tmp/models', offline: false, threads: 1 },
      loadPipeline: async () => {
        loaded = true;
        return async () => ({ dims: [1, 2], data: [0, 1] });
      },
    });

    assert.deepEqual(await service.embedBatch([]), []);
    await assert.rejects(service.embedBatch(['ok', '  ']), /non-empty string/);
    assert.equal(loaded, false);
  });

  test('surfaces malformed embedding tensor shapes', async () => {
    const service = createEmbeddingService({
      config: { modelId: 'test', cacheDir: '/tmp/models', offline: false, threads: 1 },
      loadPipeline: async () => async () => ({ dims: [2, 3], data: [0, 1, 2] }),
    });
    await assert.rejects(service.embedBatch(['a', 'b']), /Expected 2 embeddings/);
  });
});
