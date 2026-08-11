/**
 * Unit tests for backend validation middleware.
 */
const {
  sanitizeString,
  sanitizeObject,
  isValidCoordinate,
  isValidNumber,
  validatePoleData,
  validateEnclosureData,
  validateCableData,
  validateCustomerData,
} = require('../src/middleware/validation');

describe('Backend Validation Middleware', () => {
  describe('sanitizeString', () => {
    it('should remove HTML tags', () => {
      expect(sanitizeString('<script>alert("xss")</script>')).toBe('alert("xss")');
    });

    it('should remove javascript: protocol', () => {
      expect(sanitizeString('javascript:alert(1)')).toBe('alert(1)');
    });

    it('should trim and limit length', () => {
      const longString = 'a'.repeat(2000);
      const sanitized = sanitizeString(longString);
      expect(sanitized.length).toBeLessThanOrEqual(1000);
    });

    it('should handle non-string input', () => {
      expect(sanitizeString(123)).toBe(123);
      expect(sanitizeString(null)).toBe(null);
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
});


describe('validatePoleData middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { body: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });
  it('should call next for valid data', () => {
    req.body = { lat: 40.7128, lng: -74.006, name: 'Pole 1' };
    validatePoleData(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('should return 400 for invalid coordinates', () => {
    req.body = { lat: 100, lng: -74.006 };
    validatePoleData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid coordinates' }));
  });
  it('should sanitize name', () => {
    req.body = { lat: 40.7128, lng: -74.006, name: '<script>alert(1)</script>' };
    validatePoleData(req, res, next);
    expect(req.body.name).toBe('alert(1)');
  });
});

describe('validateEnclosureData middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { body: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });
  it('should call next for valid data', () => {
    req.body = { lat: 40.7128, lng: -74.006, pole_id: 'pole1', name: 'Enclosure 1', type: 'FDT' };
    validateEnclosureData(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('should return 400 for invalid coordinates', () => {
    req.body = { lat: 100, lng: -74.006, pole_id: 'pole1' };
    validateEnclosureData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid coordinates' }));
  });
  it('should sanitize name and type', () => {
    req.body = { lat: 40.7128, lng: -74.006, name: '<script>alert(1)</script>', type: '<b>FDT</b>' };
    validateEnclosureData(req, res, next);
    expect(req.body.name).toBe('alert(1)');
    expect(req.body.type).toBe('FDT');
  });
});

describe('validateCableData middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { body: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });
  it('should call next for valid data', () => {
    req.body = { route: [[-74.006, 40.7128], [-74.007, 40.713]], cable_type: 'distribution' };
    validateCableData(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('should return 400 for insufficient waypoints', () => {
    req.body = { route: [[-74.006, 40.7128]] };
    validateCableData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Route must be an array of at least 2 coordinate pairs' }));
  });
  it('should return 400 for invalid coordinates in route', () => {
    req.body = { route: [[-74.006, 40.7128], [200, 0]] };
    validateCableData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid coordinates' }));
  });
  it('should sanitize cable_type', () => {
    req.body = { route: [[-74.006, 40.7128], [-74.007, 40.713]], cable_type: '<script>alert(1)</script>distribution' };
    validateCableData(req, res, next);
    expect(req.body.cable_type).toBe('distribution');
  });
});

describe('validateCustomerData middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { body: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });
  it('should call next for valid data', () => {
    req.body = { lat: 40.7128, lng: -74.006, name: 'John Doe', email: 'john@example.com' };
    validateCustomerData(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('should return 400 for invalid coordinates', () => {
    req.body = { lat: 100, lng: -74.006, name: 'John Doe' };
    validateCustomerData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid coordinates' }));
  });
  it('should sanitize personal info', () => {
    req.body = { lat: 40.7128, lng: -74.006, name: '<script>alert(1)</script>John', email: 'test<script>@example.com', phone: '123<script>456</script>' };
    validateCustomerData(req, res, next);
    expect(req.body.name).toBe('alert(1)John');
    expect(req.body.email).toBe('test@example.com');
    expect(req.body.phone).toBe('123456');
  });
});

const {
  validateSpliceData,
  validateSplitterData,
  validateFiberCoreData,
  validateCapacityData,
} = require('../src/middleware/validation');

describe('validateSpliceData middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { body: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });
  it('should call next for valid data', () => {
    req.body = { cable_id: 'c1', enclosure_id: 'e1', core_assignments: [1, 2] };
    validateSpliceData(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('should return 400 if cable_id is missing', () => {
    req.body = { enclosure_id: 'e1', core_assignments: [] };
    validateSpliceData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'cable_id is required' }));
  });
  it('should return 400 if enclosure_id is missing', () => {
    req.body = { cable_id: 'c1', core_assignments: [] };
    validateSpliceData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'enclosure_id is required' }));
  });
  it('should return 400 if core_assignments is not an array', () => {
    req.body = { cable_id: 'c1', enclosure_id: 'e1', core_assignments: 'not-array' };
    validateSpliceData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'core_assignments must be an array' }));
  });
});

describe('validateSplitterData middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { body: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });
  it('should call next for valid data', () => {
    req.body = { enclosure_id: 'e1', split_ratio: 4, ports: 8 };
    validateSplitterData(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('should return 400 if enclosure_id is missing', () => {
    req.body = { split_ratio: 4 };
    validateSplitterData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'enclosure_id is required' }));
  });
  it('should return 400 if split_ratio is out of range', () => {
    req.body = { enclosure_id: 'e1', split_ratio: 200 };
    validateSplitterData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'split_ratio must be a number between 1 and 128' }));
  });
  it('should return 400 if ports is out of range', () => {
    req.body = { enclosure_id: 'e1', split_ratio: 4, ports: 100 };
    validateSplitterData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'ports must be a number between 1 and 64' }));
  });
});

describe('validateFiberCoreData middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { body: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });
  it('should call next for valid data', () => {
    req.body = { cable_id: 'c1', core_number: 12, status: 'available' };
    validateFiberCoreData(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('should return 400 if cable_id is missing', () => {
    req.body = { core_number: 12 };
    validateFiberCoreData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'cable_id is required' }));
  });
  it('should return 400 if core_number is out of range', () => {
    req.body = { cable_id: 'c1', core_number: 300 };
    validateFiberCoreData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'core_number must be a number between 1 and 288' }));
  });
  it('should sanitize status', () => {
    req.body = { cable_id: 'c1', core_number: 12, status: '<script>alert(1)</script>available' };
    validateFiberCoreData(req, res, next);
    expect(req.body.status).toBe('available');
  });
});

describe('validateCapacityData middleware', () => {
  let req, res, next;
  beforeEach(() => {
    req = { body: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });
  it('should call next for valid data', () => {
    req.body = { enclosure_id: 'e1', available_cores: 12 };
    validateCapacityData(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('should return 400 if enclosure_id is missing', () => {
    req.body = { available_cores: 12 };
    validateCapacityData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'enclosure_id is required' }));
  });
  it('should return 400 if available_cores is negative', () => {
    req.body = { enclosure_id: 'e1', available_cores: -5 };
    validateCapacityData(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'available_cores must be a non-negative number' }));
  });
});