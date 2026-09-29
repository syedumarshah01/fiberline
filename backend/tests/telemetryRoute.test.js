const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const snapshot = {
  available: true,
  configured: true,
  source: 'olt-a',
  stale_after_seconds: 300,
  devices: [],
  summary: { total: 0, healthy: 0, link_down: 0, low_signal: 0, stale: 0, unknown: 0, active: 0 },
  correlation: { likely_failure: null, candidates: [], impact: null },
};
const received = [];
const servicePath = require.resolve('../src/services/telemetry');
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    loadCurrentTelemetry: async () => snapshot,
    ingestTelemetry: async (body, options) => {
      received.push({ body, options });
      return { accepted: 1, devices: [], status: snapshot };
    },
    subscribeTelemetry: () => () => {},
  },
};
const telemetryRouter = require('../src/routes/telemetry');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/telemetry', telemetryRouter);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/telemetry`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

describe('telemetry HTTP API', () => {
  test('GET status returns the documented safe snapshot', async () => {
    const response = await fetch(`${base}/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'olt-a');
    assert.ok(body.summary);
    assert.ok(Array.isArray(body.devices));
  });

  test('POST events accepts a vendor payload and source header', async () => {
    const response = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telemetry-source': 'olt-field' },
      body: JSON.stringify({ device_id: 'ONT-1', status: 'link-down' }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).accepted, 1);
    assert.equal(received[0].options.source, 'olt-field');
  });
});
