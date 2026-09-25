import React from "react";
import { failureTitle, pathText, customerTitle, customerNote } from "../utils/impactOverlay.js";

/**
 * The outage report for a simulated failure: who is dark, how their light used
 * to reach them, and where a patch would bring them back.
 *
 * Purely presentational — App owns the request, this renders whatever
 * /api/impact/simulate returned (including its warnings, which are the honest
 * part: an unrooted network over-reports, and the panel says so instead of
 * quietly showing a wrong number).
 */

function RootStatus({ impact, headends, onSetNetworkRoot }) {
  const { headend, direction_resolved: resolved, failure } = impact;

  if (resolved) {
    return (
      <p className="impact-root">
        Light is traced from <b>{headend?.code || "the network root"}</b>
        {headend?.root_enclosure_code ? ` at ${headend.root_enclosure_code}` : ""} —
        everything below the failure is reported; the span that feeds it and every
        other branch are left alone.
      </p>
    );
  }

  return (
    <div className="impact-root impact-root-missing">
      <p>
        <b>No network root.</b> Without a headend/OLT the graph has no upstream
        direction, so the walk climbs back through the network too: the report can
        include the span that feeds the failure and branches that still have light.
      </p>
      {headends?.length > 0 && (
        <p>
          {headends.length} headend{headends.length === 1 ? "" : "s"} exist
          {headends[0]?.root_enclosure ? ` (${headends[0].code} → ${headends[0].root_enclosure.code})` : ""},
          but nothing at this failure point can trace back to one — check the
          feeder splices between here and the OLT.
        </p>
      )}
      {failure?.kind === "box" && onSetNetworkRoot && (
        <button
          className="btn btn-block"
          onClick={() => onSetNetworkRoot(failure.box_ids?.[0] || failure.id)}
        >
          Set {failure.label || "this box"} as the network root
        </button>
      )}
    </div>
  );
}

function RestorationOption({ option }) {
  const { viability, source_box_code, patch_box_code, available_cores, hops, approx_distance_m } = option;

  return (
    <div className="impact-option list-item">
      <div>
        <b>{option.restorable_count}</b>{" "}
        {option.restorable_count === 1 ? "customer" : "customers"} could be restored by
        patching at <b>{patch_box_code || "the failure point"}</b>
        {viability === "cabled" && source_box_code ? (
          <> from <b>{source_box_code}</b></>
        ) : null}
      </div>
      <div className="sub">
        {viability === "cabled" && (
          <>
            {available_cores} spare core{available_cores === 1 ? "" : "s"} at the source
            {hops != null && <> · {hops} hop{hops === 1 ? "" : "s"} away</>}
            {option.path?.length > 0 && (
              <> · via {option.path.map((step) => step.cable_code).filter(Boolean).join(" → ")}</>
            )}
          </>
        )}
        {viability === "new_span" && (
          <>
            No cable path back to a lit box — nearest lit source
            {option.nearest_source_box_code ? ` (${option.nearest_source_box_code})` : ""}
            {approx_distance_m != null && <> is {Math.round(approx_distance_m)} m away</>}
            {" "}— a new span would be needed.
          </>
        )}
        {viability === "unknown" && (
          <>No lit box with spare cores is reachable — this customer needs a new feed.</>
        )}
      </div>
      {option.restorable_customers?.length > 0 && (
        <div className="sub">
          {option.restorable_customers.map((c) => customerTitle(c)).join(", ")}
          {option.restorable_count > option.restorable_customers.length && " …"}
        </div>
      )}
    </div>
  );
}

