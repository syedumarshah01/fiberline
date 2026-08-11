/**
 * Unit tests for backend validation middleware.
 *
 * Run with: npm test  (uses the built-in node:test runner — no extra deps)
 *
 * These tests lock in the payload contracts that frontend/src/api.js and the
 * forms actually send; the middleware used to drift from those contracts and
 * silently break whole UI workflows (box creation, cable drawing, splicing).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../src/middleware/validation');

/** Run a middleware and capture the outcome. */
function run(middleware, body) {
  const req = { body };
  const res = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

describe('sanitizeString', () => {
  test('removes HTML tags', () => {
    assert.equal(sanitizeString('<script>alert("xss")</script>'), 'alert("xss")');
  });

  test('removes javascript: protocol', () => {
    assert.equal(sanitizeString('javascript:alert(1)'), 'alert(1)');
  });

  test('trims and limits length', () => {
    const sanitized = sanitizeString('a'.repeat(2000));
    assert.ok(sanitized.length <= 1000);
  });

  test('handles non-string input', () => {
    assert.equal(sanitizeString(123), 123);
    assert.equal(sanitizeString(null), null);
  });
});

describe('sanitizeObject', () => {
  test('sanitizes all string values recursively', () => {
    const obj = {
      name: '<script>alert(1)</script>',
      nested: { value: 'test<script>', array: ['<b>bold</b>', 'normal'] },
    };
    const sanitized = sanitizeObject(obj);
    assert.equal(sanitized.name, 'alert(1)');
    assert.equal(sanitized.nested.value, 'test');
    assert.equal(sanitized.nested.array[0], 'bold');
    assert.equal(sanitized.nested.array[1], 'normal');
  });
});

describe('isValidCoordinate', () => {
  test('accepts valid coordinates', () => {
    assert.equal(isValidCoordinate(40.7128, -74.006), true);
    assert.equal(isValidCoordinate(0, 0), true);
    assert.equal(isValidCoordinate(-90, -180), true);
    assert.equal(isValidCoordinate(90, 180), true);
  });

  test('rejects out-of-range or NaN', () => {
    assert.equal(isValidCoordinate(91, 0), false);
    assert.equal(isValidCoordinate(-91, 0), false);
    assert.equal(isValidCoordinate(NaN, 0), false);
    assert.equal(isValidCoordinate(0, 181), false);
    assert.equal(isValidCoordinate(0, -181), false);
  });
});

describe('isValidNumber', () => {
  test('validates numbers within range', () => {
    assert.equal(isValidNumber(5, 0, 10), true);
    assert.equal(isValidNumber(0, 0, 10), true);
    assert.equal(isValidNumber(10, 0, 10), true);
  });

  test('rejects numbers outside range and NaN/Infinity', () => {
    assert.equal(isValidNumber(-1, 0, 10), false);
    assert.equal(isValidNumber(11, 0, 10), false);
    assert.equal(isValidNumber(NaN), false);
    assert.equal(isValidNumber(Infinity), false);
  });
});

describe('validatePoleData middleware', () => {
  test('calls next for valid data', () => {
    const { nextCalled } = run(validatePoleData, { lat: 40.7128, lng: -74.006, name: 'Pole 1' });
    assert.equal(nextCalled, true);
  });

  test('400s on invalid coordinates', () => {
    const { res, nextCalled } = run(validatePoleData, { lat: 100, lng: -74.006 });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /Invalid coordinates/);
  });

  test('sanitizes name', () => {
    const { req, nextCalled } = run(validatePoleData, {
      lat: 40.7128, lng: -74.006, name: '<script>alert(1)</script>',
    });
    assert.equal(nextCalled, true);
    assert.equal(req.body.name, 'alert(1)');
  });
});

describe('validateEnclosureData middleware', () => {
  test('REGRESSION: pole-mounted box without lat/lng is accepted', () => {
    // The "Add box" form sends only pole_id — this used to 400 and broke the flow.
    const { nextCalled } = run(validateEnclosureData, {
      pole_id: 'pole-uuid', code: 'BOX-1', type: 'nap', capacity: 48,
    });
    assert.equal(nextCalled, true);
  });

  test('customer box with lat/lng and no pole is accepted', () => {
    const { nextCalled } = run(validateEnclosureData, {
      lat: 34.0083, lng: 71.5788, code: 'BOX-2', type: 'terminal',
    });
    assert.equal(nextCalled, true);
  });

  test('400s when neither pole nor coordinates are given', () => {
    const { res, nextCalled } = run(validateEnclosureData, { code: 'BOX-3', type: 'nap' });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /pole_id or lat\/lng/);
  });

  test('400s on invalid coordinates when provided', () => {
    const { res, nextCalled } = run(validateEnclosureData, { lat: 100, lng: -74.006 });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /Invalid coordinates/);
  });
});

