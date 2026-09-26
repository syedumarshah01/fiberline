/**
 * Wrap text to a printable width.
 *
 * Born in the splice worksheet (`GET /api/work-orders/:id/text`, printed on an
 * 80-column thermal printer in a van) and now shared with the serviceability
 * quote, which a CSR reads out loud or pastes into a CRM. Both need the same
 * thing: break on words, keep a hanging indent, never exceed the width, and
 * return something (an empty line) rather than nothing when the text is blank.
 */

function wrapLine(text, { width = 78, indent = '', hanging = null } = {}) {
  const pad = hanging == null ? indent : hanging;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = null;
  for (const word of words) {
    const prefix = lines.length === 0 ? indent : pad;
    if (line == null) line = prefix + word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = pad + word;
    }
  }
  if (line != null) lines.push(line);
  return lines.length ? lines : [indent.trimEnd()];
}

/** Append `text` to `lines`, wrapped, with an optional hanging indent. */
function wrapInto(lines, text, options = {}) {
  for (const line of wrapLine(text, options)) lines.push(line);
  return lines;
}

/** A label/value row the way the worksheet prints them: `Label:        value`. */
function labelledRow(label, value, { width = 78, labelWidth = 16 } = {}) {
  const head = `${label}:`.padEnd(labelWidth);
  const wrapped = wrapLine(String(value ?? ''), {
    width,
    indent: head,
    hanging: ' '.repeat(labelWidth),
  });
  return wrapped.join('\n');
}

module.exports = { wrapLine, wrapInto, labelledRow };
