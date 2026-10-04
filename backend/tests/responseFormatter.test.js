const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_GENERATION_TOKENS,
  formatResponse,
  formatTemplateResponse,
  hasMultipleRemediationCandidates,
  isGeneratedResponseSafe,
} = require('../src/services/responseFormatter');

const remediationResult = {
  enclosure_id: 'ENC-17',
  issue_count: 2,
  issues: ['No spare cores', 'Cable slack is exposed'],
  candidates: [
    { summary: 'Move the drop to a spare distribution core' },
    { summary: 'Install a small splitter at ENC-18' },
  ],
};

describe('formatTemplateResponse', () => {
  test('templates enclosure findings and the best fix without a model', () => {
    const result = {
      enclosure_id: 'ENC-17',
      issue_count: 1,
      issues: ['A damaged drop cable'],
      candidates: [{ summary: 'Replace the damaged drop cable' }],
    };

    assert.equal(
      formatTemplateResponse(result),
      'ENC-17 has 1 issue: A damaged drop cable. Best fix: Replace the damaged drop cable.',
    );
  });

  test('uses plural grammar and keeps ranked alternatives in the template fallback', () => {
    assert.equal(
      formatTemplateResponse(remediationResult),
      'ENC-17 has 2 issues: No spare cores, Cable slack is exposed. Best fix: Move the drop to a spare distribution core. Alternatives: Install a small splitter at ENC-18.',
    );
  });

  test('handles zero issues and missing issue counts without dangling punctuation', () => {
    assert.equal(
      formatTemplateResponse({ enclosure_code: 'CAB-4', issue_count: 0, issues: [], candidates: [] }),
      'CAB-4 has 0 issues.',
    );
    assert.equal(
      formatTemplateResponse({ enclosure_code: 'CAB-4', issue_count: null, issues: ['Loose connector'] }),
      'CAB-4 has 1 issue: Loose connector.',
    );
  });

  test('templates explicitly tagged remediation results even without enclosure issue fields', () => {
    assert.equal(
      formatTemplateResponse({
        kind: 'remediation_explanation',
        candidates: [{ summary: 'Re-splice the damaged fiber' }, { summary: 'Replace the cable' }],
      }),
      'Best fix: Re-splice the damaged fiber. Alternatives: Replace the cable.',
    );
  });

  test('templates nearest-source and customer-lookup tool results from this backend', () => {
    assert.equal(
      formatTemplateResponse({
        found: true,
        source_enclosure_id: 'BOX-5',
        available_cores: 1,
        hops: 2,
        path: [],
      }),
      'The nearest source is BOX-5, with 1 available core, 2 hops away.',
    );
    assert.equal(
      formatTemplateResponse({
        query: { radius_m: 500 },
        nearby_boxes: [],
        recommended_box: null,
        suggested_source: null,
      }),
      'No enclosures were found within 500 m.',
    );
  });

  test('templates fiber trace output without changing the trace data', () => {
    assert.equal(
      formatTemplateResponse([
        { core_id: 'core-a', cable_code: 'CBL-1', core_number: 1 },
        { splice_id: 'splice-1' },
        { core_id: 'core-b', cable_code: 'CBL-2', core_number: 3 },
      ]),
      'The trace covers 2 core segments from CBL-1 core 1 to CBL-2 core 3 across 1 splice.',
    );
  });

  test('has a safe generic fallback for empty or unsupported results', () => {
    assert.equal(formatTemplateResponse(null), 'No result was returned.');
    assert.equal(formatTemplateResponse([]), 'No results were found.');
    assert.equal(
      formatTemplateResponse({ opaque: true }),
      'The operation completed, but no response template is available for this result.',
    );
  });
});

describe('formatResponse optional generation pass', () => {
  test('defaults to templates and never calls a supplied generator', async () => {
    let called = false;
    const response = await formatResponse(remediationResult, {
      generateSummary: async () => {
        called = true;
        return 'This should not run.';
      },
    });

    assert.equal(called, false);
    assert.equal(response, formatTemplateResponse(remediationResult));
  });

  test('calls the generator only for multi-candidate remediation and caps output at 50 tokens', async () => {
    let request;
    const generated = 'ENC-17 has 2 reported issues; moving the drop is the best fix, with installing a splitter as an alternative.';
    const response = await formatResponse(remediationResult, {
      mode: 'generated',
      generateSummary: async (payload) => {
        request = payload;
        return generated;
      },
    });

    assert.equal(response, generated);
    assert.equal(request.maxTokens, MAX_GENERATION_TOKENS);
    assert.equal(request.maxTokens, 50);
    assert.equal(request.resultJson, JSON.stringify(remediationResult));
    assert.match(request.systemPrompt, /database/i);
    assert.match(request.systemPrompt, /first candidate is already best/i);
    assert.equal(hasMultipleRemediationCandidates(remediationResult), true);
  });

  test('does not invoke generation for a simple one-candidate result', async () => {
    let called = false;
    const simpleResult = {
      enclosure_id: 'ENC-17',
      issue_count: 1,
      issues: ['No spare cores'],
      candidates: [{ summary: 'Use the upstream spare core' }],
    };
    const response = await formatResponse(simpleResult, {
      mode: 'generated',
      generateSummary: async () => {
        called = true;
        return 'Model output.';
      },
    });

    assert.equal(called, false);
    assert.equal(response, formatTemplateResponse(simpleResult));
    assert.equal(hasMultipleRemediationCandidates(simpleResult), false);
  });

  test('falls back if generated text adds a numeric claim', async () => {
    const response = await formatResponse(remediationResult, {
      mode: 'generated',
      generateSummary: async () => 'ENC-17 has 2 issues and the repair will take 30 minutes.',
    });

    assert.equal(response, formatTemplateResponse(remediationResult));
  });

  test('falls back if generated text is multi-sentence, malformed, or the generator fails', async () => {
    for (const generateSummary of [
      async () => 'The best fix is the first option. The alternative is the second option.',
      async () => 'This is not a sentence\nAnd this is another line.',
      async () => { throw new Error('model unavailable'); },
    ]) {
      assert.equal(
        await formatResponse(remediationResult, { mode: 'generated', generateSummary }),
        formatTemplateResponse(remediationResult),
      );
    }
  });
});

describe('isGeneratedResponseSafe', () => {
  test('allows input numbers even when formatted differently', () => {
    assert.equal(
      isGeneratedResponseSafe('ENC-017 has 2 issues and a 0.500 success rate.', '{"id":"ENC-17","issue_count":2,"rate":0.5}'),
      true,
    );
  });

  test('rejects a numeric value that is absent from the structured input', () => {
    assert.equal(
      isGeneratedResponseSafe('ENC-17 needs 30 minutes.', JSON.stringify(remediationResult)),
      false,
    );
  });
});
