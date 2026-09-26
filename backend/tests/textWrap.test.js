/**
 * Tests for the shared text wrapper (used by the splice worksheet and the
 * serviceability quote — both are read on an 80-column terminal or a phone).
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { wrapLine, wrapInto, labelledRow } = require('../src/utils/textWrap');

describe('wrapLine', () => {
  test('breaks on words and never exceeds the width', () => {
    const lines = wrapLine('the quick brown fox jumps over the lazy dog', { width: 20 });
    assert.ok(lines.every((line) => line.length <= 20), JSON.stringify(lines));
    assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog');
  });

  test('a long word is left alone rather than cut', () => {
    const lines = wrapLine('supercalifragilisticexpialidocious', { width: 10 });
    assert.deepEqual(lines, ['supercalifragilisticexpialidocious']);
  });

  test('the first line is indented, the rest hang', () => {
    const lines = wrapLine('one two three four five', { width: 16, indent: '- ', hanging: '  ' });
    assert.equal(lines[0].startsWith('- '), true);
    assert.ok(lines.slice(1).every((line) => line.startsWith('  ')));
  });

  test('blank text is an empty line, not no lines at all', () => {
    assert.deepEqual(wrapLine('', { indent: 'x' }), ['x']);
  });
});

describe('labelledRow', () => {
  test('lines the value up under the label', () => {
    const row = labelledRow('Serve from', 'NAP-14', { width: 40 });
    assert.match(row, /^Serve from: {5}NAP-14$/);
  });

  test('a long value wraps under itself, not under the label', () => {
    const row = labelledRow('Verdict', 'Can serve — a box is within drop range and can take the connection today', { width: 40 });
    for (const line of row.split('\n')) assert.ok(line.length <= 40, line);
    assert.equal(row.split('\n').length > 1, true);
  });
});

describe('wrapInto', () => {
  test('appends to an existing list of lines', () => {
    const lines = ['header'];
    wrapInto(lines, 'a wrapped sentence here', { width: 12 });
    assert.equal(lines[0], 'header');
    assert.ok(lines.length > 1);
  });
});
