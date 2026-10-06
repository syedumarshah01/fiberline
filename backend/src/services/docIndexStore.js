const fs = require('node:fs');
const path = require('node:path');

const INDEX_SCHEMA_VERSION = '1';
let sqlPromise;

async function loadSqlJs() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      let initSqlJs;
      try {
        initSqlJs = require('sql.js');
      } catch (error) {
        const dependencyError = new Error('The local documentation index requires the sql.js package.');
        dependencyError.cause = error;
        throw dependencyError;
      }
      const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
      return initSqlJs({ locateFile: () => wasmPath });
    })();
    sqlPromise.catch(() => { sqlPromise = null; });
  }
  return sqlPromise;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return -1;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function readMetadata(db) {
  const statement = db.prepare('SELECT key, value FROM index_metadata');
  const metadata = {};
  try {
    while (statement.step()) {
      const row = statement.getAsObject();
      metadata[row.key] = row.value;
    }
  } finally {
    statement.free();
  }
  return metadata;
}

function validateEmbedding(vector, expectedDimensions) {
  if (!Array.isArray(vector) || vector.length !== expectedDimensions) {
    throw new Error(`Embedding dimension mismatch: expected ${expectedDimensions}, got ${vector?.length ?? 'none'}`);
  }
  if (!vector.every((value) => Number.isFinite(Number(value)))) {
    throw new Error('Embedding vectors must contain only finite numbers');
  }
}

async function createDocIndex({ outputPath, chunks, embeddings, modelId, sourceHash }) {
  if (!outputPath) throw new TypeError('outputPath is required');
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('No documentation chunks were provided');
  if (!Array.isArray(embeddings) || embeddings.length !== chunks.length) {
    throw new Error('Each documentation chunk must have exactly one embedding');
  }
  if (!modelId) throw new TypeError('modelId is required');

  const dimensions = embeddings[0]?.length;
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('Embedding vectors must not be empty');
  embeddings.forEach((vector) => validateEmbedding(vector, dimensions));

  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  try {
    db.run('PRAGMA journal_mode = DELETE;');
    db.run(`
      CREATE TABLE index_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE doc_chunks (
        id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL,
        section TEXT NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        embedding_json TEXT NOT NULL
      );
      CREATE INDEX doc_chunks_source_idx ON doc_chunks(source);
    `);

    const metadata = {
      schema_version: INDEX_SCHEMA_VERSION,
      embedding_model: modelId,
      embedding_dimensions: String(dimensions),
      chunk_count: String(chunks.length),
      source_hash: sourceHash || '',
      built_at: new Date().toISOString(),
    };
    const insertMetadata = db.prepare('INSERT INTO index_metadata (key, value) VALUES (?, ?)');
    try {
      for (const [key, value] of Object.entries(metadata)) insertMetadata.run([key, value]);
    } finally {
      insertMetadata.free();
    }

    const insertChunk = db.prepare(`
      INSERT INTO doc_chunks (id, source, section, text, token_count, embedding_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (!chunk?.id || !chunk?.source || !chunk?.section || !chunk?.text) {
          throw new Error(`Documentation chunk ${index} is missing id/source/section/text`);
        }
        insertChunk.run([
          chunk.id,
          chunk.source,
          chunk.section,
          chunk.text,
          Number(chunk.token_count) || 0,
          JSON.stringify(embeddings[index]),
        ]);
      }
    } finally {
      insertChunk.free();
    }

    const filePath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, Buffer.from(db.export()));
    fs.renameSync(temporaryPath, filePath);
    return { outputPath: filePath, chunkCount: chunks.length, dimensions, modelId };
  } finally {
    db.close();
  }
}

async function openDocIndex({ indexPath, expectedModelId } = {}) {
  if (!indexPath) throw new TypeError('indexPath is required');
  const filePath = path.resolve(indexPath);
  if (!fs.existsSync(filePath)) {
    const missingIndexError = new Error(`Documentation index not found at ${filePath}; build it with npm run docs:index.`);
    missingIndexError.code = 'DOC_INDEX_MISSING';
    missingIndexError.statusCode = 503;
    throw missingIndexError;
  }

  const SQL = await loadSqlJs();
  const db = new SQL.Database(fs.readFileSync(filePath));
  try {
    const metadata = readMetadata(db);
    if (metadata.schema_version !== INDEX_SCHEMA_VERSION) {
      throw new Error(`Unsupported documentation index schema version: ${metadata.schema_version || 'missing'}`);
    }
    if (expectedModelId && metadata.embedding_model !== expectedModelId) {
      throw new Error(
        `Documentation index uses ${metadata.embedding_model || 'an unknown model'}, but runtime uses ${expectedModelId}. Rebuild with npm run docs:index.`,
      );
    }

    const statement = db.prepare(`
      SELECT id, source, section, text, token_count, embedding_json
      FROM doc_chunks
    `);
    const chunks = [];
    try {
      while (statement.step()) {
        const row = statement.getAsObject();
        let embedding;
        try {
          embedding = JSON.parse(row.embedding_json);
        } catch {
          throw new Error(`Invalid embedding JSON for documentation chunk ${row.id}`);
        }
        chunks.push({
          id: row.id,
          source: row.source,
          section: row.section,
          text: row.text,
          token_count: Number(row.token_count) || 0,
          embedding,
        });
      }
    } finally {
      statement.free();
    }

    const dimensions = Number(metadata.embedding_dimensions);
    if (!chunks.length) throw new Error('Documentation index contains no chunks');
    if (!Number.isInteger(dimensions) || chunks.some((chunk) => chunk.embedding.length !== dimensions)) {
      throw new Error('Documentation index contains inconsistent embedding dimensions');
    }

    // Query work is intentionally brute-force in JS for the expected small
    // index. Release the wasm SQLite database after hydrating vectors to avoid
    // keeping both its pages and decoded embeddings resident in memory.
    db.close();
    let closed = false;
    return Object.freeze({
      metadata: Object.freeze({ ...metadata, embedding_dimensions: dimensions }),
      count: chunks.length,
      search(queryVector, { limit = 3 } = {}) {
        if (closed) throw new Error('Documentation index is closed');
        validateEmbedding(queryVector, dimensions);
        const safeLimit = Math.max(1, Math.min(10, Number.parseInt(limit, 10) || 3));
        return chunks
          .map((chunk, position) => ({
            id: chunk.id,
            source: chunk.source,
            section: chunk.section,
            text: chunk.text,
            token_count: chunk.token_count,
            score: cosineSimilarity(queryVector, chunk.embedding),
            position,
          }))
          .sort((a, b) => b.score - a.score || a.position - b.position)
          .slice(0, safeLimit)
          .map(({ position: _position, ...chunk }) => chunk);
      },
      close() {
        closed = true;
      },
    });
  } catch (error) {
    db.close();
    throw error;
  }
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  cosineSimilarity,
  createDocIndex,
  openDocIndex,
};
