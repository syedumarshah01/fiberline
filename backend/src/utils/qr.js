/**
 * QR codes, generated in this codebase — no dependency, no network call, no
 * image service. A sticker on a pole has to keep working when the laptop that
 * printed it is gone, so the encoder lives here.
 *
 * Byte mode (any UTF-8 text), versions 1–10, all four error-correction levels,
 * mask chosen by the ISO/IEC 18004 penalty rules. That covers a URL to a box or
 * pole with plenty of room to spare: 271 bytes at level L, 213 at M, 151 at Q,
 * 119 at H. A payload that does not fit is refused with a message that says so
 * rather than silently truncating — a QR code that scans and shows the wrong box
 * is worse than one that never printed.
 *
 * Everything here is pure: `encode()` returns a boolean matrix, `toSvg()` renders
 * one. The tests check the matrices against the reference implementation's output
 * byte for byte (see tests/qr.test.js), because an encoder that is merely
 * self-consistent produces codes nothing can read.
 */

/** Total codewords (data + error correction) for versions 1–10. */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * Error-correction blocks, from the standard's table:
 *   [ecCodewordsPerBlock, blocks1, dataCodewords1, blocks2, dataCodewords2]
 * Versions 1–10, levels L, M, Q, H.
 */
const EC_BLOCKS = {
  L: [
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
  ],
};

/** Alignment-pattern centres per version (version 1 has none). */
const ALIGNMENT = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** The two-bit code each level carries in the format information. */
const EC_LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const LEVELS = Object.keys(EC_LEVEL_BITS);
const MIN_VERSION = 1;
const MAX_VERSION = 10;

class QrCapacityError extends Error {
  constructor(bytes, ec, max) {
    super(
      `${bytes} bytes is too long for a QR code this generator makes (up to ${max} at level ` +
        `${ec}, versions ${MIN_VERSION}–${MAX_VERSION}). Shorten the link or use a shorter host.`,
    );
    this.name = 'QrCapacityError';
    this.bytes = bytes;
    this.ec = ec;
    this.max = max;
  }
}

// --- Galois field GF(256), primitive polynomial 0x11D -------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // reduce modulo the primitive polynomial
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPolynomial(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon remainder of `data` divided by the generator polynomial. */
function errorCorrection(data, degree) {
  const generator = generatorPolynomial(degree);
  const remainder = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] ^= gfMul(generator[i + 1], factor);
    }
  }
  return remainder;
}

// --- codeword layout ----------------------------------------------------------

/** How many data bytes a version + level holds. */
function dataCodewords(version, ec) {
  const [ecPerBlock, blocks1, data1, blocks2, data2] = EC_BLOCKS[ec][version - 1];
  return blocks1 * data1 + blocks2 * data2 + 0 * ecPerBlock;
}

/** The capacity that matters to a caller: bytes of payload that still fit. */
function capacityBytes(version, ec) {
  const overhead = 4 + countBits(version); // mode indicator + character count
  return Math.floor((dataCodewords(version, ec) * 8 - overhead) / 8);
}

/** Byte-mode character-count field width: 8 bits up to version 9, 16 from 10. */
function countBits(version) {
  return version <= 9 ? 8 : 16;
}

/** The largest payload this generator accepts at a given level. */
function maxBytes(ec) {
  return capacityBytes(MAX_VERSION, ec);
}

function normalizeLevel(ec) {
  const level = String(ec ?? 'M').toUpperCase();
  if (!LEVELS.includes(level)) {
    throw new Error(`Unknown QR error-correction level "${ec}" — use one of ${LEVELS.join(', ')}.`);
  }
  return level;
}

function pickVersion(byteLength, ec) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    if (byteLength <= capacityBytes(version, ec)) return version;
  }
  throw new QrCapacityError(byteLength, ec, maxBytes(ec));
}

/** Data codewords, split into the standard's blocks and interleaved with EC. */
function buildCodewords(bytes, version, ec) {
  const [ecPerBlock, blocks1, data1, blocks2, data2] = EC_BLOCKS[ec][version - 1];
  const totalData = blocks1 * data1 + blocks2 * data2;

  // Bit stream: mode 0100 (byte), character count, payload, terminator, padding.
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  const capacityBits = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  // The two pad bytes alternate until the data capacity is full.
  for (let i = 0; data.length < totalData; i += 1) data.push(i % 2 === 0 ? 0xec : 0x11);

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < blocks1 + blocks2; i += 1) {
    const length = i < blocks1 ? data1 : data2;
    const block = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: block, ec: errorCorrection(block, ecPerBlock) });
  }

  // Interleave: all first data codewords, then all second, … then the EC blocks.
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

// --- module placement ---------------------------------------------------------

function blankGrid(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}

function placeFinder(modules, reserved, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= modules.length || x < 0 || x >= modules.length) continue;
      const onRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = onRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      modules[y][x] = dark;
      reserved[y][x] = true;
    }
  }
}

