#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TARGET_TOKENS,
  chunkMarkdownDocument,
} = require('../src/services/docChunker');
const { createEmbeddingService, resolveEmbeddingConfig } = require('../src/services/embeddingService');
const { createDocIndex } = require('../src/services/docIndexStore');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const DOCUMENT_PATHS = [
  'docs/specs/serviceability-remediation-rules.md',
  'docs/specs/failure-simulation-algorithm.md',
  'docs/specs/capacity-remediation-feature-spec.md',
];

function tensorLength(encoding) {
  const ids = encoding?.input_ids;
  if (ids?.dims?.length) return Number(ids.dims[ids.dims.length - 1]);
  if (Array.isArray(ids)) return Array.isArray(ids[0]) ? ids[0].length : ids.length;
  if (ids?.data && ids?.dims?.length) return Number(ids.dims[ids.dims.length - 1]);
  throw new Error('Tokenizer did not return input_ids with a measurable length');
}

async function loadTokenizer(config) {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch (error) {
    const dependencyError = new Error('Install @huggingface/transformers before building the documentation index.');
    dependencyError.cause = error;
    throw dependencyError;
  }

  const { AutoTokenizer, env } = transformers;
  env.cacheDir = config.cacheDir;
  if (config.offline || config.modelPath) env.allowRemoteModels = false;
  const model = config.modelPath ? path.resolve(config.modelPath) : config.modelId;
  const tokenizer = await AutoTokenizer.from_pretrained(model, {
    local_files_only: config.offline || Boolean(config.modelPath),
  });

  return (text) => tensorLength(tokenizer(text, { truncation: false, padding: false }));
}

async function readSources() {
  const documents = [];
  for (const relativePath of DOCUMENT_PATHS) {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Documentation source is missing: ${relativePath}`);
    }
    documents.push({
      source: relativePath.replaceAll(path.sep, '/'),
      markdown: fs.readFileSync(absolutePath, 'utf8'),
    });
  }
  return documents;
}

async function build() {
  const config = resolveEmbeddingConfig();
  const documents = await readSources();
  const measureTokens = await loadTokenizer(config);
  const maxTokens = Math.min(
    DEFAULT_MAX_TOKENS,
    Math.max(64, Number.parseInt(process.env.DOC_MAX_CHUNK_TOKENS || String(DEFAULT_MAX_TOKENS), 10) || DEFAULT_MAX_TOKENS),
  );
  const targetTokens = Math.min(
    maxTokens,
    Math.max(32, Number.parseInt(process.env.DOC_TARGET_CHUNK_TOKENS || String(DEFAULT_TARGET_TOKENS), 10) || DEFAULT_TARGET_TOKENS),
  );

  const chunks = [];
  const hash = crypto.createHash('sha256');
  hash.update(`${config.modelPath ? path.resolve(config.modelPath) : config.modelId}\0${maxTokens}\0${targetTokens}\n`);
  for (const document of documents) {
    hash.update(`${document.source}\0${document.markdown}\n`);
    chunks.push(...await chunkMarkdownDocument({
      ...document,
      tokenCount: measureTokens,
      maxTokens,
      targetTokens,
    }));
  }
  if (!chunks.length) throw new Error('No documentation chunks were produced');

  const embedder = createEmbeddingService({ config });
  const embeddings = [];
  const batchSize = Math.max(1, Math.min(32, Number.parseInt(process.env.DOC_EMBED_BATCH_SIZE || '8', 10) || 8));
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    embeddings.push(...await embedder.embedBatch(batch.map((chunk) => chunk.text)));
    process.stdout.write(`Embedded ${Math.min(offset + batch.length, chunks.length)}/${chunks.length} chunks\r`);
  }
  process.stdout.write('\n');

  const indexPath = path.resolve(process.env.DOC_INDEX_PATH || path.join(BACKEND_ROOT, 'data', 'docs.sqlite'));
  const modelId = config.modelPath ? path.resolve(config.modelPath) : config.modelId;
  const result = await createDocIndex({
    outputPath: indexPath,
    chunks,
    embeddings,
    modelId,
    sourceHash: hash.digest('hex'),
  });
  const averageTokens = Math.round(chunks.reduce((total, chunk) => total + chunk.token_count, 0) / chunks.length);
  const size = fs.statSync(indexPath).size;
  console.log(`Built ${result.chunkCount} documentation chunks (${averageTokens} tokens average).`);
  console.log(`Embedding model: ${modelId} (${result.dimensions} dimensions)`);
  console.log(`Index: ${indexPath} (${(size / 1024 / 1024).toFixed(2)} MiB)`);
}

build().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
