/**
 * Pure formatting helpers for the splitter/port display in the box panel.
 * Kept free of React imports so they can be unit-tested with node:test.
 *
 * The panel must say the same thing about a splitter that the API computed —
 * the counts come from the backend's `port_summary` (one definition of "free
 * port" for the whole app), and these functions only phrase them for a human.
 * Nothing here recounts ports: a second counter is a second answer.
 */

/** "1:8" for a splitter, from the API's `ratio` or the stored split_count. */
export function splitterRatio(splitter) {
  if (!splitter) return null;
  if (splitter.ratio) return splitter.ratio;
  const n = Number(splitter.split_count);
  return Number.isFinite(n) && n > 0 ? `1:${n}` : null;
}

/** Does anything on this splitter still take a new drop? */
export function splitterHasFreePort(splitter) {
  return (splitter?.port_summary?.free ?? 0) > 0;
}

/**
 * The line under a splitter's name: what it is, how much of it is left, and
 * what it costs the light. A full splitter says "full" rather than "0 of 8
 * free", because "full" is the word that makes a person look for another box.
 */
export function splitterCapacityLine(splitter) {
  const ratio = splitterRatio(splitter);
  const summary = splitter?.port_summary;
  if (!summary) return ratio ? `${ratio} splitter` : "splitter";

  const parts = [];
  parts.push(ratio ? `${ratio} splitter` : "splitter");
  if (summary.total === 0) {
    parts.push("no ports recorded");
  } else if (summary.free > 0) {
    const numbers = summary.free_port_numbers || [];
    parts.push(
      `${summary.free} of ${summary.total} free${numbers.length ? ` (${numbers.join(", ")})` : ""}`,
    );
  } else {
    parts.push(`full — all ${summary.total} port${summary.total === 1 ? "" : "s"} taken`);
  }

  // Cascaded ports are worth naming: the splitter has a child on it, which is
  // neither a customer nor spare capacity, and it is the thing people forget.
  if (summary.cascaded > 0) {
    parts.push(`${summary.cascaded} feeding another splitter`);
  }
  if (summary.damaged > 0) {
    parts.push(`${summary.damaged} damaged`);
  }
  return parts.join(" · ");
}

/** "10.5 dB planned" / "9.12 dB measured" — never a bare number. */
export function splitterLossText(splitter) {
  const loss = splitter?.effective_loss_db;
  if (loss === null || loss === undefined || loss === "") return null;
  const value = Number(loss);
  if (Number.isNaN(value)) return null;
  return `${value} dB ${splitter.loss_measured ? "measured" : "planned"}`;
}

/**
 * What is on a port, in one cell: the customer's label when one is recorded
 * (that is what the tag on the drop says), otherwise what it feeds.
 */
export function portUsageText(port) {
  if (!port) return "—";
  if (port.usage === "cascaded" || port.output_splitter_id) {
    return `→ ${port.child_splitter_name || "splitter"}`;
  }
  if (port.customer_label) return port.customer_label;
  if (port.cable_code) return port.core_number ? `${port.cable_code} #${port.core_number}` : port.cable_code;
  if (port.output_core_id) return "core assigned";
  // Empty. Say so in a way that agrees with the count: the API will not count a
  // damaged port as free, so the cell must not read "free" either.
  return port.status === "damaged" || port.port_status === "damaged" ? "damaged — not usable" : "free";
}

/** Is this port marked damaged? Mirrors the API's portIsDamaged. */
export function portIsDamaged(port) {
  return Boolean(port && (port.status === "damaged" || port.port_status === "damaged"));
}

/** Pill text + css class for a port's state, matching the panel's Pill styles. */
export function portStatePill(port) {
  if (!port) return { text: "—", className: "pill" };
  if (port.status === "damaged" || port.port_status === "damaged") {
    return { text: "damaged", className: "pill pill-damaged" };
  }
  if (port.usage === "cascaded" || port.output_splitter_id) {
    return { text: "cascaded", className: "pill pill-reserved" };
  }
  if (port.output_core_id) return { text: "in use", className: "pill pill-spliced" };
  return { text: "free", className: "pill pill-available" };
}

/**
 * The box-level line above the splitter list: how much drop capacity this box
 * has across all of its splitters, in one sentence.
 */
export function boxCapacityLine(totals, splitterCount) {
  const count = totals?.splitters ?? splitterCount ?? 0;
  if (!count) return "No splitters documented in this box";
  if (!totals || !totals.ports) return `${count} splitter${count === 1 ? "" : "s"}`;
  if (totals.free_ports > 0) {
    return `${totals.free_ports} free port${totals.free_ports === 1 ? "" : "s"} across ${count} splitter${
      count === 1 ? "" : "s"
    }`;
  }
  return `All ${totals.ports} ports across ${count} splitter${count === 1 ? "" : "s"} are taken`;
}
