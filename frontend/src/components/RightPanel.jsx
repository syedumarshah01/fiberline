import React, { useEffect, useState } from 'react';
import { api } from '../api';

function Pill({ status }) {
  return <span className={`pill pill-${status}`}>{status}</span>;
}

function BoxDocumentation({ enclosureId, onChanged }) {
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const [spliceForm, setSpliceForm] = useState({ coreA: '', coreB: '' });

  const load = () => {
    setLoading(true);
    api.getBoxDocumentation(enclosureId)
      .then((d) => { setDoc(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { setSource(null); load(); }, [enclosureId]);

  if (loading) return <p className="loading-row">Loading box documentation…</p>;
  if (error) return <p className="error-row">{error}</p>;
  if (!doc) return null;

  const allCores = doc.cables_landing_here.flatMap((g) =>
    g.cores.map((c) => ({ ...c, cable_code: g.cable.code, cable_type: g.cable.cable_type }))
  );
  const availableCores = allCores.filter((c) => c.status === 'available');

  async function handleSplice(e) {
    e.preventDefault();
    if (!spliceForm.coreA || !spliceForm.coreB) return;
    try {
      await api.createSplice({
        enclosure_id: enclosureId,
        core_a_id: spliceForm.coreA,
        core_b_id: spliceForm.coreB,
        technician: 'field-tech',
      });
      setSpliceForm({ coreA: '', coreB: '' });
      load();
      onChanged?.();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleFindSource() {
    const result = await api.findSource(enclosureId);
    setSource(result);
  }

  return (
    <div>
      <p className="section-title">{doc.enclosure.code} — box documentation</p>

      <div className="summary-grid">
        <div className="summary-card"><div className="n">{doc.summary.total_cores}</div><div className="l">Total cores</div></div>
        <div className="summary-card"><div className="n" style={{ color: 'var(--amber)' }}>{doc.summary.available_cores}</div><div className="l">Available</div></div>
        <div className="summary-card"><div className="n" style={{ color: 'var(--teal)' }}>{doc.summary.spliced_cores}</div><div className="l">Spliced</div></div>
        <div className="summary-card"><div className="n" style={{ color: 'var(--violet)' }}>{doc.summary.terminated_cores}</div><div className="l">Terminated</div></div>
      </div>

      {doc.summary.available_cores === 0 && (
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn-block" onClick={handleFindSource}>
            No spare cores here — find nearest box with capacity
          </button>
          {source && (
            source.found ? (
              <p className="empty-state">
                Nearest source: <b>{source.source_enclosure_id.slice(0, 8)}…</b> ({source.available_cores} free, {source.hops} hop{source.hops === 1 ? '' : 's'} away)
                <br />Path: {source.path.map((p) => p.cable_code).join(' → ') || 'direct'}
              </p>
            ) : <p className="error-row">{source.message}</p>
          )}
        </div>
      )}

      <p className="section-title">Cables landing here</p>
      {doc.cables_landing_here.map((g) => (
        <table className="doc-table" key={g.cable.id} style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th colSpan={3}>{g.cable.code} · {g.cable.cable_type} {g.cable.customer_label ? `· ${g.cable.customer_label}` : ''}</th>
            </tr>
            <tr><th>Core #</th><th>Status</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {g.cores.map((c) => (
              <tr key={c.id}>
                <td>{c.core_number}</td>
                <td><Pill status={c.status} /></td>
                <td>{c.notes || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}

      <p className="section-title">Splice records (in/out map)</p>
      {doc.splices.length ? (
        <table className="doc-table" style={{ marginBottom: 16 }}>
          <thead>
            <tr><th>In</th><th>Out</th><th>Type</th></tr>
          </thead>
          <tbody>
            {doc.splices.map((s) => (
              <tr key={s.id}>
                <td>{s.cable_a_code} #{s.core_a_number}</td>
                <td>{s.cable_b_code} #{s.core_b_number}</td>
                <td>{s.splice_type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="empty-state">No splices recorded in this box yet.</p>}

      <p className="section-title">New splice</p>
      {availableCores.length >= 2 ? (
        <form onSubmit={handleSplice}>
          <div className="field">
            <label>Core in</label>
            <select value={spliceForm.coreA} onChange={(e) => setSpliceForm((f) => ({ ...f, coreA: e.target.value }))}>
              <option value="">Select…</option>
              {availableCores.map((c) => (
                <option key={c.id} value={c.id}>{c.cable_code} #{c.core_number}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Core out</label>
            <select value={spliceForm.coreB} onChange={(e) => setSpliceForm((f) => ({ ...f, coreB: e.target.value }))}>
              <option value="">Select…</option>
              {availableCores.filter((c) => c.id !== spliceForm.coreA).map((c) => (
                <option key={c.id} value={c.id}>{c.cable_code} #{c.core_number}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary btn-block" type="submit">Record splice</button>
        </form>
      ) : <p className="empty-state">Fewer than 2 available cores here — nothing to splice.</p>}
    </div>
  );
}

function CustomerLookupPanel({ point, customers, onCreateCustomer }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [customerCode, setCustomerCode] = useState('');
  const [customerName, setCustomerName] = useState('');

  useEffect(() => {
    if (!point) return;
    setLoading(true);
    api.customerLookup(point.lat, point.lng, 500)
      .then(setResult)
      .finally(() => setLoading(false));
  }, [point]);

  if (!point) return <p className="empty-state">Switch to "Locate customer" and click the map at the customer's address.</p>;
  if (loading) return <p className="loading-row">Searching nearby boxes…</p>;
  if (!result) return null;

  return (
    <div>
      <p className="section-title">Customer lookup</p>
      <p className="empty-state">{point.lat.toFixed(5)}, {point.lng.toFixed(5)} — searched {result.query.radius_m}m radius</p>

      {result.recommended_box ? (
        <div className="summary-card" style={{ marginBottom: 14, borderColor: 'var(--teal)' }}>
          <div className="sub" style={{ color: 'var(--teal)', fontWeight: 600 }}>Recommended: {result.recommended_box.code}</div>
          <div className="sub">{Math.round(result.recommended_box.distance_m)}m away · {result.recommended_box.available_cores} cores free</div>
        </div>
      ) : (
        <div className="summary-card" style={{ marginBottom: 14, borderColor: 'var(--red)' }}>
          <div className="sub" style={{ color: 'var(--red)', fontWeight: 600 }}>No nearby box has spare capacity</div>
          {result.suggested_source?.found && (
            <div className="sub" style={{ marginTop: 6 }}>
              Bring a connection from box <b>{result.suggested_source.source_enclosure_id.slice(0, 8)}…</b>
              {' '}({result.suggested_source.available_cores} free, {result.suggested_source.hops} hop{result.suggested_source.hops === 1 ? '' : 's'})
              <br />Path: {result.suggested_source.path.map((p) => p.cable_code).join(' → ') || 'direct'}
            </div>
          )}
        </div>
      )}

      <p className="section-title">Nearby boxes</p>
      {result.nearby_boxes.map((b) => (
        <div className="list-item" key={b.id}>
          <div className="code">{b.code}</div>
          <div className="sub">{Math.round(b.distance_m)}m away · {b.available_cores} free cores</div>
        </div>
      ))}

      <p className="section-title" style={{ marginTop: 16 }}>Register this customer</p>
      <div className="field">
        <label>Customer code</label>
        <input value={customerCode} onChange={(e) => setCustomerCode(e.target.value)} placeholder="CUST-10234" />
      </div>
      <div className="field">
        <label>Name</label>
        <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Full name" />
      </div>
      <button
        className="btn btn-block"
        onClick={() => {
          if (!customerCode || !customerName) return;
          onCreateCustomer({ customer_code: customerCode, name: customerName, lat: point.lat, lng: point.lng });
          setCustomerCode(''); setCustomerName('');
        }}
      >
        Save customer at this location
      </button>
    </div>
  );
}

function CableDetail({ cable }) {
  const [full, setFull] = useState(null);
  const [trace, setTrace] = useState(null);

  useEffect(() => { setTrace(null); api.getCable(cable.id).then(setFull); }, [cable.id]);

  if (!full) return <p className="loading-row">Loading cable…</p>;

  return (
    <div>
      <p className="section-title">{full.code} — {full.cable_type}</p>
      <p className="empty-state">{full.core_count} cores {full.customer_label ? `· label ${full.customer_label}` : ''}</p>
      <table className="doc-table" style={{ marginBottom: 12 }}>
        <thead><tr><th>Core #</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {full.cores.map((c) => (
            <tr key={c.id}>
              <td>{c.core_number}</td>
              <td><Pill status={c.status} /></td>
              <td>
                <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => api.traceFiber(c.id).then(setTrace)}>
                  Trace
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {trace && (
        <div>
          <p className="section-title">Fiber path (req #6)</p>
          {trace.hops.map((hop, i) =>
            hop.cable_code ? (
              <div className="list-item" key={i}>
                <div className="code">{hop.cable_code} · core #{hop.core_number}</div>
                <div className="sub">{hop.cable_type}<Pill status={hop.core_status} /></div>
              </div>
            ) : (
              <div className="empty-state" key={i} style={{ paddingLeft: 8 }}>↓ spliced ({hop.splice_type})</div>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default function RightPanel({ mode, selectedEnclosure, selectedCable, customerPoint, customers, onCreateCustomer, onChanged }) {
  if (mode === 'locate-customer') {
    return <CustomerLookupPanel point={customerPoint} customers={customers} onCreateCustomer={onCreateCustomer} />;
  }
  if (selectedEnclosure) {
    return <BoxDocumentation enclosureId={selectedEnclosure.id} onChanged={onChanged} />;
  }
  if (selectedCable) {
    return <CableDetail cable={selectedCable} />;
  }
  return <p className="empty-state">Select a box to view its documentation, a cable to trace it, or switch to "Locate customer".</p>;
}
