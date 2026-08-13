/**
 * Helpers for the visual box documentation: assigning each splice a stable
 * "pair" identity (tag + color) so it is unambiguous which core is spliced to
 * which. Both endpoint port dots, the connecting wire, and the splice-map row
 * share the same tag and color.
 */

// Ten visually distinct colors drawn from the app palette. Splices beyond the
// tenth reuse the palette — the numeric tag stays unique, so pairs remain
// traceable even then.
export const PAIR_COLORS = [
  "#3fd0c9", // teal
  "#f0b429", // amber
  "#8b7cf6", // violet
  "#ff6b35", // coral
  "#4f9cf9", // blue
  "#f472b6", // pink
  "#a3e635", // lime
  "#ef5350", // red
  "#22d3ee", // cyan
  "#e2e8f0", // pale
];

/** Tag shown next to a splice's endpoints, e.g. "S1", "S2". 1-based because
 *  it is a human-facing ordinal, not an array index. */
export function pairTag(index) {
  return `S${index + 1}`;
}

export function pairColor(index) {
  return PAIR_COLORS[index % PAIR_COLORS.length];
}

/**
 * Build a lookup of core id → { tag, color, splice } for every core that is
 * part of a splice, in document order. Used to decorate the endpoint ports.
 *
 * Note: a core can appear in several splices (branching chains a spliced IN
 * core to multiple OUT cores). The map keeps the FIRST assignment for the
 * port badge; the wires themselves are drawn per splice regardless.
 */
export function splicePairsByCore(splices) {
  const byCore = new Map();
  (splices || []).forEach((s, i) => {
    const pair = { tag: pairTag(i), color: pairColor(i), splice: s };
    if (s.core_a_id && !byCore.has(s.core_a_id)) byCore.set(s.core_a_id, pair);
    if (s.core_b_id && !byCore.has(s.core_b_id)) byCore.set(s.core_b_id, pair);
  });
  return byCore;
}
