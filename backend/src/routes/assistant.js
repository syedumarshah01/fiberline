const express = require('express');
const path = require('node:path');
const { getToolSchema } = require('../tools/toolSchema');
const { createToolRouter, executeModelToolSelection } = require('../tools/toolRouter');
const { createEmbeddingService } = require('../services/embeddingService');
const { openDocIndex } = require('../services/docIndexStore');
const { createLookupDocsHandler, validateLookupDocsArgs } = require('../services/docsLookup');
const { createModelProviderFromEnv } = require('../services/modelProvider');

const router = express.Router();
let runtimePromise;

function createDefaultRuntime() {
  const embeddingService = createEmbeddingService();
  const modelProvider = createModelProviderFromEnv();
  const indexPath = path.resolve(process.env.DOC_INDEX_PATH || path.resolve(__dirname, '../../data/docs.sqlite'));
  let indexPromise;

  async function getIndex() {
    if (!indexPromise) {
      indexPromise = openDocIndex({ indexPath, expectedModelId: embeddingService.modelId });
      indexPromise.catch(() => { indexPromise = null; });
    }
    return indexPromise;
  }

  const lookupDocs = createLookupDocsHandler({
    embedQuery: async (query) => {
      // Fail fast on a missing/stale build artifact before loading the embedding model.
      await getIndex();
      return embeddingService.embed(query);
    },
    retrieve: async (queryVector, options) => (await getIndex()).search(queryVector, options),
    generateText: (request) => modelProvider.generateText(request),
    topK: process.env.DOCS_TOP_K,
    minSimilarity: process.env.DOCS_MIN_SIMILARITY,
  });

  return {
    modelProvider,
    toolRouter: createToolRouter({ lookupDocs }),
  };
}

function getDefaultRuntime() {
  if (!runtimePromise) {
    runtimePromise = Promise.resolve().then(createDefaultRuntime);
    runtimePromise.catch(() => { runtimePromise = null; });
  }
  return runtimePromise;
}

router.get('/tools', (req, res) => {
  res.json({ tools: getToolSchema() });
});

// POST /api/assistant/tool-call
// Provider-agnostic contract: { "tool": "lookupDocs", "args": { "query": "..." } }
router.post('/tool-call', async (req, res) => {
  try {
    const { toolRouter } = await getDefaultRuntime();
    res.json(await toolRouter.execute(req.body));
  } catch (error) {
    const statusCode = Number(error.statusCode) || 503;
    res.status(statusCode).json({
      error: error.message || 'Assistant tool failed',
      ...(error.code ? { code: error.code } : {}),
    });
  }
});

// Natural-language entry point for this docs-only tool set. The provider only
// selects the registered tool; factual answering happens after RAG retrieval.
router.post('/query', async (req, res) => {
  try {
    const query = validateLookupDocsArgs({ query: req.body?.query });
    const { modelProvider, toolRouter } = await getDefaultRuntime();
    const answer = await executeModelToolSelection({
      provider: modelProvider,
      toolRouter,
      toolChoice: { type: 'function', function: { name: 'lookupDocs' } },
      maxTokens: 96,
      messages: [
        {
          role: 'system',
          content: 'You are a tool router for Fiberline documentation. Always call lookupDocs for this request. Do not answer from model knowledge or return a direct answer; preserve the user question as the tool query.',
        },
        { role: 'user', content: query },
      ],
    });
    res.json(answer);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 503;
    res.status(statusCode).json({
      error: error.message || 'Documentation query failed',
      ...(error.code ? { code: error.code } : {}),
    });
  }
});

module.exports = router;