export default function ImpactPanel({
  impact,
  loading,
  error,
  headends,
  onClear,
  onSimulate,
  onSetNetworkRoot,
}) {
  if (loading) {
    return <p className="empty-state">Simulating failure…</p>;
  }

  if (error) {
    return (
      <div className="impact-panel">
        <p className="section-title">Failure simulation</p>
        <p className="impact-error">{error}</p>
        <div className="impact-actions">
          {onSimulate && <button className="btn" onClick={onSimulate}>Try again</button>}
          <button className="btn btn-danger" onClick={onClear}>Clear</button>
        </div>
      </div>
    );
  }

  if (!impact) return null;

  const failure = impact.failure || {};
  const affected = impact.affected || {};
  const customers = affected.customers || [];
  const candidates = impact.upstream_reroute_candidates || [];
  const warnings = impact.warnings || [];
  // One cable is many fibres: a span that lost some of them is counted (and
  // drawn) apart from one that is gone.
  const cablesPartlyOut = affected.cables?.filter((cable) => cable.partially_dark).length ?? 0;
  const cablesFullyOut = (affected.cables?.length ?? 0) - cablesPartlyOut;

  return (
    <div className="impact-panel">
      <div className="impact-head">
        <div>
          <span className="pill pill-damaged">Failure simulated</span>
          <div className="impact-title">{failureTitle(impact)}</div>
          <div className="sub">
            {failure.kind}
            {failure.pole_radius_m ? ` · ${failure.pole_radius_m} m radius` : ""}
            {failure.kind === "pole" && (failure.cable_ids?.length || failure.box_ids?.length)
              ? ` · ${failure.box_ids?.length || 0} box(es), ${failure.cable_ids?.length || 0} span(s) on it`
              : ""}
          </div>
        </div>
        <button className="btn" onClick={onClear} title="Clear the simulated failure">
          Clear
        </button>
      </div>

      <RootStatus impact={impact} headends={headends} onSetNetworkRoot={onSetNetworkRoot} />

      <div className="summary-grid cols-3">
        <div className="summary-card">
          <div className="n">{affected.customer_count ?? 0}</div>
          <div className="l">customers dark</div>
        </div>
        <div className="summary-card">
          <div className="n">{affected.boxes?.length ?? 0}</div>
          <div className="l">boxes dark</div>
        </div>
        <div className="summary-card">
          <div className="n">{cablesFullyOut}</div>
          <div className="l">cables dark</div>
          {cablesPartlyOut > 0 && (
            <div className="l impact-inferred">+{cablesPartlyOut} partly out</div>
          )}
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="impact-warnings">
          {warnings.map((warning, index) => (
            <p key={index} className="impact-warning">
              {warning}
            </p>
          ))}
        </div>
      )}

      <p className="section-title">
        Affected customers ({affected.customer_count ?? 0})
      </p>
      {customers.length === 0 ? (
        <p className="empty-state">
          No customer is documented downstream of this {failure.kind}. Branches fed
          elsewhere are still lit.
        </p>
      ) : (
        <>
          {customers.map((customer) => (
            <details key={customer.key || customer.core_id} className="impact-customer">
              <summary>
                <span className="code">{customerTitle(customer)}</span>
                {customer.customer_name ? <span className="sub"> · {customer.customer_name}</span> : null}
                <span className="sub">
                  {" "}· {customer.hops ?? 0} hop{customer.hops === 1 ? "" : "s"} below the
                  failure
                  {customer.serving_box_code ? ` · served by ${customer.serving_box_code}` : ""}
                </span>
              </summary>
              <div className="sub">Path: {pathText(customer.path_through_failure) || "—"}</div>
              {customerNote(customer) && (
                <div className="sub impact-inferred">{customerNote(customer)}</div>
              )}
              {customer.patch_box_code && (
                <div className="sub">Re-splice at {customer.patch_box_code}</div>
              )}
            </details>
          ))}
          {affected.truncated && (
            <p className="empty-state">
              …and {Math.max((affected.customer_count ?? 0) - customers.length, 0)} more (list
              truncated).
            </p>
          )}
          {affected.unnamed_count > 0 && (
            <p className="empty-state">
              {affected.unnamed_count} of them have no customer record on file — they are
              counted from the network itself (a lit strand in a drop cable, a core landing in
              a customer box, or a terminated strand), and a label on the drop would name them.
            </p>
          )}
        </>
      )}

      <p className="section-title">Restoration</p>
      {candidates.length === 0 ? (
        <p className="empty-state">
          {impact.direction_resolved
            ? "No restoration candidate — nothing downstream could be re-fed from a lit box."
            : "Set a network root above to get patch suggestions."}
        </p>
      ) : (
        candidates.map((option) => (
          <RestorationOption key={option.patch_box_id || option.patch_box_code} option={option} />
        ))
      )}

      <div className="impact-actions">
        {onSimulate && (
          <button className="btn" onClick={onSimulate} title="Run the analysis again">
            Re-run
          </button>
        )}
        <button className="btn btn-danger" onClick={onClear}>
          Clear simulation
        </button>
      </div>
    </div>
  );
}
