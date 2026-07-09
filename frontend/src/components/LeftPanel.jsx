import React, { useEffect, useState } from "react";
import { api } from "../api";

function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function AddPoleForm({ point, onSubmit, onCancel }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [poleType, setPoleType] = useState("wooden");

  if (!point) {
    return (
      <p className="empty-state">Click anywhere on the map to place a pole.</p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!code.trim()) return;
        onSubmit({
          code,
          name,
          pole_type: poleType,
          lat: point.lat,
          lng: point.lng,
        });
        setCode("");
        setName("");
      }}
    >
      <p className="empty-state">
        {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
      </p>
      <Field label="Pole code *">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="POLE-0042"
          autoFocus
        />
      </Field>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Optional"
        />
      </Field>
      <Field label="Pole type">
        <select value={poleType} onChange={(e) => setPoleType(e.target.value)}>
          <option value="wooden">Wooden</option>
          <option value="concrete">Concrete</option>
          <option value="existing-utility">Existing utility pole</option>
        </select>
      </Field>
      <button className="btn btn-primary btn-block" type="submit">
        Create pole
      </button>
      <button
        className="btn btn-block"
        type="button"
        style={{ marginTop: 6 }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

export function AddEnclosureForm({ pole, onSubmit, onCancel }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("splice_closure");
  const [capacity, setCapacity] = useState(48);

  if (!pole) {
    return (
      <p className="empty-state">
        Click a pole on the map to attach a box to it.
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!code.trim()) return;
        onSubmit({
          code,
          name,
          type,
          capacity: Number(capacity),
          pole_id: pole.id,
        });
        setCode("");
        setName("");
      }}
    >
      <p className="empty-state">
        Attaching to pole <code>{pole.code}</code>
      </p>
      <Field label="Box code *">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="BOX-0042"
          autoFocus
        />
      </Field>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Optional"
        />
      </Field>
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="splice_closure">Splice closure</option>
          <option value="cabinet">Cabinet</option>
          <option value="nap">NAP (customer access point)</option>
          <option value="handhole">Handhole</option>
          <option value="terminal">Terminal</option>
        </select>
      </Field>
      <Field label="Tray/port capacity">
        <input
          type="number"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          min="1"
        />
      </Field>
      <button className="btn btn-primary btn-block" type="submit">
        Create box
      </button>
      <button
        className="btn btn-block"
        type="button"
        style={{ marginTop: 6 }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

export function DrawCableForm({
  fromEnclosure,
  toEnclosure,
  customers,
  routePoints,
  routePreview,
  onSubmit,
  onCancel,
  onUndoRoutePoint,
  onClearRoute,
  onPreviewRoute,
}) {
  const [code, setCode] = useState("");
  const [cableType, setCableType] = useState("distribution");
  const [coreCount, setCoreCount] = useState(24);
  const [customerId, setCustomerId] = useState("");

  const isDrop = cableType === "drop";
  const destinationReady = isDrop ? !!customerId : !!toEnclosure;
  const previewReady = !!routePreview?.route?.length;
  const canSubmit = code.trim() && destinationReady && previewReady;

  useEffect(() => {
    let cancelled = false;

    onPreviewRoute?.(null);

    async function previewRoute() {
      if (!fromEnclosure || !destinationReady) {
        return;
      }

      try {
        const preview = await api.previewCableRoute({
          cable_type: cableType,
          from_enclosure_id: fromEnclosure.id,
          to_enclosure_id: isDrop ? undefined : toEnclosure.id,
          customer_id: isDrop ? customerId : undefined,
          route_points: routePoints.map((point) => ({
            lat: point.lat,
            lng: point.lng,
          })),
        });

        if (!cancelled) onPreviewRoute?.(preview);
      } catch (err) {
        if (!cancelled) onPreviewRoute?.(null);
      }
    }

    previewRoute();

    return () => {
      cancelled = true;
    };
  }, [
    fromEnclosure,
    toEnclosure,
    cableType,
    customerId,
    destinationReady,
    routePoints,
    onPreviewRoute,
    isDrop,
  ]);

  if (!fromEnclosure) {
    return (
      <p className="empty-state">
        Click a box to start the cable, then click a second box as the
        destination.
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit({
          code,
          cable_type: cableType,
          core_count: Number(coreCount),
          from_enclosure_id: fromEnclosure.id,
          to_enclosure_id: isDrop ? undefined : toEnclosure.id,
          customer_id: isDrop ? customerId : undefined,
          customer_label: isDrop ? `CUST-${customerId.slice(0, 6)}` : undefined,
          route_points: routePoints.map((point) => ({
            lat: point.lat,
            lng: point.lng,
          })),
          route_geometry: routePreview?.route || undefined,
          length_m: routePreview?.length_m ?? undefined,
        });
        setCode("");
      }}
    >
      <p className="empty-state">
        From <code>{fromEnclosure.code}</code>
        {!isDrop &&
          (toEnclosure ? (
            <>
              {" "}
              → <code>{toEnclosure.code}</code>
            </>
          ) : (
            " — click the destination box on the map"
          ))}
      </p>
      <p className="empty-state" style={{ paddingTop: 0 }}>
        Duct route bends: {routePoints.length}
      </p>
      {!previewReady && destinationReady && (
        <p className="empty-state" style={{ paddingTop: 0 }}>
          Loading route preview...
        </p>
      )}

      {!!routePoints.length && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button className="btn" type="button" onClick={onUndoRoutePoint}>
            Undo last bend
          </button>
          <button className="btn" type="button" onClick={onClearRoute}>
            Clear route
          </button>
        </div>
      )}

      <Field label="Cable type">
        <select
          value={cableType}
          onChange={(e) => setCableType(e.target.value)}
        >
          <option value="feeder">Feeder</option>
          <option value="distribution">Distribution</option>
          <option value="drop">Drop (to customer)</option>
        </select>
      </Field>

      {isDrop && (
        <Field label="Customer">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">Select customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.customer_code} — {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Cable code *">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="CBL-0042"
        />
      </Field>
      <Field label="Core count">
        <input
          type="number"
          value={coreCount}
          onChange={(e) => setCoreCount(e.target.value)}
          min="1"
        />
      </Field>
      <button
        className="btn btn-primary btn-block"
        type="submit"
        disabled={!canSubmit}
      >
        Create cable
      </button>
      <button
        className="btn btn-block"
        type="button"
        style={{ marginTop: 6 }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

export default function LeftPanel(props) {
  const {
    mode,
    poles,
    enclosures,
    cables,
    onSelectPole,
    onSelectEnclosure,
    onSelectCable,
    selectedId,
  } = props;

  const [tab, setTab] = useState("poles");

  if (mode !== "view") {
    return (
      <div>
        <p className="section-title">{mode.replace("-", " ")}</p>
        {mode === "add-pole" && (
          <AddPoleForm
            {...props}
            point={props.pendingPolePoint}
            onSubmit={props.onCreatePole}
            onCancel={props.onCancelMode}
          />
        )}
        {mode === "add-enclosure" && (
          <AddEnclosureForm
            {...props}
            pole={props.pendingEnclosurePole}
            onSubmit={props.onCreateEnclosure}
            onCancel={props.onCancelMode}
          />
        )}
        {mode === "draw-cable" && (
          <DrawCableForm
            fromEnclosure={props.cableDraft?.from}
            toEnclosure={props.cableDraft?.to}
            customers={props.customers}
            routePoints={props.routePoints || []}
            routePreview={props.routePreview}
            onSubmit={props.onCreateCable}
            onCancel={props.onCancelMode}
            onUndoRoutePoint={props.onUndoRoutePoint}
            onClearRoute={props.onClearRoute}
            onPreviewRoute={props.onPreviewRoute}
          />
        )}
        {mode === "locate-customer" && (
          <p className="empty-state">
            Click anywhere on the map to drop a customer pin and search nearby
            boxes.
          </p>
        )}
      </div>
    );
  }

  const tabs = [
    { key: "poles", label: "Poles", items: poles },
    { key: "enclosures", label: "Boxes", items: enclosures },
    { key: "cables", label: "Cables", items: cables },
  ];

  return (
    <div>
      <div className="mode-toggle" style={{ marginBottom: 12 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "active" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label} ({t.items.length})
          </button>
        ))}
      </div>

      {tab === "poles" &&
        (poles.length ? (
          poles.map((p) => (
            <div
              key={p.id}
              className={`list-item ${selectedId === p.id ? "selected" : ""}`}
              onClick={() => onSelectPole(p)}
            >
              <div className="code">{p.code}</div>
              <div className="sub">
                {p.name || "—"} · {p.pole_type}
              </div>
            </div>
          ))
        ) : (
          <p className="empty-state">
            No poles yet. Switch to "Add pole" and click the map.
          </p>
        ))}

      {tab === "enclosures" &&
        (enclosures.length ? (
          enclosures.map((e) => (
            <div
              key={e.id}
              className={`list-item ${selectedId === e.id ? "selected" : ""}`}
              onClick={() => onSelectEnclosure(e)}
            >
              <div className="code">{e.code}</div>
              <div className="sub">
                {e.type.replace("_", " ")} · on {e.pole_code}
              </div>
            </div>
          ))
        ) : (
          <p className="empty-state">
            No boxes yet. Switch to "Add box" and click a pole.
          </p>
        ))}

      {tab === "cables" &&
        (cables.length ? (
          cables.map((c) => (
            <div
              key={c.id}
              className={`list-item ${selectedId === c.id ? "selected" : ""}`}
              onClick={() => onSelectCable(c)}
            >
              <div className="code">{c.code}</div>
              <div className="sub">
                {c.cable_type} · {c.core_count} cores{" "}
                {c.customer_label ? `· ${c.customer_label}` : ""}
              </div>
            </div>
          ))
        ) : (
          <p className="empty-state">No cables yet. Switch to "Draw cable".</p>
        ))}
    </div>
  );
}
