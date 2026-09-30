const express = require('express');
const {
  executeNaturalLanguageQuery,
  parseNaturalLanguageQuery,
} = require('../services/naturalLanguageQuery');
const { config, plannerMode } = require('../services/llmQueryPlanner');
const { askGeminiNetwork } = require('../services/geminiAssistant');
const { askOpenRouterNetwork } = require('../services/openRouterAssistant');
const { askGroqNetwork } = require('../services/groqAssistant');

const router = express.Router();

async function handleQuery(req, res, next) {
  try {
    const query = req.method === 'GET' ? req.query.q : req.body?.query;
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        error: 'query is required',
        examples: [
          'which customers are affected if pole 42 goes down?',
          'show me every box within 500m of 12 Main Street with spare capacity',
        ],
      });
    }

    const conversationId = req.method === 'GET' ? req.query.conversation_id : req.body?.conversation_id;
    const assistantOptions = {
      conversation_id: typeof conversationId === 'string' ? conversationId : null,
      userId: req.user?.id || 'anonymous',
    };
    const provider = config().provider;
    const result = plannerMode() !== 'deterministic' && provider === 'gemini'
      ? await askGeminiNetwork(query, assistantOptions)
      : plannerMode() !== 'deterministic' && provider === 'openrouter'
        ? await askOpenRouterNetwork(query, assistantOptions)
        : plannerMode() !== 'deterministic' && provider === 'groq'
          ? await askGroqNetwork(query, assistantOptions)
          : await executeNaturalLanguageQuery(query);
    const status = result.status === 'not_found' ? 404 : result.status === 'needs_location' || result.status === 'needs_clarification' ? 422 : 200;
    res.status(status).json(result);
  } catch (err) {
    next(err);
  }
}

// POST is used by the console. GET is useful for bookmarked/read-only links.
router.post('/query', handleQuery);
router.get('/query', handleQuery);

// Exported for focused route tests without exposing a second execution path.
router.parseNaturalLanguageQuery = parseNaturalLanguageQuery;

module.exports = router;
