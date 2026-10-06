const path = require('node:path');
const { createEmbeddingService, resolveEmbeddingConfig } = require('./embeddingService');
const { openDocIndex } = require('./docIndexStore');
const { createLookupDocsHandler } = require('./docsLookup');
const { createModelProviderFromEnv } = require('./modelProvider');

function createDocsLookupRuntime(options = {}) {
  const env = options.env || process.env;
  const embeddingService = options.embeddingService || createEmbeddingService({
    config: resolveEmbeddingConfig(env),
  });
  const modelProvider = options.modelProvider || createModelProviderFromEnv(env);
  const loadIndex = options.openIndex || openDocIndex;
  const indexPath = path.resolve(
    env.DOC_INDEX_PATH || path.resolve(__dirname, '../../data/docs.sqlite'),
  );
  let indexPromise;

  async function getIndex() {
    if (!indexPromise) {
      indexPromise = Promise.resolve().then(() => loadIndex({
        indexPath,
        expectedModelId: embeddingService.modelId,
      }));
      indexPromise.catch(() => { indexPromise = null; });
    }
    return indexPromise;
  }

  const lookupDocs = createLookupDocsHandler({
    embedQuery: async (query) => {
      // Fail before loading model weights if the build-time index is missing.
      await getIndex();
      return embeddingService.embed(query);
    },
    retrieve: async (queryVector, searchOptions) => (await getIndex()).search(queryVector, searchOptions),
    generateText: (request) => modelProvider.generateText(request),
    topK: env.DOCS_TOP_K,
    minSimilarity: env.DOCS_MIN_SIMILARITY,
  });

  return Object.freeze({ modelProvider, lookupDocs, getIndex });
}

let defaultRuntimePromise;

function getDocsLookupRuntime() {
  if (!defaultRuntimePromise) {
    defaultRuntimePromise = Promise.resolve().then(() => createDocsLookupRuntime());
    defaultRuntimePromise.catch(() => { defaultRuntimePromise = null; });
  }
  return defaultRuntimePromise;
}

async function lookupDocs(args) {
  return (await getDocsLookupRuntime()).lookupDocs(args);
}

module.exports = { createDocsLookupRuntime, getDocsLookupRuntime, lookupDocs };
