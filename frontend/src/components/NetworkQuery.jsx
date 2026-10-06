import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

const EXAMPLES = [
  "Trace fiber core fc-123 from end to end.",
  "What does Fiberline documentation say about optical loss budgets?",
];

function assetName(asset) {
  return asset?.code || asset?.name || asset?.customer_code || asset?.customer_name || asset?.id || "Unnamed asset";
}

function ToolResultDetails({ toolCall }) {
  if (!toolCall) return null;
  if (toolCall.success !== true) {
    return (
      <div className="query-results">
        <b>Tool could not complete</b>
        <p className="query-note">{toolCall.message || toolCall.error || "The deterministic handler is unavailable."}</p>
      </div>
    );
  }

  const data = toolCall.result;
  if (!data || typeof data !== "object") return null;

  if (data.error || data.status === "not_found" || data.status === "ambiguous") {
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    return (
      <div className="query-results">
        <b>{data.status === "ambiguous" ? "Matching network assets" : "Tool result"}</b>
        {data.error && <p className="query-note">{data.error}</p>}
        {data.status === "not_found" && !data.error && <p className="query-note">No matching network asset was found.</p>}
        {candidates.length > 0 && <div className="query-list">{candidates.slice(0, 20).map((asset, index) => <div className="query-row" key={asset.id || index}>{assetName(asset)}</div>)}</div>}
      </div>
    );
  }

  if (toolCall.tool === "lookupDocs") {
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (!sources.length) return null;
    return (
      <div className="query-results">
        <b>Documentation sources</b>
        <div className="query-list">
          {sources.map((source, index) => (
            <details key={source.id || `${source.source}-${source.section}-${index}`} className="query-row">
              <summary><b>{source.source || "Fiberline documentation"}</b><small>{source.section || "Relevant section"}</small></summary>
              {source.excerpt && <p className="query-note">{source.excerpt}</p>}
            </details>
          ))}
        </div>
      </div>
    );
  }

  if (toolCall.tool === "traceCore") {
    const segments = Array.isArray(data.trace) ? data.trace : [];
    return (
      <div className="query-results">
        <b>Fiber trace</b>
        {data.core && <p className="query-note">Core {data.core.core_number ?? "?"} · {data.core.cable_id || "cable not recorded"} · {data.core.status || "status unknown"}</p>}
        {segments.length > 0 ? (
          <ol className="query-list">
            {segments.slice(0, 80).map((segment, index) => (
              <li className="query-row" key={`${segment.core_id || segment.splice_id || "trace"}-${index}`}>
                {segment.core_id
                  ? `Core ${segment.core_number ?? "?"} · ${segment.cable_code || segment.cable_name || segment.cable_id || "cable unknown"}`
                  : `${segment.splice_type === "continuation" ? "Continuation" : "Splice"} · ${segment.enclosure_id || segment.splice_id || "joint not identified"}`}
              </li>
            ))}
          </ol>
        ) : <p className="query-note">No trace segments were returned.</p>}
        {segments.length > 80 && <small className="query-tool-note">Showing 80 of {segments.length} trace segments.</small>}
      </div>
    );
  }

  if (toolCall.tool === "findCoreRemediation") {
    const path = Array.isArray(data.path) ? data.path : [];
    return (
      <div className="query-results">
        <b>Spare-capacity source path</b>
        {data.found ? (
          <>
            <p className="query-note">Source enclosure {data.source_enclosure_id} · {data.available_cores} available core(s) · {data.hops} hop(s)</p>
            {data.source_core && <p className="query-note">Suggested source core {data.source_core.core_number ?? data.source_core.id}</p>}
            {path.length > 0 && <ol className="query-list">{path.slice(0, 40).map((edge, index) => <li className="query-row" key={`${edge.cable_id || "cable"}-${index}`}>{edge.cable_code || edge.cable_id}: {edge.from_enclosure_id} → {edge.to_enclosure_id}</li>)}</ol>}
          </>
        ) : <p className="query-note">{data.message || "No connected enclosure with spare capacity was found."}</p>}
      </div>
    );
  }

  if (toolCall.tool === "locateCustomer") {
    const plan = data;
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const budget = plan.optical_budget || {};
    return (
      <div className="query-results">
        <b>Customer connection plan</b>
        {plan.enclosure && <p className="query-note">Nearest enclosure: {assetName(plan.enclosure)}{plan.enclosure.distance_m != null ? ` · ${metres(plan.enclosure.distance_m)} away` : ""}</p>}
        {plan.connection && <p className="query-note">{plan.connection.label || plan.connection.type}{plan.connection.port?.port_number != null ? ` · port ${plan.connection.port.port_number}` : ""}{plan.connection.core?.core_number != null ? ` · core ${plan.connection.core.core_number}` : ""}</p>}
        {plan.route?.label && <p className="query-note">Route basis: {plan.route.label}{plan.route.length_m != null ? ` (${metres(plan.route.length_m)})` : ""}</p>}
        {budget.status && <p className="query-note">Optical budget: {budget.status}{budget.total_loss_db != null ? ` · ${budget.total_loss_db} dB total loss` : ""}{budget.remaining_margin_db != null ? ` · ${budget.remaining_margin_db} dB remaining` : ""}</p>}
        {steps.length > 0 && <ol className="query-list">{steps.slice(0, 20).map((step, index) => <li className="query-row" key={`${index}-${step}`}>{step}</li>)}</ol>}
      </div>
    );
  }

  if (toolCall.tool === "simulateFailure") {
    const summary = data.summary || {};
    const affected = Array.isArray(data.affected?.customers)
      ? data.affected.customers
      : Array.isArray(data.affected_customers) ? data.affected_customers : [];
    return (
      <div className="query-results">
        <b>Failure impact</b>
        <p className="query-note">{summary.affected_customers ?? data.affected_count ?? affected.length} affected customer(s) · {summary.affected_boxes ?? data.affected?.boxes?.length ?? 0} enclosure(s) · {summary.affected_cables ?? data.affected?.cables?.length ?? 0} cable(s)</p>
        {affected.length > 0 && <div className="query-list">{affected.slice(0, 25).map((customer, index) => <div className="query-row" key={customer.customer_id || customer.key || index}><b>{assetName(customer)}</b>{customer.serving_box_code && <small>served by {customer.serving_box_code}</small>}</div>)}</div>}
        {affected.length > 25 && <small className="query-tool-note">Showing 25 of {affected.length} affected customers.</small>}
      </div>
    );
  }

  if (Array.isArray(data.candidates) && data.candidates.length > 0) {
    return (
      <div className="query-results">
        <b>Matching network assets</b>
        <div className="query-list">{data.candidates.slice(0, 20).map((asset, index) => <div className="query-row" key={asset.id || index}>{assetName(asset)}</div>)}</div>
      </div>
    );
  }

  if (data.error || data.message) {
    return <div className="query-results"><b>Tool result</b><p className="query-note">{data.error || data.message}</p></div>;
  }
  return null;
}

