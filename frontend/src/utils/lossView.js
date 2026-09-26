/**
 * Pure formatting/classification helpers for the loss-budget UI. Kept free of
 * React/db imports so they can be unit-tested with node:test directly.
 */

/** Display labels for the OLT/transport types the backend budgets. */
export const OLT_TYPE_LABELS = {
  gpon: "GPON",
  xgs_pon: "XGS-PON",
  p2p: "P2P",
};

/** Format a dB value with two decimals ("0.35"); null → "—". */
export function formatDb(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Color class for a breakdown entry: flagged bad splice (red) beats measured
 * (teal) beats assumed-default (amber). Fiber entries with unknown length or
 * a re-visited cable also read as "assumed/attention".
 */
export function lossEntryClass(entry) {
  if (!entry) return "loss-neutral";
  if (entry.flagged === "bad_splice") return "loss-flagged";
  if (entry.measured === true) return "loss-measured";
  if (entry.measured === false) return "loss-assumed";
  if (entry.length_missing || entry.duplicate_cable) return "loss-assumed";
  return "loss-neutral";
}

/** Where the number came from — the tooltip/legend next to each dB value. */
export function lossSourceLabel(entry) {
  if (!entry) return "";
  if (entry.flagged === "bad_splice") return "bad splice — re-splice";
  if (entry.measured === true) return "measured";
  if (entry.measured === false) return "assumed (default)";
  if (entry.length_missing) return "length unknown";
  if (entry.duplicate_cable) return "same cable — not re-counted";
  if (entry.type === "fiber") return "calculated";
  return "";
}

/** Status → color class for the budget summary card. */
export function budgetStatusClass(status) {
  if (status === "OK") return "loss-status-ok";
  if (status === "MARGINAL") return "loss-status-marginal";
  return "loss-status-fail";
}

/**
 * Color class for a splice's recorded loss in the box documentation table:
 * red when it exceeds the bad-splice threshold, teal when it's a healthy
 * measured reading, neutral when there is no reading at all.
 */
export function spliceLossClass(lossDb, thresholdDb = 0.5) {
  if (lossDb === null || lossDb === undefined || lossDb === "") return "loss-neutral";
  const n = Number(lossDb);
  if (Number.isNaN(n)) return "loss-neutral";
  return n > thresholdDb ? "loss-flagged" : "loss-measured";
}

/** Short label for a splitter breakdown entry, e.g. "Tray A · 1:4". */
export function splitterLabel(entry) {
  if (!entry) return "splitter";
  const ratio = entry.split_count ? `1:${entry.split_count}` : "";
  return [entry.name || ratio, entry.name ? ratio : null].filter(Boolean).join(" · ") || "splitter";
}
