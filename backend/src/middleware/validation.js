/**
 * Backend validation middleware for input sanitization and data validation.
 *
 * IMPORTANT: these validators must mirror the payload contracts actually used by
 * the route handlers and the frontend (frontend/src/api.js). A mismatch here
 * silently breaks whole UI workflows with 400s, so keep them in sync.
 */

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  let sanitized = str.replace(/<[^>]*>/g, '');
  sanitized = sanitized.replace(/javascript:/gi, '');
  sanitized = sanitized.replace(/on\w+\s*=/gi, '');
  return sanitized.trim().substring(0, 1000);
}

function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item));
  if (typeof obj === 'object' && !Array.isArray(obj)) {
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

function isValidCoordinate(lat, lng) {
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  return (
    !isNaN(latNum) && !isNaN(lngNum) &&
    latNum >= -90 && latNum <= 90 &&
    lngNum >= -180 && lngNum <= 180
  );
}

function isValidNumber(value, min = -Infinity, max = Infinity) {
  const num = Number(value);
  return !isNaN(num) && isFinite(num) && num >= min && num <= max;
}

const INVALID_COORDS_MSG =
  'Invalid coordinates. lat must be between -90 and 90, lng between -180 and 180.';

/**
 * A route-ish array of coordinates. Accepts both [lng, lat] pairs and
 * { lat, lng } point objects (the frontend sends route_points as objects).
 */
function validateCoordArray(arr, fieldName, { require } = {}) {
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
      if (point.length < 2) {
        return `Invalid coordinate at ${fieldName}[${i}]. Expected [lng, lat] array.`;
      }
      [lng, lat] = point;
    } else if (point && typeof point === 'object') {
      lng = point.lng;
      lat = point.lat;
    } else {
      return `Invalid coordinate at ${fieldName}[${i}]. Expected [lng, lat] or { lat, lng }.`;
    }
    if (!isValidCoordinate(lat, lng)) {
      return `Invalid coordinates at ${fieldName}[${i}]. lat must be between -90 and 90, lng between -180 and 180.`;
    }
  }
  return null;
}

function validatePoleData(req, res, next) {
  const { lat, lng, name } = req.body;
  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).json({ error: INVALID_COORDS_MSG });
  }
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Name must be a string' });
  }
  req.body.name = name ? sanitizeString(name) : name;
  next();
}

function validateEnclosureData(req, res, next) {
  const { lat, lng, pole_id, name, type } = req.body;

  // A box is either attached to a pole (pole_id) OR placed at a direct
  // location (lat/lng, e.g. customer enclosures). Coordinates are only
  // required when no pole is given — the route handler enforces the
  // either/or rule itself.
  const hasPole = pole_id !== undefined && pole_id !== null && pole_id !== '';
  const hasCoords = lat !== undefined && lat !== null && lng !== undefined && lng !== null;

  if (!hasPole && !hasCoords) {
    return res.status(400).json({ error: 'Either pole_id or lat/lng is required' });
  }
  if (hasCoords && !isValidCoordinate(lat, lng)) {
    return res.status(400).json({ error: INVALID_COORDS_MSG });
  }
  if (pole_id !== undefined && typeof pole_id !== 'string' && typeof pole_id !== 'number') {
    return res.status(400).json({ error: 'pole_id must be a string or number' });
  }
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Name must be a string' });
  }
  if (type !== undefined && typeof type !== 'string') {
    return res.status(400).json({ error: 'Type must be a string' });
  }
  req.body.name = name ? sanitizeString(name) : name;
  req.body.type = type ? sanitizeString(type) : type;
  next();
}

function validateCableData(req, res, next) {
  const { route, route_geometry, route_points, cable_type, from_enclosure_id, to_enclosure_id } = req.body;

  // Geometry is optional at the middleware level: the route handler builds a
  // straight line from the two endpoints when no explicit geometry is given.
  // Validate any geometry arrays that ARE present.
  for (const [field, value] of [['route', route], ['route_geometry', route_geometry], ['route_points', route_points]]) {
    const error = validateCoordArray(value, field, { require: false });
    if (error) return res.status(400).json({ error });
  }

  if (!from_enclosure_id) {
    return res.status(400).json({ error: 'from_enclosure_id is required' });
  }
  if (cable_type !== undefined && typeof cable_type !== 'string') {
    return res.status(400).json({ error: 'cable_type must be a string' });
  }
  if (cable_type !== undefined && !['feeder', 'distribution', 'drop'].includes(cable_type)) {
    return res.status(400).json({ error: "cable_type must be 'feeder', 'distribution' or 'drop'" });
  }
  if (from_enclosure_id !== undefined && typeof from_enclosure_id !== 'string' && typeof from_enclosure_id !== 'number') {
    return res.status(400).json({ error: 'from_enclosure_id must be a string or number' });
  }
  if (to_enclosure_id !== undefined && typeof to_enclosure_id !== 'string' && typeof to_enclosure_id !== 'number') {
    return res.status(400).json({ error: 'to_enclosure_id must be a string or number' });
  }
  req.body.cable_type = cable_type ? sanitizeString(cable_type) : cable_type;
  next();
}