function metres(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${Math.round(amount)} m` : "—";
}

function recognitionConstructor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export default function NetworkQuery({ onClose, onVisualize, customerLocation = null }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [voiceError, setVoiceError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef("");
  const submittedTranscriptRef = useRef("");

  const runQuery = useCallback(async (spokenQuery) => {
    const clean = String(spokenQuery || "").trim();
    if (!clean || submittedTranscriptRef.current === clean) return;
    submittedTranscriptRef.current = clean;
    setQuery(clean);
    setLoading(true);
    setError(null);
    setVoiceError(null);
    setResult(null);
    onVisualize?.(null);
    try {
      const response = await api.networkQuery(clean, conversationId, customerLocation);
      if (response.conversation_id) setConversationId(response.conversation_id);
      setResult(response);
      onVisualize?.(response.visualization || null);
    } catch (requestError) {
      if (requestError.details?.intent || requestError.details?.status) setResult(requestError.details);
      else {
        const details = requestError.details || {};
        const requestId = details.request_id ? ` Request ID: ${details.request_id}.` : "";
        const stage = details.stage ? ` Stage: ${details.stage}.` : "";
        setError(`${details.error || requestError.message}${stage}${requestId}`);
      }
    } finally {
      setLoading(false);
    }
  }, [conversationId, customerLocation, onVisualize]);

  const startListening = useCallback(() => {
    const Recognition = recognitionConstructor();
    if (!Recognition) {
      setVoiceError("Voice input is not supported by this browser. You can type your question instead.");
      setShowTyping(true);
      return;
    }
    if (recognitionRef.current) return;
    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    finalTranscriptRef.current = "";
    recognition.onstart = () => {
      setListening(true);
      setVoiceError(null);
    };
    recognition.onresult = (event) => {
      let finalText = finalTranscriptRef.current;
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const text = event.results[index][0]?.transcript || "";
        if (event.results[index].isFinal) finalText += `${text} `;
        else interim += text;
      }
      finalTranscriptRef.current = finalText;
      setQuery(`${finalText}${interim}`.trim());
      setInterimTranscript(interim);
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted") setVoiceError(`Microphone error: ${event.error}. You can type your question instead.`);
      setListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") setShowTyping(true);
    };
    recognition.onend = () => {
      setListening(false);
      setInterimTranscript("");
      const spoken = finalTranscriptRef.current.trim();
      recognitionRef.current = null;
      if (spoken) runQuery(spoken);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (startError) {
      recognitionRef.current = null;
      setListening(false);
      setVoiceError(startError.message || "Unable to start the microphone.");
      setShowTyping(true);
    }
  }, [runQuery]);

  useEffect(() => {
    if (!showTyping) startListening();
    return () => {
      recognitionRef.current?.abort?.();
      recognitionRef.current = null;
    };
  }, [showTyping, startListening]);

  useEffect(() => {
    if (!loading) {
      setLoadingStage("");
      return undefined;
    }
    const stages = [
      "Routing your question to a Fiberline tool…",
      "Waiting for the configured model provider…",
      "Checking the live network or retrieving project documentation…",
      "Still working — a local model may take longer on its first request…",
    ];
    let index = 0;
    setLoadingStage(stages[index]);
    const timer = setInterval(() => {
      index = Math.min(index + 1, stages.length - 1);
      setLoadingStage(stages[index]);
    }, 7000);
    return () => clearInterval(timer);
  }, [loading]);

  function stopListening() {
    recognitionRef.current?.stop?.();
    setListening(false);
  }

  function submit(event) {
    event.preventDefault();
    stopListening();
    runQuery(query);
  }

  async function confirmAction() {
    const actionId = result?.pending_action?.id;
    if (!actionId) return;
    setActionBusy(true);
    try {
      const executed = await api.confirmNetworkAction(actionId);
      setResult((current) => ({ ...current, pending_action: null, answer_text: executed.message || "The confirmed action was completed." }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function cancelAction() {
    const actionId = result?.pending_action?.id;
    if (!actionId) return;
    setActionBusy(true);
    try {
      await api.cancelNetworkAction(actionId);
      setResult((current) => ({ ...current, pending_action: null, answer_text: "The action was cancelled. No data was changed." }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionBusy(false);
    }
  }

  function close() {
    recognitionRef.current?.abort?.();
    recognitionRef.current = null;
    onClose();
  }

  const answer = result?.answer;
  const interpretation = result?.interpretation;

  return (
    <div className="modal-backdrop voice-query-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="network-query" role="dialog" aria-modal="true" aria-label="Ask the network">
        <div className="user-management-header">
          <div>
            <p className="section-title" style={{ margin: 0 }}>Ask the network</p>
            <p className="empty-state">Ask about network operations or Fiberline documentation. Each question is routed to one allowlisted Fiberline tool.</p>
            {customerLocation && <small className="query-note">Customer context: {customerLocation.lat}, {customerLocation.lng}</small>}
          </div>
          <button className="btn" onClick={close}>Close</button>
        </div>

        {!result && !loading && !showTyping && (
          <div className="voice-query-hero">
            <button
              className={`voice-mic ${listening ? "is-listening" : ""}`}
              onClick={listening ? stopListening : startListening}
              aria-label={listening ? "Stop listening" : "Start listening"}
              title={listening ? "Stop listening" : "Start listening"}
            >
              <span className="voice-mic-waves" aria-hidden="true" />
              <span className="voice-mic-icon" aria-hidden="true">●</span>
            </button>
            <strong>{listening ? "Listening…" : "Tap the microphone to ask"}</strong>
            <span className="voice-query-hint">For example: “Trace fiber core fc-123” or “What does the documentation say about optical loss budgets?”</span>
            {query && <p className="voice-transcript">“{query}”{interimTranscript && <i> …</i>}</p>}
            <button className="link-button" onClick={() => { stopListening(); setShowTyping(true); }}>Type instead</button>
          </div>
        )}

        {loading && <div className="voice-query-hero"><div className="voice-thinking" aria-hidden="true"><span /><span /><span /></div><strong>{loadingStage || "Starting the network assistant…"}</strong><span className="voice-query-hint">This request is not retried. Answers are based on deterministic tool results or retrieved Fiberline documentation.</span></div>}

        {showTyping && !loading && !result && (
          <form className="network-query-form" onSubmit={submit}>
            <label htmlFor="network-query-input">Network question</label>
            <textarea id="network-query-input" rows="3" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Trace a core, simulate an enclosure outage, plan a customer connection, or ask about Fiberline documentation." autoFocus />
            <div className="network-query-examples" aria-label="Example questions">
              {EXAMPLES.map((example) => <button key={example} type="button" className="link-button" onClick={() => setQuery(example)}>{example}</button>)}
            </div>
            <div className="network-query-actions"><button className="btn" type="button" onClick={() => { setShowTyping(false); startListening(); }}>Use microphone</button><button className="btn btn-primary" type="submit" disabled={!query.trim()}>Ask assistant</button></div>
          </form>
        )}

        {result && !loading && !showTyping && (
          <div className="voice-followup">
            <button className={`voice-mic voice-mic-small ${listening ? "is-listening" : ""}`} onClick={listening ? stopListening : startListening} aria-label={listening ? "Stop listening" : "Ask a follow-up question"}>
              <span className="voice-mic-waves" aria-hidden="true" />
              <span className="voice-mic-icon" aria-hidden="true">●</span>
            </button>
            <span><b>{listening ? "Listening for your follow-up…" : "Ask another question"}</b><small>Each request routes independently; repeat the asset ID or location if needed.</small></span>
          </div>
        )}

        {voiceError && <p className="query-note" role="status">{voiceError}</p>}
        {error && <p className="error-row" role="alert">{error}</p>}
        {result?.message && <p className={result.status === "ok" ? "query-note" : "error-row"}>{result.message}</p>}
        {result?.answer_text && <div className="query-answer" aria-live="polite">{result.answer_text}</div>}
        {result?.pending_action && (
          <div className="agent-action-card" role="alert">
            <b>Confirmation required</b>
            <p>{result.pending_action.target_label}: <strong>{result.pending_action.before || "unset"}</strong> → <strong>{result.pending_action.after}</strong></p>
            {result.pending_action.reason && <small>{result.pending_action.reason}</small>}
            <div className="network-query-actions"><button className="btn" disabled={actionBusy} onClick={cancelAction}>Cancel</button><button className="btn btn-primary" disabled={actionBusy} onClick={confirmAction}>{actionBusy ? "Applying…" : "Confirm change"}</button></div>
            <small>This change will be applied only after you confirm it.</small>
          </div>
        )}
        {result?.tool_calls?.length > 0 && <small className="query-tool-note">Used {result.tool_calls.length} Fiberline tool{result.tool_calls.length === 1 ? "" : "s"}{result.tool_calls[0]?.tool ? `: ${result.tool_calls[0].tool}` : ""}.</small>}
        {result?.assistant_trace && <small className="query-tool-note">Model: {result.assistant_trace.model} · threads: {result.assistant_trace.threads || "default"} · rounds: {result.assistant_trace.rounds} · request: {result.assistant_trace.request_id}</small>}
        <ToolResultDetails toolCall={result?.tool_calls?.[0]} />

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
            {answer?.affected_customers?.length ? <div className="query-list">{answer.affected_customers.map((customer) => <div className="query-row" key={customer.key || customer.customer_id}><b>{customer.customer_name || customer.customer_label || customer.customer_code || customer.customer_id || "Unnamed customer"}</b>{customer.serving_box_code && <small>served by {customer.serving_box_code}</small>}</div>)}</div> : <p className="empty-state">No documented downstream customers were found.</p>}
          </div>
        )}

        {result?.status === "ok" && interpretation?.location && (
          <div className="query-results">
            <div className="query-result-header"><b>Boxes with spare capacity</b><span className="pill pill-healthy">{answer?.count || 0} found</span></div>
            <p className="query-note">Within {interpretation.radius_m}m of {interpretation.location.label} · {interpretation.location.source}</p>
            {answer?.boxes?.length ? <div className="query-list">{answer.boxes.map((box) => <div className="query-row" key={box.id}><span><b>{box.code || box.name || "Unnamed box"}</b><small>{box.name && box.code ? box.name : ""}</small></span><span><b>{box.available_cores}</b> spare · {metres(box.distance_m)}</span></div>)}</div> : <p className="empty-state">No box with spare capacity was found in this radius. {answer?.total_boxes_in_radius ? `${answer.total_boxes_in_radius} box${answer.total_boxes_in_radius === 1 ? " was" : "es were"} in range, but all are full.` : "No boxes were found in range."}</p>}
          </div>
        )}

        {result?.warnings?.length > 0 && <div className="query-warnings">{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        {result && <div className="network-query-actions"><button className="btn" onClick={() => { setResult(null); setQuery(""); setError(null); submittedTranscriptRef.current = ""; setShowTyping(false); startListening(); }}>Ask another question</button></div>}
      </section>
    </div>
  );
}
