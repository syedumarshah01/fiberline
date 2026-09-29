const express = require('express');
const {
  loadCurrentTelemetry,
  ingestTelemetry,
  subscribeTelemetry,
} = require('../services/telemetry');

const router = express.Router();

/**
 * GET /api/telemetry/status
 *
 * Current normalized OLT/ONT state. `stale_after_seconds` is the contract the
 * map uses when deciding whether a last-seen reading is still live.
 */
router.get('/status', async (req, res, next) => {
  try {
    res.json(await loadCurrentTelemetry());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/telemetry/events (POST /ingest is an alias)
 *
 * Feed one event or `{ events: [...] }`. A minimal event is:
 * `{ source, device_id, status, reported_at, rx_power_dbm, box_code }`.
 * Identifiers may be inventory UUIDs or the human codes used by Fiberline.
 */
async function receiveEvents(req, res, next) {
  try {
    const source = req.get('x-telemetry-source') || req.body?.source || null;
    const result = await ingestTelemetry(req.body, { source });
    res.status(202).json(result);
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Unable to ingest telemetry' });
  }
}

router.post('/events', receiveEvents);
router.post('/ingest', receiveEvents);

/**
 * GET /api/telemetry/stream
 *
 * Server-sent events for installations that prefer push over polling. The
 * client can fall back to GET /status; a heartbeat keeps proxies from closing
 * an otherwise quiet stream.
 */
router.get('/stream', async (req, res) => {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const write = (payload) => {
    if (!res.writableEnded) res.write(`event: telemetry\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  try {
    write(await loadCurrentTelemetry());
  } catch (error) {
    write({ available: false, error: error.message || 'Telemetry unavailable', devices: [] });
  }
  const unsubscribe = subscribeTelemetry(write);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

module.exports = router;
