const express = require('express');
const { randomUUID } = require('node:crypto');
const { executeNaturalLanguageQuery } = require('../services/naturalLanguageQuery');
const { plannerMode } = require('../services/llmQueryPlanner');
const { askNetworkAssistant } = require('../services/llmAssistant');
const { executePendingAction, cancelPendingAction } = require('../services/agentActions');

const router = express.Router();

async function handleQuery(req, res, next) {
  const requestId = randomUUID();
  res.set('X-Request-Id', requestId);
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
      request_id: requestId,
      userId: req.user?.id || 'anonymous',
      userRole: req.user?.role || 'technician',
    };
    console.info(`[network-query:${requestId}] accepted prompt length=${query.length}`);
    const result = plannerMode() !== 'deterministic'
      ? await askNetworkAssistant(query, assistantOptions)
      : await executeNaturalLanguageQuery(query);
    const status = result.status === 'not_found' ? 404 : result.status === 'needs_location' || result.status === 'needs_clarification' ? 422 : 200;
    res.status(status).json(result);
  } catch (err) {
    err.request_id ||= requestId;
    console.error(`[network-query:${requestId}] failed stage=${err.stage || 'route'} code=${err.code || 'UNKNOWN'} message=${err.message}`);
    next(err);
  }
}

// POST is used by the console. GET is useful for bookmarked/read-only links.
router.post('/query', handleQuery);
router.get('/query', handleQuery);

router.post('/actions/:id/confirm', async (req, res, next) => {
  try {
    const result = await executePendingAction(req.params.id, {
      userId: req.user?.id,
      userRole: req.user?.role,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/actions/:id/cancel', async (req, res, next) => {
  try {
    res.json(cancelPendingAction(req.params.id, { userId: req.user?.id }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
