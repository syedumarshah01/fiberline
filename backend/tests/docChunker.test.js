const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TARGET_TOKENS,
  approximateTokenCount,
  extractSections,
  chunkMarkdownDocument,
} = require('../src/services/docChunker');

describe('Phase 5 chunk settings', () => {
  test('defaults to section chunks in the requested 200–400 token range', () => {
    assert.equal(DEFAULT_TARGET_TOKENS, 300);
    assert.equal(DEFAULT_MAX_TOKENS, 400);
  });
});

describe('extractSections', () => {
  test('retains nested heading paths and ignores heading-looking code samples', () => {
    const sections = extractSections('# Fiberline\nintro\n\n## Tracing\ntrace text\n\n```md\n## example only\n```\n\n### Branches\nbranch text', 'guide.md');
    assert.deepEqual(sections.map((section) => section.section), [
      'Fiberline',
      'Fiberline › Tracing',
      'Fiberline › Tracing › Branches',
    ]);
    assert.match(sections[1].body, /## example only/);
    assert.match(sections[1].body, /trace text/);
  });
});

describe('chunkMarkdownDocument', () => {
  test('groups adjacent short sections and preserves their headings', async () => {
    const chunks = await chunkMarkdownDocument({
      source: 'guide.md',
      markdown: '## Setup\n\nInstall the API.\n\n## Trace\n\nFollow a core through recorded splices.',
      tokenCount: approximateTokenCount,
      maxTokens: 24,
      targetTokens: 12,
    });

    assert.equal(chunks.length, 1);
    assert.match(chunks[0].text, /## Setup/);
    assert.match(chunks[0].text, /## Guide › Trace|## Trace/);
    assert.ok(chunks[0].token_count <= 24);
    assert.equal(chunks[0].source, 'guide.md');
    assert.ok(chunks[0].id.length > 0);
  });

  test('splits oversized sections at sentence/word boundaries and respects the hard ceiling', async () => {
    const markdown = [
      '## Long section',
      '',
      'A sentence describing splice traversal and cable direction. Another sentence describes reachable branches and order.',
      '',
      'The final paragraph documents the safety cap and query response shape.',
    ].join('\n');
    const chunks = await chunkMarkdownDocument({
      source: 'guide.md',
      markdown,
      tokenCount: approximateTokenCount,
      maxTokens: 13,
      targetTokens: 10,
    });

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.token_count <= 13));
    assert.ok(chunks.every((chunk) => chunk.text.includes('Long section')));
  });

  test('compacts an undersized fragment into adjacent section text within the hard ceiling', async () => {
    const first = `${'word '.repeat(15)}first.`;
    const second = `${'word '.repeat(7)}second.`;
    const third = `${'word '.repeat(30)}third.`;
    const chunks = await chunkMarkdownDocument({
      source: 'guide.md',
      markdown: `# Guide\n\n## Long section\n\n${first} ${second} ${third}`,
      tokenCount: approximateTokenCount,
      maxTokens: 50,
      targetTokens: 20,
    });

    assert.equal(chunks.length, 2, 'the short middle fragment is folded into a neighbor');
    assert.ok(chunks.every((chunk) => chunk.token_count <= 50));
    assert.ok(chunks.some((chunk) => chunk.text.includes('second.')));
  });

  test('is deterministic for the same source and content', async () => {
    const options = { source: 'stable.md', markdown: '## A\n\nOne two three.\n\n## B\n\nFour five six.' };
    const first = await chunkMarkdownDocument(options);
    const second = await chunkMarkdownDocument(options);
    assert.deepEqual(first, second);
  });

  test('rejects a pathological single unbroken token instead of producing a truncated chunk', async () => {
    await assert.rejects(
      chunkMarkdownDocument({
        markdown: `## Huge\n\n${'x'.repeat(100)}`,
        tokenCount: (text) => text.includes('x'.repeat(100)) ? 50 : approximateTokenCount(text),
        maxTokens: 10,
        targetTokens: 8,
      }),
      /single unbroken text token/i,
    );
  });
});