function placeAlignment(modules, reserved, version) {
  const size = modules.length;
  const centres = ALIGNMENT[version] || [];
  for (const row of centres) {
    for (const col of centres) {
      // Skip the three positions the finder patterns already own.
      const nearFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          modules[row + r][col + c] = dark;
          reserved[row + r][col + c] = true;
        }
      }
    }
  }
}

function placeTiming(modules, reserved) {
  const size = modules.length;
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    modules[6][i] = dark;
    reserved[6][i] = true;
    modules[i][6] = dark;
    reserved[i][6] = true;
  }
}

/** Reserve the format-information areas (and version info from version 7 up). */
function reserveInfoAreas(modules, reserved, version) {
  const size = modules.length;
  for (let i = 0; i < 9; i += 1) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        reserved[size - 11 + j][i] = true;
        reserved[i][size - 11 + j] = true;
      }
    }
  }
}

function applyMask(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

/** Lay the codewords out in the standard two-column zigzag. */
function mapData(modules, reserved, codewords, mask) {
  const size = modules.length;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // the vertical timing pattern column
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const x = col - c;
        if (reserved[row][x]) continue;
        let dark = false;
        if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
        if (applyMask(mask, row, x)) dark = !dark;
        modules[row][x] = dark;
        bitIndex -= 1;
        if (bitIndex === -1) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

function bitLength(value) {
  let length = 0;
  let v = value;
  while (v !== 0) {
    length += 1;
    v >>>= 1;
  }
  return length;
}

function placeFormatInfo(modules, version, ec, mask) {
  const size = modules.length;
  const data = (EC_LEVEL_BITS[ec] << 3) | mask;
  // BCH(15,5): divide by 0x537 (11 bits) until the remainder is 10 bits. The
  // bound is the *divisor's* width — stopping one bit early shifts by -1, which
  // JavaScript reads as a shift of 31, and the loop never ends.
  let remainder = data << 10;
  while (bitLength(remainder) - 11 >= 0) remainder ^= 0x537 << (bitLength(remainder) - 11);
  const bits = ((data << 10) | remainder) ^ 0x5412;

  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    // First copy, wound around the top-left finder.
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[size - 15 + i][8] = dark;
    // Second copy, split between the other two corners.
    if (i < 8) modules[8][size - i - 1] = dark;
    else if (i < 9) modules[8][15 - i - 1 + 1] = dark;
    else modules[8][15 - i - 1] = dark;
  }
  modules[size - 8][8] = true; // the always-dark module

  if (version >= 7) {
    // BCH(18,6), divisor 0x1F25 (13 bits) — same bound as above.
    let v = version << 12;
    while (bitLength(v) - 13 >= 0) v ^= 0x1f25 << (bitLength(v) - 13);
    const versionBits = (version << 12) | v;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((versionBits >> i) & 1) === 1;
      modules[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = dark;
      modules[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = dark;
    }
  }
}

// --- mask choice --------------------------------------------------------------

const PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };

function penaltyScore(modules) {
  const parts = penaltyBreakdown(modules);
  return parts.total;
}

/** The four rules separately — the tests compare them against a reference's. */
function penaltyBreakdown(modules) {
  const size = modules.length;
  let score = 0;
  const rules = { rule1: 0, rule2: 0, rule3: 0, rule4: 0 };

  // Rule 1: runs of five or more same-coloured modules in a line.
  const runScore = (get) => {
    let total = 0;
    for (let i = 0; i < size; i += 1) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        if (get(i, j) === get(i, j - 1)) {
          run += 1;
        } else {
          if (run >= 5) total += PENALTY.N1 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) total += PENALTY.N1 + (run - 5);
    }
    return total;
  };
  rules.rule1 += runScore((row, col) => modules[row][col]);
  rules.rule1 += runScore((col, row) => modules[row][col]);

  // Rule 2: 2×2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = modules[row][col];
      if (value === modules[row][col + 1] && value === modules[row + 1][col] && value === modules[row + 1][col + 1]) {
        rules.rule2 += PENALTY.N2;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const PATTERNS = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];
  const matches = (get, i, j, pattern) => {
    for (let k = 0; k < pattern.length; k += 1) {
      if (get(i, j + k) !== (pattern[k] === 1)) return false;
    }
    return true;
  };
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col + 11 <= size; col += 1) {
      for (const pattern of PATTERNS) {
        if (matches((r, c) => modules[r][c], row, col, pattern)) rules.rule3 += PENALTY.N3;
      }
    }
  }
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row + 11 <= size; row += 1) {
      for (const pattern of PATTERNS) {
        if (matches((c, r) => modules[r][c], col, row, pattern)) rules.rule3 += PENALTY.N3;
      }
    }
  }

  // Rule 4: how far the proportion of dark modules is from half, in whole 5%
  // steps. The step count is floored, which is what the reference implementations
  // do (python-qrcode: `int(abs(percent * 100 - 50) / 5)`, zxing the same in
  // integer arithmetic). Taking the fractional step instead — qrcode-generator
  // does that — changes which mask wins, and a different mask is a different
  // matrix that no longer diffs against a reference. See tests/qr.test.js.
  let dark = 0;
  for (const row of modules) for (const value of row) if (value) dark += 1;
  const percent = (dark * 100) / (size * size);
  rules.rule4 += Math.floor(Math.abs(percent - 50) / 5) * PENALTY.N4;

  score = rules.rule1 + rules.rule2 + rules.rule3 + rules.rule4;
  return { ...rules, total: score };
}

