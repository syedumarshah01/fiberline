#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'ai', 'tools.json');
const REVIEW_PATH = path.join(REPO_ROOT, 'ai', 'schema-review.json');

function fail(message) {
  console.error(`Schema review gate: ${message}`);
  process.exitCode = 1;
}

try {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const review = JSON.parse(fs.readFileSync(REVIEW_PATH, 'utf8'));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(SCHEMA_PATH)).digest('hex');

  if (review.status !== 'approved') {
    fail('the tool catalog has not been explicitly approved.');
  } else if (review.schema !== 'tools.json' || review.schema_version !== schema.version) {
    fail('the approval record does not match the current catalog file/version.');
  } else if (review.sha256 !== digest) {
    fail('tools.json changed after review; obtain approval for the new schema hash.');
  } else {
    console.log(`Schema review approved: ai/tools.json sha256=${digest}`);
  }
} catch (error) {
  fail(error.message || 'approval record or tool catalog could not be read.');
}
