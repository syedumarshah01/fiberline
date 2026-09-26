/**
 * Unit tests for the serviceability verdict (pure — no database, no OSRM).
 *
 * The answer has to hold up in the room where it is used: a CSR on the phone
 * with a customer, and a technician standing at the gate. So the tests are about
 * the decisions, not the plumbing — which box is chosen when the nearest one is
 * full, what is promised when the nearest box is 300 m away, and what the sheet
 * says afterwards.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  assessServiceability,
  connectionNeeds,
  rankBoxes,
  serviceabilityText,
  STRAIGHT_LINE_FACTOR,
} = require('../src/utils/serviceability');
const { resolveCostModel, DEFAULT_MAX_DROP_M, DEFAULT_MAX_EXTENSION_M } = require('../src/utils/dropCost');

const POINT = { lat: 33.6, lng: 73.05 };

/** A box as services/serviceability.js loads it. */
const box = (overrides = {}) => ({
  id: 'nap12',
  code: 'NAP-12',
  name: null,
  type: 'nap',
  lat: 33.6005,
  lng: 73.0505,
  distance_m: 40,
  free_ports: 0,
  free_port_numbers: [],
  splitter_count: 1,
  ports_total: 8,
  available_cores: 0,
  ...overrides,
});

const model = resolveCostModel({});
const assess = (candidates, extras = {}) =>
  assessServiceability({ point: POINT, candidates, settings: {}, extras });

describe('connectionNeeds — what the box has to do', () => {
  test('a free port is the cheap path', () => {
    const needs = connectionNeeds(box({ free_ports: 2, free_port_numbers: [3, 5] }));
    assert.equal(needs.needs, 'port');
    assert.match(needs.detail, /2 free splitter ports/);
  });

  test('every port taken means a splitter has to be installed', () => {
    const needs = connectionNeeds(box({ splitter_count: 1, ports_total: 8 }));
    assert.equal(needs.needs, 'splitter');
    assert.match(needs.detail, /every port .* is assigned/);
  });

  test('spare fibre but no splitter at all is still splitter work', () => {
    const needs = connectionNeeds(box({ splitter_count: 0, ports_total: 0, available_cores: 6 }));
    assert.equal(needs.needs, 'splitter');
    assert.match(needs.detail, /6 spare fibres but no splitter/);
  });

  test('nothing free at all is capacity work, not a drop', () => {
    const needs = connectionNeeds(box({ splitter_count: 0, ports_total: 0, available_cores: 0 }));
    assert.equal(needs.needs, 'capacity');
    assert.match(needs.detail, /no free port and no spare fibre/);
  });
});

describe('rankBoxes — nearest is not always the one to serve from', () => {
  test('the nearest box wins when it has room', () => {
    const ranked = rankBoxes([box({ id: 'near', distance_m: 30, free_ports: 1 }), box({ id: 'far', distance_m: 120, free_ports: 4 })], model);
    assert.equal(ranked.nearest.id, 'near');
    assert.equal(ranked.recommended.id, 'near');
  });

  test('a full box next door loses to a box with room 60 m further on', () => {
    const ranked = rankBoxes([box({ id: 'near', distance_m: 30 }), box({ id: 'far', distance_m: 90, free_ports: 2 })], model);
    assert.equal(ranked.nearest.id, 'near', 'the nearest box is still the nearest box');
    assert.equal(ranked.recommended.id, 'far', 'but the connection is built from the one with room');
    assert.equal(ranked.alternatives.some((b) => b.id === 'near'), true, 'and the near one is offered as an alternative');
  });

  test('a free port beats a splitter install even if it is further away', () => {
    const ranked = rankBoxes(
      [box({ id: 'a', distance_m: 40, splitter_count: 1, available_cores: 4 }), box({ id: 'b', distance_m: 90, free_ports: 1 })],
      model,
    );
    assert.equal(ranked.recommended.id, 'b', 'a port is a cheaper job than a splitter');
  });

  test('a box beyond drop range is not recommended when one within range can serve', () => {
    const ranked = rankBoxes(
      [box({ id: 'near', distance_m: 60, free_ports: 1 }), box({ id: 'far', distance_m: DEFAULT_MAX_DROP_M + 80, free_ports: 8 })],
      model,
    );
    assert.equal(ranked.recommended.id, 'near');
  });
});

