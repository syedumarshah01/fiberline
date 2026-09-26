/**
 * The QR encoder, pinned to a reference implementation.
 *
 * A QR code that is wrong in one bit still looks like a QR code — so "it renders
 * something" proves nothing. Every fixture below was produced by python-qrcode
 * (a mature, widely-used encoder) for the same payload and error-correction
 * level, and this file asserts our matrix is identical to it: same version, same
 * mask pattern, same modules, hashed. The two full matrices kept below are there
 * so a failure can be read rather than only reported.
 *
 * The harness that produced these ran 204 payloads across all four levels and
 * versions 1-10 through both checks: byte-for-byte against the reference, and a
 * real decoder (OpenCV) reading them back. The eight payloads OpenCV could not
 * decode were ones it could not decode from the reference's matrix either.
 * Regenerate the digests with `node -e "..."` — or trust them; they are a hash of
 * what the reference produced, not of what this file produces.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  encode,
  encodeWithMask,
  toSvg,
  fits,
  capacityBytes,
  maxBytes,
  normalizeLevel,
  penaltyBreakdown,
  QrCapacityError,
  MAX_BYTES,
} = require('../src/utils/qr');

/** Each fixture: what the payload is, and what the reference encoder produced. */
const FIXTURES = [
  {
    text: "BOX-MID-12",
    ec: 'M',
    version: 1,
    size: 21,
    sha256: '0dced9b195b582ee4116170872116bd39ff7f589a925d21fd90e40c98e1ad837',
  },
  {
    text: "fiberline",
    ec: 'L',
    version: 1,
    size: 21,
    sha256: '690016ea77c7f53028161a4f8584aec0ba3fb7be32d26cf783dbec7c30642827',
  },
  {
    text: "CBL-F1-B",
    ec: 'Q',
    version: 1,
    size: 21,
    sha256: '369bc37f811782dcf101cca7f3a9612de5b736bceacf20ededeafb5c3515c2a5',
  },
  {
    text: "http://192.168.1.44:5173/?box=11111111-2222-3333-4444-555555555555",
    ec: 'M',
    version: 5,
    size: 37,
    sha256: '5e484b9e989ed8a4805e48b0ec161a3b8b3a8dfb8d1c4222063408bb36989702',
  },
  {
    text: "http://10.0.0.7/?pole=22222222-3333-4444-5555-666666666666",
    ec: 'Q',
    version: 5,
    size: 37,
    sha256: 'bbfbe6a7c41d1119660a6b0820aadd5cb7824f51d78beeb2b5a23f9eb07ce3cd',
  },
  {
    text: "https://fiberline.example.net/?box=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&tab=splices",
    ec: 'L',
    version: 5,
    size: 37,
    sha256: '0defbac2a78d209b7f4fc4387ed6ef7a33c74a366965d7792b4b772af899af54',
  },
  {
    text: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ec: 'H',
    version: 5,
    size: 37,
    sha256: 'f00429b3badf531c18a2095c659b735c3f0b27b98da0b1f0b06bf96d330dde57',
  },
  {
    text: "قطب ۱۱۲ / باکس BOX-NAP-4",
    ec: 'H',
    version: 4,
    size: 33,
    sha256: 'ae618fcc6e9c44b8f150bf2402d6de88105b25e5d0126d69a6fc37a98dcda6f8',
  },
  {
    text: "Sheet 7 · tray 3 · CBL-F1-B #4 ↔ CBL-DROP-9 #1",
    ec: 'M',
    version: 4,
    size: 33,
    sha256: '4f3c14c3746de23b407695393824a6720b220912398ffbe58fd75661dd5ec2e1',
  },
  {
    text: "v10 case yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
    ec: 'Q',
    version: 9,
    size: 53,
    sha256: 'c718d01389143f076a484501b3668d86bdb09e00d07921af200ee306dbf35ac1',
  }
];

