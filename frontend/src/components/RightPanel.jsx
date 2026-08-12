import React, { useEffect, useState } from "react";
import { api } from "../api";
import VisualDocumentation from "./VisualDocumentation";

function Pill({ status }) {
  return <span className={`pill pill-${status}`}>{status}</span>;
}

// Per-cable core status counts, e.g. "4 available · 2 spliced · 1 terminated"
function CoreCountChips({ cores }) {
  const counts = {};
  for (const c of cores) counts[c.status] = (counts[c.status] || 0) + 1;
  const order = ["available", "spliced", "terminated", "reserved", "damaged"];
  const entries = order.filter((s) => counts[s]);
  return (
    <span className="core-count-chips">
      {entries.map((s) => (
        <span key={s} className={`core-count-chip chip-${s}`}>
          {counts[s]} {s}
        </span>
      ))}
    </span>
  );
}

// Standard fiber color codes (IEC 60304)
// For 12-fiber ribbon: Blue, Orange, Green, Brown, Slate, White, Red, Black, Yellow, Violet, Rose, Aqua
// For 24+ fibers, the pattern repeats with a black stripe
const FIBER_COLORS = [
  "#0000FF", // 1: Blue
  "#FFA500", // 2: Orange
  "#008000", // 3: Green
  "#8B4513", // 4: Brown
  "#808080", // 5: Slate
  "#FFFFFF", // 6: White
  "#FF0000", // 7: Red
  "#000000", // 8: Black
  "#FFFF00", // 9: Yellow
  "#8A2BE2", // 10: Violet
  "#FF69B4", // 11: Rose (Pink)
  "#00FFFF", // 12: Aqua
];

function FiberColorDot({ coreNumber }) {
  const colorIndex = (coreNumber - 1) % 12;
  const bgColor = FIBER_COLORS[colorIndex] || "#808080";
  return (
    <span
      style={{
        display: "inline-block",
        width: "12px",
        height: "12px",
        borderRadius: "50%",
        backgroundColor: bgColor,
        border: "1px solid #333",
        marginRight: "4px",
        verticalAlign: "middle",
      }}
      title={`Fiber color: ${getFiberColorName(coreNumber)}`}
    />
  );
}

function getFiberColorName(coreNumber) {
  const colorNames = [
    "Blue", "Orange", "Green", "Brown", "Slate", "White",
    "Red", "Black", "Yellow", "Violet", "Rose", "Aqua"
  ];
  const colorIndex = (coreNumber - 1) % 12;
  const baseName = colorNames[colorIndex] || "Unknown";
  if (coreNumber > 12) {
    return `${baseName} (with black stripe)`;
  }
  return baseName;
}