describe('validateCableData middleware', () => {
  const endpoints = { from_enclosure_id: 'a', to_enclosure_id: 'b' };

  test('REGRESSION: draw-cable payload (route_points as {lat,lng} objects) is accepted', () => {
    // The draw-cable form sends route_points objects + route_geometry pairs —
    // the old middleware demanded a `route` field and 400'd every creation.
    const { nextCalled } = run(validateCableData, {
      ...endpoints,
      cable_type: 'distribution',
      route_points: [{ lat: 34.0, lng: 71.5 }, { lat: 34.1, lng: 71.6 }],
      route_geometry: [[71.5, 34.0], [71.55, 34.05], [71.6, 34.1]],
    });
    assert.equal(nextCalled, true);
  });

  test('endpoints only (no geometry) is accepted — handler draws a straight line', () => {
    const { nextCalled } = run(validateCableData, { ...endpoints, cable_type: 'feeder' });
    assert.equal(nextCalled, true);
  });

  test('400s without from_enclosure_id', () => {
    const { res, nextCalled } = run(validateCableData, { cable_type: 'drop' });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /from_enclosure_id/);
  });

  test('400s on malformed geometry', () => {
    const { res, nextCalled } = run(validateCableData, {
      ...endpoints,
      route_geometry: [[71.5, 34.0], [200, 0]],
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /route_geometry\[1\]/);
  });

  test('400s on unknown cable_type', () => {
    const { res } = run(validateCableData, { ...endpoints, cable_type: 'aerial' });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /cable_type/);
  });
});

describe('validateCustomerData middleware', () => {
  test('calls next for valid data', () => {
    const { nextCalled } = run(validateCustomerData, {
      lat: 40.7128, lng: -74.006, name: 'John Doe', email: 'john@example.com',
    });
    assert.equal(nextCalled, true);
  });

  test('400s on invalid coordinates', () => {
    const { res } = run(validateCustomerData, { lat: 100, lng: -74.006, name: 'John Doe' });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /Invalid coordinates/);
  });

  test('sanitizes personal info', () => {
    const { req } = run(validateCustomerData, {
      lat: 40.7128, lng: -74.006,
      name: '<script>alert(1)</script>John',
      email: 'test<script>@example.com',
      phone: '123<script>456</script>',
    });
    assert.equal(req.body.name, 'alert(1)John');
    assert.equal(req.body.email, 'test@example.com');
    assert.equal(req.body.phone, '123456');
  });
});

describe('validateSpliceData middleware', () => {
  test('REGRESSION: the splice form payload is accepted', () => {
    // The form sends enclosure/core ids only — the old middleware demanded
    // cable_id + core_assignments and 400'd every splice.
    const { nextCalled } = run(validateSpliceData, {
      enclosure_id: 'box-1', core_a_id: 'core-1', core_b_id: 'core-2', technician: 'field-tech',
    });
    assert.equal(nextCalled, true);
  });

  test('400s on missing core ids', () => {
    const { res } = run(validateSpliceData, { enclosure_id: 'box-1' });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /core_a_id/);
  });

  test('400s when a core is spliced to itself', () => {
    const { res } = run(validateSpliceData, {
      enclosure_id: 'box-1', core_a_id: 'core-1', core_b_id: 'core-1',
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /itself/);
  });

  test('400s on bogus splice_type', () => {
    const { res } = run(validateSpliceData, {
      enclosure_id: 'box-1', core_a_id: 'core-1', core_b_id: 'core-2', splice_type: 'tape',
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('validateSplitterData middleware', () => {
  test('REGRESSION: the splitter form payload is accepted', () => {
    // The form sends split_count (2/4/8) — the old middleware demanded a
    // split_ratio between 1 and 128 and 400'd every splitter.
    const { nextCalled } = run(validateSplitterData, {
      enclosure_id: 'box-1', input_core_id: 'core-1', split_count: 4,
    });
    assert.equal(nextCalled, true);
  });

  test('400s on missing input core', () => {
    const { res } = run(validateSplitterData, { enclosure_id: 'box-1', split_count: 4 });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /input_core_id/);
  });

  test('400s on unsupported split_count', () => {
    const { res } = run(validateSplitterData, {
      enclosure_id: 'box-1', input_core_id: 'core-1', split_count: 3,
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /split_count/);
  });
});

describe('validateFiberCoreData middleware', () => {
  test('REGRESSION: PATCH with only a status is accepted', () => {
    // PATCH /fiber-cores/:id exists to flip a core's status — the old
    // middleware demanded cable_id + core_number and 400'd every update.
    const { nextCalled } = run(validateFiberCoreData, { status: 'damaged' });
    assert.equal(nextCalled, true);
  });

  test('400s on non-string status', () => {
    const { res } = run(validateFiberCoreData, { status: 42 });
    assert.equal(res.statusCode, 400);
  });
});
