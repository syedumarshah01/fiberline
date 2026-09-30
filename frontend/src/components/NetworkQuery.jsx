import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

const EXAMPLES = [
  "Which customers are affected if pole 42 goes down?",
  "Show me every box within 500m of 12 Main Street with spare capacity",
];

function metres(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${Math.round(amount)} m` : "—";
}

function recognitionConstructor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export default function NetworkQuery({ onClose, onVisualize }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [voiceError, setVoiceError] = useState(null);
  const [loading, setLoading] = useState(false);
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
    try {
      const response = await api.networkQuery(clean, conversationId);
      if (response.conversation_id) setConversationId(response.conversation_id);
      setResult(response);
      onVisualize?.(response.visualization || null);
    } catch (requestError) {
      if (requestError.details?.intent || requestError.details?.status) setResult(requestError.details);
      else setError(requestError.details?.error || requestError.message);
    } finally {
      setLoading(false);
    }
  }, [conversationId, onVisualize]);

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
            <p className="empty-state">Speak your question and the network assistant will check the live Fiberline network.</p>
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
            <span className="voice-query-hint">For example: “Which customers are affected if pole 42 goes down?”</span>
            {query && <p className="voice-transcript">“{query}”{interimTranscript && <i> …</i>}</p>}
            <button className="link-button" onClick={() => { stopListening(); setShowTyping(true); }}>Type instead</button>
          </div>
        )}

        {loading && <div className="voice-query-hero"><div className="voice-thinking" aria-hidden="true"><span /><span /><span /></div><strong>Checking the network…</strong><span className="voice-query-hint">The assistant is looking through the documented network graph.</span></div>}

        {showTyping && !loading && !result && (
          <form className="network-query-form" onSubmit={submit}>
            <label htmlFor="network-query-input">Network question</label>
            <textarea id="network-query-input" rows="3" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask about poles, boxes, customers, capacity, outages, cables, approvals, or Fiberline workflows." autoFocus />
            <div className="network-query-actions"><button className="btn" type="button" onClick={() => { setShowTyping(false); startListening(); }}>Use microphone</button><button className="btn btn-primary" type="submit" disabled={!query.trim()}>Ask assistant</button></div>
          </form>
        )}

        {result && !loading && !showTyping && (
          <div className="voice-followup">
            <button className={`voice-mic voice-mic-small ${listening ? "is-listening" : ""}`} onClick={listening ? stopListening : startListening} aria-label={listening ? "Stop listening" : "Ask a follow-up question"}>
              <span className="voice-mic-waves" aria-hidden="true" />
              <span className="voice-mic-icon" aria-hidden="true">●</span>
            </button>
            <span><b>{listening ? "Listening for your follow-up…" : "Ask a follow-up"}</b><small>Your next question continues this conversation.</small></span>
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
        {result?.tool_calls?.length > 0 && <small className="query-tool-note">Checked {result.tool_calls.length} live network source{result.tool_calls.length === 1 ? "" : "s"}.</small>}

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
