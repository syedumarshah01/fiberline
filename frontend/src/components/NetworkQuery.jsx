import React, { useState } from "react";
import { api } from "../api";

const EXAMPLES = [
  "Which customers are affected if pole 42 goes down?",
  "Show me every box within 500m of 12 Main Street with spare capacity",
];

function metres(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${Math.round(amount)} m` : "—";
}

export default function NetworkQuery({ onClose }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.networkQuery(query.trim()));
    } catch (requestError) {
      // Validation/clarification responses are still useful to the person asking;
      // a provider/configuration error should remain visibly an error.
      if (requestError.details?.intent || requestError.details?.status) setResult(requestError.details);
      else setError(requestError.details?.error || requestError.message);
    } finally {
      setLoading(false);
    }
  }

  const answer = result?.answer;
  const interpretation = result?.interpretation;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="network-query" role="dialog" aria-modal="true" aria-label="Ask the network">
        <div className="user-management-header">
          <div>
            <p className="section-title" style={{ margin: 0 }}>Ask the network</p>
            <p className="empty-state">Ask a question in plain language. The answer is computed from the network graph.</p>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        <form className="network-query-form" onSubmit={submit}>
          <label htmlFor="network-query-input">Network question</label>
          <textarea
            id="network-query-input"
            rows="3"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Which customers are affected if pole 42 goes down?"
            autoFocus
          />
          <div className="network-query-actions">
            <button className="btn btn-primary" type="submit" disabled={loading || !query.trim()}>{loading ? "Querying graph…" : "Ask"}</button>
          </div>
        </form>

        <div className="network-query-examples">
          <small>Try an example:</small>
          {EXAMPLES.map((example) => <button className="link-button" key={example} onClick={() => setQuery(example)}>{example}</button>)}
        </div>

        {error && <p className="error-row" role="alert">{error}</p>}
        {result?.message && <p className={result.status === "ok" ? "query-note" : "error-row"}>{result.message}</p>}

        {result?.status === "needs_clarification" && result.candidates?.length > 0 && (
          <div className="query-results"><b>Possible poles</b>{result.candidates.map((candidate) => <div className="query-row" key={candidate.id}>{candidate.code}{candidate.name ? ` — ${candidate.name}` : ""}</div>)}</div>
        )}
        {result?.status === "needs_location" && result.location?.candidates?.length > 0 && (
          <div className="query-results"><b>Possible locations</b>{result.location.candidates.map((candidate) => <div className="query-row" key={`${candidate.kind}-${candidate.id}`}><span><b>{candidate.label || candidate.code || candidate.name}</b>{candidate.address && <small>{candidate.address}</small>}</span><small>{candidate.placeable ? "mapped" : "needs coordinates"}</small></div>)}</div>
        )}

        {result?.status === "ok" && interpretation?.target && (
          <div className="query-results">
            <div className="query-result-header"><b>Pole outage impact</b><span className="pill pill-damaged">{answer?.affected_count || 0} customers</span></div>
            <p className="query-note">{interpretation.target.code || interpretation.target.name} · simulated failure of {interpretation.simulated_boxes?.length || 0} mounted box{interpretation.simulated_boxes?.length === 1 ? "" : "es"}</p>
            {answer?.affected_customers?.length ? (
              <div className="query-list">{answer.affected_customers.map((customer) => <div className="query-row" key={customer.key || customer.customer_id}><b>{customer.customer_name || customer.customer_code || customer.customer_id || "Unnamed customer"}</b>{customer.serving_box_code && <small>served by {customer.serving_box_code}</small>}</div>)}</div>
            ) : <p className="empty-state">No documented downstream customers were found.</p>}
          </div>
        )}

        {result?.status === "ok" && interpretation?.location && (
          <div className="query-results">
            <div className="query-result-header"><b>Boxes with spare capacity</b><span className="pill pill-healthy">{answer?.count || 0} found</span></div>
            <p className="query-note">Within {interpretation.radius_m}m of {interpretation.location.label} · {interpretation.location.source}</p>
            {answer?.boxes?.length ? (
              <div className="query-list">{answer.boxes.map((box) => <div className="query-row" key={box.id}><span><b>{box.code || box.name || "Unnamed box"}</b><small>{box.name && box.code ? box.name : ""}</small></span><span><b>{box.available_cores}</b> spare · {metres(box.distance_m)}</span></div>)}</div>
            ) : <p className="empty-state">No box with spare capacity was found in this radius. {answer?.total_boxes_in_radius ? `${answer.total_boxes_in_radius} box${answer.total_boxes_in_radius === 1 ? " was" : "es were"} in range, but all are full.` : "No boxes were found in range."}</p>}
          </div>
        )}

        {result?.warnings?.length > 0 && <div className="query-warnings">{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      </section>
    </div>
  );
}
