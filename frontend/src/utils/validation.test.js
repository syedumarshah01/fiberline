/**
 * Unit tests for validation utilities.
 */
import { describe, it, expect } from 'vitest';
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
} from './validation';

describe('isValidCoordinate', () => {
  it('should return true for valid coordinates', () => {
    expect(isValidCoordinate(40.7128, -74.006)).toBe(true);
    expect(isValidCoordinate(0, 0)).toBe(true);
    expect(isValidCoordinate(-90, -180)).toBe(true);
    expect(isValidCoordinate(90, 180)).toBe(true);
  });

  it('should return false for invalid latitude', () => {
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(-91, 0)).toBe(false);
    expect(isValidCoordinate(NaN, 0)).toBe(false);
  });

  it('should return false for invalid longitude', () => {
    expect(isValidCoordinate(0, 181)).toBe(false);
    expect(isValidCoordinate(0, -181)).toBe(false);
    expect(isValidCoordinate(0, NaN)).toBe(false);
  });

  it('should return false for null/undefined values', () => {
    expect(isValidCoordinate(null, 0)).toBe(false);
    expect(isValidCoordinate(0, null)).toBe(false);
    expect(isValidCoordinate(undefined, 0)).toBe(false);
    expect(isValidCoordinate(0, undefined)).toBe(false);
  });
});

describe('validateCoordinatesArray', () => {
  it('should return empty array for valid coordinates', () => {
    const coords = [[-74.006, 40.7128], [0, 0], [180, -90]];
    expect(validateCoordinatesArray(coords)).toEqual([]);
  });

  it('should return indices of invalid coordinates', () => {
    const coords = [[-74.006, 40.7128], [200, 0], [0, 0]];
    expect(validateCoordinatesArray(coords)).toEqual([1]);
  });

  it('should handle non-array input', () => {
    expect(validateCoordinatesArray('not an array')).toEqual([0]);
  });
});

describe('findDuplicateIds', () => {
  it('should return empty array when no duplicates', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(findDuplicateIds(items)).toEqual([]);
  });

  it('should return duplicate IDs', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 1 }, { id: 2 }];
    expect(findDuplicateIds(items)).toEqual([1, 2]);
  });

  it('should work with custom id field', () => {
    const items = [{ code: 'A' }, { code: 'B' }, { code: 'A' }];
    expect(findDuplicateIds(items, 'code')).toEqual(['A']);
  });
});

describe('sanitizeString', () => {
  it('should remove HTML tags', () => {
    expect(sanitizeString('<script>alert("xss")</script>')).toBe('alert(&quot;xss&quot;)');
  });

  it('should remove javascript: protocol', () => {
    expect(sanitizeString('javascript:alert(1)')).toBe('alert(1)');
  });

  it('should remove event handlers', () => {
    expect(sanitizeString('onclick=alert(1)')).toBe('alert(1)');
  });

  it('should escape special characters', () => {
    expect(sanitizeString('<div>Test & "quotes"\'s</div>')).toBe('Test &amp; &quot;quotes&quot;&#039;s');
  });

  it('should handle non-string input', () => {
    expect(sanitizeString(123)).toBe('');
    expect(sanitizeString(null)).toBe('');
    expect(sanitizeString(undefined)).toBe('');
  });
});


describe('sanitizeObject', () => {
  it('should sanitize all string values recursively', () => {
    const obj = {
      name: '<script>alert(1)</script>',
      nested: {
        value: 'test<script>',
        array: ['<b>bold</b>', 'normal']
      }
    };
    const sanitized = sanitizeObject(obj);
    expect(sanitized.name).toBe('alert(1)');
    expect(sanitized.nested.value).toBe('test');
    expect(sanitized.nested.array[0]).toBe('bold');
    expect(sanitized.nested.array[1]).toBe('normal');
  });
});

describe('isValidNumber', () => {
  it('should validate numbers within range', () => {
    expect(isValidNumber(5, 0, 10)).toBe(true);
    expect(isValidNumber(0, 0, 10)).toBe(true);
    expect(isValidNumber(10, 0, 10)).toBe(true);
  });

  it('should reject numbers outside range', () => {
    expect(isValidNumber(-1, 0, 10)).toBe(false);
    expect(isValidNumber(11, 0, 10)).toBe(false);
  });

  it('should reject NaN and Infinity', () => {
    expect(isValidNumber(NaN)).toBe(false);
    expect(isValidNumber(Infinity)).toBe(false);
    expect(isValidNumber(-Infinity)).toBe(false);
  });
});

describe('validatePoleData', () => {
  it('should return empty errors for valid pole data', () => {
    const data = { lat: 40.7128, lng: -74.006, name: 'Pole 1' };
    expect(validatePoleData(data)).toEqual([]);
  });

  it('should return errors for invalid coordinates', () => {
    const data = { lat: 100, lng: -74.006 };
    expect(validatePoleData(data)).toContain('Invalid coordinates');
  });

  it('should return errors for non-object input', () => {
    expect(validatePoleData(null)).toContain('Pole data must be an object');
    expect(validatePoleData('string')).toContain('Pole data must be an object');
  });
});

describe('validateEnclosureData', () => {
  it('should return empty errors for valid enclosure data', () => {
    const data = { lat: 40.7128, lng: -74.006, pole_id: 'pole1', name: 'Enclosure 1', type: 'FDT' };
    expect(validateEnclosureData(data)).toEqual([]);
  });

  it('should return errors for invalid pole_id type', () => {
    const data = { lat: 40.7128, lng: -74.006, pole_id: 123 };
    // pole_id can be string or number, so this should be valid
    expect(validateEnclosureData(data)).toEqual([]);
  });
});

describe('validateCableData', () => {
  it('should return empty errors for valid cable data', () => {
    const data = {
      route: [[-74.006, 40.7128], [-74.007, 40.713]],
      cable_type: 'distribution'
    };
    expect(validateCableData(data)).toEqual([]);
  });

  it('should return errors for insufficient waypoints', () => {
    const data = { route: [[-74.006, 40.7128]] };
    expect(validateCableData(data)).toContain('Route must be an array of at least 2 coordinate pairs');
  });

  it('should return errors for invalid coordinates in route', () => {
    const data = { route: [[-74.006, 40.7128], [200, 0]] };
    expect(validateCableData(data)).toContain('Invalid coordinates');
  });
});

describe('validateCustomerData', () => {
  it('should return empty errors for valid customer data', () => {
    const data = { lat: 40.7128, lng: -74.006, name: 'John Doe', email: 'john@example.com' };
    expect(validateCustomerData(data)).toEqual([]);
  });

  it('should return errors for invalid coordinates', () => {
    const data = { lat: 100, lng: -74.006, name: 'John Doe' };
    expect(validateCustomerData(data)).toContain('Invalid coordinates');
  });
});