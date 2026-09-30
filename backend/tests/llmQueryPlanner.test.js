const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { requestPlan, requestGeminiPlan, normalizePlan } = require('../src/services/llmQueryPlanner');

describe('LLM network-query planner', () => {
  test('normalizes a strict pole plan from an OpenAI-compatible response', async () => {
    let request;
    const plan = await requestPlan('which customers are affected if pole 42 goes down?', {
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://llm.test/v1',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            intent: 'pole_outage',
            message: '',
            pole_identifier: '42',
            location_text: null,
            latitude: null,
            longitude: null,
            radius_m: null,
          }) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    assert.equal(request.url, 'https://llm.test/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(request.options.body).model, 'test-model');
    assert.deepEqual(plan.target, { kind: 'pole', text: '42' });
    assert.equal(plan.intent, 'pole_outage');
  });

  test('calls Gemini native generateContent with the API key header and JSON schema', async () => {
    let request;
    const plan = await requestGeminiPlan('boxes within 500m of 12 Main Street with spare capacity', {
      apiKey: 'gemini-test-key',
      model: 'gemini-2.5-flash-lite',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            intent: 'nearby_capacity',
            message: '',
            pole_identifier: null,
            location_text: '12 Main Street',
            latitude: null,
            longitude: null,
            radius_m: 500,
          }) }] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    assert.equal(request.options.headers['x-goog-api-key'], 'gemini-test-key');
    assert.equal(JSON.parse(request.options.body).generationConfig.responseMimeType, 'application/json');
    assert.equal(plan.intent, 'nearby_capacity');
    assert.equal(plan.location.text, '12 Main Street');
  });

  test('normalizes a nearby-capacity plan and converts missing radius to the safe default', () => {
    const plan = normalizePlan({
      intent: 'nearby_capacity',
      message: '',
      pole_identifier: null,
      location_text: '12 Main Street',
      latitude: null,
      longitude: null,
      radius_m: null,
    });
    assert.equal(plan.radius_m, 500);
    assert.equal(plan.location.text, '12 Main Street');
    assert.equal(plan.require_spare_capacity, true);
  });

  test('turns an incomplete LLM plan into a clarification instead of guessing', () => {
    const plan = normalizePlan({
      intent: 'nearby_capacity',
      message: '',
      pole_identifier: null,
      location_text: null,
      latitude: null,
      longitude: null,
      radius_m: 500,
    });
    assert.equal(plan.intent, 'clarification');
    assert.match(plan.message, /address|coordinates/i);
  });
});
