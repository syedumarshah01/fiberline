/**
 * Tests for the serviceability panel's view helpers.
 *
 * The cases worth testing are the ones a CSR will actually meet: a box next door
 * that is full, a build instead of a drop, a refusal, and a price that has to be
 * readable in a currency the app has never seen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  verdictView,
  formatMoney,
  formatBand,
  formatDistance,
  boxSummary,
  runLine,
  serviceabilityFacts,
  highlightBoxId,
  headline,
  quoteClipboardText,
} from './serviceabilityView.js';

const box = (overrides = {}) => ({
  id: 'nap12',
  code: 'NAP-12',
  distance_m: 40,
  free_ports: 0,
  free_port_numbers: [],
  available_cores: 0,
  needs: 'capacity',
  ...overrides,
});

const result = (overrides = {}) => ({
  verdict: 'serviceable',
  nearest_box: box({ code: 'NAP-12', distance_m: 40, needs: 'capacity' }),
  recommended_box: box({ id: 'nap14', code: 'NAP-14', distance_m: 70, free_ports: 2, free_port_numbers: [3, 5], needs: 'port' }),
  connection: { needs: 'port', label: 'Free splitter port available', detail: 'NAP-14 has 2 free splitter ports (3, 5)' },
  drop: { length_m: 62, cable_length_m: 69, source: 'street_route' },
  quote: { currency: 'PKR', total: 5905, band: { low: 5480, typical: 5905, high: 6330 }, survey_required: false },
  confidence: 'high',
  confidence_reason: 'street route measured and a free port confirmed',
  next_steps: ['Assign a free splitter port in NAP-14 (port 3).'],
  warnings: [],
  extension: null,
  ...overrides,
});

test('verdictView maps every backend verdict, and unknown ones ask for a check', () => {
  assert.equal(verdictView('serviceable').tone, 'ok');
  assert.equal(verdictView('serviceable_with_work').tone, 'warn');
  assert.equal(verdictView('build_required').short, 'Build');
  assert.equal(verdictView('out_of_reach').tone, 'bad');
  assert.equal(verdictView('no_network').label, 'No network nearby');
  assert.equal(verdictView('something-new').label, 'Check required');
});

test('money is grouped, whole, and carries whatever currency the project set', () => {
  assert.equal(formatMoney(6400, 'PKR'), 'PKR 6,400');
  assert.equal(formatMoney(6400.4, 'USD'), 'USD 6,400');
  assert.equal(formatMoney(null), '—');
  assert.equal(formatMoney(1234567, 'PKR'), 'PKR 1,234,567');
});

test('a band with no width is a single figure, not a range', () => {
  assert.equal(formatBand({ low: 5900, high: 7100 }, 'PKR'), 'PKR 5,900 – PKR 7,100');
  assert.equal(formatBand({ low: 6400, high: 6400, typical: 6400 }, 'PKR'), 'PKR 6,400');
  assert.equal(formatBand(null), null);
});

test('distances switch to kilometres when metres stop being readable', () => {
  assert.equal(formatDistance(62), '62 m');
  assert.equal(formatDistance(1200), '1.2 km');
  assert.equal(formatDistance(12000), '12 km');
  assert.equal(formatDistance(null), '—');
});

test('when the serving box is not the nearest one, the panel says why', () => {
  const summary = boxSummary(result());
  assert.equal(summary.sameBox, false);
  assert.match(summary.title, /Serve from NAP-14 — 70 m/);
  assert.match(summary.detail, /NAP-12 is closer \(40 m\) but it has no free port and no spare fibre/);
  assert.match(summary.detail, /2 free splitter ports \(3, 5\)/);
});

test('when the nearest box can serve, the panel keeps it short', () => {
  const both = box({ id: 'nap14', code: 'NAP-14', distance_m: 40, free_ports: 1, free_port_numbers: [3], needs: 'port' });
  const summary = boxSummary(result({ nearest_box: both, recommended_box: both }));
  assert.equal(summary.sameBox, true);
  assert.match(summary.title, /Serve from NAP-14 — 40 m/);
  assert.match(summary.detail, /1 free splitter port \(3\)/, 'singular reads as singular');
});

test('a refusal names the box it is refusing about', () => {
  const summary = boxSummary(result({ recommended_box: null, nearest_box: box({ distance_m: 3200 }) }));
  assert.equal(summary.serving, null);
  assert.match(summary.title, /Nearest box NAP-12 — 3.2 km/);
});

test('the run says whether it was measured or estimated', () => {
  assert.match(runLine(result()), /62 m along the street/);
  assert.match(runLine(result()), /69 m of cable with slack/);
  assert.match(runLine(result({ drop: { length_m: 62, cable_length_m: 62, source: 'straight_line' } })), /straight-line estimate/);
  assert.equal(runLine(result({ drop: null })), null);
});

test('the facts list carries the price, the work at the box and the confidence', () => {
  const facts = serviceabilityFacts(result());
  const labels = facts.map((f) => f.label);
  assert.deepEqual(labels, ['Serving box', 'Run', 'At the box', 'Estimated cost', 'Confidence']);
  const price = facts.find((f) => f.label === 'Estimated cost');
  assert.equal(price.value, 'PKR 5,480 – PKR 6,330');
  assert.match(price.detail, /labour, cable and the splice/);
});

test('an estimated run is flagged in the facts, not just in a warning', () => {
  const facts = serviceabilityFacts(result({ drop: { length_m: 62, source: 'straight_line' } }));
  const run = facts.find((f) => f.label === 'Run');
  assert.match(run.detail, /measure before cutting/);
});

test('a build is listed as an extension, and the price is called indicative', () => {
  const build = result({
    verdict: 'build_required',
    extension: { length_m: 338, from_box_code: 'NAP-12' },
    quote: { currency: 'PKR', total: 90000, band: { low: 88000, typical: 90000, high: 92000 }, survey_required: true },
  });
  const facts = serviceabilityFacts(build);
  const extension = facts.find((f) => f.label === 'Extension');
  assert.match(extension.value, /338 m of new build/);
  const price = facts.find((f) => f.label === 'Estimated cost');
  assert.match(price.detail, /indicative only/);
});

test('the map is pointed at the box that would serve, not the nearest one', () => {
  assert.equal(highlightBoxId(result()), 'nap14');
  assert.equal(highlightBoxId(result({ recommended_box: null })), 'nap12');
  assert.equal(highlightBoxId(null), null);
});

test('the headline is one sentence, and never promises what was refused', () => {
  assert.match(headline(result()), /Can serve — NAP-14, PKR 5,480 – PKR 6,330\./);
  assert.match(headline(result({ verdict: 'out_of_reach', recommended_box: null })), /Cannot serve — nearest box NAP-12 is 40 m away\./);
  assert.match(headline(result({ verdict: 'no_network' })), /No box found/);
  assert.equal(headline(null), '');
});

test('the clipboard text is plain, ordered, and explains the price', () => {
  const text = quoteClipboardText(result());
  assert.match(text, /Can serve — NAP-14/);
  assert.match(text, /Serving box: Serve from NAP-14/);
  assert.match(text, /Estimated cost: PKR 5,480 – PKR 6,330/);
  assert.match(text, /Next steps:\n1\. Assign a free splitter port/);
  assert.equal(text.includes('<'), false, 'no markup, so it pastes anywhere');
});

test('the clipboard text carries the warnings a CSR must not promise through', () => {
  const text = quoteClipboardText(result({ warnings: ['no headend (network root) is configured'] }));
  assert.match(text, /Notes:\n- no headend/);
});
