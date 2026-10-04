const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_HANDLERS, executeToolCall } = require('../src/services/toolExecutor');

function fakeDb(rowsByTable = {}) {
  const calls = [];
  const db = (table) => ({
    where(criteria) {
      calls.push({ table, criteria });
      return {
        async first() {
          return rowsByTable[table]?.[criteria.id] || null;
        },
      };
    },
  });
  db.calls = calls;
  return db;
}

test('executes a valid read-only route only through an allowlisted deterministic handler', async () => {
  const db = fakeDb({ enclosures: { 'box-1': { id: 'box-1' } } });
  const calls = [];
  const result = await executeToolCall(
    { tool: 'findPortRemediation', args: { enclosure_id: 'box-1' } },
    {
      dbClient: db,
      handlers: {
        findPortRemediation: async (args) => {
          calls.push(args);
          return { status: 'ok', enclosure_id: args.enclosure_id, candidates: [] };
        },
      },
    },
  );

  assert.deepEqual(result, {
    success: true,
    tool: 'findPortRemediation',
    result: { status: 'ok', enclosure_id: 'box-1', candidates: [] },
  });
  assert.deepEqual(calls, [{ enclosure_id: 'box-1' }]);
  assert.deepEqual(db.calls, [{ table: 'enclosures', criteria: { id: 'box-1' } }]);
});

test('rejects a valid-shaped route with a missing required argument before touching the database', async () => {
  const db = fakeDb();
  const result = await executeToolCall(
    { tool: 'traceCore', args: {} },
    {
      dbClient: db,
      handlers: { traceCore: async () => ({ should_not_run: true }) },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'INVALID_TOOL_CALL');
  assert.match(result.message, /missing required argument: core_id/);
  assert.deepEqual(db.calls, []);
});

test('rejects a hallucinated enclosure before the handler runs', async () => {
  const db = fakeDb({ enclosures: {} });
  let called = false;
  const result = await executeToolCall(
    { tool: 'simulateFailure', args: { enclosure_id: 'invented-box' } },
    {
      dbClient: db,
      handlers: { simulateFailure: async () => { called = true; return {}; } },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'ENTITY_NOT_FOUND');
  assert.equal(result.param, 'enclosure_id');
  assert.match(result.message, /invented-box/);
  assert.equal(called, false);
});

test('rejects a hallucinated core before the handler runs', async () => {
  const db = fakeDb({ fiber_cores: {} });
  let called = false;
  const result = await executeToolCall(
    { tool: 'traceCore', args: { core_id: 'invented-core' } },
    {
      dbClient: db,
      handlers: { traceCore: async () => { called = true; return {}; } },
    },
  );

  assert.equal(result.error, 'ENTITY_NOT_FOUND');
  assert.equal(result.param, 'core_id');
  assert.equal(called, false);
});

test('rejects an unknown tool without database access or dynamic module loading', async () => {
  const db = fakeDb();
  const result = await executeToolCall(
    { tool: 'runArbitrarySql', args: { sql: 'DROP TABLE enclosures' } },
    { dbClient: db },
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'UNKNOWN_TOOL');
  assert.match(result.message, /Unknown tool/);
  assert.deepEqual(db.calls, []);
});


test('routes lookupDocs through its deterministic RAG handler without database access', async () => {
  const db = fakeDb();
  const args = { query: 'How does tracing work?', top_k: 2 };
  const documentation = { query: args.query, answer: 'Tracing follows the recorded splices.', sources: [] };
  let received;
  assert.equal(typeof DEFAULT_HANDLERS.lookupDocs, 'function');

  const result = await executeToolCall(
    { tool: 'lookupDocs', args },
    {
      dbClient: db,
      handlers: { lookupDocs: async (lookupArgs) => { received = lookupArgs; return documentation; } },
    },
  );

  assert.deepEqual(result, { success: true, tool: 'lookupDocs', result: documentation });
  assert.deepEqual(received, args);
  assert.deepEqual(db.calls, []);
});