describe('assessServiceability — the verdict', () => {
  test('a free port close by is a straight "can serve"', () => {
    const result = assess([box({ free_ports: 3, free_port_numbers: [1, 2, 3] })], {
      headend_configured: true,
    });
    assert.equal(result.verdict, 'serviceable');
    assert.equal(result.serviceable, true);
    assert.equal(result.serviceable_now, true);
    assert.equal(result.connection.needs, 'port');
    assert.equal(result.recommended_box.code, 'NAP-12');
    assert.equal(result.quote.total > 0, true);
    assert.deepEqual(result.next_steps[0].includes('Assign a free splitter port'), true);
  });

  test('a full splitter is still serviceable — with work, and priced as such', () => {
    const result = assess([box({ splitter_count: 1, ports_total: 8 })]);
    assert.equal(result.verdict, 'serviceable_with_work');
    assert.equal(result.serviceable, true);
    assert.equal(result.serviceable_now, false);
    assert.equal(result.requires_work, true);
    assert.ok(result.quote.lines.some((line) => line.item === 'splitter'));
  });

  test('the nearest box being full does not change the verdict — the answer names both boxes', () => {
    const result = assess([box({ id: 'near', code: 'NAP-12', distance_m: 35 }), box({ id: 'far', code: 'NAP-14', distance_m: 70, free_ports: 2 })]);
    assert.equal(result.verdict, 'serviceable');
    assert.equal(result.nearest_box.code, 'NAP-12');
    assert.equal(result.recommended_box.code, 'NAP-14');
    assert.equal(result.summary.includes('NAP-14'), true);
  });

  test('no box within drop range but one within build range is a build, and priced as one', () => {
    const result = assess([box({ distance_m: DEFAULT_MAX_DROP_M + 120, free_ports: 2 })]);
    assert.equal(result.verdict, 'build_required');
    assert.equal(result.serviceable, false);
    assert.equal(result.requires_build, true);
    assert.equal(result.survey_required, true);
    // The extension is priced on the *run*: 270 m of straight line, scaled by the
    // planning factor, because that is the cable somebody has to buy.
    assert.equal(result.extension.length_m, Math.round((DEFAULT_MAX_DROP_M + 120) * STRAIGHT_LINE_FACTOR));
    assert.equal(result.extension.from_box_code, 'NAP-12', 'and it starts at the nearest box');
    assert.ok(result.quote.lines.some((line) => line.item === 'extension build'));
    assert.ok(result.warnings.some((w) => /indicative extension build, not a drop quote/.test(w)));
  });

  test('past the build limit the answer is no, and says why', () => {
    const result = assess([box({ distance_m: DEFAULT_MAX_EXTENSION_M + 500 })]);
    assert.equal(result.verdict, 'out_of_reach');
    assert.equal(result.serviceable, false);
    assert.equal(result.quote, null, 'no price is quoted for work nobody has designed');
    assert.ok(result.warnings.some((w) => /refer it to network planning/.test(w)));
  });

  test('nothing nearby at all is reported as such, not as a refusal', () => {
    const result = assess([]);
    assert.equal(result.verdict, 'no_network');
    assert.equal(result.recommended_box, null);
    assert.equal(result.nearest_box, null);
  });

  test('a full box with no alternative in range is serviceable with capacity work', () => {
    const empty = box({ splitter_count: 0, ports_total: 0, available_cores: 0 });
    const result = assess([empty], { suggested_source: { found: true, source_enclosure_id: 'CAB-01', available_cores: 8, hops: 2 } });
    assert.equal(result.verdict, 'serviceable_with_work');
    assert.equal(result.connection.needs, 'capacity');
    assert.equal(result.quote.survey_required, true);
    assert.ok(result.next_steps.some((step) => step.includes('CAB-01')), 'the box to bring capacity from is named');
  });
});