// ---------------------------------------------------------------------------
// BoxDocumentation — shown when an enclosure is selected
// ---------------------------------------------------------------------------
function BoxDocumentation({ enclosureId, onChanged, onDeleteEnclosure }) {
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const [viewMode, setViewMode] = useState("text"); // "text" or "visual"
  const [spliceForm, setSpliceForm] = useState({ coreA: "", coreB: "" });
  const [editingSplice, setEditingSplice] = useState(null);
  const [editSpliceForm, setEditSpliceForm] = useState({});
  const [showSplitterForm, setShowSplitterForm] = useState(false);
  const [splitterForm, setSplitterForm] = useState({
    name: "",
    split_count: 4,
    input_core_id: "",
    output_core_ids: [],
    splice_type: "fusion",
    loss_db: "",
    technician: "",
    notes: "",
  });
  const [splitters, setSplitters] = useState([]);
  const [creatingSplitter, setCreatingSplitter] = useState(false);

  const load = () => {
    setLoading(true);
    return api
      .getBoxDocumentation(enclosureId)
      .then((d) => {
        setDoc(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const loadSplitters = () => {
    api.listSplitters(enclosureId).then(setSplitters).catch(() => {});
  };

  useEffect(() => {
    setSource(null);
    load();
    loadSplitters();
  }, [enclosureId]);

  if (loading) return <p className="loading-row">Loading box documentation…</p>;
  if (error) return <p className="error-row">{error}</p>;
  if (!doc) return null;

  // Separate IN and OUT cores
  const inCores = doc.cables_landing_here
    .filter((g) => g.direction === "in")
    .flatMap((g) =>
      g.cores.map((c) => ({
        ...c,
        cable_code: g.cable.code,
        cable_type: g.cable.cable_type,
      })),
    )
    .sort((a, b) => a.core_number - b.core_number);
  const outCores = doc.cables_landing_here
    .filter((g) => g.direction === "out")
    .flatMap((g) =>
      g.cores.map((c) => ({
        ...c,
        cable_code: g.cable.code,
        cable_type: g.cable.cable_type,
      })),
    )
    .sort((a, b) => a.core_number - b.core_number);
  const allCores = [...inCores, ...outCores].sort((a, b) => a.core_number - b.core_number);
  const availableInCores = inCores.filter((c) => c.status === "available").sort((a, b) => a.core_number - b.core_number);
  const availableOutCores = outCores.filter((c) => c.status === "available").sort((a, b) => a.core_number - b.core_number);
  const availableCores = allCores.filter((c) => c.status === "available").sort((a, b) => a.core_number - b.core_number);
  // Spliced cores can be used for branching (adding splitter to an already-spliced core)
  const splicedCores = allCores.filter((c) => c.status === "spliced").sort((a, b) => a.core_number - b.core_number);

  // Build list of splitter output ports that are empty (available for splicing)
  const splitterPorts = splitters.flatMap((s) =>
    (s.ports || [])
      .filter((p) => !p.output_core_id)
      .map((p) => ({
        id: `port-${s.id}-${p.port_number}`,
        splitter_id: s.id,
        port_number: p.port_number,
        splitter_name: s.name,
        isSplitterPort: true,
        cable_code: `Splitter ${s.split_count}-way`,
        core_number: `Port ${p.port_number}`,
        status: "available",
      })),
  );

  // Get cores that are already used by splitters (input cores)
  const splitterInputCoreIds = splitters.map((s) => s.input_core_id).filter(Boolean);
  const splitterOutputCoreIds = splitters.flatMap((s) =>
    (s.ports || [])
      .filter((p) => p.output_core_id)
      .map((p) => p.output_core_id)
  );
  
  // Filter out cores that are already used by splitters
  const splicedCoresForBranching = splicedCores.filter(
    (c) => !splitterInputCoreIds.includes(c.id) && !splitterOutputCoreIds.includes(c.id)
  );
  const availableInCoresForBranching = availableInCores.filter(
    (c) => !splitterInputCoreIds.includes(c.id) && !splitterOutputCoreIds.includes(c.id)
  );
  const availableOutCoresForBranching = availableOutCores.filter(
    (c) => !splitterInputCoreIds.includes(c.id) && !splitterOutputCoreIds.includes(c.id)
  );

  async function handleSplice(e) {
    e.preventDefault();
    if (!spliceForm.coreA || !spliceForm.coreB) return;
    try {
      const coreA = spliceForm.coreA;
      const coreB = spliceForm.coreB;

      // If either selection is a splitter port, just assign the other core to that port
      // The splitter_ports table tracks the connection (no separate splice record needed)
      if (coreA.startsWith("port-")) {
        const portInfo = splitterPorts.find((p) => p.id === coreA);
        if (!portInfo) {
          alert("Port not found. Please refresh and try again.");
          return;
        }
        // coreB gets assigned to the port
        await api.assignCoreToPort(portInfo.splitter_id, portInfo.port_number, coreB);
      } else if (coreB.startsWith("port-")) {
        const portInfo = splitterPorts.find((p) => p.id === coreB);
        if (!portInfo) {
          alert("Port not found. Please refresh and try again.");
          return;
        }
        // coreA gets assigned to the port
        await api.assignCoreToPort(portInfo.splitter_id, portInfo.port_number, coreA);
      } else {
        // Regular splice between two cores
        await api.createSplice({
          enclosure_id: enclosureId,
          core_a_id: coreA,
          core_b_id: coreB,
          technician: "field-tech",
        });
      }
      // Reset form and refresh data
      setSpliceForm({ coreA: "", coreB: "" });
      // Refresh both doc and splitters to get updated core statuses
      await load();
      await loadSplitters();
      onChanged?.();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleUpdateSplice(spliceId) {
    try {
      await api.updateSplice(spliceId, editSpliceForm);
      setEditingSplice(null);
      setEditSpliceForm({});
      load();
      onChanged?.();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleCreateSplitter(e) {
    e.preventDefault();
    if (!splitterForm.input_core_id) {
      alert("Please select an input core (IN)");
      return;
    }
    setCreatingSplitter(true);
    try {
      await api.createSplitter({
        enclosure_id: enclosureId,
        ...splitterForm,
        output_core_ids: splitterForm.output_core_ids,
      });
      setShowSplitterForm(false);
      setSplitterForm({
        name: "",
        split_count: 4,
        input_core_id: "",
        output_core_ids: [],
        splice_type: "fusion",
        loss_db: "",
        technician: "",
        notes: "",
      });
      load();
      loadSplitters();
      onChanged?.();
    } catch (err) {
      alert(err.message);
    } finally {
      setCreatingSplitter(false);
    }
  }

  async function handleDeleteSplitter(splitterId) {
    if (!confirm("Remove this splitter? All cores will return to available.")) return;
    try {
      await api.deleteSplitter(splitterId);
      load();
      loadSplitters();
      onChanged?.();
    } catch (err) {
      alert(err.message);
    }
  }

  function startEditSplice(splice) {
    setEditingSplice(splice.id);
    setEditSpliceForm({
      splice_type: splice.splice_type,
      tray_number: splice.tray_number || "",
      tray_position: splice.tray_position || "",
      loss_db: splice.loss_db || "",
      technician: splice.technician || "",
      splice_date: splice.splice_date ? splice.splice_date.slice(0, 10) : "",
      notes: splice.notes || "",
      // Pre-populate with current cores
      core_a_id: splice.core_a_id,
      core_b_id: splice.core_b_id,
      change_cores: false,
    });
  }

  async function handleFindSource() {
    const result = await api.findSource(enclosureId);
    setSource(result);
  }

  // Visual mode - data-driven wiring diagram (uses the already-loaded doc)
  if (viewMode === "visual") {
    return (
      <div>
        <p className="section-title">{doc.enclosure.code} — wiring diagram</p>
        <VisualDocumentation
          doc={doc}
          onBack={() => setViewMode("text")}
          onChanged={() => {
            load();
            loadSplitters();
          }}
        />
      </div>
    );
  }

  // Sort cables: feeder/distribution first, then drop cables
  const sortedCables = [...doc.cables_landing_here].sort((a, b) => {
    const typeOrder = { feeder: 0, distribution: 1, drop: 2 };
    return (typeOrder[a.cable.cable_type] ?? 3) - (typeOrder[b.cable.cable_type] ?? 3);
  });

  // Text mode - show the original text documentation
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 6, flexWrap: "wrap" }}>
        <p className="section-title" style={{ margin: 0 }}>{doc.enclosure.code} — box documentation</p>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn" onClick={() => setViewMode("visual")} style={{ padding: "4px 12px", fontSize: 12 }}>
            Visual view
          </button>
          {onDeleteEnclosure && (
            <button
              className="btn btn-danger"
              onClick={() => onDeleteEnclosure(enclosureId)}
              style={{ padding: "4px 12px", fontSize: 12 }}
            >
              Delete box
            </button>
          )}
        </div>
      </div>

      <div className="summary-grid">
        <div className="summary-card">
          <div className="n">{doc.summary.total_cores}</div>
          <div className="l">Total cores</div>
        </div>
        <div className="summary-card">
          <div className="n" style={{ color: "var(--amber)" }}>
            {doc.summary.available_cores}
          </div>
          <div className="l">Available</div>
        </div>
        <div className="summary-card">
          <div className="n" style={{ color: "var(--teal)" }}>
            {doc.summary.spliced_cores}
          </div>
          <div className="l">Spliced</div>
        </div>
        <div className="summary-card">
          <div className="n" style={{ color: "var(--violet)" }}>
            {doc.summary.terminated_cores}
          </div>
          <div className="l">Terminated</div>
        </div>
      </div>

      {doc.summary.available_cores === 0 && (
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn-block" onClick={handleFindSource}>
            No spare cores here — find nearest box with capacity
          </button>
          {source &&
            (source.found ? (
              <p className="empty-state">
                Nearest source: <b>{source.source_enclosure_id.slice(0, 8)}…</b>{" "}
                ({source.available_cores} free, {source.hops} hop
                {source.hops === 1 ? "" : "s"} away)
                <br />
                Path:{" "}
                {source.path.map((p) => p.cable_code).join(" → ") || "direct"}
              </p>
            ) : (
              <p className="error-row">{source.message}</p>
            ))}
        </div>
      )}

      {/* Separate incoming and outgoing cables */}
      {sortedCables.filter((g) => g.direction === "in").length > 0 && (
        <>
          <p className="section-title" style={{ marginTop: 16 }}>IN (from upstream)</p>
          {sortedCables.filter((g) => g.direction === "in").map((g) => (
            <table
              className="doc-table"
              key={g.cable.id}
              style={{ marginBottom: 12 }}
            >
              <thead>
                <tr>
                  <th colSpan={3}>
                    {g.cable.code} · {g.cable.cable_type}{" "}
                    {g.cable.customer_label ? `· ${g.cable.customer_label}` : ""}
                    <CoreCountChips cores={g.cores} />
                  </th>
                </tr>
                <tr>
                  <th>Core #</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {[...g.cores].sort((a, b) => a.core_number - b.core_number).map((c) => (
                  <tr key={c.id}>
                    <td>
                      <FiberColorDot coreNumber={c.core_number} />
                      {c.core_number}
                    </td>
                    <td>
                      <Pill status={c.status} />
                    </td>
                    <td>{c.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      )}

      {sortedCables.filter((g) => g.direction === "out").length > 0 && (
        <>
          <p className="section-title" style={{ marginTop: 16 }}>OUT (to downstream)</p>
          {sortedCables.filter((g) => g.direction === "out").map((g) => (
            <table
              className="doc-table"
              key={g.cable.id}
              style={{ marginBottom: 12 }}
            >
              <thead>
                <tr>
                  <th colSpan={3}>
                    {g.cable.code} · {g.cable.cable_type}{" "}
                    {g.cable.customer_label ? `· ${g.cable.customer_label}` : ""}
                    <CoreCountChips cores={g.cores} />
                  </th>
                </tr>
                <tr>
                  <th>Core #</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {[...g.cores].sort((a, b) => a.core_number - b.core_number).map((c) => (
                  <tr key={c.id}>
                    <td>
                      <FiberColorDot coreNumber={c.core_number} />
                      {c.core_number}
                    </td>
                    <td>
                      <Pill status={c.status} />
                    </td>
                    <td>{c.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      )}

      <p className="section-title">Splice records (in/out map)</p>
      {doc.splices.length ? (
        <table className="doc-table" style={{ marginBottom: 16 }}>
          <thead>
            <tr>
              <th>In (from)</th>
              <th>Out (to)</th>
              <th>Type</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {doc.splices.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.cable_a_code} #{s.core_a_number}
                </td>
                <td>
                  {s.cable_b_code} #{s.core_b_number}
                </td>
                <td>{s.splice_type}</td>
                <td>
                  <button
                    className="btn"
                    style={{ padding: "3px 8px", fontSize: 11 }}
                    onClick={() => startEditSplice(s)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-danger"
                    style={{ padding: "3px 8px", fontSize: 11, marginLeft: 4 }}
                    onClick={async () => {
                      if (!confirm("Unsplice this? Both cores will return to available.")) return;
                      try {
                        await api.deleteSplice(s.id);
                        load();
                        loadSplitters();
                        onChanged?.();
                        alert("Splice removed successfully");
                      } catch (err) {
                        alert(err.message);
                      }
                    }}
                  >
                    Unsplice
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty-state">No splices recorded in this box yet.</p>
      )}

      {/* Splice edit form */}
      {editingSplice && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleUpdateSplice(editingSplice);
          }}
          style={{ marginBottom: 16 }}
        >
          <p className="section-title">Edit splice</p>

          {/* Change cores checkbox */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={editSpliceForm.change_cores || false}
                onChange={(e) =>
                  setEditSpliceForm((f) => ({ ...f, change_cores: e.target.checked }))
                }
              />
              <span style={{ fontSize: 13 }}>Change splice partners (unsplice & re-splice)</span>
            </label>
          </div>

          {editSpliceForm.change_cores && (
            <div style={{ marginBottom: 12, padding: 10, background: "rgba(239,83,80,0.1)", border: "1px solid rgba(239,83,80,0.3)", borderRadius: "var(--radius)" }}>
              <p style={{ fontSize: 11, color: "var(--red)", marginBottom: 8 }}>
                ⚠️ This will unsplice the current cores and splice two new available cores. Current cores will return to "available".
              </p>
              <div className="field">
                <label>New core IN (from upstream)</label>
                <select
                  value={editSpliceForm.core_a_id}
                  onChange={(e) =>
                    setEditSpliceForm((f) => ({ ...f, core_a_id: e.target.value }))
                  }
                >
                  <option value="">Select…</option>
                  {availableCores.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.cable_code} #{c.core_number}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>New core OUT (to downstream)</label>
                <select
                  value={editSpliceForm.core_b_id}
                  onChange={(e) =>
                    setEditSpliceForm((f) => ({ ...f, core_b_id: e.target.value }))
                  }
                >
                  <option value="">Select…</option>
                  {availableCores
                    .filter((c) => c.id !== editSpliceForm.core_a_id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.cable_code} #{c.core_number}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          )}

          <div className="field">
            <label>Splice type</label>
            <select
              value={editSpliceForm.splice_type}
              onChange={(e) =>
                setEditSpliceForm((f) => ({ ...f, splice_type: e.target.value }))
              }
            >
              <option value="fusion">Fusion</option>
              <option value="mechanical">Mechanical</option>
            </select>
          </div>
          <div className="field">
            <label>Tray number</label>
            <input
              value={editSpliceForm.tray_number}
              onChange={(e) =>
                setEditSpliceForm((f) => ({ ...f, tray_number: e.target.value }))
              }
            />
          </div>
          <div className="field">
            <label>Tray position</label>
            <input
              value={editSpliceForm.tray_position}
              onChange={(e) =>
                setEditSpliceForm((f) => ({ ...f, tray_position: e.target.value }))
              }
            />
          </div>
          <div className="field">
            <label>Loss (dB)</label>
            <input
              type="number"
              step="0.01"
              value={editSpliceForm.loss_db}
              onChange={(e) =>
                setEditSpliceForm((f) => ({ ...f, loss_db: e.target.value }))
              }
            />
          </div>
          <div className="field">
            <label>Technician</label>
            <input
              value={editSpliceForm.technician}
              onChange={(e) =>
                setEditSpliceForm((f) => ({ ...f, technician: e.target.value }))
              }
            />
          </div>
          <div className="field">
            <label>Splice date</label>
            <input
              type="date"
              value={editSpliceForm.splice_date}
              onChange={(e) =>
                setEditSpliceForm((f) => ({ ...f, splice_date: e.target.value }))
              }
            />
          </div>
          <div className="field">
            <label>Notes</label>
            <textarea
              value={editSpliceForm.notes}
              onChange={(e) =>
                setEditSpliceForm((f) => ({ ...f, notes: e.target.value }))
              }
              rows={2}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" type="submit">
              Save changes
            </button>
            <button
              className="btn btn-danger"
              type="button"
              onClick={async () => {
                if (!confirm("Unsplice this? Both cores will return to available.")) return;
                try {
                  await api.deleteSplice(editingSplice);
                  setEditingSplice(null);
                  setEditSpliceForm({});
                  load();
                  loadSplitters();
                  onChanged?.();
                } catch (err) {
                  alert(err.message);
                }
              }}
            >
              Unsplice
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setEditingSplice(null);
                setEditSpliceForm({});
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <p className="section-title">New splice</p>
      {availableInCoresForBranching.length + availableOutCoresForBranching.length + splicedCoresForBranching.length + splitterPorts.length >= 1 ? (
        <form onSubmit={handleSplice} style={{ marginBottom: 16 }}>
          <div className="field">
            <label>Core in (from upstream)</label>
            <select
              value={spliceForm.coreA}
              onChange={(e) =>
                setSpliceForm((f) => ({ ...f, coreA: e.target.value, coreB: "" }))
              }
            >
              <option value="">Select…</option>
              <optgroup label="Available IN cores">
                {availableInCoresForBranching.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.cable_code} #{c.core_number} ({getFiberColorName(c.core_number)})
                  </option>
                ))}
              </optgroup>
              {splicedCoresForBranching.length > 0 && (
                <optgroup label="Spliced IN cores (for branching)">
                  {splicedCoresForBranching.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.cable_code} #{c.core_number} ({getFiberColorName(c.core_number)})
                    </option>
                  ))}
                </optgroup>
              )}
              {splitterPorts.length > 0 && (
                <optgroup label="Splitter ports">
                  {splitterPorts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.cable_code} {p.core_number}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="field">
            <label>Core out (to downstream)</label>
            <select
              value={spliceForm.coreB}
              onChange={(e) =>
                setSpliceForm((f) => ({ ...f, coreB: e.target.value }))
              }
            >
              <option value="">Select…</option>
              <optgroup label="Available OUT cores">
                {availableOutCoresForBranching
                  .filter((c) => c.id !== spliceForm.coreA)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.cable_code} #{c.core_number} ({getFiberColorName(c.core_number)})
                    </option>
                  ))}
              </optgroup>
              {/* Only show splitter ports if coreA is NOT a splitter port */}
              {!spliceForm.coreA?.startsWith("port-") && splitterPorts.length > 0 && (
                <optgroup label="Splitter ports">
                  {splitterPorts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.cable_code} {p.core_number}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <button className="btn btn-primary btn-block" type="submit">
            Record splice
          </button>
        </form>
      ) : (
        <p className="empty-state" style={{ marginBottom: 16 }}>
          No available splice points here.
        </p>
      )}

      {/* Available splitter ports count */}
      {splitterPorts.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <p className="section-title">Available splitter ports</p>
          <p className="empty-state" style={{ fontSize: 12 }}>
            {splitterPorts.length} empty port{splitterPorts.length !== 1 ? "s" : ""} ready for assignment
          </p>
        </div>
      )}

      <p className="section-title">Splitters</p>
      {splitters.length ? (
        <div style={{ marginBottom: 16 }}>
          {splitters.map((s) => (
            <div
              key={s.id}
              className="summary-card"
              style={{ marginBottom: 8 }}
            >
              <div style={{ fontWeight: 600 }}>{s.name}</div>
              <div className="sub">
                {s.split_count}-way · input: core #{s.core_number || s.input_core_id?.slice(0, 8)} ·{" "}
                {s.splice_type}
              </div>
              {s.ports?.length ? (
                <table className="doc-table" style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>Port</th>
                      <th>Core</th>
                      <th>Cable</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.ports.map((p) => (
                      <tr key={p.port_id}>
                        <td>{p.port_number}</td>
                        <td>{p.core_number ? `#${p.core_number}` : "—"}</td>
                        <td>{p.cable_code || "—"}</td>
                        <td>
                          {p.output_core_id ? <Pill status={p.core_status} /> : <span style={{ color: "var(--text-faint)", fontSize: 11 }}>empty</span>}
                        </td>
                        <td>
                          {p.output_core_id ? (
                            <button
                              className="btn btn-danger"
                              style={{ padding: "3px 8px", fontSize: 11 }}
                              onClick={async () => {
                                try {
                                  await api.unassignCoreFromPort(s.id, p.port_number);
                                  load();
                                  loadSplitters();
                                  onChanged?.();
                                } catch (err) {
                                  alert(err.message);
                                }
                              }}
                            >
                              Unassign
                            </button>
                          ) : (
                            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="empty-state" style={{ padding: "4px 0" }}>
                  No ports configured
                </p>
              )}
              <button
                className="btn btn-danger"
                style={{ marginTop: 8, padding: "4px 8px", fontSize: 11 }}
                onClick={() => handleDeleteSplitter(s.id)}
              >
                Remove splitter
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-state" style={{ marginBottom: 16 }}>
          No splitters in this box.
        </p>
      )}

      {!showSplitterForm ? (
        <button
          className="btn btn-block"
          onClick={() => setShowSplitterForm(true)}
          style={{ marginBottom: 16 }}
        >
          Add splitter
        </button>
      ) : (
        <form onSubmit={handleCreateSplitter} style={{ marginBottom: 16 }}>
          <p className="section-title">New splitter</p>
          <div className="field">
            <label>Name (optional)</label>
            <input
              value={splitterForm.name}
              onChange={(e) =>
                setSplitterForm((f) => ({ ...f, name: e.target.value }))
              }
              placeholder="e.g. 1:4 splitter tray #1"
            />
          </div>
          <div className="field">
            <label>Split count</label>
            <select
              value={splitterForm.split_count}
              onChange={(e) =>
                setSplitterForm((f) => ({ ...f, split_count: Number(e.target.value) }))
              }
            >
              <option value={2}>1:2</option>
              <option value={4}>1:4</option>
              <option value={8}>1:8</option>
            </select>
          </div>
          <div className="field">
            <label>Input core (IN) — select the fiber coming into the splitter</label>
            <select
              value={splitterForm.input_core_id}
              onChange={(e) =>
                setSplitterForm((f) => ({ ...f, input_core_id: e.target.value }))
              }
            >
              <option value="">Select input core…</option>
              <optgroup label="Available cores">
                {availableInCoresForBranching.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.cable_code} #{c.core_number} ({getFiberColorName(c.core_number)})
                  </option>
                ))}
              </optgroup>
              {splicedCoresForBranching.length > 0 && (
                <optgroup label="Spliced cores (for branching)">
                  {splicedCoresForBranching.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.cable_code} #{c.core_number} ({getFiberColorName(c.core_number)})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div style={{ padding: 10, background: "rgba(63,208,201,0.1)", border: "1px solid rgba(63,208,201,0.3)", borderRadius: "var(--radius)", marginBottom: 12 }}>
            <p style={{ fontSize: 12, color: "var(--teal)", margin: 0 }}>
              ℹ️ After creation, {splitterForm.split_count} empty output ports will appear in the splitters list below. You can assign available cores to these ports later, and splice them to customer drop cables when needed.
            </p>
          </div>
          <div className="field">
            <label>Splice type</label>
            <select
              value={splitterForm.splice_type}
              onChange={(e) =>
                setSplitterForm((f) => ({ ...f, splice_type: e.target.value }))
              }
            >
              <option value="fusion">Fusion</option>
              <option value="mechanical">Mechanical</option>
            </select>
          </div>
          <div className="field">
            <label>Loss (dB)</label>
            <input
              type="number"
              step="0.01"
              value={splitterForm.loss_db}
              onChange={(e) =>
                setSplitterForm((f) => ({ ...f, loss_db: e.target.value }))
              }
            />
          </div>
          <div className="field">
            <label>Technician</label>
            <input
              value={splitterForm.technician}
              onChange={(e) =>
                setSplitterForm((f) => ({ ...f, technician: e.target.value }))
              }
            />
          </div>
          <div className="field">
            <label>Notes</label>
            <textarea
              value={splitterForm.notes}
              onChange={(e) =>
                setSplitterForm((f) => ({ ...f, notes: e.target.value }))
              }
              rows={2}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={creatingSplitter}
            >
              {creatingSplitter ? "Creating…" : "Create splitter"}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setShowSplitterForm(false);
                setSplitterForm({
                  name: "",
                  split_count: 4,
                  input_core_id: "",
                  output_core_ids: [],
                  splice_type: "fusion",
                  loss_db: "",
                  technician: "",
                  notes: "",
                });
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CableDetail — shown when a cable is selected
// ---------------------------------------------------------------------------
function CableDetail({ cable, onSplitPointChange, onChanged, onDeleteCable }) {
  const [full, setFull] = useState(null);
  const [trace, setTrace] = useState(null);
  const [insertForm, setInsertForm] = useState(null);
  const [splitInfo, setSplitInfo] = useState(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [splitLngLat, setSplitLngLat] = useState(null);
  const [inserting, setInserting] = useState(false);

  useEffect(() => {
    setTrace(null);
    setInsertForm(null);
    setSplitInfo(null);
    setSplitRatio(0.5);
    setSplitLngLat(null);
    api.getCable(cable.id).then(setFull);
  }, [cable.id]);

  // Load split info once we have the cable
  useEffect(() => {
    if (full && full.cable_type !== "drop") {
      api.getSplitInfo(full.id).then((info) => {
        setSplitInfo(info);
        // Show midpoint by default
        const ratio = 0.5;
        setSplitRatio(ratio);
        updateSplitPreview(info, ratio);
      }).catch(() => {});
    }
  }, [full]);

  function interpolateSplitPoint(coords, ratio) {
    if (!coords || coords.length < 2) return null;

    // Validate all coordinates have proper [lng, lat] pairs
    for (let i = 0; i < coords.length; i++) {
      if (
        !Array.isArray(coords[i]) ||
        coords[i].length < 2 ||
        !Number.isFinite(coords[i][0]) ||
        !Number.isFinite(coords[i][1])
      ) return null;
    }

    // Calculate total length of the route in coordinate space
    let totalLength = 0;
    const segments = [];
    for (let i = 1; i < coords.length; i++) {
      const dx = coords[i][0] - coords[i-1][0];
      const dy = coords[i][1] - coords[i-1][1];
      const len = Math.sqrt(dx * dx + dy * dy);
      segments.push(len);
      totalLength += len;
    }
    if (totalLength === 0) return coords[0];

    const targetDist = ratio * totalLength;
    let accumulated = 0;

    for (let i = 1; i < coords.length; i++) {
      const segLen = segments[i - 1];
      if (accumulated + segLen >= targetDist) {
        const t = segLen > 0 ? (targetDist - accumulated) / segLen : 0;
        const lng = Number.isFinite(coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t)
          ? coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t
          : coords[i - 1][0];
        const lat = Number.isFinite(coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t)
          ? coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t
          : coords[i - 1][1];
        return [lng, lat];
      }
      accumulated += segLen;
    }
    return coords[coords.length - 1];
  }

  function updateSplitPreview(info, ratio) {
    // Use the cable prop's parsed route (from cables list endpoint),
    // NOT full.route (single-cable endpoint returns raw geography)
    if (!info || !cable?.route || !Array.isArray(cable.route) || cable.route.length < 2) return;
    const coords = cable.route; // already [lng, lat] pairs from cables list

    // Validate the first coordinate to ensure we have real data
    const first = coords[0];
    if (
      !Array.isArray(first) ||
      first.length < 2 ||
      !Number.isFinite(first[0]) ||
      !Number.isFinite(first[1])
    ) return;

    const point = interpolateSplitPoint(coords, ratio);
    setSplitLngLat(point);
    if (onSplitPointChange) {
      onSplitPointChange(point, ratio);
    }
  }

  function handleSplitRatioChange(e) {
    const val = parseFloat(e.target.value);
    setSplitRatio(val);
    updateSplitPreview(splitInfo, val);
  }

  function openInsertForm() {
    setInsertForm({
      // poles are anonymous mounting points — no code/name needed
      enclosure_code: `${full.code}-MID-BOX`,
      enclosure_name: "",
      downstream_cable_code: `${full.code}-B`,
      downstream_cable_name: full.name ? `${full.name} - segment B` : "",
    });
  }

  async function handleInsertEnclosure(e) {
    e.preventDefault();
    if (!insertForm) return;
    setInserting(true);

    try {
      const result = await api.insertEnclosureOnCable(full.id, {
        enclosure_code: insertForm.enclosure_code,
        enclosure_name: insertForm.enclosure_name || null,
        downstream_cable_code: insertForm.downstream_cable_code,
        downstream_cable_name: insertForm.downstream_cable_name || null,
        split_ratio: splitRatio,
      });
      setInsertForm(null);
      setTrace(null);
      setSplitLngLat(null);
      if (onSplitPointChange) onSplitPointChange(null, null);
      await api.getCable(cable.id).then(setFull);
      onChanged?.();
      alert(
        `Done! New pole and enclosure "${result.enclosure.code}" placed.\n` +
        `Upstream: ${Math.round(result.split_info.upstream_length_m)}m → Box → Downstream: ${Math.round(result.split_info.downstream_length_m)}m\n` +
        `${result.summary.available_cores} cores available for splicing to customer drops.`
      );
    } catch (err) {
      alert(err.message);
    } finally {
      setInserting(false);
    }
  }

  if (!full) return <p className="loading-row">Loading cable…</p>;

  // Build core status summary
  const coreSummary = {};
  for (const c of full.cores) {
    coreSummary[c.status] = (coreSummary[c.status] || 0) + 1;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
        <div>
          <p className="section-title" style={{ margin: 0 }}>
            {full.code} — {full.cable_type}
          </p>
          <p className="empty-state">
            {full.core_count} cores{" "}
            {full.customer_label ? `· label ${full.customer_label}` : ""}
          </p>
        </div>
        {onDeleteCable && (
          <button
            className="btn btn-danger"
            onClick={() => onDeleteCable(full.id)}
            style={{ padding: "4px 12px", fontSize: 12, flexShrink: 0 }}
          >
            Delete cable
          </button>
        )}
      </div>

      <div className="summary-grid" style={{ marginBottom: 12 }}>
        {Object.entries(coreSummary).map(([status, count]) => (
          <div className="summary-card" key={status}>
            <div className="n">{count}</div>
            <div className="l">{status}</div>
          </div>
        ))}
      </div>

  <table className="doc-table" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>Core #</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {[...full.cores].sort((a, b) => a.core_number - b.core_number).map((c) => (
            <tr key={c.id}>
              <td>
                <FiberColorDot coreNumber={c.core_number} />
                {c.core_number}
              </td>
              <td>
                <Pill status={c.status} />
              </td>
              <td>
                <button
                  className="btn"
                  style={{ padding: "3px 8px", fontSize: 11 }}
                  onClick={() => api.traceFiber(c.id).then(setTrace)}
                >
                  Trace
                </button>
                {c.status === "spliced" && (
                  <button
                    className="btn btn-danger"
                    style={{ padding: "3px 8px", fontSize: 11, marginLeft: 4 }}
                    onClick={async () => {
                      if (!confirm(`Unsplice core #${c.core_number}? It will return to available.`)) return;
                      try {
                        await api.unspliceCore(c.id);
                        await api.getCable(cable.id).then(setFull);
                        alert(`Core #${c.core_number} unspliced successfully`);
                      } catch (err) {
                        alert(err.message);
                      }
                    }}
                  >
                    Unsplice
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {full.cable_type !== "drop" && (
        <>
          <p className="section-title">Mid-span enclosure</p>
          {!insertForm ? (
            <button className="btn btn-block" onClick={openInsertForm}>
              Insert enclosure at midpoint
            </button>
          ) : (
            <form onSubmit={handleInsertEnclosure} style={{ marginBottom: 16 }}>
              {/* Split location slider */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontWeight: 600, display: "block", marginBottom: 4 }}>
                  Split location: {Math.round(splitRatio * 100)}% from start
                  {splitInfo && (
                    <span style={{ fontWeight: 400, color: "var(--muted)", marginLeft: 8 }}>
                      (~{Math.round(splitRatio * splitInfo.total_length_m)}m / {splitInfo.total_length_m}m)
                    </span>
                  )}
                </label>
                <input
                  type="range"
                  min="0.05"
                  max="0.95"
                  step="0.01"
                  value={splitRatio}
                  onChange={handleSplitRatioChange}
                  style={{ width: "100%" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
                  <span>Start box (0%)</span>
                  <span>End box (100%)</span>
                </div>
              </div>

              {/* Core impact preview */}
              {splitInfo && (
                <div className="summary-grid" style={{ marginBottom: 12 }}>
                  <div className="summary-card">
                    <div className="n" style={{ color: "var(--teal)" }}>
                      {splitInfo.core_summary?.available || 0}
                    </div>
                    <div className="l">Will splice</div>
                  </div>
                  <div className="summary-card">
                    <div className="n" style={{ color: "var(--amber)" }}>
                      {full.core_count - (splitInfo.core_summary?.available || 0)}
                    </div>
                    <div className="l">Pass-through</div>
                  </div>
                </div>
              )}

              <div className="field">
                <label>Enclosure code</label>
                <input
                  value={insertForm.enclosure_code}
                  onChange={(e) =>
                    setInsertForm((f) => ({ ...f, enclosure_code: e.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Enclosure name</label>
                <input
                  value={insertForm.enclosure_name}
                  onChange={(e) =>
                    setInsertForm((f) => ({ ...f, enclosure_name: e.target.value }))
                  }
                  placeholder="Optional"
                />
              </div>
              <div className="field">
                <label>Downstream cable code</label>
                <input
                  value={insertForm.downstream_cable_code}
                  onChange={(e) =>
                    setInsertForm((f) => ({
                      ...f,
                      downstream_cable_code: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="field">
                <label>Downstream cable name</label>
                <input
                  value={insertForm.downstream_cable_name}
                  onChange={(e) =>
                    setInsertForm((f) => ({
                      ...f,
                      downstream_cable_name: e.target.value,
                    }))
                  }
                  placeholder="Optional"
                />
              </div>
              {/* IN/OUT direction indicators */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, marginBottom: 12, alignItems: "center" }}>
                <div style={{ background: "rgba(63,208,201,0.1)", border: "1px solid rgba(63,208,201,0.3)", borderRadius: "var(--radius)", padding: 10 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--teal)", marginBottom: 4 }}>IN (from upstream)</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {full.from_enclosure_id ? `Box ${full.from_enclosure_id.slice(0, 8)}…` : "Customer drop"}
                  </div>
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 20, fontWeight: 700 }}>→</div>
                <div style={{ background: "rgba(240,180,41,0.1)", border: "1px solid rgba(240,180,41,0.3)", borderRadius: "var(--radius)", padding: 10 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--amber)", marginBottom: 4 }}>OUT (to downstream)</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {full.to_enclosure_id ? `Box ${full.to_enclosure_id.slice(0, 8)}…` : "Customer drop"}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={inserting}
                >
                  {inserting ? "Creating…" : "Insert enclosure"}
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setInsertForm(null);
                    setSplitLngLat(null);
                    if (onSplitPointChange) onSplitPointChange(null, null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {trace && (
        <div>
          <p className="section-title">Fiber path (req #6)</p>
          {trace.hops.map((hop, i) =>
            hop.cable_code ? (
              <div className="list-item" key={i}>
                <div className="code">
                  {hop.cable_code} · core #{hop.core_number}
                </div>
                <div className="sub">
                  {hop.cable_type}
                  <Pill status={hop.core_status} />
                </div>
              </div>
            ) : (
              <div className="empty-state" key={i} style={{ paddingLeft: 8 }}>
                ↓ spliced ({hop.splice_type})
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CustomerLookupPanel — shown in locate-customer mode
// ---------------------------------------------------------------------------
function CustomerLookupPanel({ customerPoint, customers, customerRoute, onCreateCustomer }) {
  const [result, setResult] = useState(null);
  const [route, setRoute] = useState(null);
  const [form, setForm] = useState({
    customer_code: "",
    name: "",
    phone: "",
    email: "",
    address: "",
  });

  useEffect(() => {
    if (!customerPoint) {
      setResult(null);
      setRoute(null);
      return;
    }
    api
      .customerLookup(customerPoint.lat, customerPoint.lng)
      .then((lookupResult) => {
        setResult(lookupResult);
        // If we have a recommended box, fetch the route
        if (lookupResult.recommended_box) {
          return api.getCustomerRoute(
            customerPoint.lat,
            customerPoint.lng,
            lookupResult.recommended_box.id
          );
        }
        return null;
      })
      .then((routeResult) => {
        if (routeResult) {
          setRoute(routeResult);
        }
      })
      .catch(() => {
        setResult(null);
        setRoute(null);
      });
  }, [customerPoint]);

  async function handleCreate(e) {
    e.preventDefault();
    try {
      await api.createCustomer({
        ...form,
        lat: customerPoint.lat,
        lng: customerPoint.lng,
      });
      setForm({
        customer_code: "",
        name: "",
        phone: "",
        email: "",
        address: "",
      });
      onCreateCustomer?.();
      alert("Customer registered");
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div>
      <p className="section-title">Customer lookup</p>
      {!customerPoint ? (
        <p className="empty-state">Click the map at the customer's location.</p>
      ) : (
        <>
          {result && (
            <div style={{ marginBottom: 16 }}>
              <p className="empty-state">
                Nearby boxes: {result.nearby_boxes.length}
              </p>
              {result.recommended_box && (
                <p className="empty-state">
                  Recommended: <b>{result.recommended_box.code}</b> (
                  {result.recommended_box.available_cores} free,{" "}
                  {Math.round(result.recommended_box.distance_m)}m away)
                </p>
              )}
              {result.suggested_source && (
                <p className="empty-state">
                  Suggested source: {result.suggested_source.source_enclosure_id.slice(0, 8)}… (
                  {result.suggested_source.available_cores} free,{" "}
                  {result.suggested_source.hops} hops)
                </p>
              )}
              {route && (
                <p className="empty-state" style={{ marginTop: 8, color: "var(--teal)" }}>
                  Route distance: {Math.round(route.length_m)}m along the street
                </p>
              )}
            </div>
          )}
          <form onSubmit={handleCreate} style={{ marginBottom: 16 }}>
            <div className="field">
              <label>Customer code</label>
              <input
                value={form.customer_code}
                onChange={(e) =>
                  setForm((f) => ({ ...f, customer_code: e.target.value }))
                }
              />
            </div>
            <div className="field">
              <label>Name</label>
              <input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div className="field">
              <label>Phone</label>
              <input
                value={form.phone}
                onChange={(e) =>
                  setForm((f) => ({ ...f, phone: e.target.value }))
                }
              />
            </div>
            <div className="field">
              <label>Email</label>
              <input
                value={form.email}
                onChange={(e) =>
                  setForm((f) => ({ ...f, email: e.target.value }))
                }
              />
            </div>
            <div className="field">
              <label>Address</label>
              <input
                value={form.address}
                onChange={(e) =>
                  setForm((f) => ({ ...f, address: e.target.value }))
                }
              />
            </div>
            <button className="btn btn-primary btn-block" type="submit">
              Register customer
            </button>
          </form>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main RightPanel — mode-based routing
// ---------------------------------------------------------------------------
export default function RightPanel({
  mode,
  selectedEnclosure,
  selectedCable,
  customerPoint,
  customers,
  onCreateCustomer,
  onChanged,
  onDeleteEnclosure,
  onDeleteCable,
  onSplitPointChange,
}) {
  return (
    <>
      {mode === "view" && !selectedEnclosure && !selectedCable && (
        <p className="empty-state">Select a box or cable to see details.</p>
      )}

      {selectedEnclosure && (
        <BoxDocumentation
          enclosureId={selectedEnclosure.id}
          onChanged={onChanged}
          onDeleteEnclosure={onDeleteEnclosure}
        />
      )}

      {selectedCable && (
        <CableDetail
          cable={selectedCable}
          onSplitPointChange={onSplitPointChange}
          onChanged={onChanged}
          onDeleteCable={onDeleteCable}
        />
      )}

      {mode === "locate-customer" && (
        <CustomerLookupPanel
          customerPoint={customerPoint}
          customers={customers}
          onCreateCustomer={onCreateCustomer}
        />
      )}
    </>
  );
}