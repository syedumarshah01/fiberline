/**
 * Turns an /api/impact/simulate response into the few sets the map views need
 * to paint an outage, plus the small style overrides they apply.
 *
 * Kept pure and provider-free on purpose: the three map components (Leaflet,
 * Google, Mapbox) all need identical rules for "what is dark", and that is
 * exactly the kind of duplicate that drifts apart. The renderers stay dumb —
 * they ask here, then format the answer for their own API.
 */

/** The out-of-service color: same red as --red in the dark theme. */
export const FAILURE_COLOR = "#ef5350";

export const EMPTY_OVERLAY = Object.freeze({
  active: false,
  darkCableIds: new Set(),
  darkBoxIds: new Set(),
  failureCableIds: new Set(),
  failureBoxIds: new Set(),
  customersByBox: {},
  affectedCustomers: 0,
});

/**
 * @param {object|null} impact the simulate response, or null when nothing is simulated
 */
export function impactOverlay(impact) {
  if (!impact) return EMPTY_OVERLAY;

  const affected = impact.affected || {};
  const failure = impact.failure || {};

  // The response carries the affected boxes/cables as detail objects; accept a
  // plain id list too so the same helper works with slimmer payloads.
  const boxIds = affected.boxes?.length
    ? affected.boxes.map((box) => box.id)
    : affected.box_ids || [];
  const cableIds = affected.cables?.length
    ? affected.cables.map((cable) => cable.id)
    : affected.cable_ids || [];

  const customersByBox = {};
  for (const customer of affected.customers || []) {
    const boxId = customer.serving_box_id;
    if (!boxId) continue;
    customersByBox[boxId] = (customersByBox[boxId] || 0) + 1;
  }

  return {
    active: true,
    darkCableIds: new Set(cableIds),
    darkBoxIds: new Set(boxIds),
    failureCableIds: new Set(failure.cable_ids || []),
    failureBoxIds: new Set(failure.box_ids || []),
    customersByBox,
    affectedCustomers: affected.customer_count ?? 0,
  };
}

const PLURALS = { box: "boxes" };

function plural(count, word) {
  if (count === 1) return `1 ${word}`;
  return `${count} ${PLURALS[word] || `${word}s`}`;
}

/** One-line description of the outage, for the banner over the map. */
export function overlayHeadline(impact) {
  if (!impact) return "";
  const affected = impact.affected || {};
  const parts = [plural(affected.customer_count ?? 0, "customer")];
  // The response carries both the detail arrays and the id lists; either is
  // enough to count, so accept whichever one is present.
  const boxes = affected.boxes?.length ?? affected.box_ids?.length ?? 0;
  const cables = affected.cables?.length ?? affected.cable_ids?.length ?? 0;
  if (boxes) parts.push(plural(boxes, "box"));
  if (cables) parts.push(plural(cables, "cable"));
  return parts.join(" · ");
}

/** What the failure is, for headings: "BOX-B (box)". */
export function failureTitle(impact) {
  if (!impact?.failure) return "";
  return impact.failure.label || impact.failure.name || impact.failure.id || "";
}

/**
 * Style override for a cable that the outage has taken out. Returns null when
 * the cable is unaffected, so callers keep their normal styling.
 */
export function impactCableStyle(cableId, overlay) {
  if (!overlay?.active) return null;
  const isFailure = overlay.failureCableIds.has(cableId);
  const isDark = overlay.darkCableIds.has(cableId);
  if (!isFailure && !isDark) return null;
  return isFailure
    ? { color: FAILURE_COLOR, weight: 7, opacity: 1, dash: [5, 3], animated: false }
    : { color: FAILURE_COLOR, weight: 5, opacity: 1, dash: [12, 5], animated: false };
}

/** `{ dark, failed }` for a box marker. */
export function impactBoxState(boxId, overlay) {
  if (!overlay?.active) return { dark: false, failed: false };
  return {
    dark: overlay.darkBoxIds.has(boxId),
    failed: overlay.failureBoxIds.has(boxId),
  };
}

/**
 * How many affected customers sit behind a box — shown as a badge on the
 * marker so the field tech can see where the customers are without opening
 * the panel.
 */
export function customersBehind(boxId, overlay) {
  return overlay?.customersByBox?.[boxId] || 0;
}

/**
 * What to call an affected customer leg.
 *
 * Documented premises carry a label; legs the analysis inferred from the
 * network itself (a lit strand in a drop cable, a core landing in a customer
 * box) have none. A blank row would read as "nobody", so name what it is and
 * which cable it is on.
 */
export function customerTitle(customer) {
  if (!customer) return "";
  if (customer.customer_label) return customer.customer_label;
  if (customer.customer_name) return customer.customer_name;
  const cable = customer.cable_code ? ` on ${customer.cable_code}` : "";
  switch (customer.source) {
    case "customer_box":
      return `Customer box${cable}`;
    case "terminated":
      return `Unlabelled termination${cable}`;
    case "drop":
      return `Unlabelled drop${cable}`;
    default:
      return `Unlabelled customer${cable}`;
  }
}

/**
 * Why this leg counts as a customer, when it has no label to prove it. Empty
 * for properly documented customers.
 */
export function customerNote(customer) {
  if (!customer || customer.customer_label || customer.customer_name) return "";
  switch (customer.source) {
    case "customer_box":
      return "no customer record, but a lit core lands in a customer box";
    case "drop":
      return "no customer record, but a drop cable exists to reach one premises";
    case "terminated":
      return "no customer record, but the strand is marked terminated";
    default:
      return "no customer record on this leg";
  }
}

/**
 * The path a customer's light used to take, as a readable chain:
 * "CBL-D1 → splitter @ BOX-B → CBL-DROP-1".
 */
export function pathText(pathItems) {
  const parts = [];
  for (const item of pathItems || []) {
    if (item.kind === "fiber") {
      const core = item.core_number != null ? ` #${item.core_number}` : "";
      parts.push(`${item.cable_code || "fiber"}${core}`);
      continue;
    }
    const where = item.box_code ? ` @ ${item.box_code}` : "";
    if (item.kind === "splitter") {
      parts.push(`splitter${where}`);
    } else if (item.kind === "splitter_cascade") {
      parts.push(`cascade${where}`);
    } else if (item.kind === "splitter_input") {
      parts.push(`in${where}`);
    } else if (item.kind === "splitter_port") {
      parts.push(`port${item.port_number != null ? ` ${item.port_number}` : ""}${where}`);
    } else if (item.kind === "splice") {
      parts.push(`splice${where}`);
    } else if (item.kind === "continuation") {
      // A closure inserted mid-span: the same fiber carries on through the box.
      parts.push(`through ${item.box_code || "closure"}`);
    }
  }
  return parts.join(" → ");
}