describe('assessServiceability — the run and the price', () => {
  test('a street route is used as measured, and no factor is added', () => {
    const result = assessServiceability({
      point: POINT,
      candidates: [box({ free_ports: 1, distance_m: 40 })],
      settings: {},
      route: { length_m: 58, coordinates: [[73.05, 33.6], [73.0505, 33.6005]], source: 'street_route' },
    });
    assert.equal(result.drop.length_m, 58);
    assert.equal(result.drop.source, 'street_route');
    assert.equal(result.distance.run_source, 'street_route');
    assert.equal(result.quote.drop_length_m, 58);
    assert.equal(result.warnings.some((w) => /straight-line/.test(w)), false);
  });

  test('without a route the straight line is scaled and flagged as an estimate', () => {
    const result = assess([box({ free_ports: 1, distance_m: 40 })]);
    assert.equal(result.drop.length_m, Math.round(40 * STRAIGHT_LINE_FACTOR));
    assert.equal(result.drop.source, 'straight_line');
    assert.ok(result.warnings.some((w) => /straight-line distance/.test(w)));
    assert.ok(result.confidence !== 'high', 'an estimated length cannot be a high-confidence quote');
  });

  test('the price follows the box that will serve, not the nearest one', () => {
    const result = assessServiceability({
      point: POINT,
      candidates: [box({ id: 'near', distance_m: 30 }), box({ id: 'far', distance_m: 90, free_ports: 2 })],
      settings: {},
      route: { length_m: 95, source: 'street_route' },
    });
    assert.equal(result.quote.drop_length_m, 95, 'the run is to the serving box');
    assert.equal(result.recommended_box.id, 'far');
  });

  test('the project\'s own rates reach the quote', () => {
    const result = assessServiceability({
      point: POINT,
      candidates: [box({ free_ports: 1, distance_m: 40 })],
      settings: { currency: 'usd', drop_cable_cost_per_m: 2, labour_cost_per_drop: 80, splice_cost: 10, slack_pct: 0 },
      route: { length_m: 50, source: 'street_route' },
    });
    assert.equal(result.quote.currency, 'USD');
    assert.equal(result.quote.total, 50 * 2 + 80 + 10);
    assert.equal(result.quote.cable_length_m, 50);
  });

  test('the missing headend is on the answer, because a spare fibre is not a lit fibre', () => {
    const withoutRoot = assess([box({ free_ports: 1 })], { headend_configured: false });
    assert.ok(withoutRoot.warnings.some((w) => /no headend .* is configured/.test(w)));
    const withRoot = assess([box({ free_ports: 1 })], { headend_configured: true });
    assert.equal(withRoot.warnings.some((w) => /no headend/.test(w)), false);
  });
});

describe('serviceabilityText — the sheet a CSR reads out loud', () => {
  const result = () =>
    assessServiceability({
      point: POINT,
      candidates: [box({ free_ports: 2, free_port_numbers: [3, 5], distance_m: 40 })],
      settings: {},
      route: { length_m: 62, source: 'street_route' },
      extras: { headend_configured: true },
    });

  test('it carries the verdict, both boxes, the run, the price and the steps', () => {
    const text = serviceabilityText({ ...result(), query: { input: 'House 12-B, Street 4' } });
    assert.match(text, /SERVICEABILITY — House 12-B, Street 4/);
    assert.match(text, /Verdict:\s+Can serve/);
    assert.match(text, /Nearest box:\s+NAP-12/);
    assert.match(text, /Run:\s+62 m along the street/);
    assert.match(text, /Price:\s+PKR /);
    assert.match(text, /Next steps/);
    assert.match(text, /Confidence: high/);
  });

  test('every line fits the printable width', () => {
    const text = serviceabilityText({ ...result(), query: { input: 'House 12-B, Street 4, Phase 2, Islamabad' } });
    for (const line of text.split('\n')) {
      assert.ok(line.length <= 78, `too long (${line.length}): ${line}`);
    }
  });

  test('a refusal reads as a refusal, with no price in it', () => {
    const refusal = assess([box({ distance_m: DEFAULT_MAX_EXTENSION_M + 900 })]);
    const text = serviceabilityText(refusal);
    assert.match(text, /Cannot serve/);
    assert.match(text, /Price:\s+no quote/);
  });

  test('an empty result is an empty string, not a crash', () => {
    assert.equal(serviceabilityText(null), '');
  });
});

describe('a box outside the search radius is still reported as the nearest one', () => {
  test('nothing within the radius says how far the nearest box on the map is', () => {
    // "No box found" and "the nearest box is 1.2 km away" are different answers,
    // and only one of them can be acted on.
    const faraway = box({ code: 'NAP-FAR', distance_m: 1200, free_ports: 1, outside_search_radius: true });
    const result = assessServiceability({
      point: POINT,
      candidates: [faraway],
      settings: {},
      extras: { radius_m: 500 },
    });
    assert.equal(result.verdict, 'out_of_reach');
    assert.equal(result.nearest_box.code, 'NAP-FAR');
    assert.equal(result.nearest_box.outside_search_radius, true);
    assert.ok(result.warnings.some((w) => /no box is within the 500 m search radius/.test(w)));
    assert.equal(result.summary.includes('1200 m'), true);
  });
});