// 'fiberline' at level L (version 1) — kept in full so a failure can be read, not just reported
const MATRIX_FIBERLINE_L = [
  "#######.....#.#######",
  "#.....#...#.#.#.....#",
  "#.###.#...###.#.###.#",
  "#.###.#.#.#.#.#.###.#",
  "#.###.#.##..#.#.###.#",
  "#.....#..#.#..#.....#",
  "#######.#.#.#.#######",
  ".....................",
  "##...###...#....##...",
  ".##..#.##.####.......",
  "#..#.##.##..#.#..###.",
  "...##...#..###.#.##.#",
  ".######.#.####.#.#..#",
  "........#.#.##..#.#.#",
  "#######.#..#.#.....#.",
  "#.....#.#.#...#.#####",
  "#.###.#..###....#...#",
  "#.###.#..#.####.###..",
  "#.###.#..#.###..#.###",
  "#.....#.#######.###..",
  "#######.##..#..#.#.#.",
];
// a box deep link at level M (version 3) — the shape this app actually prints
const MATRIX_BOX_URL_M = [
  "#######..#.#....#.........#...#######",
  "#.....#...#.##....#.#.###..##.#.....#",
  "#.###.#.###..##.#....###..###.#.###.#",
  "#.###.#.#.##.#.####.#..###.##.#.###.#",
  "#.###.#.#.##.#####.#.####.....#.###.#",
  "#.....#.##.##....#..##....##..#.....#",
  "#######.#.#.#.#.#.#.#.#.#.#.#.#######",
  "........#.....##.##..####.#.#........",
  "#.#####..#..##.##....#..##..#.#####..",
  "#.####.#####...#..#.#.#.###..#...#.#.",
  "..#.#.##..#.#.###.##..#..####.....###",
  ".#####..##..#.##...####....#####.#..#",
  ".#.#.##...#.#########.#..#.#..###.###",
  "##..#.....#####....#...##.#..#.....#.",
  ".###..##..#....#..#.#.#...##.###.#..#",
  "#..###...#..#..........#..##..#....##",
  "#.#..##....#...#..#.###..#..#.###.##.",
  "##.....#####.#.##....#.##.#..#...#.#.",
  ".#..####.#.###....#.#.....###.#...###",
  "..#.##.##..###..#....#.....##..#.#..#",
  ".#..#.##.##.#.#.###.#.#..#.##.###.#..",
  ".#..#..##.##.....#.#.#.##.#......#...",
  ".###.##.#...####.#..##....##.#####..#",
  "##.#...##.#####..##..##.#.#.#.####...",
  "###.####.###..###....#...#.##.###.#.#",
  "##......#.##.###..#.#.###.#......#...",
  "#...#.##.###.#.##.##..#...####.#..###",
  "#.###..#.###.#.#...####....##..###...",
  "#.##..##...#.#.######.#..#.######.#.#",
  "........#.##.#.....#..###.#.#...####.",
  "#######......#.##.#.#.#...#.#.#.###.#",
  "#.....#.##.##.###...#.....###...##...",
  "#.###.#.###...#...#####..#.########.#",
  "#.###.#.#########......####...#.##..#",
  "#.###.#.#...#.....#.##...#.#.#....###",
  "#.....#..#....#.#....#......##.###..#",
  "#######.##.##.#..##.#....#.#.########",
];

/** The grid as the digest sees it: 1/0 per module, row by row. */
function gridOf(modules) {
  return modules.map((row) => row.map((value) => (value ? '1' : '0')).join('')).join('');
}

const digest = (modules) => crypto.createHash('sha256').update(gridOf(modules)).digest('hex');
const parse = (rows) => rows.map((row) => [...row].map((char) => char === '#'));

/** The 15 format bits, read back out of a matrix — both copies. */
function readFormatInfo(modules) {
  const size = modules.length;
  const first = [];
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) first.push(modules[i][8]);
    else if (i < 8) first.push(modules[i + 1][8]);
    else first.push(modules[size - 15 + i][8]);
  }
  const second = [];
  for (let i = 0; i < 15; i += 1) {
    if (i < 8) second.push(modules[8][size - i - 1]);
    else if (i < 9) second.push(modules[8][15 - i - 1 + 1]);
    else second.push(modules[8][15 - i - 1]);
  }
  return { first, second };
}

const bitsToNumber = (bits) => bits.reduce((value, bit, index) => value + (bit ? 1 : 0) * 2 ** index, 0);

describe('encode — byte for byte against the reference encoder', () => {
  for (const fixture of FIXTURES) {
    test(`${JSON.stringify(fixture.text.slice(0, 38))} at ${fixture.ec}`, () => {
      const result = encode(fixture.text, { ec: fixture.ec });
      assert.equal(result.version, fixture.version, 'same version as the reference');
      assert.equal(result.size, fixture.size, `size is 4*version+17`);
      assert.equal(
        digest(result.modules),
        fixture.sha256,
        'same mask and same modules as the reference — see the file header',
      );
    });
  }

  test('the level is normalised, and a bad one is refused by name', () => {
    assert.equal(encode('x', { ec: 'm' }).ec, 'M');
    assert.throws(() => normalizeLevel('Z'), /Unknown QR error-correction level "Z"/);
  });

  test('the same input always produces the same matrix', () => {
    const a = encode('BOX-MID-12', { ec: 'M' });
    const b = encode('BOX-MID-12', { ec: 'M' });
    assert.equal(digest(a.modules), digest(b.modules));
  });
});

