/**
 * Validation utilities for frontend data validation.
 *
 * These mirror the payload contracts of the backend middleware
 * (backend/src/middleware/validation.js) and the route handlers — keep them in
 * sync or forms will build payloads the API rejects.
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
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
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
 * Validates a coordinate list. Accepts [lng, lat] pairs and { lat, lng }
 * point objects (route_points are sent as objects). Returns an error string
 * or null.
 */
function checkCoordList(arr, fieldName, { require = false } = {}) {
  if (arr === undefined || arr === null) {
    return require ? `${fieldName} is required` : null;
  }
  if (!Array.isArray(arr) || arr.length < 2) {
    return `${fieldName} must be an array of at least 2 coordinates`;
  }
  for (let i = 0; i < arr.length; i++) {
    const point = arr[i];
    let lng, lat;
    if (Array.isArray(point)) {
      if (point.length < 2) return `${fieldName}[${i}] must be a [lng, lat] pair`;
      [lng, lat] = point;
    } else if (point && typeof point === 'object') {
      lng = point.lng;
      lat = point.lat;
    } else {
      return `${fieldName}[${i}] must be a [lng, lat] pair or { lat, lng } object`;
    }
    if (!isValidCoordinate(lat, lng)) {
      return `Invalid coordinates at ${fieldName}[${i}]`;
    }
  }
  return null;
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
 * A box is attached to a pole (pole_id) OR placed at a direct location
 * (lat/lng — customer boxes). Coordinates are only required without a pole.
 */
export function validateEnclosureData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Enclosure data must be an object');
    return errors;
  }
  const hasPole = data.pole_id !== undefined && data.pole_id !== null && data.pole_id !== '';
  const hasCoords = data.lat !== undefined && data.lat !== null && data.lng !== undefined && data.lng !== null;
  if (!hasPole && !hasCoords) {
    errors.push('Either pole_id or lat/lng is required');
  } else if (hasCoords && !isValidCoordinate(data.lat, data.lng)) {
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
 * Geometry is optional — the API can draw a straight line between endpoints —
 * but any provided geometry list must contain at least 2 valid coordinates.
 */
export function validateCableData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Cable data must be an object');
    return errors;
  }
  if (data.from_enclosure_id === undefined || data.from_enclosure_id === null || data.from_enclosure_id === '') {
    errors.push('from_enclosure_id is required');
  }
  for (const field of ['route', 'route_geometry', 'route_points']) {
    const error = checkCoordList(data[field], field);
    if (error) errors.push(error);
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
 * Validates splice data structure — matches POST /api/splices and the splice
 * form in RightPanel (core_a is spliced onto core_b inside an enclosure).
 */
export function validateSpliceData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Splice data must be an object');
    return errors;
  }
  if (data.enclosure_id === undefined || data.enclosure_id === null || data.enclosure_id === '') {
    errors.push('enclosure_id is required');
  }
  if (data.core_a_id === undefined || data.core_a_id === null || data.core_a_id === '') {
    errors.push('core_a_id is required');
  }
  if (data.core_b_id === undefined || data.core_b_id === null || data.core_b_id === '') {
    errors.push('core_b_id is required');
  }
  if (errors.length === 0 && data.core_a_id === data.core_b_id) {
    errors.push('A core cannot be spliced to itself');
  }
  return errors;
}

/**
 * Validates splitter data structure — matches POST /api/splitters.
 */
export function validateSplitterData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Splitter data must be an object');
    return errors;
  }
  if (data.enclosure_id === undefined || data.enclosure_id === null || data.enclosure_id === '') {
    errors.push('enclosure_id is required');
  }
  if (data.input_core_id === undefined || data.input_core_id === null || data.input_core_id === '') {
    errors.push('input_core_id is required');
  }
  if (data.split_count !== undefined && ![2, 4, 8].includes(Number(data.split_count))) {
    errors.push('split_count must be 2, 4, or 8');
  }
  return errors;
}

/**
 * Validates fiber core PATCH data — every field is optional; the API applies
 * what is present.
 */
export function validateFiberCoreData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Fiber core data must be an object');
    return errors;
  }
  if (data.status !== undefined && typeof data.status !== 'string') {
    errors.push('status must be a string');
  }
  if (data.notes !== undefined && data.notes !== null && typeof data.notes !== 'string') {
    errors.push('notes must be a string');
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