function validateCustomerData(req, res, next) {
  const { lat, lng, name, email, phone } = req.body;
  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).json({ error: INVALID_COORDS_MSG });
  }
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Name must be a string' });
  }
  if (email !== undefined && typeof email !== 'string') {
    return res.status(400).json({ error: 'Email must be a string' });
  }
  if (phone !== undefined && typeof phone !== 'string') {
    return res.status(400).json({ error: 'Phone must be a string' });
  }
  req.body.name = name ? sanitizeString(name) : name;
  req.body.email = email ? sanitizeString(email) : email;
  req.body.phone = phone ? sanitizeString(phone) : phone;
  next();
}

function validateSpliceData(req, res, next) {
  // Contract used by POST /api/splices and the frontend splice form.
  const { enclosure_id, core_a_id, core_b_id, loss_db, splice_type } = req.body;

  if (enclosure_id === undefined || enclosure_id === null || enclosure_id === '') {
    return res.status(400).json({ error: 'enclosure_id is required' });
  }
  if (core_a_id === undefined || core_a_id === null || core_a_id === '') {
    return res.status(400).json({ error: 'core_a_id is required' });
  }
  if (core_b_id === undefined || core_b_id === null || core_b_id === '') {
    return res.status(400).json({ error: 'core_b_id is required' });
  }
  if (core_a_id === core_b_id) {
    return res.status(400).json({ error: 'A core cannot be spliced to itself' });
  }
  if (splice_type !== undefined && !['fusion', 'mechanical'].includes(splice_type)) {
    return res.status(400).json({ error: "splice_type must be 'fusion' or 'mechanical'" });
  }
  if (loss_db !== undefined && loss_db !== null && loss_db !== '' && !isValidNumber(loss_db, 0, 10)) {
    return res.status(400).json({ error: 'loss_db must be a number between 0 and 10' });
  }
  next();
}

function validateSplitterData(req, res, next) {
  // Contract used by POST /api/splitters and the frontend splitter form.
  const { enclosure_id, input_core_id, split_count, loss_db, splice_type } = req.body;

  if (enclosure_id === undefined || enclosure_id === null || enclosure_id === '') {
    return res.status(400).json({ error: 'enclosure_id is required' });
  }
  if (input_core_id === undefined || input_core_id === null || input_core_id === '') {
    return res.status(400).json({ error: 'input_core_id is required' });
  }
  if (split_count !== undefined && ![2, 4, 8].includes(Number(split_count))) {
    return res.status(400).json({ error: 'split_count must be 2, 4, or 8' });
  }
  if (splice_type !== undefined && !['fusion', 'mechanical'].includes(splice_type)) {
    return res.status(400).json({ error: "splice_type must be 'fusion' or 'mechanical'" });
  }
  if (loss_db !== undefined && loss_db !== null && loss_db !== '' && !isValidNumber(loss_db, 0, 40)) {
    return res.status(400).json({ error: 'loss_db must be a number between 0 and 40' });
  }
  next();
}

function validateFiberCoreData(req, res, next) {
  // Used on PATCH /api/fiber-cores/:id — every field is optional; the handler
  // decides what to apply. Just type-check what is present.
  const { status, notes } = req.body;
  if (status !== undefined && typeof status !== 'string') {
    return res.status(400).json({ error: 'status must be a string' });
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return res.status(400).json({ error: 'notes must be a string' });
  }
  if (status) req.body.status = sanitizeString(status);
  next();
}

function validateCapacityData(req, res, next) {
  const { enclosure_id, available_cores } = req.body;
  if (enclosure_id === undefined) {
    return res.status(400).json({ error: 'enclosure_id is required' });
  }
  if (!isValidNumber(available_cores, 0, Infinity)) {
    return res.status(400).json({ error: 'available_cores must be a non-negative number' });
  }
  next();
}

module.exports = {
  sanitizeString,
  sanitizeObject,
  isValidCoordinate,
  isValidNumber,
  validatePoleData,
  validateEnclosureData,
  validateCableData,
  validateCustomerData,
  validateSpliceData,
  validateSplitterData,
  validateFiberCoreData,
  validateCapacityData,
};