describe('full matrices, for reading a failure', () => {
  test('version 1, level L', () => {
    assert.deepEqual(encode('fiberline', { ec: 'L' }).modules, parse(MATRIX_FIBERLINE_L));
  });

  test('a box deep link, level M', () => {
    const url = 'http://192.168.1.44:5173/?box=11111111-2222-3333-4444-555555555555';
    assert.deepEqual(encode(url, { ec: 'M' }).modules, parse(MATRIX_BOX_URL_M));
  });
});

describe('the structure of a symbol (checks that need no reference)', () => {
  const fixtures = [
    ['BOX-MID-12', 'M'],
    ['http://10.0.0.7/?pole=22222222-3333-4444-5555-666666666666', 'Q'],
    ['x'.repeat(40), 'H'],
  ];

  test('finder patterns and their separators sit in three corners', () => {
    for (const [text, ec] of fixtures) {
      const { modules, size } = encode(text, { ec });
      const corner = [[0, 0], [0, size - 7], [size - 7, 0]];
      for (const [row, col] of corner) {
        assert.equal(modules[row][col], true, 'outer ring');
        assert.equal(modules[row + 1][col + 1], false, 'separator ring');
        assert.equal(modules[row + 2][col + 2], true, 'inner block starts');
        assert.equal(modules[row + 3][col + 3], true, 'inner block');
        assert.equal(modules[row + 4][col + 4], true, 'inner block');
        assert.equal(modules[row + 5][col + 5], false, 'inner block ends');
      }
    }
  });

  test('the timing patterns alternate, starting dark at the eighth module', () => {
    for (const [text, ec] of fixtures) {
      const { modules, size } = encode(text, { ec });
      for (let i = 8; i < size - 8; i += 1) {
        assert.equal(modules[6][i], i % 2 === 0, `row 6 column ${i}`);
        assert.equal(modules[i][6], i % 2 === 0, `column 6 row ${i}`);
      }
    }
  });

  test('the module beside the bottom-left finder is always dark', () => {
    for (const [text, ec] of fixtures) {
      const { modules, size } = encode(text, { ec });
      assert.equal(modules[size - 8][8], true);
    }
  });

  test('both copies of the format information agree, and carry this level and mask', () => {
    const ecBits = { L: 1, M: 0, Q: 3, H: 2 };
    for (const [text, ec] of fixtures) {
      const { modules, mask, ec: level } = encode(text, { ec });
      const { first, second } = readFormatInfo(modules);
      assert.deepEqual(second, first, 'the two copies are the same 15 bits');
      const value = bitsToNumber(first) ^ 0x5412;
      const data = value >> 10;
      assert.equal((data >> 3) & 0b11, ecBits[level], 'the level bits match the requested level');
      assert.equal(data & 0b111, mask, 'the mask bits match the mask that was applied');
      // and the BCH remainder is consistent: re-encode the 5 data bits and compare
      let remainder = data << 10;
      const bitLength = (v) => { let n = 0; let x = v; while (x) { n += 1; x >>>= 1; } return n; };
      while (bitLength(remainder) - 11 >= 0) remainder ^= 0x537 << (bitLength(remainder) - 11);
      assert.equal(((data << 10) | remainder) ^ 0x5412, bitsToNumber(first), 'valid BCH(15,5)');
    }
  });

  test('version 7 and up carry their version in both version blocks', () => {
    const { version, size, modules } = encode('x'.repeat(120), { ec: 'Q' });
    assert.ok(version >= 7, `expected a version that needs version info, got ${version}`);
    // The two blocks are written in different orientations: the top-right one is
    // 6 rows by 3 columns, the bottom-left one is 3 rows by 6 columns. Both are
    // read least-significant-bit first.
    const topRight = () => {
      let value = 0;
      for (let i = 0; i < 18; i += 1) {
        value += (modules[Math.floor(i / 3)][size - 11 + (i % 3)] ? 1 : 0) * 2 ** i;
      }
      return value;
    };
    const bottomLeft = () => {
      let value = 0;
      for (let i = 0; i < 18; i += 1) {
        value += (modules[size - 11 + (i % 3)][Math.floor(i / 3)] ? 1 : 0) * 2 ** i;
      }
      return value;
    };
    const bitLength = (v) => { let n = 0; let x = v; while (x) { n += 1; x >>>= 1; } return n; };
    let remainder = version << 12;
    while (bitLength(remainder) - 13 >= 0) remainder ^= 0x1f25 << (bitLength(remainder) - 13);
    const expected = (version << 12) | remainder;
    for (const [label, value] of [['top-right', topRight()], ['bottom-left', bottomLeft()]]) {
      assert.equal(value, expected, `the ${label} version block holds version ${version} and its BCH remainder`);
    }
  });

  test('a mask that is not 0-7 is refused', () => {
    assert.throws(() => encodeWithMask('x', { mask: 8 }), /mask must be an integer 0-7/);
  });
});

