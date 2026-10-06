const path = require('node:path');

const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const BACKEND_ROOT = path.resolve(__dirname, '../..');

function resolveEmbeddingConfig(env = process.env) {
  return {
    modelId: env.DOC_EMBEDDING_MODEL_ID || DEFAULT_EMBEDDING_MODEL,
    modelPath: env.DOC_EMBEDDING_MODEL_PATH || null,
    cacheDir: path.resolve(env.TRANSFORMERS_CACHE || path.join(BACKEND_ROOT, '.runtime-assets', 'transformers-cache')),
    offline: env.DOC_EMBEDDING_OFFLINE === '1',
    threads: Math.max(1, Number.parseInt(env.DOC_EMBEDDING_THREADS || '1', 10) || 1),
  };
}

function vectorsFromTensor(output, expectedCount) {
  if (!output || !output.dims || !output.data) {
    throw new Error('Embedding model returned an invalid tensor');
  }

  const dimensions = output.dims;
  const vectorSize = dimensions[dimensions.length - 1];
  if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
    throw new Error('Embedding model returned an invalid vector size');
  }
  const data = Array.from(output.data);
  if (data.length !== expectedCount * vectorSize) {
    throw new Error(`Expected ${expectedCount} embeddings, got tensor shape [${dimensions.join(', ')}]`);
  }

  return Array.from({ length: expectedCount }, (_, index) =>
    data.slice(index * vectorSize, (index + 1) * vectorSize),
  );
}

function createEmbeddingService({
  config = resolveEmbeddingConfig(),
  loadPipeline = defaultLoadPipeline,
} = {}) {
  let pipelinePromise;

  async function getPipeline() {
    if (!pipelinePromise) {
      pipelinePromise = Promise.resolve().then(() => loadPipeline(config));
      pipelinePromise.catch(() => {
        // Permit a later retry after a transient download/model-load failure.
        pipelinePromise = null;
      });
    }
    return pipelinePromise;
  }

  async function embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    if (texts.some((text) => typeof text !== 'string' || !text.trim())) {
      throw new TypeError('Every value to embed must be a non-empty string');
    }

    const extractor = await getPipeline();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return vectorsFromTensor(output, texts.length);
  }

  async function embed(text) {
    const vectors = await embedBatch([text]);
    return vectors[0];
  }

  return Object.freeze({
    modelId: config.modelPath ? path.resolve(config.modelPath) : config.modelId,
    embed,
    embedBatch,
  });
}

async function defaultLoadPipeline(config) {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch (error) {
    const dependencyError = new Error(
      'Document embeddings require @huggingface/transformers and its ONNX runtime. Reinstall backend dependencies before building or using the docs index.',
    );
    dependencyError.cause = error;
    throw dependencyError;
  }

  const { env, pipeline } = transformers;
  env.cacheDir = config.cacheDir;
  env.backends.onnx.wasm.numThreads = config.threads;
  if (config.offline || config.modelPath) env.allowRemoteModels = false;

  const model = config.modelPath ? path.resolve(config.modelPath) : config.modelId;
  try {
    return await pipeline('feature-extraction', model, {
      local_files_only: config.offline || Boolean(config.modelPath),
    });
  } catch (error) {
    const modelError = new Error(
      `Unable to load embedding model ${model}. Run npm run docs:index with network access, or package the model cache for offline use.`,
    );
    modelError.cause = error;
    throw modelError;
  }
}

module.exports = {
  DEFAULT_EMBEDDING_MODEL,
  resolveEmbeddingConfig,
  vectorsFromTensor,
  createEmbeddingService,
};
