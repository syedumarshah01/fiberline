const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createDocsLookupRuntime } = require('../src/services/docsLookupRuntime');

test('shared docs runtime lazily loads one matching index for both direct and routed lookup', async () => {
  const openCalls = [];
  const searchCalls = [];
  const embedCalls = [];
  const modelCalls = [];
  const runtime = createDocsLookupRuntime({
    env: {
      DOC_INDEX_PATH: './data/test-docs.sqlite',
      DOCS_TOP_K: '3',
      DOCS_MIN_SIMILARITY: '0.2',
    },
    embeddingService: {
      modelId: 'test-embedding-model',
      async embed(query) {
        embedCalls.push(query);
        return [1, 0];
      },
    },
    modelProvider: {
      async generateText(request) {
        modelCalls.push(request);
        return 'Tracing follows documented splice connections.';
      },
    },
    openIndex: async (options) => {
      openCalls.push(options);
      return {
        search(vector, searchOptions) {
          searchCalls.push({ vector, searchOptions });
          return [{
            id: 'trace-doc',
            source: 'backend/README.md',
            section: 'Tracing',
            text: 'Tracing follows documented splice connections.',
            score: 0.91,
          }];
        },
      };
    },
  });

  const result = await runtime.lookupDocs({ query: 'How does tracing work?', top_k: 1 });
  assert.equal(result.answer, 'Tracing follows documented splice connections.');
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].indexPath, path.resolve('./data/test-docs.sqlite'));
  assert.equal(openCalls[0].expectedModelId, 'test-embedding-model');
  assert.deepEqual(embedCalls, ['How does tracing work?']);
  assert.deepEqual(searchCalls, [{ vector: [1, 0], searchOptions: { limit: 1 } }]);
  assert.equal(modelCalls.length, 1);

  await runtime.lookupDocs({ query: 'How does tracing work?' });
  assert.equal(openCalls.length, 1, 'the SQLite index is opened only once per runtime');
});
