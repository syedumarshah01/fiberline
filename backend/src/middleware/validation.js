/**
 * Backend validation middleware for input sanitization and data validation.
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
      if (obj.hasOwnProperty(key)) {
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


function validatePoleData(req, res, next) {
  const { lat, lng, name } = req.body;
  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).json({
      error: 'Invalid coordinates. lat must be between -90 and 90, lng between -180 and 180.'
    });
  }
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Name must be a string' });
  }
  req.body.name = name ? sanitizeString(name) : name;
  next();
}

function validateEnclosureData(req, res, next) {
  const { lat, lng, pole_id, name, type } = req.body;
  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).json({
      error: 'Invalid coordinates. lat must be between -90 and 90, lng between -180 and 180.'
    });
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
  const { route, cable_type, start_enclosure_id, end_enclosure_id } = req.body;
  if (!Array.isArray(route) || route.length < 2) {
    return res.status(400).json({
      error: 'Route must be an array of at least 2 coordinate pairs [lng, lat]'
    });
  }
  for (let i = 0; i < route.length; i++) {
    const coord = route[i];
    if (!Array.isArray(coord) || coord.length < 2) {
      return res.status(400).json({
        error: `Invalid coordinate at index ${i}. Expected [lng, lat] array.`
      });
    }
    const [lng, lat] = coord;
    if (!isValidCoordinate(lat, lng)) {
      return res.status(400).json({
        error: `Invalid coordinates at index ${i}. lat must be between -90 and 90, lng between -180 and 180.`
      });
    }
  }
  if (cable_type !== undefined && typeof cable_type !== 'string') {
    return res.status(400).json({ error: 'cable_type must be a string' });
  }
  if (start_enclosure_id !== undefined && typeof start_enclosure_id !== 'string' && typeof start_enclosure_id !== 'number') {
    return res.status(400).json({ error: 'start_enclosure_id must be a string or number' });
  }
  if (end_enclosure_id !== undefined && typeof end_enclosure_id !== 'string' && typeof end_enclosure_id !== 'number') {
    return res.status(400).json({ error: 'end_enclosure_id must be a string or number' });
  }
  req.body.cable_type = cable_type ? sanitizeString(cable_type) : cable_type;
  next();
}

function validateCustomerData(req, res, next) {
  const { lat, lng, name, email, phone } = req.body;
  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).json({
      error: 'Invalid coordinates. lat must be between -90 and 90, lng between -180 and 180.'
    });
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
  const { cable_id, enclosure_id, core_assignments } = req.body;
  if (cable_id === undefined) {
    return res.status(400).json({ error: 'cable_id is required' });
  }
  if (enclosure_id === undefined) {
    return res.status(400).json({ error: 'enclosure_id is required' });
  }
  if (!Array.isArray(core_assignments)) {
    return res.status(400).json({ error: 'core_assignments must be an array' });
  }
  next();
}

function validateSplitterData(req, res, next) {
  const { enclosure_id, split_ratio, ports } = req.body;
  if (enclosure_id === undefined) {
    return res.status(400).json({ error: 'enclosure_id is required' });
  }
  if (!isValidNumber(split_ratio, 1, 128)) {
    return res.status(400).json({ error: 'split_ratio must be a number between 1 and 128' });
  }
  if (ports !== undefined && !isValidNumber(ports, 1, 64)) {
    return res.status(400).json({ error: 'ports must be a number between 1 and 64' });
  }
  next();
}

function validateFiberCoreData(req, res, next) {
  const { cable_id, core_number, status } = req.body;
  if (cable_id === undefined) {
    return res.status(400).json({ error: 'cable_id is required' });
  }
  if (!isValidNumber(core_number, 1, 288)) {
    return res.status(400).json({ error: 'core_number must be a number between 1 and 288' });
  }
  if (status !== undefined && typeof status !== 'string') {
    return res.status(400).json({ error: 'status must be a string' });
  }
  req.body.status = status ? sanitizeString(status) : status;
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