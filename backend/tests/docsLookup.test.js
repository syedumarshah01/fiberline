const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  DOC_ANSWER_MAX_TOKENS,
  createLookupDocsHandler,
  validateLookupDocsArgs,
} = require('../src/services/docsLookup');

function match(id, score, text = `Chunk text ${id}`) {
  return { id, source: 'backend/README.md', section: 'Reference', score, text };
}

describe('validateLookupDocsArgs', () => {
  test('trims valid questions and rejects malformed or oversized requests', () => {
    assert.equal(validateLookupDocsArgs({ query: '  how does tracing work?  ' }), 'how does tracing work?');
    assert.equal(validateLookupDocsArgs({ query: 'question', top_k: 2 }), 'question');
    for (const args of [null, [], {}, { query: ' ' }, { query: 'question', extra: true }, ...[0, 4, 1.5, '2'].map((top_k) => ({ query: 'question', top_k }))]) {
      assert.throws(() => validateLookupDocsArgs(args), { statusCode: 400 });
    }
    assert.throws(() => validateLookupDocsArgs({ query: 'x'.repeat(1001) }), { statusCode: 400 });
  });
});

describe('createLookupDocsHandler', () => {
  test('embeds the query, retrieves at most 3 chunks, and sends only those chunks to the answer model', async () => {
    let embedded;
    let retrievalOptions;
    let answerRequest;
    const handler = createLookupDocsHandler({
      embedQuery: async (query) => {
        embedded = query;
        return [1, 0];
      },
      retrieve: async (vector, options) => {
        assert.deepEqual(vector, [1, 0]);
        retrievalOptions = options;
        return [match('a', 0.9), match('b', 0.8), match('c', 0.7), match('d', 0.6)];
      },
      generateText: async (request) => {
        answerRequest = request;
        return 'Fiber tracing follows recorded splices and returns the path.';
      },
    });

    const result = await handler({ query: '  How does the trace feature work?  ' });
    assert.equal(embedded, 'How does the trace feature work?');
    assert.equal(retrievalOptions.limit, 3);
    assert.equal(answerRequest.maxTokens, DOC_ANSWER_MAX_TOKENS);
    assert.match(answerRequest.userPrompt, /How does the trace feature work/);
    assert.match(answerRequest.userPrompt, /Chunk text a/);
    assert.match(answerRequest.userPrompt, /Chunk text c/);
    assert.doesNotMatch(answerRequest.userPrompt, /Chunk text d/);
    assert.equal(result.sources.length, 3);
    assert.equal(result.mode, 'generated');
    assert.equal(result.answer, 'Fiber tracing follows recorded splices and returns the path.');
  });

  test('honors a schema-provided top_k value while capping retrieval at three', async () => {
    let retrievalOptions;
    const handler = createLookupDocsHandler({
      embedQuery: async () => [1, 0],
      retrieve: async (_vector, options) => {
        retrievalOptions = options;
        return [match('a', 0.9), match('b', 0.8), match('c', 0.7)];
      },
      generateText: async () => 'The docs describe this behavior.',
    });
    const result = await handler({ query: 'question?', top_k: 2 });
    assert.equal(retrievalOptions.limit, 2);
    assert.equal(result.sources.length, 2);
  });

  test('does not ask the model when no retrieved chunk clears the similarity threshold', async () => {
    let generated = false;
    const handler = createLookupDocsHandler({
      embedQuery: async () => [1, 0],
      retrieve: async () => [match('weak', 0.1)],
      generateText: async () => {
        generated = true;
        return 'Should not run.';
      },
    });
    const result = await handler({ query: 'What is undocumented?' });
    assert.equal(generated, false);
    assert.equal(result.mode, 'no_match');
    assert.deepEqual(result.sources, []);
  });

  test('falls back to retrieved text if generation fails or adds a number absent from the evidence', async () => {
    const retrieve = async () => [match('evidence', 0.9, 'Splitter loss has no application default.')];
    for (const generateText of [
      async () => { throw new Error('model offline'); },
      async () => 'The default is 20 dB.',
    ]) {
      const handler = createLookupDocsHandler({
        embedQuery: async () => [1, 0],
        retrieve,
        generateText,
      });
      const result = await handler({ query: 'What is the default splitter loss?' });
      assert.equal(result.mode, 'extractive_fallback');
      assert.match(result.answer, /Splitter loss has no application default/);
    }
  });
});
