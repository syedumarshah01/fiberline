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

module.exports = { nextCode };
