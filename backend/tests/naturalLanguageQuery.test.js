const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCoordinates,
  parseNaturalLanguageQuery,
  parseRadius,
} = require('../src/services/naturalLanguageQuery');

describe('natural-language network query parser', () => {
  test('translates a pole outage question into a pole graph intent', () => {
    assert.deepEqual(parseNaturalLanguageQuery('Which customers are affected if pole 42 goes down?'), {
      intent: 'pole_outage',
      query: 'Which customers are affected if pole 42 goes down?',
      target: { kind: 'pole', text: '42' },
    });
  });

  test('translates a nearby spare-capacity question and preserves its address', () => {
    const result = parseNaturalLanguageQuery('show me every box within 500m of 12 Main Street with spare capacity');
    assert.equal(result.intent, 'nearby_capacity');
    assert.equal(result.radius_m, 500);
    assert.equal(result.require_spare_capacity, true);
    assert.equal(result.location.text, '12 Main Street');
  });

  test('supports kilometre radii and coordinate locations', () => {
    const result = parseNaturalLanguageQuery('boxes within 1.5 km of 34.0151, 71.5249 with available cores');
    assert.equal(result.radius_m, 1500);
    assert.deepEqual(result.location.coordinates, {
      lat: 34.0151,
      lng: 71.5249,
      label: '34.0151, 71.5249',
      source: 'coordinates',
    });
    assert.deepEqual(parseCoordinates('34.0151, 71.5249'), result.location.coordinates);
  });

  test('does not guess when the supported question is missing a location', () => {
    const result = parseNaturalLanguageQuery('show boxes within 500m of this address with spare capacity');
    assert.equal(result.intent, 'nearby_capacity');
    assert.equal(result.location.text, null);
  });

  test('does not turn an unsupported request into a graph operation', () => {
    const result = parseNaturalLanguageQuery('make a new cable from pole 42 to box 7');
    assert.equal(result.intent, 'clarification');
  });

  test('uses the 500m default and clamps unusually large radii', () => {
    assert.equal(parseRadius('boxes near 12 Main Street with spare capacity'), 500);
    assert.equal(parseRadius('boxes within 20 km of 12 Main Street with spare capacity'), 10000);
  });
});
