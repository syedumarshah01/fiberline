/**
 * Validation utilities for frontend data validation.
 */

/**
 * Validates that latitude and longitude values are within valid ranges.
 */
export function isValidCoordinate(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return false;
  }
  const latNum = Number(lat);
  const lngNum = Number(lng);
  return (
    !isNaN(latNum) && !isNaN(lngNum) &&
    latNum >= -90 && latNum <= 90 &&
    lngNum >= -180 && lngNum <= 180
  );
}

/**
 * Validates an array of coordinates (lat/lng pairs).
 * Returns an array of invalid indices.
 */
export function validateCoordinatesArray(coords) {
  if (!Array.isArray(coords)) return [0];
  const invalidIndices = [];
  coords.forEach((coord, index) => {
    if (!Array.isArray(coord) || coord.length < 2) {
      invalidIndices.push(index);
      return;
    }
    const [lng, lat] = coord;
    if (!isValidCoordinate(lat, lng)) {
      invalidIndices.push(index);
    }
  });
  return invalidIndices;
}


/**
 * Checks for duplicate IDs in an array of objects.
 */
export function findDuplicateIds(items, idField = 'id') {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const duplicates = new Set();
  items.forEach(item => {
    const id = item[idField];
    if (id === null || id === undefined) return;
    if (seen.has(id)) {
      duplicates.add(id);
    } else {
      seen.add(id);
    }
  });
  return Array.from(duplicates);
}

/**
 * Sanitizes a string input to prevent XSS and injection attacks.
 */
export function sanitizeString(input) {
  if (typeof input !== 'string') return '';
  let sanitized = input.replace(/<[^>]*>/g, '');
  sanitized = sanitized.replace(/javascript:/gi, '');
  sanitized = sanitized.replace(/on\w+\s*=/gi, '');
  sanitized = sanitized.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  return sanitized.trim();
}

/**
 * Sanitizes an object by sanitizing all string values recursively.
 */
export function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item));
  if (typeof obj === 'object') {
    const sanitized = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        sanitized[key] = sanitizeObject(obj[key]);
      }
    }
    return sanitized;
  }
  return obj;
}

/**
 * Validates that a number is within a specified range.
 */
export function isValidNumber(value, min = -Infinity, max = Infinity) {
  const num = Number(value);
  return !isNaN(num) && isFinite(num) && num >= min && num <= max;
}

/**
 * Validates pole data structure.
 */
export function validatePoleData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Pole data must be an object');
    return errors;
  }
  if (!isValidCoordinate(data.lat, data.lng)) {
    errors.push('Invalid coordinates');
  }
  if (data.name !== undefined && typeof data.name !== 'string') {
    errors.push('Name must be a string');
  }
  return errors;
}

/**
 * Validates enclosure data structure.
 */
export function validateEnclosureData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Enclosure data must be an object');
    return errors;
  }
  if (!isValidCoordinate(data.lat, data.lng)) {
    errors.push('Invalid coordinates');
  }
  if (data.pole_id !== undefined && (typeof data.pole_id !== 'string' && typeof data.pole_id !== 'number')) {
    errors.push('pole_id must be a string or number');
  }
  if (data.name !== undefined && typeof data.name !== 'string') {
    errors.push('Name must be a string');
  }
  return errors;
}

/**
 * Validates cable data structure.
 */
export function validateCableData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Cable data must be an object');
    return errors;
  }
  if (!Array.isArray(data.route) || data.route.length < 2) {
    errors.push('Route must be an array of at least 2 coordinate pairs');
  } else {
    const invalidCoords = validateCoordinatesArray(data.route);
    if (invalidCoords.length > 0) {
      errors.push(`Invalid coordinates at indices: ${invalidCoords.join(', ')}`);
    }
  }
  return errors;
}

/**
 * Validates customer data structure.
 */
export function validateCustomerData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Customer data must be an object');
    return errors;
  }
  if (!isValidCoordinate(data.lat, data.lng)) {
    errors.push('Invalid coordinates');
  }
  if (data.name !== undefined && typeof data.name !== 'string') {
    errors.push('Name must be a string');
  }
  return errors;
}

/**
 * Validates splice data structure.
 */
export function validateSpliceData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Splice data must be an object');
    return errors;
  }
  if (data.cable_id === undefined) {
    errors.push('cable_id is required');
  }
  if (data.enclosure_id === undefined) {
    errors.push('enclosure_id is required');
  }
  if (!Array.isArray(data.core_assignments)) {
    errors.push('core_assignments must be an array');
  }
  return errors;
}

/**
 * Validates splitter data structure.
 */
export function validateSplitterData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Splitter data must be an object');
    return errors;
  }
  if (data.enclosure_id === undefined) {
    errors.push('enclosure_id is required');
  }
  if (!isValidNumber(data.split_ratio, 1, 128)) {
    errors.push('split_ratio must be between 1 and 128');
  }
  return errors;
}

/**
 * Validates fiber core data structure.
 */
export function validateFiberCoreData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Fiber core data must be an object');
    return errors;
  }
  if (data.cable_id === undefined) {
    errors.push('cable_id is required');
  }
  if (!isValidNumber(data.core_number, 1, 288)) {
    errors.push('core_number must be between 1 and 288');
  }
  return errors;
}

export default {
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
};