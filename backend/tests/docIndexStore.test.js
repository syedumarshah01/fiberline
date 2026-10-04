const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  cosineSimilarity,
  createDocIndex,
  openDocIndex,
} = require('../src/services/docIndexStore');

const fixtureChunks = [
  { id: 'positive', source: 'README.md', section: 'Capacity', text: 'Positive match', token_count: 10 },
  { id: 'nearby', source: 'backend/README.md', section: 'Trace', text: 'Related match', token_count: 9 },
  { id: 'opposite', source: 'guide.md', section: 'Other', text: 'Opposite match', token_count: 8 },
];

describe('cosineSimilarity', () => {
  test('computes cosine similarity and handles invalid or zero vectors safely', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
    assert.equal(cosineSimilarity([1], [1, 0]), -1);
  });
});

describe('SQLite documentation index', () => {
  test('builds a SQLite file, persists metadata, and ranks by brute-force cosine', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberline-doc-index-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const indexPath = path.join(directory, 'docs.sqlite');
    const embeddings = [[1, 0, 0], [0.8, 0.6, 0], [-1, 0, 0]];

    const built = await createDocIndex({
      outputPath: indexPath,
      chunks: fixtureChunks,
      embeddings,
      modelId: 'test-embedder',
      sourceHash: 'docs-hash',
    });
    assert.equal(built.chunkCount, 3);
    assert.ok(fs.statSync(indexPath).size > 0);

    const index = await openDocIndex({ indexPath, expectedModelId: 'test-embedder' });
    t.after(() => index.close());
    assert.equal(index.count, 3);
    assert.equal(index.metadata.source_hash, 'docs-hash');
    assert.equal(index.metadata.embedding_dimensions, 3);
    assert.deepEqual(index.search([1, 0, 0], { limit: 2 }).map((match) => match.id), ['positive', 'nearby']);
  });

  test('rejects an index built with a different embedding model', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberline-doc-index-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const indexPath = path.join(directory, 'docs.sqlite');
    await createDocIndex({
      outputPath: indexPath,
      chunks: [fixtureChunks[0]],
      embeddings: [[1, 0]],
      modelId: 'old-model',
    });
    await assert.rejects(openDocIndex({ indexPath, expectedModelId: 'new-model' }), /uses old-model/);
  });

  test('reports a missing index as a 503 build/setup error', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberline-doc-index-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await assert.rejects(openDocIndex({ indexPath: path.join(directory, 'missing.sqlite') }), (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, 'DOC_INDEX_MISSING');
      return true;
    });
  });
});
