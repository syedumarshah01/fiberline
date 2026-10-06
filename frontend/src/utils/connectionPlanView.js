export function formatPlanDistance(metres) {
  const value = Number(metres);
  if (!Number.isFinite(value)) return "unknown distance";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

export function routeBasis(route) {
  if (!route) return "No route measurement";
  if (route.source === "street_route") return `${formatPlanDistance(route.length_m)} street route`;
  return `${formatPlanDistance(route.length_m)} direct · haversine, not a street route`;
}

export function connectionChoiceLabel(connection) {
  if (!connection) return "Capacity choice not loaded";
  if (connection.type === "splitter_port") {
    const splitter = connection.splitter?.name || connection.splitter?.id || "the existing splitter";
    return `${splitter}, port ${connection.port?.port_number ?? "?"}`;
  }
  if (connection.type === "install_splitter_on_core") {
    return `Install ${connection.splitter?.name || "a splitter"} on core ${connection.core?.core_number ?? "?"} of ${connection.core?.cable_code || "the identified cable"}`;
  }
  if (connection.source?.source_enclosure) {
    const source = connection.source.source_enclosure.code || connection.source.source_enclosure.id;
    const core = connection.source.source_core?.core_number;
    return `Bring core ${core ?? "?"} from ${source}`;
  }
  return "Source capacity path required";
}

export function budgetTone(budget) {
  if (!budget || budget.status === "UNKNOWN") return "unknown";
  if (budget.status === "OK") return "ok";
  if (budget.status === "MARGINAL") return "warn";
  return "bad";
}

export function budgetSummary(budget) {
  if (!budget) return "Optical budget is not available";
  const remaining = Number(budget.remaining_margin_db);
  const margin = Number.isFinite(remaining) ? `${remaining.toFixed(2)} dB remaining` : "remaining margin unknown";
  if (budget.status === "UNKNOWN") return `Path incomplete · ${margin}`;
  if (budget.exceeds_budget) return `Exceeds ${budget.budget_db} dB OLT budget · ${margin}`;
  if (budget.consumes_required_margin) return `Only ${margin}; required ${budget.required_margin_db} dB`;
  return `${budget.status} · ${budget.total_loss_db} dB loss · ${margin}`;
}

export function planClipboardText(plan) {
  if (!plan) return "";
  const lines = [
    "CUSTOMER CONNECTION PLAN",
    `Enclosure: ${plan.enclosure?.code || plan.enclosure?.id || "unknown"}`,
    `Route basis: ${routeBasis(plan.route)}`,
    `Connection: ${connectionChoiceLabel(plan.connection)}`,
    `Optical budget: ${budgetSummary(plan.optical_budget)}`,
    "",
    "INSTALLATION STEPS:",
    ...(plan.steps || []).map((step, index) => `${index + 1}. ${step}`),
  ];
  if (plan.optical_budget?.breakdown?.length) {
    lines.push("", "LOSS BREAKDOWN:");
    for (const item of plan.optical_budget.breakdown) {
      lines.push(`${item.type}: ${item.loss_db == null ? "unknown" : `+${item.loss_db} dB`} · running ${item.running_db ?? "unknown"} dB`);
    }
  }
  if (plan.warnings?.length) lines.push("", "NOTES:", ...plan.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}
