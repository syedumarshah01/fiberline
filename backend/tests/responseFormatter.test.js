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

  test('formats deterministic serviceability remediation candidates and safety tags', () => {
    assert.equal(
      formatTemplateResponse({
        status: 'ok',
        enclosure_id: 'BOX-7',
        search_limits: { max_hops: 10, max_distance_m: 2000 },
        candidates: [{
          type: 'spare_core', source_enclosure_id: 'BOX-8', core_id: 'CORE-8', core_number: 4,
          hops: 2, distance_m: 350, margin_db: 2.5, severity: 'MARGINAL', requires_review: false,
        }],
      }),
      'BOX-7: best spare-core candidate: spare core #4 at BOX-8 (2 hops, 350 m, 2.5 dB margin · MARGINAL).',
    );
    assert.match(formatTemplateResponse({
      status: 'manual_review_required', enclosure_id: 'BOX-7', tier: 3,
      candidates: [{
        type: 'cascade_splitter', splitter_id: 'SPL-1', port_number: 2, sacrificed_core_id: 'CORE-2',
        new_split_count: 4, insertion_loss_db: 7.2, margin_db: 1.1, severity: 'MARGINAL', requires_review: true,
      }],
    }), /Human review required; cascade candidate: human-review-only/);
    const noPowerFix = formatTemplateResponse({
      status: 'ok', enclosure_id: 'BOX-7', required_margin_db: 3,
      current_path: { total_loss_db: 28, margin_db: 1 }, candidates: [],
      informational_candidates: [{ total_loss_db: 30, severity: 'FAIL', not_an_improvement: true }],
      reason: 'no path meets required margin within search limits',
      olt_optics_review_suggested: true,
    });
    assert.equal(noPowerFix, 'BOX-7: no path meets required margin within search limits. OLT optics review is suggested.');
    assert.doesNotMatch(noPowerFix, /30/);
  });

  test('templates connection plans and outage summaries from structured results', () => {
    assert.equal(
      formatTemplateResponse({
        enclosure: { code: 'BOX-5', distance_m: 100 },
        connection: { type: 'splitter_port', label: 'Connect to an existing splitter port' },
        route: { length_m: 125, is_street_route: true },
        optical_budget: { status: 'OK' },
      }),
      'BOX-5 plan: Connect to an existing splitter port, 125 m customer drop, ok optical budget.',
    );
    assert.equal(
      formatTemplateResponse({
        status: 'ok',
        box: { code: 'BOX-9' },
        failure: { label: 'BOX-9' },
        affected_count: 2,
        affected: { boxes: [{}], cables: [{}, {}, {}] },
        summary: { affected_customers: 2, affected_boxes: 1, affected_cables: 3 },
      }),
      'Failure simulation for BOX-9 affects 2 customers across 1 enclosure and 3 cables.',
    );
  });

  test('reports ambiguous and missing tool targets without inventing details', () => {
    assert.equal(
      formatTemplateResponse({ status: 'ambiguous', candidates: [{ code: 'BOX-1' }, { code: 'BOX-2' }] }),
      'The identifier is ambiguous; matches: BOX-1, BOX-2.',
    );
    assert.equal(
      formatTemplateResponse({ status: 'not_found', candidates: [] }),
      'No matching network asset was found.',
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

  test('does not generate when candidates carry safety or disposition tags', async () => {
    let called = false;
    const tagged = {
      enclosure_id: 'ENC-17',
      issue_count: 1,
      issues: ['No spare cores'],
      candidates: [
        { summary: 'Review a cascade splitter', requires_review: true, severity: 'MARGINAL' },
        { summary: 'Check the optical path', not_an_improvement: true },
      ],
    };
    const response = await formatResponse(tagged, {
      mode: 'generated',
      generateSummary: async () => { called = true; return 'The first fix is approved.'; },
    });
    assert.equal(called, false);
    assert.equal(response, formatTemplateResponse(tagged));
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