// --- the public API -----------------------------------------------------------

/**
 * Encode text as a QR matrix.
 *
 * @returns {{ text, ec, version, size, mask, modules: boolean[][] }}
 * @throws  {QrCapacityError} when the payload does not fit in version 10
 */
function encode(text, { ec = 'M' } = {}) {
  const value = String(text ?? '');
  const level = normalizeLevel(ec);
  const bytes = [...Buffer.from(value, 'utf8')];
  if (!bytes.length) throw new Error('Nothing to encode — a QR code needs some text.');
  const version = pickVersion(bytes.length, level);

  // Which mask wins is decided on the matrix *without* the format information —
  // its 30 modules left light. Both reference implementations do this
  // (python-qrcode's `makeImpl(test=True)` and qrcode-generator's
  // `setupTypeInfo(test=true)` write light modules there while scoring), so
  // following it is what lets the tests diff our matrices against theirs; zxing
  // scores with the format bits in place and picks a different mask sometimes.
  // Every one of those choices scans — the mask is recorded in the format
  // information — so the tie-breaker here is "can it be verified".
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = buildMatrix(value, { ec: level, mask, withFormatInfo: false });
    if (!best || candidate.score < best.score) best = candidate;
  }
  return encodeWithMask(value, { ec: level, mask: best.mask });
}

/**
 * Build the matrix for one specific mask. `encode()` uses it to score all eight
 * and keep the best; the tests use it to diff a single matrix against a reference
 * implementation, which is the only way to prove the encoder is right rather than
 * merely self-consistent.
 */
function encodeWithMask(text, { ec = 'M', mask = 0 } = {}) {
  return buildMatrix(text, { ec, mask, withFormatInfo: true });
}

function buildMatrix(text, { ec = 'M', mask = 0, withFormatInfo = true } = {}) {
  const value = String(text ?? '');
  const level = normalizeLevel(ec);
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) {
    throw new Error(`mask must be an integer 0-7 (got ${mask})`);
  }
  const bytes = [...Buffer.from(value, 'utf8')];
  const version = pickVersion(bytes.length, level);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version, level);

  const prototype = blankGrid(size);
  const reserved = blankGrid(size);
  placeFinder(prototype, reserved, 0, 0);
  placeFinder(prototype, reserved, 0, size - 7);
  placeFinder(prototype, reserved, size - 7, 0);
  placeAlignment(prototype, reserved, version);
  placeTiming(prototype, reserved);
  reserveInfoAreas(prototype, reserved, version);

  const modules = prototype.map((row) => [...row]);
  mapData(modules, reserved, codewords, mask);
  if (withFormatInfo) placeFormatInfo(modules, version, level, mask);
  return { text: value, ec: level, version, size, mask, modules, score: penaltyScore(modules) };
}

/** True when this text will fit in the codes this generator makes. */
function fits(text, { ec = 'M', maxVersion = MAX_VERSION } = {}) {
  try {
    const level = normalizeLevel(ec);
    // An empty payload is refused by encode(), so it does not "fit" either —
    // a caller asking this question is about to call encode().
    if (!String(text ?? '').length) return false;
    const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
    for (let version = MIN_VERSION; version <= maxVersion; version += 1) {
      if (bytes <= capacityBytes(version, level)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Render a QR code as an SVG string.
 *
 * One `<path>` of unit squares rather than a `<rect>` per module: a version 6
 * code is 41×41, and 900 rectangles per label adds up on a sheet of fifty.
 */
function toSvg(text, { ec = 'M', scale = 6, quiet = 4, dark = '#000000', light = '#ffffff', className = null, title = null } = {}) {
  const { modules, size, version, mask } = encode(text, { ec });
  const span = size + quiet * 2;
  const parts = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (modules[row][col]) parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
    }
  }
  const label = title ? `<title>${escapeXml(title)}</title>` : '';
  const cls = className ? ` class="${escapeXml(className)}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${cls} width="${span * scale}" height="${span * scale}" ` +
    `viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" ` +
    `data-qr-version="${version}" data-qr-mask="${mask}" data-qr-ec="${ec}">` +
    label +
    `<rect width="${span}" height="${span}" fill="${escapeXml(light)}"/>` +
    `<path d="${parts.join('')}" fill="${escapeXml(dark)}"/>` +
    '</svg>'
  );
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  encode,
  encodeWithMask,
  toSvg,
  fits,
  capacityBytes,
  maxBytes,
  dataCodewords,
  normalizeLevel,
  penaltyScore,
  penaltyBreakdown,
  QrCapacityError,
  LEVELS,
  MIN_VERSION,
  MAX_VERSION,
  MAX_BYTES: { L: maxBytes('L'), M: maxBytes('M'), Q: maxBytes('Q'), H: maxBytes('H') },
};
