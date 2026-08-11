/**
 * Unit tests for frontend validation utilities.
 *
 * Run with: npm test  (built-in node:test runner — no extra deps)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidCoordinate,
  validateCoordinatesArray,
  findDuplicateIds,
  sanitizeString,
  sanitizeObject,
  isValidNumber,
  validatePoleData,
  validateEnclosureData,
  validateCableData,
  validateCustomerData,
  validateSpliceData,
  validateSplitterData,
  validateFiberCoreData,
} from './validation.js';

describe('isValidCoordinate', () => {
  it('should return true for valid coordinates', () => {
    assert.equal(isValidCoordinate(40.7128, -74.006), true);
    assert.equal(isValidCoordinate(0, 0), true);
    assert.equal(isValidCoordinate(-90, -180), true);
    assert.equal(isValidCoordinate(90, 180), true);
  });

  it('should return false for invalid latitude', () => {
    assert.equal(isValidCoordinate(91, 0), false);
    assert.equal(isValidCoordinate(-91, 0), false);
    assert.equal(isValidCoordinate(NaN, 0), false);
  });

  it('should return false for invalid longitude', () => {
    assert.equal(isValidCoordinate(0, 181), false);
    assert.equal(isValidCoordinate(0, -181), false);
    assert.equal(isValidCoordinate(0, NaN), false);
  });

  it('should return false for null/undefined values', () => {
    assert.equal(isValidCoordinate(null, 0), false);
    assert.equal(isValidCoordinate(0, null), false);
    assert.equal(isValidCoordinate(undefined, 0), false);
    assert.equal(isValidCoordinate(0, undefined), false);
  });
});

describe('validateCoordinatesArray', () => {
  it('should return empty array for valid coordinates', () => {
    const coords = [[-74.006, 40.7128], [0, 0], [180, -90]];
    assert.deepEqual(validateCoordinatesArray(coords), []);
  });

  it('should return invalid indices', () => {
    const coords = [[-74.006, 40.7128], [200, 0], 'nope', [0]];
    assert.deepEqual(validateCoordinatesArray(coords), [1, 2, 3]);
  });
});

describe('findDuplicateIds', () => {
  it('should find duplicated ids', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: null }, { id: 'c' }, { id: 'b' }];
    assert.deepEqual(findDuplicateIds(items).sort(), ['a', 'b']);
  });

  it('should return empty array for non-arrays', () => {
    assert.deepEqual(findDuplicateIds(null), []);
  });
});

describe('sanitizeString / sanitizeObject', () => {
  it('should strip tags and dangerous protocols', () => {
    assert.equal(sanitizeString('<script>alert(1)</script>John'), 'alert(1)John');
    assert.equal(sanitizeString('javascript:alert(1)'), 'alert(1)');
    assert.equal(sanitizeString(42), '');
  });

  it('should sanitize nested objects', () => {
    const out = sanitizeObject({ a: '<b>x</b>', list: ['<i>y</i>', 1] });
    assert.equal(out.a, 'x');
    assert.equal(out.list[0], 'y');
    assert.equal(out.list[1], 1);
  });
});

describe('isValidNumber', () => {
  it('should validate numbers within range', () => {
    assert.equal(isValidNumber(5, 0, 10), true);
    assert.equal(isValidNumber(-1, 0, 10), false);
    assert.equal(isValidNumber(NaN), false);
    assert.equal(isValidNumber(Infinity), false);
  });
});

describe('validatePoleData', () => {
  it('should return empty errors for valid pole data', () => {
    assert.deepEqual(validatePoleData({ lat: 40.7128, lng: -74.006, name: 'Pole 1' }), []);
  });

  it('should return errors for invalid coordinates', () => {
    assert.ok(validatePoleData({ lat: 100, lng: -74.006 }).includes('Invalid coordinates'));
  });
});

describe('validateEnclosureData', () => {
  it('REGRESSION: accepts a pole-mounted box without coordinates', () => {
    assert.deepEqual(
      validateEnclosureData({ pole_id: 'pole-1', code: 'B1', type: 'nap' }),
      [],
    );
  });

  it('accepts a customer box with coordinates and no pole', () => {
    assert.deepEqual(
      validateEnclosureData({ lat: 34.0, lng: 71.5, code: 'B2', type: 'terminal' }),
      [],
    );
  });

  it('requires pole_id or lat/lng', () => {
    const errors = validateEnclosureData({ code: 'B3', type: 'nap' });
    assert.ok(errors.some((e) => e.includes('pole_id or lat/lng')));
  });

  it('flags invalid coordinates when provided', () => {
    assert.ok(validateEnclosureData({ lat: 100, lng: 0 }).includes('Invalid coordinates'));
  });
});

describe('validateCableData', () => {
  const endpoints = { from_enclosure_id: 'a', to_enclosure_id: 'b' };

  it('REGRESSION: accepts the draw-cable form payload', () => {
    const errors = validateCableData({
      ...endpoints,
      cable_type: 'distribution',
      route_points: [{ lat: 34.0, lng: 71.5 }, { lat: 34.1, lng: 71.6 }],
      route_geometry: [[71.5, 34.0], [71.6, 34.1]],
    });
    assert.deepEqual(errors, []);
  });

  it('requires from_enclosure_id', () => {
    assert.ok(validateCableData({}).some((e) => e.includes('from_enclosure_id')));
  });

  it('flags malformed geometry', () => {
    const errors = validateCableData({ ...endpoints, route_geometry: [[71.5, 34.0], [200, 0]] });
    assert.ok(errors.some((e) => e.includes('route_geometry[1]')));
  });
});

describe('validateCustomerData', () => {
  it('should return empty errors for valid customer data', () => {
    assert.deepEqual(
      validateCustomerData({ lat: 40.7128, lng: -74.006, name: 'John Doe', email: 'john@example.com' }),
      [],
    );
  });

  it('should return errors for invalid coordinates', () => {
    assert.ok(validateCustomerData({ lat: 100, lng: -74.006, name: 'John Doe' }).includes('Invalid coordinates'));
  });
});

describe('validateSpliceData', () => {
  it('REGRESSION: accepts the splice form payload', () => {
    assert.deepEqual(
      validateSpliceData({ enclosure_id: 'box', core_a_id: 'c1', core_b_id: 'c2' }),
      [],
    );
  });

  it('requires all ids and rejects self-splices', () => {
    assert.ok(validateSpliceData({}).some((e) => e.includes('enclosure_id')));
    const errors = validateSpliceData({ enclosure_id: 'box', core_a_id: 'c1', core_b_id: 'c1' });
    assert.ok(errors.some((e) => e.includes('itself')));
  });
});

describe('validateSplitterData', () => {
  it('REGRESSION: accepts the splitter form payload', () => {
    assert.deepEqual(
      validateSplitterData({ enclosure_id: 'box', input_core_id: 'c1', split_count: 8 }),
      [],
    );
  });

  it('requires enclosure and input core', () => {
    const errors = validateSplitterData({});
    assert.ok(errors.some((e) => e.includes('enclosure_id')));
    assert.ok(errors.some((e) => e.includes('input_core_id')));
  });

  it('rejects unsupported split counts', () => {
    assert.ok(
      validateSplitterData({ enclosure_id: 'box', input_core_id: 'c1', split_count: 3 })
        .some((e) => e.includes('split_count')),
    );
  });
});

describe('validateFiberCoreData', () => {
  it('REGRESSION: accepts a status-only PATCH payload', () => {
    assert.deepEqual(validateFiberCoreData({ status: 'terminated' }), []);
  });

  it('rejects non-string fields', () => {
    assert.ok(validateFiberCoreData({ status: 1 }).some((e) => e.includes('status')));
  });
});
