/**
 * Unit tests for the cable label helpers.
 * Run with: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as geoLabels from './geoLabels.js';
import { cableLabel, routeMidpointLngLat, CABLE_LABEL_MIN_ZOOM } from './geoLabels.js';

describe('cableLabel', () => {
  it('returns the code when there is no name', () => {
    assert.equal(cableLabel({ code: 'CBL-0007' }), 'CBL-0007');
  });

  it('joins code and name when both exist and differ', () => {
    assert.equal(cableLabel({ code: 'CBL-0007', name: 'University Rd' }), 'CBL-0007 · University Rd');
  });

  it('falls back to the name when the code is missing', () => {
    assert.equal(cableLabel({ name: 'Drop link' }), 'Drop link');
  });

  it('does not duplicate name equal to code', () => {
    assert.equal(cableLabel({ code: 'CBL-0007', name: 'CBL-0007' }), 'CBL-0007');
  });

  it('returns empty string for empty input', () => {
    assert.equal(cableLabel(null), '');
    assert.equal(cableLabel({}), '');
  });
});

describe('routeMidpointLngLat', () => {
  it('returns the geometric midpoint of a straight line', () => {
    assert.deepEqual(routeMidpointLngLat([[0, 0], [10, 0]]), [5, 0]);
  });

  it('walks by length, not by vertex index', () => {
    // 9 units right, then 1 unit up: midpoint (by length) sits on the long
    // horizontal segment, not at vertex [9, 0].
    assert.deepEqual(routeMidpointLngLat([[0, 0], [9, 0], [9, 1]]), [5, 0]);
  });

  it('handles diagonal routes', () => {
    const [x, y] = routeMidpointLngLat([[0, 0], [3, 4]]);
    assert.ok(Math.abs(x - 1.5) < 1e-9);
    assert.ok(Math.abs(y - 2) < 1e-9);
  });

  it('returns null for routes with fewer than 2 valid points', () => {
    assert.equal(routeMidpointLngLat([]), null);
    assert.equal(routeMidpointLngLat([[1, 1]]), null);
    assert.equal(routeMidpointLngLat(null), null);
    assert.equal(routeMidpointLngLat([[0, 0], [1, 1], [null, 2]]), null);
    assert.equal(routeMidpointLngLat([[5, 5], [5, 5]]), null);
  });
});

describe('CABLE_LABEL_MIN_ZOOM', () => {
  it('is a number the map providers can gate on', () => {
    assert.equal(typeof CABLE_LABEL_MIN_ZOOM, 'number');
    assert.ok(CABLE_LABEL_MIN_ZOOM > 10 && CABLE_LABEL_MIN_ZOOM <= 16);
  });

  it('has no enclosure counterpart — box codes are hover/selection-only', () => {
    // ENCLOSURE_LABEL_MIN_ZOOM was removed on purpose: box labels must never
    // appear en masse at any zoom, only on hover/selection.
    assert.equal(geoLabels.ENCLOSURE_LABEL_MIN_ZOOM, undefined);
  });
});