describe('capacity', () => {
  test('the documented limits are where refusals start', () => {
    for (const [level, limit] of Object.entries(MAX_BYTES)) {
      assert.equal(maxBytes(level), limit);
      assert.equal(fits('x'.repeat(limit), { ec: level }), true, `${level} fits at its limit`);
      assert.equal(fits('x'.repeat(limit + 1), { ec: level }), false, `${level} refuses one more`);
    }
  });

  test('a payload too long is refused, and says what would fit', () => {
    assert.throws(
      () => encode('x'.repeat(MAX_BYTES.H + 1), { ec: 'H' }),
      (err) => {
        assert.ok(err instanceof QrCapacityError, 'a typed error, so callers can tell it apart');
        assert.match(err.message, /too long for a QR code this generator makes/);
        assert.match(err.message, /up to 119 at level H/);
        assert.match(err.message, /Shorten the link/);
        return true;
      },
    );
  });

  test('an empty payload is refused rather than encoded', () => {
    assert.throws(() => encode(''), /Nothing to encode/);
  });

  test('a multi-byte character is measured in bytes, not characters', () => {
    // 'قطب' is 3 characters, 6 bytes — capacity is bytes.
    assert.equal(fits('ق'.repeat(60), { ec: 'L' }), true);
    assert.equal(fits('ق'.repeat(136), { ec: 'L' }), false, '136 Arabic letters are 272 bytes');
    assert.equal(capacityBytes(10, 'L'), MAX_BYTES.L);
    assert.equal(capacityBytes(1, 'M'), 14);
  });

  test('fits() agrees with encode() about what it will accept', () => {
    assert.equal(fits('x'.repeat(10000), { ec: 'M' }), false, 'far too long');
    assert.equal(fits('', { ec: 'M' }), false, 'an empty payload is refused by encode(), so it does not fit');
    assert.equal(fits('BOX-MID-12', { ec: 'M' }), true);
    assert.equal(fits('BOX-MID-12', { ec: 'nonsense' }), false, 'an unknown level is not a fit');
  });
});

describe('toSvg', () => {
  test('draws one path of unit squares, sized for the label', () => {
    const svg = toSvg('BOX-MID-12', { ec: 'M', scale: 4, quiet: 2 });
    const { modules, size, version, mask } = encode('BOX-MID-12', { ec: 'M' });
    const span = size + 4;
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, new RegExp(`width="${span * 4}" height="${span * 4}"`));
    assert.match(svg, new RegExp(`viewBox="0 0 ${span} ${span}"`));
    assert.match(svg, /shape-rendering="crispEdges"/);
    assert.match(svg, new RegExp(`data-qr-version="${version}" data-qr-mask="${mask}" data-qr-ec="M"`));
    const dark = modules.flat().filter(Boolean).length;
    const squares = (svg.match(/M\d+ \d+h1v1h-1z/g) || []).length;
    assert.equal(squares, dark, 'one square per dark module');
    assert.match(svg, new RegExp(`<rect width="${span}" height="${span}" fill="#ffffff"\/>`));
  });

  test('a title and class are escaped, never injected', () => {
    const svg = toSvg('x', { title: '<script>alert("x")</script>', className: 'qr" onload="x' });
    assert.doesNotMatch(svg, /<script>/);
    assert.match(svg, /&lt;script&gt;/);
    assert.doesNotMatch(svg, /onload="x"/);
  });

  test('the quiet zone is real: nothing is drawn in it', () => {
    const svg = toSvg('x', { quiet: 4 });
    for (const match of svg.match(/M(\d+) (\d+)h1v1h-1z/g) || []) {
      const [, x, y] = match.match(/M(\d+) (\d+)/);
      assert.ok(Number(x) >= 4 && Number(y) >= 4, `module at ${x},${y} is inside the quiet zone`);
    }
  });
});

describe('scoring', () => {
  test('the four penalty rules are reported separately', () => {
    const { modules } = encode('BOX-MID-12', { ec: 'M' });
    const parts = penaltyBreakdown(modules);
    for (const rule of ['rule1', 'rule2', 'rule3', 'rule4']) {
      assert.equal(typeof parts[rule], 'number', rule);
    }
    assert.equal(parts.total, parts.rule1 + parts.rule2 + parts.rule3 + parts.rule4);
  });

  test('the chosen mask is the one with the lowest score', () => {
    const { mask } = encode('BOX-MID-12', { ec: 'M' });
    const scores = [];
    for (let candidate = 0; candidate < 8; candidate += 1) {
      scores.push(encodeWithMask('BOX-MID-12', { ec: 'M', mask: candidate }).score);
    }
    assert.equal(mask, scores.indexOf(Math.min(...scores)));
  });
});
