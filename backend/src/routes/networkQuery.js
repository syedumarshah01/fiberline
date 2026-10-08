const express = require('express');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { routeToolCall } = require('../services/toolRouter');
const { executeToolCall } = require('../services/toolExecutor');
const { formatResponse } = require('../services/responseFormatter');
const { executePendingAction, cancelPendingAction } = require('../services/agentActions');

const MAX_QUERY_LENGTH = 4000;
const ROUTER_SOURCE = 'constrained_tool_router';

function requestQuery(req) {
  return req.method === 'GET' ? req.query?.q : req.body?.query;
}

function requestConversationId(req) {
  const value = req.method === 'GET' ? req.query?.conversation_id : req.body?.conversation_id;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null;
}

function requestCustomerLocation(req) {
  const payload = req.method === 'GET' ? req.query : req.body;
  const candidate = payload?.customer_location;
  const hasFlatLat = payload?.lat !== undefined || payload?.customer_lat !== undefined;
  const hasFlatLng = payload?.lng !== undefined || payload?.customer_lng !== undefined;
  const value = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : hasFlatLat || hasFlatLng
      ? { lat: payload?.customer_lat ?? payload?.lat, lng: payload?.customer_lng ?? payload?.lng }
      : null;
  if (!value) return { location: null, error: null };
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { location: null, error: 'customer_location must contain valid latitude and longitude coordinates.' };
  }
  return { location: { lat, lng }, error: null };
}

function executionStatus(errorCode, statusCode) {
  const explicitStatus = Number(statusCode);
  if ([400, 403, 404, 503].includes(explicitStatus)) return explicitStatus;
  if (errorCode === 'ENTITY_NOT_FOUND') return 404;
  if (errorCode === 'CONFIRMATION_REQUIRED') return 403;
  if (errorCode === 'INVALID_ARGUMENT' || errorCode === 'INVALID_TOOL_CALL' || errorCode === 'UNKNOWN_TOOL') return 400;
  if (errorCode === 'TOOL_HANDLER_UNAVAILABLE' || errorCode === 'DOC_INDEX_MISSING') return 503;
  return 502;
}

function toolCallRecord(toolCall, execution) {
  return {
    ...(typeof toolCall?.tool === 'string' ? { tool: toolCall.tool } : {}),
    ...(toolCall?.args && typeof toolCall.args === 'object' ? { args: toolCall.args } : {}),
    success: execution.success === true,
    ...(execution.success === true
      ? { result: execution.result }
      : { error: execution.error, message: execution.message }),
  };
}

function createQueryHandler({
  route = routeToolCall,
  execute = executeToolCall,
  format = formatResponse,
} = {}) {
  if (typeof route !== 'function' || typeof execute !== 'function' || typeof format !== 'function') {
    throw new TypeError('route, execute, and format dependencies must be functions');
  }

  return async function handleQuery(req, res, next) {
    const requestId = randomUUID();
    res.set('X-Request-Id', requestId);
    const queryValue = requestQuery(req);
    const conversationId = requestConversationId(req) || requestId;
    if (typeof queryValue !== 'string' || !queryValue.trim()) {
      return res.status(400).json({
        status: 'error',
        error: 'INVALID_QUERY',
        answer_text: 'A non-empty query is required.',
        request_id: requestId,
        conversation_id: conversationId,
        examples: [
          'Trace fiber core fc-123.',
          'What does the Fiberline documentation say about optical loss budgets?',
        ],
      });
    }

    const query = queryValue.trim();
    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({
        status: 'error',
        error: 'QUERY_TOO_LONG',
        answer_text: `Queries must be ${MAX_QUERY_LENGTH} characters or fewer.`,
        request_id: requestId,
        conversation_id: conversationId,
      });
    }

    const { location: customerLocation, error: locationError } = requestCustomerLocation(req);
    if (locationError) {
      return res.status(400).json({
        status: 'error',
        error: 'INVALID_CUSTOMER_LOCATION',
        answer_text: locationError,
        request_id: requestId,
        conversation_id: conversationId,
      });
    }
    const context = {
      userId: req.user?.id || 'anonymous',
      userRole: req.user?.role || 'technician',
      ...(customerLocation ? { customer_location: customerLocation } : {}),
    };

    console.info(`[network-query:${requestId}] accepted prompt length=${query.length}`);
    try {
      const routingStarted = performance.now();
      const toolCall = await route(query, { requestId });
      console.info(`[network-query:${requestId}] router_latency_ms=${Math.round(performance.now() - routingStarted)}`);
      const execution = await execute(toolCall, { context });
      if (!execution || execution.success !== true) {
        const errorCode = execution?.error || 'TOOL_EXECUTION_FAILED';
        const errorMessage = execution?.message || 'The selected Fiberline tool could not be completed.';
        return res.status(executionStatus(errorCode, execution?.status_code)).json({
          status: 'error',
          error: errorCode,
          answer_text: await format({ error: errorMessage }),
          request_id: requestId,
          conversation_id: conversationId,
          planner_source: ROUTER_SOURCE,
          tool_calls: execution ? [toolCallRecord(toolCall, execution)] : [],
        });
      }

      const result = execution.result;
      // Documentation answers are already grounded by lookupDocs in the
      // retrieved excerpts; format that answer without serializing the chunks.
      let formattedInput = result;
      if (toolCall.tool === 'lookupDocs' && typeof result?.answer === 'string') {
        formattedInput = result.answer;
      } else if (toolCall.tool === 'traceCore' && Array.isArray(result?.trace)) {
        formattedInput = result.trace;
      }
      const answerText = await format(formattedInput);
      return res.status(200).json({
        status: 'ok',
        request_id: requestId,
        conversation_id: conversationId,
        planner_source: ROUTER_SOURCE,
        answer_text: answerText,
        tool_calls: [toolCallRecord(toolCall, execution)],
        ...(Array.isArray(result?.warnings) && result.warnings.length ? { warnings: result.warnings } : {}),
      });
    } catch (error) {
      error.request_id ||= requestId;
      console.error(`[network-query:${requestId}] failed stage=${error.stage || 'router'} code=${error.code || 'UNKNOWN'} message=${error.message}`);
      next(error);
    }
  };
}

const handleQuery = createQueryHandler();
const router = express.Router();

// POST is used by the console. GET remains available for bookmarked read-only queries.
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

// Keep the Express router as the CommonJS default export for app.use(), while
// exposing its factory and handler for focused integration tests.
router.MAX_QUERY_LENGTH = MAX_QUERY_LENGTH;
router.ROUTER_SOURCE = ROUTER_SOURCE;
router.requestCustomerLocation = requestCustomerLocation;
router.createQueryHandler = createQueryHandler;
router.handleQuery = handleQuery;
module.exports = router;
