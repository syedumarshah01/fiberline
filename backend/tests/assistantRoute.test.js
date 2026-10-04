const express = require('express');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const assistantRouter = require('../src/routes/assistant');

test('assistant routes publish the lookupDocs schema and validate query requests', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', assistantRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/assistant`;

  const toolsResponse = await fetch(`${baseUrl}/tools`);
  assert.equal(toolsResponse.status, 200);
  const tools = await toolsResponse.json();
  assert.equal(tools.tools[0].function.name, 'lookupDocs');

  const invalidQuery = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: ' ' }),
  });
  assert.equal(invalidQuery.status, 400);
  assert.match((await invalidQuery.json()).error, /non-empty query/);
});
