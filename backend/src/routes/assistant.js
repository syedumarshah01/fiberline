const express = require('express');
const { getToolSchema } = require('../tools/toolSchema');
const { createToolRouter, executeModelToolSelection } = require('../tools/toolRouter');
const { validateLookupDocsArgs } = require('../services/docsLookup');
const { getDocsLookupRuntime } = require('../services/docsLookupRuntime');

const router = express.Router();
let runtimePromise;

function getDefaultRuntime() {
  if (!runtimePromise) {
    runtimePromise = getDocsLookupRuntime().then(({ modelProvider, lookupDocs }) => ({
      modelProvider,
      toolRouter: createToolRouter({ lookupDocs }),
    }));
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
