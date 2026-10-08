const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_HANDLERS, executeToolCall, entityExists } = require('../src/services/toolExecutor');

const { fakeEntityDb: fakeDb } = require('./helpers/entityDb');
const BOX_ID = '3c651534-b5f8-4c8b-91d0-64578cb6c1a2';
const OTHER_BOX_ID = '5252ae96-a1b9-4bf9-8971-ae44c58a36e2';
const CORE_ID = 'bc2cb596-a88c-4637-82fc-0d21e0c18fc3';

test('executes a valid read-only route only through an allowlisted deterministic handler', async () => {
  const db = fakeDb({ enclosures: [{ id: BOX_ID, code: 'BOX-0002' }] });
  const calls = [];
  const result = await executeToolCall(
    { tool: 'findPortRemediation', args: { enclosure_id: BOX_ID } },
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
    result: { status: 'ok', enclosure_id: BOX_ID, candidates: [] },
  });
  assert.deepEqual(calls, [{ enclosure_id: BOX_ID }]);
  assert.deepEqual(db.calls, [{ table: 'enclosures', criteria: { id: BOX_ID } }]);
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
  const db = fakeDb({ enclosures: [] });
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
  const db = fakeDb({ fiber_cores: [] });
  let called = false;
  const result = await executeToolCall(
    { tool: 'traceCore', args: { core_id: CORE_ID } },
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


test('preserves the actionable missing-doc-index error from the RAG handler', async () => {
  const error = new Error('Documentation index is missing; build it with npm run docs:index.');
  error.code = 'DOC_INDEX_MISSING';
  error.statusCode = 503;
  const result = await executeToolCall(
    { tool: 'lookupDocs', args: { query: 'How do I trace a core?' } },
    {
      dbClient: fakeDb(),
      handlers: { lookupDocs: async () => { throw error; } },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'DOC_INDEX_MISSING');
  assert.equal(result.status_code, 503);
  assert.match(result.message, /npm run docs:index/);
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

test('resolves a lower-case box code to its database UUID without mutating router output', async () => {
  const db = fakeDb({ enclosures: [{ id: BOX_ID, code: 'BOX-0002' }] });
  const original = Object.freeze({ tool: 'checkServiceability', args: Object.freeze({ enclosure_id: ' box-0002 ' }) });
  let received;
  const result = await executeToolCall(original, {
    dbClient: db,
    handlers: { checkServiceability: async (args) => { received = args; return { status: 'ok' }; } },
  });
  assert.equal(result.success, true);
  assert.deepEqual(received, { enclosure_id: BOX_ID });
  assert.equal(original.args.enclosure_id, ' box-0002 ');
  assert.deepEqual(db.calls, [{ table: 'enclosures', sql: 'lower(??) = lower(?)', bindings: ['code', 'box-0002'] }]);
});

test('all enclosure tools receive resolved UUIDs, while location/options and context are preserved', async () => {
  const examples = [
    ['checkServiceability', { enclosure_id: 'BOX-0002', lat: 34, lng: 71 }],
    ['findPortRemediation', { enclosure_id: 'BOX-0002' }],
    ['findPowerRemediation', { core_id: CORE_ID, enclosure_id: 'BOX-0002' }],
    ['findCoreRemediation', { enclosure_id: 'BOX-0002', exclude_self: true }],
    ['simulateFailure', { enclosure_id: 'BOX-0002' }],
  ];
  const context = { customer_location: { lat: 34, lng: 71 }, userId: 'user-1' };
  for (const [tool, args] of examples) {
    const db = fakeDb({ enclosures: [{ id: BOX_ID, code: 'BOX-0002' }], fiber_cores: [{ id: CORE_ID }] });
    let called = false;
    const result = await executeToolCall({ tool, args }, {
      dbClient: db, context,
      handlers: { [tool]: async (resolved, receivedContext) => {
        called = true;
        assert.deepEqual(resolved, { ...args, enclosure_id: BOX_ID });
        assert.strictEqual(receivedContext, context);
        return {};
      } },
    });
    assert.equal(result.success, true, tool);
    assert.equal(called, true, tool);
  }
});

test('valid UUIDs are checked directly and canonical database IDs reach handlers', async () => {
  const db = fakeDb({ fiber_cores: [{ id: CORE_ID }] });
  let received;
  const result = await executeToolCall({ tool: 'traceCore', args: { core_id: ` ${CORE_ID.toUpperCase()} ` } }, {
    dbClient: db,
    handlers: { traceCore: async (args) => { received = args; return {}; } },
  });
  assert.equal(result.success, true);
  assert.deepEqual(received, { core_id: CORE_ID });
  assert.deepEqual(db.calls, [{ table: 'fiber_cores', criteria: { id: CORE_ID.toUpperCase() } }]);
});

test('missing UUIDs are not executed and do not fall back to guessed codes', async () => {
  const db = fakeDb();
  const result = await executeToolCall({ tool: 'simulateFailure', args: { enclosure_id: BOX_ID } }, {
    dbClient: db, handlers: { simulateFailure: async () => assert.fail('must not run') },
  });
  assert.equal(result.error, 'ENTITY_NOT_FOUND');
  assert.deepEqual(db.calls, [{ table: 'enclosures', criteria: { id: BOX_ID } }]);
});

test('ambiguous case-insensitive enclosure codes never choose an arbitrary record', async () => {
  const db = fakeDb({ enclosures: [
    { id: BOX_ID, code: 'BOX-0002' },
    { id: OTHER_BOX_ID, code: 'box-0002' },
  ] });
  const result = await executeToolCall({ tool: 'simulateFailure', args: { enclosure_id: 'box-0002' } }, {
    dbClient: db, handlers: { simulateFailure: async () => assert.fail('must not run') },
  });
  assert.equal(result.error, 'AMBIGUOUS_ENTITY');
  assert.equal(result.status_code, 400);
  assert.match(result.message, /Use its UUID/);
});

test('code lookup is exact and parameter-bound: no wildcard, partial-name or SQL interpretation', async () => {
  for (const identifier of ['BOX-%', 'BOX_0002', 'BOX-000', "' OR 1=1 --", 'Main cabinet']) {
    const db = fakeDb({ enclosures: [{ id: BOX_ID, code: 'BOX-0002', name: 'Main cabinet' }] });
    const result = await executeToolCall({ tool: 'simulateFailure', args: { enclosure_id: identifier } }, {
      dbClient: db, handlers: { simulateFailure: async () => assert.fail('must not run') },
    });
    assert.equal(result.error, 'ENTITY_NOT_FOUND', identifier);
    assert.deepEqual(db.calls[0].bindings, ['code', identifier]);
  }
});

test('blank IDs and non-UUID core labels fail safely without a database query', async () => {
  for (const [tool, args] of [
    ['traceCore', { core_id: 'core-123' }],
    ['traceCore', { core_id: '4' }],
    ['traceCore', { core_id: 'bc2cb596-a88c-4637-82fc-0d21e0c18fZZ' }],
    ['traceCore', { core_id: '   ' }],
    ['simulateFailure', { enclosure_id: '   ' }],
  ]) {
    const db = fakeDb();
    const result = await executeToolCall({ tool, args }, {
      dbClient: db, handlers: { [tool]: async () => assert.fail('must not run') },
    });
    assert.equal(result.error, 'INVALID_ARGUMENT');
    assert.deepEqual(db.calls, []);
  }
  const db = fakeDb();
  assert.equal(await entityExists(db, 'enclosures', 'box-0002'), false);
  assert.deepEqual(db.calls, []);
});

test('failed inventory lookups return a safe service error, not raw SQL or not-found', async () => {
  const result = await executeToolCall({ tool: 'simulateFailure', args: { enclosure_id: 'box-0002' } }, {
    dbClient: () => { const error = new Error('select id from enclosures: internal database detail'); error.code = '08006'; throw error; },
    handlers: { simulateFailure: async () => assert.fail('must not run') },
  });
  assert.equal(result.error, 'ENTITY_LOOKUP_FAILED');
  assert.equal(result.status_code, 503);
  assert.doesNotMatch(result.message, /select|internal database detail/);
});
