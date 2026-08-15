/**
 * Generate the next internal code for assets whose codes users never type —
 * poles are anonymous mounting points, so their codes are auto-assigned.
 *
 * nextCode(["POLE-0001", "POLE-0009"], "POLE-") -> "POLE-0010"
 */
function nextCode(codes, prefix = "POLE-") {
  let max = 0;
  for (const code of codes || []) {
    const match = /^([^\d]*?)(\d+)$/.exec(String(code || "").trim());
    if (match && match[1] === prefix) {
      max = Math.max(max, parseInt(match[2], 10));
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

/**
 * Normalize a user-editable asset code (cable code, enclosure code, …) for a
 * PATCH update. Codes are identifiers users see and type, so they must be
 * non-empty readable strings; everything else is rejected with null.
 *
 * normalizeEditableCode("  CBL-0007 ") -> "CBL-0007"
 * normalizeEditableCode("")           -> null
 * normalizeEditableCode(42)           -> null
 */
function normalizeEditableCode(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

module.exports = { nextCode, normalizeEditableCode };
